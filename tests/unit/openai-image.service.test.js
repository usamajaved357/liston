const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const sharp = require('sharp');

const config = require('../../src/config');
const openaiImage = require('../../src/modules/ai-generation/image-generation/openai-image.service');

const ALL_ON = { addUkFlag: true, addFreeShippingLabel: true, addGlowBorder: true, showPerson: true, quality: 'high' };
const ALL_OFF = { addUkFlag: false, addFreeShippingLabel: false, addGlowBorder: false, showPerson: false, quality: 'high' };

test.afterEach(() => {
  mock.restoreAll();
});

test('buildPrompt carries the product-accuracy rules that make a reference-based shot trustworthy', () => {
  const prompt = openaiImage.buildPrompt({ settings: ALL_ON });
  assert.match(prompt, /provided product image as the exact product reference/);
  assert.match(prompt, /Do not redesign, modify, recolour, replace, or distort/);
  assert.match(prompt, /pure clean white background/);
});

test('buildPrompt strips supplier identifiers from the reference', () => {
  // The seller's rule: nothing AliExpress-related may survive onto the listing.
  const prompt = openaiImage.buildPrompt({ settings: ALL_ON });
  assert.match(prompt, /no watermarks, store names, logos, price tags or overlaid text/);
});

test('buildPrompt includes the requested overlays only when they are switched on', () => {
  const on = openaiImage.buildPrompt({ settings: ALL_ON });
  assert.match(on, /UK flag/);
  assert.match(on, /FREE SHIPPING/);
  assert.match(on, /illuminated border/);

  const off = openaiImage.buildPrompt({ settings: ALL_OFF });
  assert.doesNotMatch(off, /UK flag/);
  assert.doesNotMatch(off, /FREE SHIPPING/);
  assert.doesNotMatch(off, /illuminated border/);
  assert.doesNotMatch(off, /Additional Elements/);
});

test('buildPrompt asks for a person only when showPerson is on', () => {
  assert.match(openaiImage.buildPrompt({ settings: ALL_ON }), /realistic adult person naturally holding/);
  assert.doesNotMatch(openaiImage.buildPrompt({ settings: ALL_OFF }), /adult person/);
});

test('buildPrompt varies the shot by gallery slot', () => {
  const angle = openaiImage.buildPrompt({ variant: 'angle', settings: ALL_ON });
  const detail = openaiImage.buildPrompt({ variant: 'detail', settings: ALL_ON });
  assert.match(angle, /three-quarter or side/);
  assert.match(detail, /texture, finish and build quality/);
  assert.notStrictEqual(angle, detail);
});

test('buildPrompt appends a seller instruction without displacing the accuracy rules', () => {
  const prompt = openaiImage.buildPrompt({ settings: ALL_ON, extraInstruction: 'show it from the back' });
  assert.match(prompt, /Specific request from the seller for this image: show it from the back/);
  assert.match(prompt, /Do not redesign/);
});

test('activeOverlays names exactly what is on, for the draft warning', () => {
  assert.deepStrictEqual(openaiImage.activeOverlays(ALL_ON), ['UK flag', 'FREE SHIPPING label', 'glow border']);
  assert.deepStrictEqual(openaiImage.activeOverlays(ALL_OFF), []);
});

test('generateProductShot refuses to run without a key or a reference', async () => {
  const previous = config.openaiApiKey;
  config.openaiApiKey = null;
  try {
    await assert.rejects(
      () => openaiImage.generateProductShot({ referenceImages: [Buffer.alloc(1)] }),
      /OPENAI_API_KEY/
    );
  } finally {
    config.openaiApiKey = previous;
  }
});

test('generateProductShot sends the reference as a multipart edit and decodes the base64 result', async () => {
  const previous = config.openaiApiKey;
  config.openaiApiKey = 'test-key';
  const reference = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).png().toBuffer();
  const generated = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toBuffer();

  let captured;
  mock.method(global, 'fetch', async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: generated.toString('base64') }] }) };
  });

  try {
    const result = await openaiImage.generateProductShot({ referenceImages: [reference], variant: 'hero', settings: ALL_ON });

    assert.strictEqual(captured.url, 'https://api.openai.com/v1/images/edits');
    assert.strictEqual(captured.options.headers.Authorization, 'Bearer test-key');
    assert.ok(captured.options.body instanceof FormData);
    assert.strictEqual(captured.options.body.get('model'), 'gpt-image-1');
    assert.strictEqual(captured.options.body.get('size'), '1024x1024');
    assert.ok(captured.options.body.get('prompt').includes('exact product reference'));
    assert.ok(captured.options.body.getAll('image[]').length === 1);
    assert.ok(Buffer.isBuffer(result));
    assert.strictEqual(result.length, generated.length);
  } finally {
    config.openaiApiKey = previous;
  }
});

test("generateProductShot surfaces OpenAI's own error message", async () => {
  const previous = config.openaiApiKey;
  config.openaiApiKey = 'test-key';
  mock.method(global, 'fetch', async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: 'Your organization must be verified to use the model' } }),
  }));
  try {
    await assert.rejects(
      () => openaiImage.generateProductShot({ referenceImages: [Buffer.alloc(10)], settings: ALL_ON }),
      /organization must be verified/
    );
  } finally {
    config.openaiApiKey = previous;
  }
});
