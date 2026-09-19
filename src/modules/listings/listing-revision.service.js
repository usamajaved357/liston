const crypto = require('crypto');
const policyWords = require('./policy-words');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const config = require('../../config');
const imageOps = require('../ai-generation/image-pipeline/image.ops');
const heroBadges = require('../ai-generation/image-pipeline/hero-badges');
const { AiGenerationError } = require('../ai-generation/ai-generation.errors');

// "Make the description shorter", "add a heading to the main image" — the
// seller describes a change in their own words and gets a PROPOSAL back.
// Nothing is saved until they accept, which matters most for images: a
// generated image can come back wrong, and overwriting the original would
// lose a shot that was already good.

const MODEL = config.aiModel;

function client() {
  if (!config.anthropicApiKey) {
    throw new AiGenerationError("AI editing isn't configured on this server. Set ANTHROPIC_API_KEY.");
  }
  return new Anthropic({ apiKey: config.anthropicApiKey });
}

const CONDITIONS = ['NEW', 'USED_EXCELLENT', 'USED_GOOD', 'USED_ACCEPTABLE'];

// Everything on the editor except the photos: the seller says what to
// change in plain words and the model returns just the fields that change,
// in the editor's own terms (variations by index, options by name).
const TEXT_TOOL = {
  name: 'submit_revision',
  description: 'Submit the changes to the draft listing. Include ONLY the fields the instruction asks to change; omit everything else.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 80, description: 'New listing title (eBay allows 80 characters).' },
      description: { type: 'string', description: 'New full description text. Plain text; **bold** is allowed.' },
      aspects: {
        type: 'object',
        description: 'Item specifics to set or replace, as { name: [value] }. Only the ones that change.',
        additionalProperties: { type: 'array', items: { type: 'string' } },
      },
      removeAspects: { type: 'array', items: { type: 'string' }, description: 'Item specifics to remove, by name.' },
      condition: { type: 'string', enum: CONDITIONS },
      price: { type: 'number', description: 'New price for a single-item listing (not a variation listing).' },
      quantity: { type: 'integer', minimum: 0, description: 'New quantity for a single-item listing.' },
      sku: { type: 'string', maxLength: 50, description: 'New custom label / SKU.' },
      variants: {
        type: 'array',
        description: 'Price and/or quantity changes to specific variations, by the index shown in the variations table.',
        items: {
          type: 'object',
          properties: { index: { type: 'integer', minimum: 0 }, price: { type: 'number' }, quantity: { type: 'integer', minimum: 0 } },
          required: ['index'],
        },
      },
      allVariants: {
        type: 'object',
        description: 'Price and/or quantity to apply to every variation.',
        properties: { price: { type: 'number' }, quantity: { type: 'integer', minimum: 0 } },
      },
      renameAxes: {
        type: 'array',
        description: 'Rename a variation attribute (what buyers choose from), e.g. Color → Colour.',
        items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string', maxLength: 65 } }, required: ['from', 'to'] },
      },
      renameAxisValues: {
        type: 'array',
        description: 'Rename an option of an attribute, e.g. Colour "Black H" → "Black with hooks".',
        items: { type: 'object', properties: { axis: { type: 'string' }, from: { type: 'string' }, to: { type: 'string', maxLength: 50 } }, required: ['axis', 'from', 'to'] },
      },
      removeAxisValues: {
        type: 'array',
        description: 'Drop an option and every variation that uses it.',
        items: { type: 'object', properties: { axis: { type: 'string' }, value: { type: 'string' } }, required: ['axis', 'value'] },
      },
      addAxisValues: {
        type: 'array',
        description: 'Add a new option to an attribute. Its variations copy price, quantity and photo from copyFrom (an existing option).',
        items: { type: 'object', properties: { axis: { type: 'string' }, value: { type: 'string', maxLength: 50 }, copyFrom: { type: 'string' } }, required: ['axis', 'value'] },
      },
      removeVariants: { type: 'array', items: { type: 'integer', minimum: 0 }, description: 'Variations to drop, by index.' },
      listingPolicies: {
        type: 'object',
        description: 'Business policies to switch to, by the exact names listed.',
        properties: { postage: { type: 'string' }, payment: { type: 'string' }, returns: { type: 'string' } },
      },
      storeCategoryNames: { type: 'array', items: { type: 'string' }, maxItems: 2, description: 'Shop categories, from the list given.' },
      summary: { type: 'string', description: 'One short sentence telling the seller what changed.' },
      cannotDo: { type: 'string', description: 'If the instruction asks for something outside these fields (photos, the eBay category), say so here in one sentence and change nothing.' },
    },
    required: ['summary'],
  },
};

