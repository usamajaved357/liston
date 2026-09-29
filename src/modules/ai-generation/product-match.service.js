const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const config = require('../../config');
const { AiGenerationError } = require('./ai-generation.errors');
const aiUsage = require('./ai-usage');

// Whether AliExpress products are the same thing an eBay listing sells, from
// their photos: the listing's own photos beside one product's main photo, a
// Claude call for each product (several at once). Titles alone can't tell
// ("Christmas projector light" is a round spotlight and a tree-shaped USB lamp
// alike); the photos can. One call per product, describing both items before
// deciding: a single call judging a dozen products at once mixed them up. A
// product whose photo couldn't be read is never judged the same.

const MODEL = config.aiModel;
const SIDE = 384; // px: enough to see the product's shape, few tokens
const MAX_LISTING_PHOTOS = 3;
const CONCURRENCY = 6;

const TOOL = {
  name: 'record_match',
  description: 'Record whether the AliExpress product is the same product the eBay listing sells.',
  input_schema: {
    type: 'object',
    properties: {
      ebay_item: { type: 'string', description: 'The physical item the eBay photos show: its shape, form and design, in a few words' },
      aliexpress_item: { type: 'string', description: 'The physical item the AliExpress photo shows, the same way' },
      same: { type: 'boolean' },
      why: { type: 'string', description: "Under 15 words, in a seller's plain words: what differs, or what makes it the same" },
    },
    required: ['ebay_item', 'aliexpress_item', 'same', 'why'],
  },
};

function client() {
  if (!config.anthropicApiKey) throw new AiGenerationError("Comparing photos needs the AI, which isn't configured on this server (ANTHROPIC_API_KEY).");
  return new Anthropic({ apiKey: config.anthropicApiKey });
}

// A photo as Claude takes it, small; null when it isn't an image sharp can read.
async function asImage(bytes) {
  if (!bytes || !bytes.length) return null;
  try {
    const jpeg = await sharp(bytes).rotate().resize(SIDE, SIDE, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer();
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } };
  } catch {
    return null;
  }
}

const INSTRUCTIONS =
  'Is the AliExpress product the SAME product the eBay listing sells, so that a buyer who ordered it would receive the item ' +
  'shown in the eBay photos? First describe the physical item in each, then decide.\n' +
  '- Judge the physical item: its shape, design, construction, parts and what it does. Ignore backgrounds, props, models, ' +
  'text and badges on the photo, packaging, lighting, and what it projects or displays.\n' +
  '- The same design in another colour, print or size, or photographed from another angle, is the same product: colour alone never makes it different.\n' +
  '- A different design, shape, model or kind of item is NOT the same, even when it does the same job and the titles share ' +
  'words (a round spotlight projector is not a tree-shaped projector; a plain mug is not a mug with a lid).\n' +
  '- A product sold in several designs counts when this design is plainly one of them.\n' +
  '- The titles help; the photos decide. When you cannot tell, answer same: false.';

async function compareOne(anthropic, listingContent, candidate, image) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    temperature: 0,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [
      {
        role: 'user',
        content: [...listingContent, { type: 'text', text: `The AliExpress product: "${String(candidate.title || '').slice(0, 200)}". Its photo:` }, image, { type: 'text', text: INSTRUCTIONS }],
      },
    ],
  });
  aiUsage.record('hunting.match', response);
  const answer = response.content.find((b) => b.type === 'tool_use')?.input;
  if (!answer || typeof answer.same !== 'boolean') throw new AiGenerationError('the AI gave no answer on the photos');
  return { same: answer.same, why: String(answer.why || '').trim() || null };
}

/**
 * [{ same, why }] for each candidate, in their order. `listing`:
 * { title, photos: [Buffer] } (the first is its main photo); `candidates`:
 * [{ title, photo: Buffer | null }]. Throws when the listing has no photo
 * that can be read (nothing to compare with) or the AI answers for none.
 */
async function sameAsListing({ listing, candidates, anthropic = null }) {
  const listingImages = (await Promise.all((listing.photos || []).slice(0, MAX_LISTING_PHOTOS).map(asImage))).filter(Boolean);
  if (!listingImages.length) throw new AiGenerationError("the eBay listing's photo couldn't be read to compare with");
  const images = await Promise.all(candidates.map((c) => asImage(c.photo)));
  const listingContent = [{ type: 'text', text: `The eBay listing: "${String(listing.title || '').slice(0, 200)}". Its photos:` }, ...listingImages];
  const ai = anthropic || client();
  const out = candidates.map((c, i) => (images[i] ? null : { same: false, why: "Its photo couldn't be read to compare" }));
  const queue = candidates.map((c, i) => i).filter((i) => images[i]);
  const asked = queue.length;
  const failures = [];
  async function worker() {
    while (queue.length) {
      const i = queue.shift();
      try {
        out[i] = await compareOne(ai, listingContent, candidates[i], images[i]);
      } catch (err) {
        // One that couldn't be compared isn't the same; none compared at all is the AI being down.
        failures.push(err);
        out[i] = { same: false, why: "Couldn't be compared just now" };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  if (asked && failures.length === asked) throw new AiGenerationError(`the photos couldn't be compared (${failures[0].message})`);
  return out;
}

module.exports = { sameAsListing, asImage };
