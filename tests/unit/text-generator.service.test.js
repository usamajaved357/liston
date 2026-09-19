const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../src/config');
const { AiGenerationError } = require('../../src/modules/ai-generation/ai-generation.errors');

// The Anthropic SDK's `messages` client is an instance property, not a
// static export — mock its shared prototype so it applies to any client
// text-generator.service.js constructs internally.
const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'test-key' }).messages);

test.afterEach(() => {
  mock.restoreAll();
});

function toolResultResponse(input) {
  return { content: [{ type: 'tool_use', name: 'submit_listing_draft', input }] };
}

test('generateListingContent throws when ANTHROPIC_API_KEY is not configured', async () => {
  const originalKey = config.anthropicApiKey;
  config.anthropicApiKey = null;
  try {
    // Re-require to get a fresh module isn't necessary — client() reads config.anthropicApiKey live.
    delete require.cache[require.resolve('../../src/modules/ai-generation/text-generator.service')];
    const textGenerator = require('../../src/modules/ai-generation/text-generator.service');
    await assert.rejects(
      () =>
        textGenerator.generateListingContent({
          competitor: { title: 'x', variants: [] },
          source: { title: 'y', variants: [] },
          costPrice: 1,
          sellPrice: 2,
          currency: 'GBP',
        }),
      AiGenerationError
    );
  } finally {
    config.anthropicApiKey = originalKey;
  }
});

test('generateListingContent requests the single-item tool schema when the source has no variants', async () => {
  config.anthropicApiKey = 'test-key';
  delete require.cache[require.resolve('../../src/modules/ai-generation/text-generator.service')];
  const textGenerator = require('../../src/modules/ai-generation/text-generator.service');

  let capturedArgs;
  mock.method(messagesProto, 'create', async (args) => {
    if (!capturedArgs) capturedArgs = args;
    return toolResultResponse({
      title: 'A great widget',
      description: 'desc',
      condition: 'NEW',
      aspects: { Colour: ['Black'] },
      imageScenePrompt: 'clean white studio background with soft shadow',
    });
  });

  const result = await textGenerator.generateListingContent({
    competitor: { title: 'Competitor widget', variants: [], specifics: {}, categoryBreadcrumb: [] },
    source: { title: 'Source widget', variants: [], specifics: {}, categoryBreadcrumb: [] },
    costPrice: 5,
    sellPrice: 15,
    currency: 'GBP',
  });

  assert.strictEqual(capturedArgs.tools[0].name, 'submit_listing_draft');
  assert.deepStrictEqual(Object.keys(capturedArgs.tools[0].input_schema.properties).sort(), [
    'aspects',
    'condition',
    'description',
    'title',
  ]);
  assert.ok(capturedArgs.messages[0].content.includes('Competitor widget'));
  assert.ok(capturedArgs.messages[0].content.includes('Source widget'));
  assert.strictEqual(result.title, 'A great widget');
});

test('generateListingContent requests the variation tool schema when the source has variants', async () => {
  config.anthropicApiKey = 'test-key';
  delete require.cache[require.resolve('../../src/modules/ai-generation/text-generator.service')];
  const textGenerator = require('../../src/modules/ai-generation/text-generator.service');

  let capturedArgs;
  mock.method(messagesProto, 'create', async (args) => {
    if (!capturedArgs) capturedArgs = args;
    return toolResultResponse({
      commonTitle: 'A great widget',
      commonDescription: 'desc',
      condition: 'NEW',
      sharedAspects: { Material: ['Silicone'] },
      varyingAspectName: 'Colour',
      variantAspectValues: { Black: 'Black', Red: 'Red' },
      imageScenePrompt: 'clean white studio background with soft shadow',
    });
  });

  const result = await textGenerator.generateListingContent({
    competitor: { title: 'Competitor widget', variants: [], specifics: {}, categoryBreadcrumb: [] },
    source: {
      title: 'Source widget',
      specifics: {},
      categoryBreadcrumb: [],
      variants: [{ attributes: { Colour: 'Black' } }, { attributes: { Colour: 'Red' } }],
    },
    costPrice: 5,
    sellPrice: 15,
    currency: 'GBP',
  });

  assert.deepStrictEqual(Object.keys(capturedArgs.tools[0].input_schema.properties).sort(), [
    'commonDescription',
    'commonTitle',
    'condition',
    'sharedAspects',
    'variantAspectValues',
    'varyingAspectName',
  ]);
  assert.strictEqual(result.varyingAspectName, 'Colour');
});

