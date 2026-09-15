const config = require('../../../config');
const logger = require('../../../utils/logger');

// Real product photography from a supplier photo, via OpenAI's image model
// in EDIT mode: the supplier photo goes in as the reference, the prompt says
// what to make of it, and a new photograph comes back with the product
// preserved. This is a different job from Bria's lifestyle mode, which only
// ever re-backgrounds the cutout it's given — the difference the seller saw
// between "shift" and a listing that looks shot in a studio.
//
// Implemented against OpenAI's public images/edits contract with native
// fetch + FormData (no SDK). NOT live-verified: no OPENAI_API_KEY exists in
// this environment yet, so the first real call is the verification step.

const OPENAI_EDITS_URL = 'https://api.openai.com/v1/images/edits';
const MODEL = 'gpt-image-1';
// Square is what eBay's gallery wants; 1024 is the model's largest square.
// The pipeline pads to 1600 afterwards, so the "below 1600px" warning will
// fire on these — that's the model's ceiling, not a pipeline fault.
const SIZE = '1024x1024';
const REQUEST_TIMEOUT_MS = 120 * 1000;

function isConfigured() {
  return Boolean(config.openaiApiKey);
}

// The seller's own brief, with the elements that eBay's picture policy
// frowns on (badges, borders) driven by settings so they can be switched
// off without touching the prompt.
function buildPrompt({ variant = 'hero', settings = config.imageGeneration, extraInstruction } = {}) {
  const subject = settings.showPerson
    ? `Show a realistic adult person naturally holding or using the product according to its actual purpose, function, size, and specifications. The hand placement, body position, grip, and interaction with the product must look completely natural and practical.`
    : `Show the product on its own, positioned naturally as it would be used.`;

  const angle = {
    hero: '',
    angle: ' Photograph it from a different, informative angle than a straight-on front view — three-quarter or side — so the depth and edges of the product are clear.',
    detail: ' Frame a close, detailed view that shows the texture, finish and build quality of the product.',
    in_use: ' Show the product mid-use in the most typical way it is actually used, still against the pure white background.',
    back: ' Show the rear or underside of the product clearly.',
  }[variant] || '';

  const extras = [
    settings.addUkFlag ? '- Add a small UK flag neatly in one corner without covering the product.' : null,
    settings.addFreeShippingLabel ? '- Add a clean FREE SHIPPING label in another suitable corner.' : null,
    settings.addGlowBorder
      ? '- Add a thin, elegant illuminated border line around the image edges with a subtle premium glow.'
      : null,
  ].filter(Boolean);

  return [
    `Create a premium, ultra-realistic 4K HD eBay product image using the provided product image as the exact product reference.`,
    ``,
    subject + angle,
    ``,
    `Product Accuracy — CRITICAL`,
    `- Preserve the exact original product design, shape, colour, dimensions, proportions, texture, material, patterns, buttons, attachments, and all visible details.`,
    `- Do not redesign, modify, recolour, replace, or distort the product.`,
    `- Do not invent any features or accessories.`,
    `- Keep the product clearly visible and as the primary focus.`,
    `- Remove anything that identifies the original supplier or marketplace: no watermarks, store names, logos, price tags or overlaid text from the reference photo.`,
    ``,
    `Background & Image Style`,
    `- Use a pure clean white background (FFFFFF).`,
    `- No lifestyle environment, room, furniture, landscape, props, or scenery.`,
    `- Professional e-commerce product photography.`,
    `- Ultra-sharp 4K HD quality.`,
    `- Excellent clarity, realistic lighting, and natural product details.`,
    `- Add a subtle, realistic soft shadow beneath/around the product and person's hand where appropriate.`,
    `- Clean, minimal, premium, and trustworthy appearance.`,
    ...(extras.length
      ? [``, `Additional Elements`, ...extras, `- Keep these elements small and secondary so they do not distract from the product.`]
      : []),
    ``,
    `Final Requirement`,
    `The final image must look like a professional eBay product listing image on a pure white background${
      settings.showPerson ? ', with the product being naturally held/used by the person' : ''
    } while maintaining complete product accuracy.`,
    ``,
    `Do not add unnecessary text, logos, watermarks, decorative objects, fake features, or coloured backgrounds.`,
    // A seller's own instruction from the editor ("show it from the back")
    // rides on top of the brief; it can refine the shot but never override
    // the product-accuracy rules above.
    ...(extraInstruction ? [``, `Specific request from the seller for this image: ${extraInstruction}`] : []),
  ].join('\n');
}

/**
 * Generates one product photograph.
 *
 * @param referenceImages  Buffer[] — the supplier photo(s) the product must
 *                         match. Several can be given (e.g. front + back).
 * @param variant          which shot in the gallery this is: hero | angle |
 *                         detail | in_use | back
 * @returns Buffer (PNG) — the pipeline normalises it to eBay's shape.
 */
async function generateProductShot({ referenceImages, variant = 'hero', settings, extraInstruction }) {
  if (!isConfigured()) {
    throw new Error('OpenAI image generation is not configured — set OPENAI_API_KEY');
  }
  if (!referenceImages?.length) {
    throw new Error('A reference photo of the product is required');
  }

  const form = new FormData();
  form.append('model', MODEL);
  form.append('prompt', buildPrompt({ variant, settings, extraInstruction }));
  form.append('size', SIZE);
  form.append('quality', (settings || config.imageGeneration).quality || 'high');
  form.append('n', '1');
  for (const [index, buffer] of referenceImages.entries()) {
    form.append('image[]', new Blob([buffer], { type: 'image/png' }), `reference-${index}.png`);
  }

  const res = await fetch(OPENAI_EDITS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error?.message || `OpenAI image request failed (${res.status})`;
    logger.warn('OpenAI image generation failed', { status: res.status, message });
    throw new Error(message);
  }

  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image');
  return Buffer.from(b64, 'base64');
}

// Which of the seller's requested overlays are on. Surfaced as a draft
// warning, since eBay demotes listings whose images carry badges/text.
function activeOverlays(settings = config.imageGeneration) {
  return [
    settings.addUkFlag ? 'UK flag' : null,
    settings.addFreeShippingLabel ? 'FREE SHIPPING label' : null,
    settings.addGlowBorder ? 'glow border' : null,
  ].filter(Boolean);
}

module.exports = { isConfigured, buildPrompt, generateProductShot, activeOverlays, MODEL, SIZE };
