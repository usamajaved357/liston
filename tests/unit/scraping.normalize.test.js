const test = require('node:test');
const assert = require('node:assert');

const aliexpressScraper = require('../../src/modules/scraping/aliexpress-listing.scraper');
const { ScrapingError } = require('../../src/modules/scraping/scraping.errors');

// True end-to-end scraping (launching a real browser against a live
// AliExpress page) is NOT run here or in CI — it's inherently flaky (site
// layout drift, bot detection, network) and shouldn't gate builds. These
// tests cover only the pure normalization logic against fixture data; the
// scraper was verified manually against real live listings during
// implementation (see PROGRESS.md).
//
// eBay has no scraper any more — competitor listings come from the official
// Browse API instead; see tests/unit/ebay-listing.source.test.js.

test('aliexpress normalize throws ScrapingError when no title was found', () => {
  assert.throws(() => aliexpressScraper.normalize({ title: null }), ScrapingError);
});

test('aliexpress normalize builds the full matrix across EVERY variant group', () => {
  const result = aliexpressScraper.normalize({
    title: 'Cat Case',
    priceText: 'Rs.837',
    description: '',
    imageUrls: ['https://example.com/main.jpg'],
    specifics: { Material: 'Silicone' },
    variantGroups: [
      {
        name: 'Color',
        options: [
          { label: 'Black', imageUrl: 'https://example.com/black.jpg' },
          { label: 'Red', imageUrl: 'https://example.com/red.jpg' },
        ],
      },
      {
        name: 'Compatibility by Model',
        options: [{ label: 'Galaxy A12' }, { label: 'Galaxy A13' }],
      },
    ],
  });

  // A fitted case is sold per model AND per colour. Keeping only the first
  // axis produced a listing where the buyer couldn't say which phone they
  // had — confirmed on a real draft before this was fixed.
  assert.strictEqual(result.variants.length, 4);
  assert.deepStrictEqual(result.variants[0], {
    attributes: { Color: 'Black', 'Compatibility by Model': 'Galaxy A12' },
    imageUrl: 'https://example.com/black.jpg',
    priceText: null,
  });
  assert.deepStrictEqual(
    result.variants.map((v) => v.attributes['Compatibility by Model']),
    ['Galaxy A12', 'Galaxy A13', 'Galaxy A12', 'Galaxy A13']
  );

  // The colour photo carries across that colour's whole row of models.
  assert.strictEqual(result.variants[1].imageUrl, 'https://example.com/black.jpg');
  assert.strictEqual(result.variants[2].imageUrl, 'https://example.com/red.jpg');

  // A real variation axis is no longer buried in specifics as flat text.
  assert.strictEqual(result.specifics['Compatibility by Model'], undefined);
  assert.strictEqual(result.specifics.Material, 'Silicone');
});

test('aliexpress normalize reports each axis and which one carries photos', () => {
  const result = aliexpressScraper.normalize({
    title: 'Case',
    imageUrls: [],
    specifics: {},
    variantGroups: [
      { name: 'Color', options: [{ label: 'Black', imageUrl: 'https://example.com/b.jpg' }] },
      { name: 'Size', options: [{ label: 'S' }, { label: 'M' }] },
    ],
  });

  // Only an axis with its own photography should drive eBay's image switching.
  assert.deepStrictEqual(result.variantAxes.map((a) => [a.name, a.hasImages]), [
    ['Color', true],
    ['Size', false],
  ]);
});

test('aliexpress normalize returns the FULL matrix — the cap is applied only after the seller chooses', () => {
  const many = (n, prefix) => Array.from({ length: n }, (_, i) => ({ label: `${prefix}${i}` }));
  const full = aliexpressScraper.normalize({
    title: 'Case',
    imageUrls: [],
    specifics: {},
    variantGroups: [
      { name: 'Color', options: many(20, 'c') },
      { name: 'Model', options: many(30, 'm') },
    ],
  });
  // Capping here would hide options from the variation picker before they
  // could be chosen — a real product lost two colours that way.
  assert.strictEqual(full.variants.length, 600);
});

test('capVariants trims a runaway matrix to whole rows of the first axis', () => {
  const many = (n, prefix) => Array.from({ length: n }, (_, i) => ({ label: `${prefix}${i}` }));
  const result = aliexpressScraper.capVariants(aliexpressScraper.normalize({
    title: 'Case',
    imageUrls: [],
    specifics: {},
    variantGroups: [
      { name: 'Color', options: many(20, 'c') },
      { name: 'Model', options: many(30, 'm') },
    ],
  }));

  // 600 combinations would be hundreds of eBay API calls and well past what
  // one listing should carry — and the trim lands on a whole number of
  // colours, so no colour is left offering only some of the models.
  assert.ok(result.variants.length <= aliexpressScraper.MAX_VARIANTS);
  assert.strictEqual(result.variants.length % 30, 0, 'must keep whole rows of the trailing axis');

  const perColour = new Map();
  for (const variant of result.variants) {
    const colour = variant.attributes.Color;
    perColour.set(colour, (perColour.get(colour) || 0) + 1);
  }
  // Every colour that made the cut carries the full model range.
  assert.ok([...perColour.values()].every((count) => count === 30));
});

test('aliexpress normalize returns an empty variants array for a product with no variant options', () => {
  const result = aliexpressScraper.normalize({
    title: 'Plain Widget',
    imageUrls: [],
    variantGroups: [],
  });
  assert.deepStrictEqual(result.variants, []);
});
