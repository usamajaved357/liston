const crypto = require('crypto');
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
    throw new AiGenerationError("AI editing isn't configured on this server — set ANTHROPIC_API_KEY.");
  }
  return new Anthropic({ apiKey: config.anthropicApiKey });
}

const TEXT_TOOL = {
  name: 'submit_revision',
  description: "Submit the revised listing fields. Include ONLY fields the instruction actually asks to change.",
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 80 },
      description: { type: 'string' },
      aspects: {
        type: 'object',
        description: 'Item specifics as { aspectName: [value] } — only if the instruction concerns them.',
        additionalProperties: { type: 'array', items: { type: 'string' } },
      },
      summary: { type: 'string', description: 'One short sentence describing what you changed, for the seller.' },
    },
    required: ['summary'],
  },
};

/**
 * Proposes a text revision. Returns { changes, summary } — the caller decides
 * whether to persist it.
 */
async function reviseText({ draft, instruction }) {
  const anthropic = client();
  const isVariation = Array.isArray(draft.variants) && draft.variants.length > 0;
  const currentTitle = isVariation ? draft.commonTitle : draft.title;
  const currentDescription = isVariation ? draft.commonDescription : draft.description;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    tools: [TEXT_TOOL],
    tool_choice: { type: 'tool', name: TEXT_TOOL.name },
    messages: [
      {
        role: 'user',
        content:
          `An eBay seller wants to change their draft listing. Apply ONLY what they ask for and leave everything ` +
          `else exactly as it is — return just the fields the instruction touches.\n\n` +
          `Current title (max 80 characters): ${currentTitle}\n\n` +
          `Current description:\n${currentDescription}\n\n` +
          (Object.keys(draft.aspects || draft.variesBy?.aspects || {}).length
            ? `Current item specifics: ${JSON.stringify(draft.aspects || draft.variesBy?.aspects)}\n\n`
            : '') +
          `Their instruction: "${instruction}"`,
      },
    ],
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse?.input) {
    throw new AiGenerationError('The AI editor returned an unexpected response — try rewording your instruction.');
  }

  const { summary, ...changes } = toolUse.input;
  return { changes: mapChangesForDraft(changes, isVariation), summary };
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
    throw new AiGenerationError('The AI editor returned an unexpected response — try rewording your instruction.');
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
