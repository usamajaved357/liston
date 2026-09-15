const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const sharp = require('sharp');
require('dotenv').config();

const revision = require('../../src/modules/listings/listing-revision.service');

function makeImage(width = 800, height = 800) {
  return sharp({ create: { width, height, channels: 3, background: '#3355ff' } }).jpeg().toBuffer();
}

test.afterEach(() => {
  mock.restoreAll();
});

// Text is composited deterministically rather than generated: a model renders
// text unreliably (misspelt, warped, misplaced) where an SVG overlay is
// exact and reproducible.
test('overlayText composites onto the image without changing its dimensions', async () => {
  const original = await makeImage(1000, 1000);
  const result = await revision.overlayText(original, { text: 'BUY 2 GET 1 FREE', position: 'bottom' });
  const meta = await sharp(result).metadata();

  assert.strictEqual(meta.width, 1000);
  assert.strictEqual(meta.height, 1000);
  assert.notStrictEqual(result.length, original.length, 'the image should actually change');
});

test('overlayText places the band at the top when asked', async () => {
  const original = await makeImage(600, 600);
  const top = await revision.overlayText(original, { text: 'SALE', position: 'top' });
  const bottom = await revision.overlayText(original, { text: 'SALE', position: 'bottom' });

  // Sampling the very first row: a top band darkens it, a bottom band doesn't.
  const topFirstRow = (await sharp(top).raw().toBuffer())[0];
  const bottomFirstRow = (await sharp(bottom).raw().toBuffer())[0];
  assert.notStrictEqual(topFirstRow, bottomFirstRow);
});

test('overlayText escapes characters that would break the SVG', async () => {
  // A title containing & or < would otherwise produce invalid SVG and throw.
  const original = await makeImage(600, 600);
  await assert.doesNotReject(() => revision.overlayText(original, { text: 'Cases & Covers <Best>' }));
});

test('the text-overlay warning names eBay’s actual rule', () => {
  // The seller asked for this feature explicitly, so it exists — but never
  // silently, because eBay demotes listings whose images carry text.
  assert.match(revision.TEXT_OVERLAY_WARNING, /doesn't allow text/i);
  assert.match(revision.TEXT_OVERLAY_WARNING, /visibility/i);
});

test('takeProposal is one-shot, so accepting twice cannot re-upload an image', () => {
  assert.strictEqual(revision.takeProposal('does-not-exist'), null);
});

test('mapChangesForDraft rewrites title onto commonTitle for a variation draft', () => {
  // A variation listing keeps its text under commonTitle/commonDescription;
  // without this the revision would apply to a key nothing renders.
  const mapped = revision.mapChangesForDraft({ title: 'Short', description: 'New desc' }, true);

  assert.deepStrictEqual(mapped, { commonTitle: 'Short', commonDescription: 'New desc' });
});

test('mapChangesForDraft leaves a single-SKU draft alone', () => {
  const mapped = revision.mapChangesForDraft({ title: 'Short', aspects: { Brand: ['X'] } }, false);
  assert.deepStrictEqual(mapped, { title: 'Short', aspects: { Brand: ['X'] } });
});

test('mapChangesForDraft passes through fields it does not rename', () => {
  const mapped = revision.mapChangesForDraft({ aspects: { Colour: ['Black'] } }, true);
  assert.deepStrictEqual(mapped, { aspects: { Colour: ['Black'] } });
});

// Scene and background edits in the editor use the same generator as
// drafting, so an edited photo matches the gallery it sits in.
test('reviseImage sends scene edits to the OpenAI generator', async () => {
  const openaiImage = require('../../src/modules/ai-generation/image-generation/openai-image.service');
  const imageOps = require('../../src/modules/ai-generation/image-pipeline/image.ops');
  const Anthropic = require('@anthropic-ai/sdk');

  const source = await makeImage(900, 900);
  const generated = await makeImage(1024, 1024);

  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'test-key' }).messages);
  mock.method(messagesProto, 'create', async () => ({
    content: [{ type: 'tool_use', input: { operation: 'scene', scenePrompt: 'on a wooden desk', summary: 'Placed on a desk' } }],
  }));
  mock.method(imageOps, 'prepare', async () => ({ buffer: source, sourceUrl: 'https://example.test/a.jpg' }));
  mock.method(openaiImage, 'isConfigured', () => true);
  const generate = mock.method(openaiImage, 'generateProductShot', async () => generated);

  const result = await revision.reviseImage({ imageUrl: 'https://example.test/a.jpg', instruction: 'put it on a wooden desk' });

  assert.strictEqual(generate.mock.callCount(), 1);
  assert.strictEqual(generate.mock.calls[0].arguments[0].extraInstruction, 'on a wooden desk');
  assert.strictEqual(result.operation, 'scene');
  assert.ok(result.previewDataUrl.startsWith('data:image/jpeg;base64,'));
});