function describeCurrent(current, options) {
  const lines = [];
  lines.push(`Title (max 80 chars): ${current.title || ''}`);
  lines.push(`Condition: ${current.condition || 'NEW'} (options: ${CONDITIONS.join(', ')})`);
  if (current.sku) lines.push(`SKU / custom label: ${current.sku}`);
  if (!current.variants?.length) {
    lines.push(`Price: ${current.price ?? ''} ${current.currency || ''}`.trim());
    lines.push(`Quantity: ${current.quantity ?? ''}`);
  }
  const aspects = current.aspects || {};
  lines.push(`Item specifics: ${Object.keys(aspects).length ? JSON.stringify(aspects) : 'none'}`);
  if (options?.requiredAspects?.length) lines.push(`Item specifics eBay requires in this category: ${options.requiredAspects.join(', ')}`);
  if (current.variants?.length) {
    const axes = (current.specifications || []).map((s) => `${s.name}: ${s.values.join(' | ')}`).join('; ');
    lines.push(`Variation attributes and options: ${axes}`);
    lines.push('Variations (index · options · price · quantity):');
    for (const v of current.variants) lines.push(`  ${v.index} · ${v.options} · ${v.price} ${current.currency || ''} · qty ${v.quantity}`);
  }
  if (options?.policies) {
    for (const [key, list] of Object.entries(options.policies)) {
      if (list?.length) lines.push(`${key} policies available: ${list.map((p) => `"${p.name}"`).join(', ')} (current: "${current.policies?.[key] || ''}")`);
    }
  }
  if (options?.storeCategories?.length) lines.push(`Shop categories available: ${options.storeCategories.map((c) => `"${c}"`).join(', ')} (current: ${JSON.stringify(current.storeCategoryNames || [])})`);
  lines.push(`\nDescription:\n${current.description || ''}`);
  return lines.join('\n');
}

/**
 * Proposes a revision. `current` is the editor's state (including unsaved
 * edits) in the shape the frontend sends; falls back to the stored draft.
 * Returns { changes, summary } — the caller decides whether to apply it.
 */
async function reviseText({ draft, instruction, current: given, options = {} }) {
  const anthropic = client();
  const isVariation = Array.isArray(draft.variants) && draft.variants.length > 0;
  const current = given || currentFromDraft(draft);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [TEXT_TOOL],
    tool_choice: { type: 'tool', name: TEXT_TOOL.name },
    messages: [
      {
        role: 'user',
        content:
          `An eBay seller is editing a draft listing and has asked for a change. Apply exactly what they ask, ` +
          `leave everything else as it is, and return ONLY the fields that change. Keep the title within 80 characters. ` +
          policyWords.PROMPT_GUIDANCE +
          `Refer to variations by their index and to options by their exact current names. Photos and the eBay ` +
          `category cannot be changed here: if asked, fill in cannotDo and change nothing.\n\n` +
          `Current listing:\n${describeCurrent(current, options)}\n\n` +
          `Their instruction: "${instruction}"`,
      },
    ],
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse?.input) {
    throw new AiGenerationError('The AI editor returned an unexpected response. Try rewording your instruction.');
  }

  const { summary, cannotDo, ...changes } = toolUse.input;
  if (cannotDo) return { changes: {}, summary: cannotDo, cannotDo: true };
  return { changes: mapChangesForDraft(tidyChanges(changes, current, options), isVariation), summary };
}

// The editor's shape of the stored draft, for when the frontend sends nothing.
function currentFromDraft(draft) {
  const isVariation = Array.isArray(draft.variants) && draft.variants.length > 0;
  const axes = (draft.variesBy?.specifications || []).map((s) => s.name);
  return {
    title: isVariation ? draft.commonTitle : draft.title,
    description: isVariation ? draft.commonDescription : draft.description,
    aspects: isVariation ? draft.variesBy?.aspects : draft.aspects,
    condition: isVariation ? draft.variants[0]?.condition : draft.condition,
    sku: draft.sku,
    currency: (isVariation ? draft.variants[0]?.price : draft.price)?.currency,
    price: isVariation ? undefined : draft.price?.value,
    quantity: isVariation ? undefined : draft.quantity,
    specifications: draft.variesBy?.specifications,
    variants: isVariation
      ? draft.variants.map((v, index) => ({ index, options: axes.map((a) => v.aspects?.[a]?.[0]).filter(Boolean).join(' · '), price: v.price?.value, quantity: v.quantity }))
      : [],
    storeCategoryNames: draft.storeCategoryNames,
  };
}

