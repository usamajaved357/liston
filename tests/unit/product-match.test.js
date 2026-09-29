const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');

const productMatch = require('../../src/modules/ai-generation/product-match.service');

// Claude itself isn't called here: a stand-in client answers, and the tests check what it's asked and how
// its answers are read. (The comparison was checked live against real eBay and AliExpress photos.)
const photo = (color, width = 600, height = 600) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
function fakeClient(answer) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        const input = await answer(req, calls.length);
        return { content: input ? [{ type: 'tool_use', name: 'record_match', input }] : [{ type: 'text', text: '?' }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  };
}
const titleOf = (req) => req.messages[0].content.find((b) => b.type === 'text' && b.text.startsWith('The AliExpress product')).text;

test('each AliExpress product is compared on its own with the listing\'s photos, small JPEGs, and read back in order', async () => {
  const ai = fakeClient((req) => (/Tree/.test(titleOf(req)) ? { ebay_item: 'tree', aliexpress_item: 'tree', same: true, why: 'Same tree-shaped projector' } : { ebay_item: 'tree', aliexpress_item: 'round spotlight', same: false, why: 'Round spotlight, not tree-shaped' }));
  const out = await productMatch.sameAsListing({
    listing: { title: 'Christmas Projector Light Tree', photos: [await photo('#0a0', 2000, 1500), await photo('#080'), await photo('#060'), await photo('#040')] },
    candidates: [
      { title: 'Christmas Projector Light 16Pattern Spotlight', photo: await photo('#000') },
      { title: 'Christmas Tree USB Projector', photo: await photo('#0a0') },
    ],
    anthropic: ai,
  });
  assert.deepStrictEqual(out, [
    { same: false, why: 'Round spotlight, not tree-shaped' },
    { same: true, why: 'Same tree-shaped projector' },
  ]);
  assert.strictEqual(ai.calls.length, 2, 'one call per product');
  const req = ai.calls[0];
  assert.deepStrictEqual([req.temperature, req.tool_choice.name], [0, 'record_match']);
  const images = req.messages[0].content.filter((b) => b.type === 'image');
  assert.strictEqual(images.length, 4, "the listing's first three photos, then the product's");
  for (const img of images) {
    assert.strictEqual(img.source.media_type, 'image/jpeg');
    const { width, height } = await sharp(Buffer.from(img.source.data, 'base64')).metadata();
    assert.ok(width <= 384 && height <= 384, `${width}x${height}`);
  }
});

test('a product whose photo can\'t be read is never the same, and is not sent', async () => {
  const ai = fakeClient(() => ({ ebay_item: 'a', aliexpress_item: 'a', same: true, why: 'Same' }));
  const out = await productMatch.sameAsListing({
    listing: { title: 'Mug', photos: [await photo('#fff')] },
    candidates: [{ title: 'No photo', photo: null }, { title: 'Not an image', photo: Buffer.from('nope') }, { title: 'Mug', photo: await photo('#eee') }],
    anthropic: ai,
  });
  assert.deepStrictEqual(out.map((o) => o.same), [false, false, true]);
  assert.strictEqual(out[0].why, "Its photo couldn't be read to compare");
  assert.strictEqual(ai.calls.length, 1);
});

test("without a readable listing photo, or when the AI answers for none, it throws: nothing is picked unseen; one that fails alone isn't the same", async () => {
  const ai = fakeClient(() => ({ ebay_item: 'a', aliexpress_item: 'a', same: true, why: 'Same' }));
  await assert.rejects(productMatch.sameAsListing({ listing: { title: 'Mug', photos: [null] }, candidates: [{ title: 'Mug', photo: await photo('#eee') }], anthropic: ai }), /eBay listing's photo couldn't be read/);
  assert.strictEqual(ai.calls.length, 0);

  const silent = fakeClient(() => null);
  await assert.rejects(productMatch.sameAsListing({ listing: { title: 'Mug', photos: [await photo('#fff')] }, candidates: [{ title: 'Mug', photo: await photo('#eee') }], anthropic: silent }), /photos couldn't be compared/);

  const flaky = fakeClient((req, n) => (n === 1 ? null : { ebay_item: 'a', aliexpress_item: 'a', same: true, why: 'Same' }));
  const out = await productMatch.sameAsListing({
    listing: { title: 'Mug', photos: [await photo('#fff')] },
    candidates: [{ title: 'Mug 1', photo: await photo('#eee') }, { title: 'Mug 2', photo: await photo('#ddd') }],
    anthropic: flaky,
  });
  assert.deepStrictEqual(out.map((o) => o.same).sort(), [false, true]);
  assert.ok(out.some((o) => o.why === "Couldn't be compared just now"));
});
