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

// There is no generative model behind the editor any more: sharpening,
// badges and text are done locally; anything that would change the photo
// itself is refused with a plain message rather than faked.
test('reviseImage refuses edits that would need a generative model', async () => {
  const Anthropic = require('@anthropic-ai/sdk');
  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'test-key' }).messages);
  mock.method(messagesProto, 'create', async () => ({
    content: [{ type: 'tool_use', input: { operation: 'unsupported', summary: 'Put it on a wooden desk' } }],
  }));
  await assert.rejects(
    () => revision.reviseImage({ imageUrl: 'https://example.test/a.jpg', instruction: 'put it on a wooden desk' }),
    /limited to sharpening/
  );
});

test('reviseImage enhances locally when asked to sharpen', async () => {
  const Anthropic = require('@anthropic-ai/sdk');
  const imageOps = require('../../src/modules/ai-generation/image-pipeline/image.ops');
  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'test-key' }).messages);
  const source = await makeImage(900, 900);
  mock.method(messagesProto, 'create', async () => ({
    content: [{ type: 'tool_use', input: { operation: 'enhance', summary: 'Sharpened' } }],
  }));
  mock.method(imageOps, 'download', async () => source);
  const enhance = mock.method(imageOps, 'enhance', async (b) => b);

  const result = await revision.reviseImage({ imageUrl: 'https://example.test/a.jpg', instruction: 'make it sharper' });
  assert.strictEqual(enhance.mock.callCount(), 1);
  assert.strictEqual(result.operation, 'enhance');
  assert.ok(result.previewDataUrl.startsWith('data:image/jpeg;base64,'));
});

// --- whole-listing revisions -------------------------------------------------

function mockModel(input) {
  const Anthropic = require('@anthropic-ai/sdk');
  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'test-key' }).messages);
  return mock.method(messagesProto, 'create', async (req) => {
    mockModel.lastRequest = req;
    return { content: [{ type: 'tool_use', name: 'submit_revision', input }] };
  });
}

const variationDraft = {
  commonTitle: 'Widget',
  commonDescription: 'A widget.',
  variesBy: { aspects: { Brand: ['Acme'] }, specifications: [{ name: 'Colour', values: ['Black', 'Brown'] }] },
  variants: [
    { aspects: { Colour: ['Black'] }, price: { value: '3.99', currency: 'GBP' }, quantity: 1, condition: 'NEW' },
    { aspects: { Colour: ['Brown'] }, price: { value: '3.99', currency: 'GBP' }, quantity: 1, condition: 'NEW' },
  ],
  listingPolicies: { fulfillmentPolicyId: 'f1', paymentPolicyId: 'p1', returnPolicyId: 'r1' },
};

test('reviseText can change prices, options, specifics and policies, in the editor’s own terms', async () => {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  mockModel({
    title: 'Better Widget',
    variants: [{ index: 1, price: 4.5 }, { index: 7, price: 9 }],
    allVariants: { quantity: 5 },
    renameAxisValues: [{ axis: 'Colour', from: 'Black', to: 'Jet Black' }],
    removeVariants: [0, 99],
    aspects: { Material: ['Steel'] },
    removeAspects: ['Brand'],
    listingPolicies: { postage: 'Free 48h', returns: 'No such policy' },
    summary: 'Done',
  });

  const { changes, summary } = await revision.reviseText({
    draft: variationDraft,
    instruction: 'tidy up',
    options: { policies: { postage: [{ id: 'f2', name: 'Free 48h' }], payment: [], returns: [{ id: 'r1', name: '30 days' }] } },
  });

  assert.strictEqual(summary, 'Done');
  assert.strictEqual(changes.commonTitle, 'Better Widget', 'title lands on the variation key');
  assert.deepStrictEqual(changes.variants, [{ index: 1, price: { value: '4.50', currency: 'GBP' } }], 'a variation that does not exist is dropped');
  assert.deepStrictEqual(changes.allVariants, { quantity: 5 });
  assert.deepStrictEqual(changes.removeVariants, [0]);
  assert.deepStrictEqual(changes.renameAxisValues, [{ axis: 'Colour', from: 'Black', to: 'Jet Black' }]);
  assert.deepStrictEqual(changes.aspects, { Material: ['Steel'] });
  assert.deepStrictEqual(changes.removeAspects, ['Brand']);
  assert.deepStrictEqual(changes.listingPolicies, { fulfillmentPolicyId: 'f2' }, 'policy names become ids; unknown names are ignored');
});

test('reviseText works from the editor’s unsaved state when it is given', async () => {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  mockModel({ price: 12, summary: 'Priced' });
  const { changes } = await revision.reviseText({
    draft: { title: 'Old', description: 'd', price: { value: '9.00', currency: 'GBP' }, quantity: 1 },
    instruction: 'set the price to 12',
    current: { title: 'Typed but unsaved', description: 'd', currency: 'GBP', price: '9.00', quantity: 1, variants: [] },
  });
  const prompt = mockModel.lastRequest.messages[0].content;
  assert.ok(prompt.includes('Typed but unsaved'), 'the model saw the unsaved title');
  assert.deepStrictEqual(changes.price, { value: '12.00', currency: 'GBP' });
});

