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
    capturedArgs = args;
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
    'imageScenePrompt',
    'imageScenePrompts',
    'title',
  ]);
  assert.ok(capturedArgs.tools[0].input_schema.required.includes('imageScenePrompt'));
  // Several distinct briefs, so a gallery can be built when the supplier's
  // own photos are mostly unusable marketing graphics.
  assert.ok(capturedArgs.tools[0].input_schema.required.includes('imageScenePrompts'));
  assert.ok(capturedArgs.messages[0].content.includes('Competitor widget'));
  assert.ok(capturedArgs.messages[0].content.includes('Source widget'));
  assert.strictEqual(result.title, 'A great widget');
  assert.strictEqual(result.imageScenePrompt, 'clean white studio background with soft shadow');
});

test('generateListingContent requests the variation tool schema when the source has variants', async () => {
  config.anthropicApiKey = 'test-key';
  delete require.cache[require.resolve('../../src/modules/ai-generation/text-generator.service')];
  const textGenerator = require('../../src/modules/ai-generation/text-generator.service');

  let capturedArgs;
  mock.method(messagesProto, 'create', async (args) => {
    capturedArgs = args;
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
    'imageScenePrompt',
    'imageScenePrompts',
    'sharedAspects',
    'variantAspectValues',
    'varyingAspectName',
  ]);
  assert.ok(capturedArgs.tools[0].input_schema.required.includes('imageScenePrompt'));
  // Several distinct briefs, so a gallery can be built when the supplier's
  // own photos are mostly unusable marketing graphics.
  assert.ok(capturedArgs.tools[0].input_schema.required.includes('imageScenePrompts'));
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