test('generateListingContent throws AiGenerationError when the model returns no tool_use block', async () => {
  config.anthropicApiKey = 'test-key';
  delete require.cache[require.resolve('../../src/modules/ai-generation/text-generator.service')];
  const textGenerator = require('../../src/modules/ai-generation/text-generator.service');

  mock.method(messagesProto, 'create', async () => ({ content: [{ type: 'text', text: 'sorry, I cannot help' }] }));

  await assert.rejects(
    () =>
      textGenerator.generateListingContent({
        competitor: { title: 'x', variants: [], specifics: {}, categoryBreadcrumb: [] },
        source: { title: 'y', variants: [], specifics: {}, categoryBreadcrumb: [] },
        costPrice: 1,
        sellPrice: 2,
        currency: 'GBP',
      }),
    AiGenerationError
  );
});

test('generateListingContent shortens a title the model made longer than 80 characters', async () => {
  config.anthropicApiKey = 'test-key';
  const textGenerator = require('../../src/modules/ai-generation/text-generator.service');
  const longTitle = 'WiFi 1080P HD Security Camera Indoor Window Mount 2.4/5GHz Night Vision Remote Monitoring';
  mock.method(messagesProto, 'create', async () => ({
    content: [{ type: 'tool_use', input: { title: longTitle, description: 'd', condition: 'NEW', aspects: {} } }],
  }));
  const result = await textGenerator.generateListingContent({
    competitor: { title: 'C', specifics: {}, categoryBreadcrumb: [], variants: [] },
    source: { title: 'S', specifics: {}, imageUrls: [], variants: [] },
    currency: 'GBP',
  });
  assert.ok(result.title.length <= 80, result.title);
  assert.ok(!result.title.endsWith(' '));
  assert.match(result.aspectWarnings.join(' '), /80-character limit/);
});

test('generateListingContent lengthens a title the model left under 70 characters', async () => {
  config.anthropicApiKey = 'test-key';
  delete require.cache[require.resolve('../../src/modules/ai-generation/text-generator.service')];
  const textGenerator = require('../../src/modules/ai-generation/text-generator.service');

  const calls = [];
  mock.method(messagesProto, 'create', async (args) => {
    calls.push(args);
    if (args.tools[0].name === 'submit_title') {
      return { content: [{ type: 'tool_use', name: 'submit_title', input: { title: 'Coin Dispenser Holder Organiser with Spring 8 Slots for Cashiers Drivers Waiters' } }] };
    }
    return toolResultResponse({ title: 'Coin Dispenser Holder', description: 'desc', condition: 'NEW', aspects: {} });
  });

  const result = await textGenerator.generateListingContent({
    competitor: null,
    source: { title: 'Coin dispenser', variants: [], specifics: {}, categoryBreadcrumb: [] },
    costPrice: 5,
    sellPrice: 15,
    currency: 'GBP',
  });

  assert.strictEqual(calls.length, 2);
  assert.ok(result.title.length >= 70 && result.title.length <= 80, result.title);
});

test('generateListingContent drafts without a competitor and mentions the category instead', async () => {
  config.anthropicApiKey = 'test-key';
  delete require.cache[require.resolve('../../src/modules/ai-generation/text-generator.service')];
  const textGenerator = require('../../src/modules/ai-generation/text-generator.service');

  let prompt;
  mock.method(messagesProto, 'create', async (args) => {
    if (!prompt) prompt = args.messages[0].content;
    return toolResultResponse({ title: 'x'.repeat(72), description: 'desc', condition: 'NEW', aspects: {} });
  });

  const result = await textGenerator.generateListingContent({
    competitor: null,
    source: { title: 'Source widget', variants: [], specifics: {}, categoryBreadcrumb: [] },
    costPrice: 5,
    sellPrice: 15,
    currency: 'GBP',
    categoryPath: ['Home, Furniture & DIY', 'Bath', 'Soap Dishes & Dispensers'],
  });

  assert.ok(!prompt.includes("Competitor's eBay listing"));
  assert.ok(prompt.includes('Soap Dishes & Dispensers'));
  assert.strictEqual(result.aspectWarnings.length, 0);
});

