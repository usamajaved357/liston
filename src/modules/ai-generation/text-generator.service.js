const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');
const { AiGenerationError } = require('./ai-generation.errors');
const aiUsage = require('./ai-usage');
const { validateAspects, describeSchemaForPrompt, prepareAspectsForEbay } = require('./aspect-validator');

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
      title: { type: 'string', maxLength: 80, description: 'Between 70 and 80 characters. Use the full space.' },
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
      commonTitle: { type: 'string', maxLength: 80, description: 'Between 70 and 80 characters. Use the full space.' },
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

// eBay's title limit is 80 characters and search rewards using it: a short
// title leaves keywords buyers type on the table.
const policyWords = require('../listings/policy-words');
const descriptionFormat = require('./description-format');

const TITLE_RULE =
  `TITLE RULE: the title MUST be between 70 and 80 characters long (count them). Pack it with the words buyers ` +
  `search for: product type, key feature, use, compatibility, size or pack count, colour if fixed. No filler ` +
  `words, no ALL CAPS, no emoji, no "wow"/"L@@K", no seller name.\n`;

// How the variation axis and its options should be named. With a
// competitor that has variations, buyers already know that seller's
// wording ("Colour: Midnight Black", "Size: UK 8"), so the axis takes the
// competitor's name and each option is named the way they name the same
// thing. Without one, eBay's own aspect names for the category (the ones it
// allows variations on) are the vocabulary.
function variationNamingGuidance({ competitor, aspectSchema }) {
  const lines = [];
  const competitorAxes = {};
  for (const variant of competitor?.variants || []) {
    for (const [axis, value] of Object.entries(variant.attributes || {})) {
      competitorAxes[axis] = competitorAxes[axis] || new Set();
      competitorAxes[axis].add(value);
    }
  }
  const axisNames = Object.keys(competitorAxes);
  if (axisNames.length) {
    lines.push(
      `NAMING THE VARIATIONS: the competitor's listing offers ${axisNames
        .map((axis) => `"${axis}" (${[...competitorAxes[axis]].slice(0, 30).join(', ')})`)
        .join(' and ')}. Use the competitor's axis name as varyingAspectName when it describes the same kind of ` +
        `choice, and name each option the way the competitor names its equivalent (same wording, casing and ` +
        `units). Options the competitor doesn't have get names in the same style.`
    );
  }
  const variationAspects = (aspectSchema || []).filter((a) => a.variation).map((a) => a.name);
  if (variationAspects.length) {
    lines.push(
      `varyingAspectName MUST be one of eBay's variation-enabled aspects for this category: ${variationAspects
        .slice(0, 20)
        .join(', ')}. Pick the one that matches the option (Colour for colours, Size for sizes, Model for device models).`
    );
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function buildPrompt({ competitor, source, costPrice, sellPrice, currency, aspectSchema, categoryPath }) {
  const hasVariants = source.variants.length > 0;
  const schemaText = describeSchemaForPrompt(aspectSchema);
  return (
    (competitor
      ? `You are drafting a new eBay listing for a seller. Compare a competitor's live eBay listing against the ` +
        `seller's own source product (from a supplier), and draft an ORIGINAL, improved listing for the source ` +
        `product — better organized and clearer than the competitor's, adapted to fit the source product's own ` +
        `real attributes. Never copy the competitor's text verbatim.\n`
      : `You are drafting a new eBay listing for a seller from their supplier's product page alone. Draft an ` +
        `ORIGINAL, well organised listing that reads like an established UK retailer wrote it.\n`) +
    `The seller is a UK business dispatching from the UK. Never mention China, AliExpress, overseas shipping, ` +
    `import, or any supplier in the title, description or item specifics.\n` +
    TITLE_RULE +
    policyWords.PROMPT_GUIDANCE +
    descriptionFormat.PROMPT_GUIDANCE +
    `\nThe seller pays ${currency} ${costPrice} per unit and will sell at ${currency} ${sellPrice}.\n\n` +
    (competitor ? `--- Competitor's eBay listing ---\n${summarizeListing(competitor)}\n\n` : '') +
    (categoryPath?.length ? `--- eBay category this will be listed in ---\n${categoryPath.join(' > ')}\n\n` : '') +
    `--- Source product (what will actually be sold) ---\n${summarizeListing(source)}\n\n` +
    (hasVariants
      ? `The source product has these variant options for "${
          Object.keys(source.variants[0]?.attributes || {})[0] || 'Option'
        }": ${[...new Set(source.variants.map((v) => Object.values(v.attributes)[0]))].join(', ')}. ` +
        `Draft ONE common title/description/shared aspects for the whole listing, choose which scraped ` +
        `attribute is the real variation axis, and provide a clean eBay aspect value for every listed option.\n` +
        variationNamingGuidance({ competitor, aspectSchema }) +
        `CRITICAL: every option must map to a DIFFERENT value — eBay rejects a variation listing where two ` +
        `variants share the same value. If the options combine two things (e.g. "2PCS Warm White" is a pack ` +
        `size AND a colour), keep enough of both in the value to stay distinct, and name the axis accordingly.`
      : `Draft a single listing (title, description, condition, item specifics).`) +
    (Object.keys(competitor?.specifics || {}).length
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

// The model often stops short of the 70-character floor even when told.
// One small follow-up call, given only the title and the product facts,
// brings a short title up to length; a title that's already long enough
// costs nothing extra.
const TITLE_MIN = 70;
const TITLE_MAX = 80;
const LENGTHEN_TOOL = {
  name: 'submit_title',
  description: 'Submit the lengthened eBay title.',
  input_schema: {
    type: 'object',
    properties: { title: { type: 'string', maxLength: 80 } },
    required: ['title'],
  },
};

function trimTitle(title) {
  if (typeof title !== 'string' || title.length <= TITLE_MAX) return title;
  const cut = title.slice(0, TITLE_MAX);
  return (cut.lastIndexOf(' ') > 60 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trim();
}

async function ensureTitleLength(anthropic, title, facts) {
  if (typeof title !== 'string' || title.length >= TITLE_MIN) return trimTitle(title);
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 256,
      tools: [LENGTHEN_TOOL],
      tool_choice: { type: 'tool', name: LENGTHEN_TOOL.name },
      messages: [
        {
          role: 'user',
          content:
            `This eBay title is ${title.length} characters; eBay allows ${TITLE_MAX} and search rewards using them. ` +
            `Rewrite it to between ${TITLE_MIN} and ${TITLE_MAX} characters by adding the words buyers search for ` +
            `(use, compatibility, key feature, material, pack size), keeping every existing fact. No filler, no ` +
            `punctuation tricks, no ALL CAPS, never mention China or any supplier.\n\nTitle: ${title}\n\n` +
            (facts ? `Product facts:\n${facts}\n` : ''),
        },
      ],
    });
    aiUsage.record('draft.title', response);
    const toolUse = response.content.find((block) => block.type === 'tool_use');
    const longer = toolUse?.input?.title;
    return typeof longer === 'string' && longer.length > title.length ? trimTitle(longer) : title;
  } catch {
    return title;
  }
}

async function generateListingContent({ competitor, source, costPrice, sellPrice, currency, aspectSchema, categoryPath }) {
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
      { role: 'user', content: buildPrompt({ competitor, source, costPrice, sellPrice, currency, aspectSchema, categoryPath }) },
    ],
  });
  aiUsage.record('draft.write', response);

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
  const validated = validateAspects(content[aspectKey], aspectSchema);
  const warnings = validated.warnings;
  // Shared specifics never repeat a variation attribute, and a required
  // identifier the product doesn't have carries eBay's "Does Not Apply" —
  // both are publish rejections otherwise.
  const axisNames = hasVariants ? [content.varyingAspectName, ...Object.keys(source.variants[0]?.attributes || {})].filter(Boolean) : [];
  const { aspects, missing: unfilled } = prepareAspectsForEbay(validated.aspects, aspectSchema, axisNames);
  if (unfilled.length) {
    warnings.push(`eBay requires ${unfilled.join(', ')} in this category and the draft has no value yet — fill ${unfilled.length === 1 ? 'it' : 'them'} in item specifics before publishing.`);
  }

  // Parity check against the competitor: anything they filled that we
  // didn't is a filter buyers can use to find them and not us.
  const ours = new Set(Object.keys(aspects).map((name) => name.toLowerCase()));
  const variationAxes = new Set(
    hasVariants ? [content.varyingAspectName, ...Object.keys(source.variants[0]?.attributes || {})].map((n) => String(n).toLowerCase()) : []
  );
  const missing = Object.keys(competitor?.specifics || {}).filter(
    (name) => !ours.has(name.toLowerCase()) && !variationAxes.has(name.toLowerCase())
  );
  if (missing.length) {
    const shown = missing.slice(0, 6).join(', ') + (missing.length > 6 ? ` and ${missing.length - 6} more` : '');
    warnings.push(
      `The competitor fills ${missing.length} item specific${missing.length === 1 ? '' : 's'} this draft doesn't ` +
        `(${shown}) — add any the product supports.`
    );
  }

  // The list sections take the editor's default bullets even when the model
  // leaves them off, and any dash it used as punctuation is rewritten.
  const descKey = hasVariants ? 'commonDescription' : 'description';
  // Lines the model wrote to the seller ("confirm the contents before
  // publishing") are taken out of the buyer's text.
  content[descKey] = descriptionFormat.dropSellerNotes(descriptionFormat.cleanDashes(descriptionFormat.applyDefaultBullets(content[descKey])));

  // The schema says maxLength 80 but the model doesn't always honour it (an
  // 89-character camera title came back and blocked Save). Trim at a word
  // boundary rather than mid-word.
  const titleKey = hasVariants ? 'commonTitle' : 'title';
  if (typeof content[titleKey] === 'string' && content[titleKey].length > TITLE_MAX) {
    content[titleKey] = trimTitle(content[titleKey]);
    warnings.push('The title was longer than eBay\'s 80-character limit and has been shortened. Check it still reads well.');
  }
  content[titleKey] = await ensureTitleLength(anthropic, content[titleKey], summarizeListing(source));

  // Whatever the model was told, a trigger word that slips through (or
  // sits in a supplier's option name, which isn't the model's to change)
  // is named now, not by eBay at publish.
  const triggers = policyWords.hazmatTriggersIn(
    hasVariants
      ? { commonTitle: content.commonTitle, commonDescription: content.commonDescription, variants: [{}], variesBy: { aspects, specifications: [{ name: content.varyingAspectName || 'Option', values: Object.values(content.variantAspectValues || {}) }] } }
      : { title: content.title, description: content.description, aspects }
  );
  if (triggers.length) {
    warnings.push(
      `eBay's hazardous-materials filter blocks listings containing certain words, and this draft has ${triggers.join('; ')}. Reword before publishing.`
    );
  }

  return { ...content, [aspectKey]: aspects, aspectWarnings: warnings };
}