// A variation listing stores its text under commonTitle/commonDescription, so
// a revision to "the title" has to be rewritten onto the right key or it
// silently does nothing.
function mapChangesForDraft(changes, isVariation) {
  if (!isVariation) return changes;

  const mapped = { ...changes };
  if (mapped.title !== undefined) {
    mapped.commonTitle = mapped.title;
    delete mapped.title;
  }
  if (mapped.description !== undefined) {
    mapped.commonDescription = mapped.description;
    delete mapped.description;
  }
  return mapped;
}

// Numbers become the editor's strings; policy names become ids; anything
// that names a variation or option that doesn't exist is dropped.
function tidyChanges(changes, current, options) {
  const out = { ...changes };
  const currency = current.currency || 'GBP';
  const money = (n) => ({ value: Number(n).toFixed(2), currency });
  if (out.price !== undefined) out.price = money(out.price);
  if (out.allVariants) {
    out.allVariants = { ...(out.allVariants.price !== undefined ? { price: money(out.allVariants.price) } : {}), ...(out.allVariants.quantity !== undefined ? { quantity: out.allVariants.quantity } : {}) };
  }
  const count = current.variants?.length || 0;
  if (Array.isArray(out.variants)) {
    out.variants = out.variants
      .filter((v) => Number.isInteger(v.index) && v.index >= 0 && v.index < count)
      .map((v) => ({ index: v.index, ...(v.price !== undefined ? { price: money(v.price) } : {}), ...(v.quantity !== undefined ? { quantity: v.quantity } : {}) }));
    if (!out.variants.length) delete out.variants;
  }
  if (Array.isArray(out.removeVariants)) {
    out.removeVariants = out.removeVariants.filter((i) => Number.isInteger(i) && i >= 0 && i < count);
    if (!out.removeVariants.length) delete out.removeVariants;
  }
  if (out.listingPolicies && options.policies) {
    const ids = {};
    const byKey = { postage: 'fulfillmentPolicyId', payment: 'paymentPolicyId', returns: 'returnPolicyId' };
    for (const [key, name] of Object.entries(out.listingPolicies)) {
      const list = options.policies[key] || [];
      const hit = list.find((p) => p.name.toLowerCase() === String(name).toLowerCase());
      if (hit) ids[byKey[key]] = hit.id;
    }
    if (Object.keys(ids).length) out.listingPolicies = ids;
    else delete out.listingPolicies;
  } else delete out.listingPolicies;
  return out;
}

const IMAGE_OP_TOOL = {
  name: 'plan_image_edit',
  description: 'Decide which image operation carries out the seller\'s instruction.',
  input_schema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['text_overlay', 'enhance', 'badges', 'unsupported'],
        description:
          '"text_overlay" prints the seller\'s words onto the image. "enhance" sharpens, brightens and trims the ' +
          'margins so the product fills the frame. "badges" adds the store\'s UK flag / FREE SHIPPING label. ' +
          '"unsupported" for anything that would change the photo itself (new background, new scene, remove or add ' +
          'objects, change the product) — those are not available.',
      },
      text: { type: 'string', description: 'For "text_overlay": the exact words to print. Keep it short.' },
      position: { type: 'string', enum: ['top', 'bottom'], description: 'For "text_overlay": where it goes.' },
      summary: { type: 'string', description: 'One short sentence describing the change, for the seller.' },
    },
    required: ['operation', 'summary'],
  },
};

// eBay prohibits text, watermarks and badges on listing images and demotes
// listings that carry them — it's the same rule image-screen.service.js
// enforces on supplier photos. Sellers ask for it anyway, so it's supported,
// but never silently: the proposal carries this warning to the accept button.
const TEXT_OVERLAY_WARNING =
  "eBay doesn't allow text, badges or watermarks on listing images and reduces the visibility of listings that " +
  'use them. Consider putting this in the description or an item specific instead.';

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', "'": 'apos', '"': 'quot' }[char]};`);
}