test('refitContentForCategory drops the variation axes from the shared specifics', async () => {
  config.anthropicApiKey = 'test-key';
  delete require.cache[require.resolve('../../src/modules/ai-generation/text-generator.service')];
  const textGenerator = require('../../src/modules/ai-generation/text-generator.service');

  mock.method(messagesProto, 'create', async () => ({
    content: [
      {
        type: 'tool_use',
        name: 'submit_refit',
        input: { title: 'y'.repeat(75), description: 'new desc', aspects: { Type: ['Cup Holder'], Colour: ['Black'] } },
      },
    ],
  }));

  const result = await textGenerator.refitContentForCategory({
    draft: { commonTitle: 'old', commonDescription: 'old desc', variesBy: { aspects: { Type: ['Coin Holder'] } }, variants: [{}] },
    source: null,
    categoryPath: ['Vehicle Parts & Accessories', 'Cup Holders'],
    aspectSchema: null,
    variationAxes: ['Colour'],
  });

  assert.deepStrictEqual(result.aspects, { Type: ['Cup Holder'] });
  assert.strictEqual(result.title.length, 75);
});

test('generateListingContent tells the model to name variations the way the competitor does', async () => {
  config.anthropicApiKey = 'test-key';
  delete require.cache[require.resolve('../../src/modules/ai-generation/text-generator.service')];
  const textGenerator = require('../../src/modules/ai-generation/text-generator.service');

  let prompt;
  mock.method(messagesProto, 'create', async (args) => {
    if (!prompt) prompt = args.messages[0].content;
    return toolResultResponse({
      commonTitle: 'x'.repeat(72),
      commonDescription: 'd',
      condition: 'NEW',
      sharedAspects: {},
      varyingAspectName: 'Colour',
      variantAspectValues: { blk: 'Midnight Black' },
    });
  });

  await textGenerator.generateListingContent({
    competitor: {
      title: 'Comp',
      specifics: {},
      categoryBreadcrumb: [],
      variants: [{ attributes: { Colour: 'Midnight Black' } }, { attributes: { Colour: 'Arctic White' } }],
    },
    source: { title: 'Src', specifics: {}, categoryBreadcrumb: [], variants: [{ attributes: { Color: 'blk' } }, { attributes: { Color: 'wht' } }] },
    costPrice: 1,
    sellPrice: 2,
    currency: 'GBP',
    aspectSchema: [{ name: 'Colour', required: false, selectionOnly: false, multiValue: false, variation: true, allowedValues: [], hasMoreValues: false }],
  });

  assert.match(prompt, /competitor's listing offers "Colour" \(Midnight Black, Arctic White\)/);
  assert.match(prompt, /MUST be one of eBay's variation-enabled aspects for this category: Colour/);
});

test('generateListingContent tells the model to write around eBay’s hazardous-materials words, and flags any that slip through', async () => {
  config.anthropicApiKey = 'test-key';
  delete require.cache[require.resolve('../../src/modules/ai-generation/text-generator.service')];
  const textGenerator = require('../../src/modules/ai-generation/text-generator.service');

  let prompt;
  mock.method(messagesProto, 'create', async (args) => {
    if (!prompt) prompt = args.messages[0].content;
    return toolResultResponse({ title: 'x'.repeat(72), description: 'Pairs with lead clips and a petrol lighter.', condition: 'NEW', aspects: {} });
  });

  const result = await textGenerator.generateListingContent({
    competitor: null,
    source: { title: 'Rig', variants: [], specifics: {}, categoryBreadcrumb: [] },
    costPrice: 5,
    sellPrice: 15,
    currency: 'GBP',
    categoryPath: ['Sporting Goods', 'Fishing'],
  });

  assert.match(prompt, /hazardous-materials filter/);
  assert.match(prompt, /lead → weight/);
  const warning = result.aspectWarnings.find((w) => /hazardous-materials/.test(w));
  assert.match(warning, /"lead" in the description/);
  assert.match(warning, /"petrol" in the description/);
  assert.match(warning, /"lighter" in the description/);
});