const REFIT_TOOL = {
  name: 'submit_refit',
  description: 'Submit the listing content refitted to the new eBay category.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 80, description: 'Between 70 and 80 characters. Use the full space.' },
      aspects: {
        type: 'object',
        description: 'The complete set of item specifics for the new category, as { aspectName: [value] }',
        additionalProperties: { type: 'array', items: { type: 'string' } },
      },
    },
    required: ['title', 'aspects'],
  },
};

// A listing moved to a different category needs its specifics re-expressed
// in that category's vocabulary (a bag's "Exterior Colour" is a phone case's
// "Colour"), and often a title angle to match. The description stays as the
// seller has it: rewriting it here was most of this call's cost (output
// tokens), for wording the category rarely changes. The product facts
// come from the draft as it stands plus the original supplier data; nothing
// is invented to fill a required aspect.
async function refitContentForCategory({ draft, source, categoryPath, aspectSchema, variationAxes = [] }) {
  const anthropic = client();
  const isVariation = Array.isArray(draft.variants) && draft.variants.length > 0;
  const title = isVariation ? draft.commonTitle : draft.title;
  const description = isVariation ? draft.commonDescription : draft.description;
  const aspects = isVariation ? draft.variesBy?.aspects : draft.aspects;
  const schemaText = describeSchemaForPrompt(aspectSchema);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [REFIT_TOOL],
    tool_choice: { type: 'tool', name: REFIT_TOOL.name },
    messages: [
      {
        role: 'user',
        content:
          `An eBay seller has moved their draft listing to a different category. Rewrite the title and item ` +
          `specifics so they fit the NEW category, keeping every product fact the same. The description stays as ` +
          `it is; it is shown only for facts.\n` +
          `The seller is a UK business dispatching from the UK. Never mention China, AliExpress, overseas shipping, ` +
          `import, or any supplier.\n` +
          TITLE_RULE +
          policyWords.PROMPT_GUIDANCE +
          (variationAxes.length
            ? `This is a multi-variation listing: buyers choose ${variationAxes.join(' and ')}. The title and shared ` +
              `specifics must NOT name any one option (no single colour, size or model); the ${variationAxes.join('/')} ` +
              `specifics are carried per variation and must be left out of your aspects.\n`
            : '') +
          `\nNew category: ${categoryPath.join(' > ')}\n\n` +
          `Current title: ${title}\n\nCurrent description:\n${description}\n\n` +
          `Current item specifics: ${JSON.stringify(aspects || {})}\n\n` +
          (source ? `--- Supplier's product data, for facts ---\n${summarizeListing(source)}\n\n` : '') +
          (schemaText
            ? `--- eBay's item specifics for the NEW category ---\nUse these names verbatim. Fill every REQUIRED one you ` +
              `can genuinely determine; carry over any current specific that still applies (renamed to the new ` +
              `category's name for it where one exists); drop specifics that make no sense in this category. If a ` +
              `required value isn't knowable, leave it out rather than inventing it.\n${schemaText}`
            : ''),
      },
    ],
  });
  aiUsage.record('draft.refit', response);

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse?.input) {
    throw new AiGenerationError('The AI drafting model returned an unexpected response. Try again.');
  }
  const content = toolUse.input;
  const checked = validateAspects(content.aspects, aspectSchema);
  const { warnings } = checked;
  // The varying specifics live on each variation, never on the listing; a
  // required identifier with no value gets eBay's "Does Not Apply".
  const { aspects: validated, missing } = prepareAspectsForEbay(checked.aspects, aspectSchema, variationAxes);
  if (missing.length) {
    warnings.push(`eBay requires ${missing.join(', ')} in this category and the draft has no value yet — fill ${missing.length === 1 ? 'it' : 'them'} in item specifics before publishing.`);
  }
  const finalTitle = await ensureTitleLength(anthropic, trimTitle(content.title), source ? summarizeListing(source) : null);
  return { title: finalTitle, description, aspects: validated, warnings };
}

module.exports = { generateListingContent, refitContentForCategory };
