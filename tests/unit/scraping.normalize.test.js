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

test('aliexpress normalize treats only the first variant group as the purchasable variation axis', () => {
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

  assert.strictEqual(result.variants.length, 2);
  assert.deepStrictEqual(result.variants[0], {
    attributes: { Color: 'Black' },
    imageUrl: 'https://example.com/black.jpg',
    priceText: null,
  });
  // The second group gets folded into specifics as informational text, not a second variation axis.
  assert.strictEqual(result.specifics['Compatibility by Model'], 'Galaxy A12, Galaxy A13');
  assert.strictEqual(result.specifics.Material, 'Silicone');
});

test('aliexpress normalize returns an empty variants array for a product with no variant options', () => {
  const result = aliexpressScraper.normalize({
    title: 'Plain Widget',
    imageUrls: [],
    variantGroups: [],
  });
  assert.deepStrictEqual(result.variants, []);
});
