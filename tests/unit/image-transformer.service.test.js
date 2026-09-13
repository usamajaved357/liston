const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const config = require('../../src/config');

function freshModule() {
  delete require.cache[require.resolve('../../src/modules/ai-generation/image-transformer.service')];
  return require('../../src/modules/ai-generation/image-transformer.service');
}

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

test.afterEach(() => {
  mock.restoreAll();
});

test('transformImages returns the raw URL unchanged when no keys are configured', async () => {
  const originalBria = config.briaApiKey;
  const originalPhotoroom = config.photoroomApiKey;
  config.briaApiKey = null;
  config.photoroomApiKey = null;
  const imageTransformer = freshModule();

  const result = await imageTransformer.transformImages(['https://example.com/a.jpg'], 'a nice scene');

  assert.deepStrictEqual(result, ['https://example.com/a.jpg']);
  config.briaApiKey = originalBria;
  config.photoroomApiKey = originalPhotoroom;
});

test('transformImages uses the Bria scene composite result when it succeeds', async () => {
  config.briaApiKey = 'bria-key';
  config.photoroomApiKey = null;
  const imageTransformer = freshModule();

  mock.method(global, 'fetch', async (url, options) => {
    assert.ok(url.includes('/v1/product/lifestyle_shot_by_text'));
    const body = JSON.parse(options.body);
    assert.strictEqual(body.scene_description, 'a nice scene');
    assert.strictEqual(body.sync, true);
    // Real response shape, confirmed with a live API call this session.
    return jsonResponse({ result: [['https://bria.example.com/composite.jpg', 123456, 'file.PNG']] });
  });

  const result = await imageTransformer.transformImages(['https://example.com/a.jpg'], 'a nice scene');
  assert.deepStrictEqual(result, ['https://bria.example.com/composite.jpg']);

  config.briaApiKey = null;
});

test('transformImages falls back to Bria plain background removal when the composite call fails', async () => {
  config.briaApiKey = 'bria-key';
  config.photoroomApiKey = null;
  const imageTransformer = freshModule();

  mock.method(global, 'fetch', async (url) => {
    if (url.includes('/v1/product/lifestyle_shot_by_text')) return jsonResponse({}, false);
    if (url.includes('/v2/image/edit/remove_background')) return jsonResponse({ result: { image_url: 'https://bria.example.com/cutout.jpg' } });
    throw new Error('unexpected url');
  });

  const result = await imageTransformer.transformImages(['https://example.com/a.jpg'], 'a nice scene');
  assert.deepStrictEqual(result, ['https://bria.example.com/cutout.jpg']);

  config.briaApiKey = null;
});

test('transformImages falls back to Photoroom when both Bria calls fail', async () => {
  config.briaApiKey = 'bria-key';
  config.photoroomApiKey = 'photoroom-key';
  const imageTransformer = freshModule();

  mock.method(global, 'fetch', async (url) => {
    if (url.includes('bria-api.com')) return jsonResponse({}, false);
    if (url.includes('photoroom.com')) return jsonResponse({ result_b64: 'abc123' });
    throw new Error('unexpected url');
  });

  const result = await imageTransformer.transformImages(['https://example.com/a.jpg'], 'a nice scene');
  assert.deepStrictEqual(result, ['data:image/png;base64,abc123']);

  config.briaApiKey = null;
  config.photoroomApiKey = null;
});

test('transformImages accepts the array-of-arrays shape lifestyle_shot_by_text actually returns (verified live)', async () => {
  config.briaApiKey = 'bria-key';
  config.photoroomApiKey = null;
  const imageTransformer = freshModule();

  mock.method(global, 'fetch', async () =>
    jsonResponse({ result: [['https://bria.example.com/composite.png', 884492, 'abc.PNG']] })
  );

  const result = await imageTransformer.transformImages(['https://example.com/a.jpg'], 'a nice scene');
  assert.deepStrictEqual(result, ['https://bria.example.com/composite.png']);

  config.briaApiKey = null;
});

test('transformImages accepts a result nested under result.image_url (verified live for remove_background)', async () => {
  config.briaApiKey = 'bria-key';
  config.photoroomApiKey = null;
  const imageTransformer = freshModule();

  mock.method(global, 'fetch', async () => jsonResponse({ result: { image_url: 'https://bria.example.com/nested.jpg' } }));

  const result = await imageTransformer.transformImages(['https://example.com/a.jpg'], 'a nice scene');
  assert.deepStrictEqual(result, ['https://bria.example.com/nested.jpg']);

  config.briaApiKey = null;
});

test('transformImages falls back to the raw URL when every provider fails', async () => {
  config.briaApiKey = 'bria-key';
  config.photoroomApiKey = 'photoroom-key';
  const imageTransformer = freshModule();

  mock.method(global, 'fetch', async () => jsonResponse({}, false));

  const result = await imageTransformer.transformImages(['https://example.com/a.jpg'], 'a nice scene');
  assert.deepStrictEqual(result, ['https://example.com/a.jpg']);

  config.briaApiKey = null;
  config.photoroomApiKey = null;
});
