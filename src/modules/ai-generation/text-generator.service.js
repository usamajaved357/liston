const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');
const { AiGenerationError } = require('./ai-generation.errors');
const { validateAspects, describeSchemaForPrompt } = require('./aspect-validator');

const MODEL = config.aiModel;

function client() {
  if (!config.anthropicApiKey) {
    throw new AiGenerationError("AI drafting isn't configured on this server. Set ANTHROPIC_API_KEY.");
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
    },
    required: ['title', 'description', 'condition', 'aspects'],
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
    },
    required: [
      'commonTitle',
      'commonDescription',
      'condition',
      'sharedAspects',
      'varyingAspectName',
      'variantAspectValues',
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
    `real attributes. Never copy the competitor's text verbatim.\n` +
    `The seller is a UK business dispatching from the UK. Never mention China, AliExpress, overseas shipping, ` +
    `import, or any supplier in the title, description or item specifics.\n\n` +
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
    (Object.keys(competitor.specifics || {}).length
      ? `\n\n--- Item specifics the competitor filled in ---\nThe competitor's listing carries these ${
          Object.keys(competitor.specifics).length
        } item specifics: ${Object.keys(competitor.specifics).join(', ')}. These are what buyers filter and ` +
        `search by in this category, so a listing missing them ranks below one that has them. Fill EVERY one of ` +
        `these for the source product, with the source product's own real value — never copy the competitor's ` +
        `value blindly, but do use theirs as the answer when the fact is about the product type rather than ` +
        `their specific item (e.g. Type, Compatible Brand, Material, Features). Then add any further specifics ` +
        `the source product's details support.`
      : '') +
    (schemaText
      ? `\n\n--- eBay's item specifics for this exact category ---\nFill these using the SOURCE product's real ` +
        `attributes. Use these names verbatim where they apply; extra specifics the competitor uses are welcome too. ` +
        `Fill every REQUIRED one you can genuinely determine from the source product; if a required ` +
        `value genuinely isn't knowable from the information given, leave it out rather than inventing it.\n` +
        `${schemaText}`
      : '')
  );
}

async function generateListingContent({ competitor, source, costPrice, sellPrice, currency, aspectSchema }) {
  const anthropic = client();
  const hasVariants = source.variants.length > 0;
  const tool = hasVariants ? VARIATION_TOOL : SINGLE_TOOL;

  const response = await anthropic.messages.create({
    model: MODEL,
    // A phone case's Compatible Model alone can be 27 values; 2048 tokens was
    // truncating the aspect list and silently dropping specifics.
    max_tokens: 4096,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [
      { role: 'user', content: buildPrompt({ competitor, source, costPrice, sellPrice, currency, aspectSchema }) },
    ],
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse || !toolUse.input) {
    throw new AiGenerationError('The AI drafting model returned an unexpected response. Try again.');
  }

  const content = toolUse.input;

  // Telling the model the schema isn't enough on its own — it can still
  // return an aspect eBay doesn't list, a free-text value for a fixed-list
  // aspect, or several values where eBay takes one. Correct that here rather
  // than letting eBay reject the publish after the user has approved it.
  const aspectKey = hasVariants ? 'sharedAspects' : 'aspects';
  const { aspects, warnings } = validateAspects(content[aspectKey], aspectSchema);

  // Parity check against the competitor: anything they filled that we
  // didn't is a filter buyers can use to find them and not us.
  const ours = new Set(Object.keys(aspects).map((name) => name.toLowerCase()));
  const variationAxes = new Set(
    hasVariants ? [content.varyingAspectName, ...Object.keys(source.variants[0]?.attributes || {})].map((n) => String(n).toLowerCase()) : []
  );
  const missing = Object.keys(competitor.specifics || {}).filter(
    (name) => !ours.has(name.toLowerCase()) && !variationAxes.has(name.toLowerCase())
  );
  if (missing.length) {
    const shown = missing.slice(0, 6).join(', ') + (missing.length > 6 ? ` and ${missing.length - 6} more` : '');
    warnings.push(
      `The competitor fills ${missing.length} item specific${missing.length === 1 ? '' : 's'} this draft doesn't ` +
        `(${shown}) — add any the product supports.`
    );
  }

  // The schema says maxLength 80 but the model doesn't always honour it (an
  // 89-character camera title came back and blocked Save). Trim at a word
  // boundary rather than mid-word.
  const titleKey = hasVariants ? 'commonTitle' : 'title';
  if (typeof content[titleKey] === 'string' && content[titleKey].length > 80) {
    const cut = content[titleKey].slice(0, 80);
    content[titleKey] = (cut.lastIndexOf(' ') > 60 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trim();
    warnings.push('The title was longer than eBay\'s 80-character limit and has been shortened. Check it still reads well.');
  }

  return { ...content, [aspectKey]: aspects, aspectWarnings: warnings };
}

module.exports = { generateListingContent };