// Text is composited with sharp rather than generated by a model. A
// generative model renders text unreliably — misspelt, warped, or in the
// wrong place — where an SVG overlay is exact, legible and reproducible.
async function overlayText(buffer, { text, position = 'bottom' }) {
  const { width, height } = await sharp(buffer).metadata();
  const fontSize = Math.round(width * 0.075);
  const bandHeight = Math.round(fontSize * 2);
  const bandY = position === 'top' ? 0 : height - bandHeight;
  const textY = bandY + Math.round(bandHeight / 2 + fontSize * 0.35);

  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
       <rect x="0" y="${bandY}" width="${width}" height="${bandHeight}" fill="rgba(0,0,0,0.55)"/>
       <text x="${Math.round(width / 2)}" y="${textY}" font-family="Helvetica, Arial, sans-serif"
             font-size="${fontSize}" font-weight="bold" fill="#ffffff" text-anchor="middle">${escapeXml(text)}</text>
     </svg>`
  );

  return sharp(buffer).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 90 }).toBuffer();
}

/**
 * Proposes an edited image. Returns { previewDataUrl, operation, summary,
 * policyWarning } — the image is NOT uploaded to eBay until accepted, so a
 * rejected proposal costs nothing.
 */
async function reviseImage({ imageUrl, instruction }) {
  pruneProposals();
  const anthropic = client();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    tools: [IMAGE_OP_TOOL],
    tool_choice: { type: 'tool', name: IMAGE_OP_TOOL.name },
    messages: [
      {
        role: 'user',
        content:
          `An eBay seller wants to change one of their listing photos. Decide which operation does what they ask.\n\n` +
          `Their instruction: "${instruction}"`,
      },
    ],
  });

  const plan = response.content.find((block) => block.type === 'tool_use')?.input;
  if (!plan) {
    throw new AiGenerationError('The AI editor returned an unexpected response. Try rewording your instruction.');
  }

  let buffer;
  if (plan.operation === 'text_overlay') {
    if (!plan.text) throw new AiGenerationError("Tell me what text you'd like on the image.");
    buffer = await overlayText(await imageOps.download(imageUrl), plan);
  } else if (plan.operation === 'enhance') {
    buffer = await imageOps.enhance(await imageOps.download(imageUrl));
  } else if (plan.operation === 'badges') {
    buffer = await heroBadges.brandHero(await imageOps.enhance(await imageOps.download(imageUrl)));
  } else {
    // There is deliberately no generative model here (see image-pipeline):
    // say so plainly rather than pretend.
    throw new AiGenerationError(
      'Image edits are limited to sharpening/framing, badges and text — changing the background, scene or the ' +
        'product itself isn\'t available. Upload your own photo for that.'
    );
  }

  // Normalised to eBay's shape before the seller sees it, so the preview is
  // exactly what would be listed.
  const squared = await imageOps.padToSquare(buffer);

  const proposalId = crypto.randomUUID();
  proposals.set(proposalId, { buffer: squared, expiresAt: Date.now() + PROPOSAL_TTL_MS });

  return {
    proposalId,
    operation: plan.operation,
    summary: plan.summary,
    policyWarning: plan.operation === 'text_overlay' ? TEXT_OVERLAY_WARNING : null,
    // Inline preview so nothing is stored anywhere durable until accepted —
    // the bytes themselves stay server-side under `proposalId`, so accepting
    // doesn't have to ship a 250KB image back up again.
    previewDataUrl: `data:image/jpeg;base64,${squared.toString('base64')}`,
  };
}

// Proposed images live in memory only between being generated and being
// accepted or abandoned. They're regenerable, so losing them to a restart
// costs a retry, not data — which is why this isn't a table.
const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const proposals = new Map();

function takeProposal(proposalId) {
  const proposal = proposals.get(proposalId);
  if (!proposal) return null;
  proposals.delete(proposalId);
  return proposal.expiresAt > Date.now() ? proposal : null;
}

// Cheap opportunistic sweep — proposals are few and short-lived, so this
// doesn't warrant a timer holding the process open.
function pruneProposals() {
  const now = Date.now();
  for (const [id, proposal] of proposals) {
    if (proposal.expiresAt <= now) proposals.delete(id);
  }
}

module.exports = { reviseText, reviseImage, overlayText, mapChangesForDraft, takeProposal, pruneProposals, TEXT_OVERLAY_WARNING };
