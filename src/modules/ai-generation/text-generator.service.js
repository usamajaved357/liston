const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');
const { AiGenerationError } = require('./ai-generation.errors');

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
          'natural light") — chosen to suit the product category and make it look professionally photographed.',
      },
    },
    required: ['title', 'description', 'condition', 'aspects', 'imageScenePrompt'],
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
          'natural light") — chosen to suit the product category and make it look professionally photographed.',
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
    ],
  },
};

function buildPrompt({ competitor, source, costPrice, sellPrice, currency }) {
  const hasVariants = source.variants.length > 0;
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
        `attribute is the real variation axis, and provide a clean eBay aspect value for every listed option.`
      : `Draft a single listing (title, description, condition, item specifics).`) +
    `\n\nAlso write a photography brief (imageScenePrompt) for the product photo background — a specific, ` +
    `concrete scene appropriate to this exact product category (not a generic phrase), aimed at making the ` +
    `product photo look more professional and appealing than the competitor's.`
  );
}

async function generateListingContent({ competitor, source, costPrice, sellPrice, currency }) {
  const anthropic = client();
  const hasVariants = source.variants.length > 0;
  const tool = hasVariants ? VARIATION_TOOL : SINGLE_TOOL;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: buildPrompt({ competitor, source, costPrice, sellPrice, currency }) }],
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse || !toolUse.input) {
    throw new AiGenerationError('The AI drafting model returned an unexpected response — try again.');
  }

  return toolUse.input;
}

module.exports = { generateListingContent };
