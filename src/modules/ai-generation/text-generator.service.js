const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');
const { AiGenerationError } = require('./ai-generation.errors');
const { validateAspects, describeSchemaForPrompt } = require('./aspect-validator');

const MODEL = 'claude-sonnet-4-5';

function client() {
  if (!config.anthropicApiKey) {
    throw new AiGenerationError("AI drafting isn't configured on this server — set ANTHROPIC_API_KEY.");
  }
  return new Anthropic({ apiKey: config.anthropicApiKey });
}

function summarizeListing(listing) {
  return [
    `Title: ${listing.title}`,
    listing.categoryBreadcrumb?.length ? `Category: ${listing.categoryBreadcrumb.join(' > ')}` : null,
    listing.priceText ? `Price shown: ${listing.priceText}` : null,
    listing.description ? `Description: ${listing.description.slice(0, 1500)}` : null,
    Object.keys(listing.specifics || {}).length
      ? `Specifics: ${Object.entries(listing.specifics)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

const SINGLE_TOOL = {
  name: 'submit_listing_draft',
  description: 'Submit the drafted eBay listing content.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 80 },
      description: { type: 'string' },
      condition: { type: 'string', enum: ['NEW', 'USED_EXCELLENT', 'USED_GOOD', 'USED_ACCEPTABLE'] },
      aspects: {
        type: 'object',
        description: 'Item specifics as { aspectName: [value] }',
        additionalProperties: { type: 'array', items: { type: 'string' } },
      },
      imageScenePrompt: {
        type: 'string',
        description:
          'A short, concrete description of an appealing product-photography background/scene for this item ' +
          '(e.g. "clean white studio background with soft shadow" or "minimalist marble surface with soft ' +
          'natural light") — chosen to suit the product category and make it look professionally photographed. ' +
          'This one is the MAIN gallery shot.',
      },
      imageScenePrompts: {
        type: 'array',
        items: { type: 'string' },
        minItems: 3,
        maxItems: 5,
        description:
          'Three to five DISTINCT photography briefs for this product, in gallery order, starting with the main ' +
          'shot. Supplier galleries are mostly unusable marketing graphics, so these are used to build a full ' +
          'gallery from whatever clean photography exists. Vary the setting meaningfully — a clean studio hero, ' +
          'the product in realistic use in a fitting environment, a close detail on texture or finish, a styled ' +
          'surface — and make each specific to THIS product category rather than generic. Never describe text, ' +
          'labels, badges, watermarks or collages: eBay prohibits those on listing images.',
      },
    },
    required: ['title', 'description', 'condition', 'aspects', 'imageScenePrompt', 'imageScenePrompts'],
  },
};

const VARIATION_TOOL = {
  name: 'submit_listing_draft',
  description: 'Submit the drafted multi-variation eBay listing content.',
  input_schema: {
    type: 'object',
    properties: {
      commonTitle: { type: 'string', maxLength: 80 },
      commonDescription: { type: 'string' },
      condition: { type: 'string', enum: ['NEW', 'USED_EXCELLENT', 'USED_GOOD', 'USED_ACCEPTABLE'] },
      sharedAspects: {
        type: 'object',
        description: 'Item specifics common to every variant, as { aspectName: [value] }',
        additionalProperties: { type: 'array', items: { type: 'string' } },
      },
      varyingAspectName: { type: 'string', description: 'The eBay aspect name for the variation axis, e.g. "Colour"' },
      variantAspectValues: {
        type: 'object',
        description:
          'Maps each scraped variant option label (verbatim) to a clean eBay aspect value for that variant.',
        additionalProperties: { type: 'string' },
      },
      imageScenePrompt: {
        type: 'string',
        description:
          'A short, concrete description of an appealing product-photography background/scene for this item ' +
          '(e.g. "clean white studio background with soft shadow" or "minimalist marble surface with soft ' +
          'natural light") — chosen to suit the product category and make it look professionally photographed. ' +
          'This one is the MAIN gallery shot.',
      },
      imageScenePrompts: {
        type: 'array',
        items: { type: 'string' },
        minItems: 3,
        maxItems: 5,
        description:
          'Three to five DISTINCT photography briefs for this product, in gallery order, starting with the main ' +
          'shot. Supplier galleries are mostly unusable marketing graphics, so these are used to build a full ' +
          'gallery from whatever clean photography exists. Vary the setting meaningfully — a clean studio hero, ' +
          'the product in realistic use in a fitting environment, a close detail on texture or finish, a styled ' +
          'surface — and make each specific to THIS product category rather than generic. Never describe text, ' +
          'labels, badges, watermarks or collages: eBay prohibits those on listing images.',
      },
    },
    required: [
      'commonTitle',
      'commonDescription',
      'condition',
      'sharedAspects',
      'varyingAspectName',
      'variantAspectValues',
      'imageScenePrompt',
      'imageScenePrompts',
    ],
  },
};

function buildPrompt({ competitor, source, costPrice, sellPrice, currency, aspectSchema }) {
  const hasVariants = source.variants.length > 0;
  const schemaText = describeSchemaForPrompt(aspectSchema);
  return (
    `You are drafting a new eBay listing for a seller. Compare a competitor's live eBay listing against the ` +
    `seller's own source product (from a supplier), and draft an ORIGINAL, improved listing for the source ` +
    `product — better organized and clearer than the competitor's, adapted to fit the source product's own ` +
    `real attributes. Never copy the competitor's text verbatim.\n\n` +
    `The seller pays ${currency} ${costPrice} per unit and will sell at ${currency} ${sellPrice}.\n\n` +
    `--- Competitor's eBay listing ---\n${summarizeListing(competitor)}\n\n` +
    `--- Source product (what will actually be sold) ---\n${summarizeListing(source)}\n\n` +
    (hasVariants
      ? `The source product has these variant options for "${
          Object.keys(source.variants[0]?.attributes || {})[0] || 'Option'
        }": ${source.variants.map((v) => Object.values(v.attributes)[0]).join(', ')}. ` +
        `Draft ONE common title/description/shared aspects for the whole listing, choose which scraped ` +
        `attribute is the real variation axis, and provide a clean eBay aspect value for every listed option.\n` +
        `CRITICAL: every option must map to a DIFFERENT value — eBay rejects a variation listing where two ` +
        `variants share the same value. If the options combine two things (e.g. "2PCS Warm White" is a pack ` +
        `size AND a colour), keep enough of both in the value to stay distinct, and name the axis accordingly.`
      : `Draft a single listing (title, description, condition, item specifics).`) +
    (schemaText
      ? `\n\n--- eBay's item specifics for this exact category ---\nFill these using the SOURCE product's real ` +
        `attributes. Use these names verbatim, and only these — an item specific eBay doesn't list here will be ` +
        `discarded. Fill every REQUIRED one you can genuinely determine from the source product; if a required ` +
        `value genuinely isn't knowable from the information given, leave it out rather than inventing it.\n` +
        `${schemaText}`
      : '') +
    `\n\nAlso write photography briefs (imageScenePrompt) for the product photo background — a specific, ` +
    `concrete scene appropriate to this exact product category (not a generic phrase), aimed at making the ` +
    `product photo look more professional and appealing than the competitor's.`
  );
}

async function generateListingContent({ competitor, source, costPrice, sellPrice, currency, aspectSchema }) {
  const anthropic = client();
  const hasVariants = source.variants.length > 0;
  const tool = hasVariants ? VARIATION_TOOL : SINGLE_TOOL;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [
      { role: 'user', content: buildPrompt({ competitor, source, costPrice, sellPrice, currency, aspectSchema }) },
    ],
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse || !toolUse.input) {
    throw new AiGenerationError('The AI drafting model returned an unexpected response — try again.');
  }

  const content = toolUse.input;

  // Telling the model the schema isn't enough on its own — it can still
  // return an aspect eBay doesn't list, a free-text value for a fixed-list
  // aspect, or several values where eBay takes one. Correct that here rather
  // than letting eBay reject the publish after the user has approved it.
  const aspectKey = hasVariants ? 'sharedAspects' : 'aspects';
  const { aspects, warnings } = validateAspects(content[aspectKey], aspectSchema);

  return { ...content, [aspectKey]: aspects, aspectWarnings: warnings };
}

module.exports = { generateListingContent };