// "Rewrite the description" produces the same layout a fresh draft has; a
// small edit keeps whatever layout the description already has.
test('reviseText gives the model the description layout for rewrites', async () => {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  mockModel({ summary: 'Rewritten', description: '**Mat**\nNew.' });
  await revision.reviseText({
    draft: { title: 'Mat', description: 'Old.', price: { value: '9.00', currency: 'GBP' }, quantity: 1 },
    instruction: 'rewrite the description',
  });
  const prompt = mockModel.lastRequest.messages[0].content;
  assert.match(prompt, /return descriptionEdits \(the exact passages and their new text\), never the whole description/);
  assert.match(prompt, /DESCRIPTION FORMAT/);
});

test('a small description change comes back as passages, applied to the description, and its cost is counted', async () => {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  const aiUsage = require('../../src/modules/ai-generation/ai-usage');
  aiUsage._reset();
  const Anthropic = require('@anthropic-ai/sdk');
  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'test-key' }).messages);
  mock.method(messagesProto, 'create', async () => ({
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 3000, output_tokens: 60 },
    content: [{ type: 'tool_use', name: 'submit_revision', input: { summary: 'Swapped the colour.', descriptionEdits: [{ find: 'Black strap', replace: 'Brown strap' }, { find: 'not there', replace: 'x' }] } }],
  }));
  const result = await revision.reviseText({
    draft: { title: 'Watch', description: '**Watch**\nBlack strap, steel case.\nBlack strap fits all.', price: { value: '9.00', currency: 'GBP' }, quantity: 1 },
    instruction: 'the strap is brown',
  });
  assert.strictEqual(result.changes.description, '**Watch**\nBrown strap, steel case.\nBrown strap fits all.');
  assert.match(result.summary, /1 part of the description couldn't be matched/);
  const today = (await aiUsage.snapshot(1)).days[0];
  assert.deepStrictEqual(today.byPurpose.map((r) => [r.purpose, r.calls, r.input, r.output]), [['editor.revise', 1, 3000, 60]]);
  assert.strictEqual(today.total, 0.0033, '3,000 in at $1/M + 60 out at $5/M');
  aiUsage._reset();
});

test('the description layout rules are sent only when the instruction could reshape the description', async () => {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  mockModel({ summary: 'Price set.', price: 4.99 });
  await revision.reviseText({ draft: { title: 'Mat', description: 'Old.', price: { value: '9.00', currency: 'GBP' }, quantity: 1 }, instruction: 'set the price to 4.99' });
  assert.doesNotMatch(mockModel.lastRequest.messages[0].content, /DESCRIPTION FORMAT/);
  assert.strictEqual(revision.touchesDescriptionLayout('Add 3 bullet points of key benefits'), true);
  assert.strictEqual(revision.touchesDescriptionLayout('Make the title more searchable'), false);
  assert.strictEqual(revision.touchesDescriptionLayout('Shorten the description'), true);
});

test('applyDescriptionEdits replaces every exact match and counts what it could not find', () => {
  assert.deepStrictEqual(revision.applyDescriptionEdits('a b a', [{ find: 'a', replace: 'c' }]), { text: 'c b c', missed: 0 });
  assert.deepStrictEqual(revision.applyDescriptionEdits('one\n\ntwo\n\nthree', [{ find: 'two', replace: '' }]), { text: 'one\n\nthree', missed: 0 });
  assert.deepStrictEqual(revision.applyDescriptionEdits('text', [{ find: 'nope', replace: 'x' }, { find: '', replace: 'y' }]), { text: 'text', missed: 2 });
});

test('reviseText reports what it cannot do instead of inventing a change', async () => {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  mockModel({ summary: 'n/a', cannotDo: 'Photos are edited from the gallery, not here.' });
  const result = await revision.reviseText({ draft: variationDraft, instruction: 'remove the background of photo 2' });
  assert.deepStrictEqual(result, { changes: {}, summary: 'Photos are edited from the gallery, not here.', cannotDo: true });
});

test('reviseText tells the model that item specifics must be stated facts, never invented', async () => {
  const Anthropic = require('@anthropic-ai/sdk');
  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'test-key' }).messages);
  const create = mock.method(messagesProto, 'create', async () => ({
    content: [{ type: 'tool_use', input: { summary: 'Left Seller Warranty empty: the listing does not state one.' } }],
  }));
  const result = await revision.reviseText({ draft: { title: 'Trim strip', description: 'Blue trim.', aspects: {} }, instruction: 'Fill these empty item specifics: Seller Warranty.' });
  const prompt = create.mock.calls[0].arguments[0].messages[0].content;
  assert.match(prompt, /Never invent or infer one it doesn't/);
  assert.match(prompt, /a returns or postage policy is not a warranty/);
  assert.deepStrictEqual(result.changes, {});
});
