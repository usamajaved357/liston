const test = require('node:test');
const assert = require('node:assert');

const ebayScraper = require('../../src/modules/scraping/ebay-listing.scraper');
const aliexpressScraper = require('../../src/modules/scraping/aliexpress-listing.scraper');
const { ScrapingError } = require('../../src/modules/scraping/scraping.errors');

// True end-to-end scraping (launching a real browser against live eBay/
// AliExpress pages) is NOT run here or in CI — it's inherently flaky (site
// layout drift, bot detection, network) and shouldn't gate builds. These
// tests cover only the pure normalization logic against fixture data; the
// scrapers were verified manually against real live listings during
// implementation (see PROGRESS.md).

test('ebay normalize throws ScrapingError when no title was found', () => {
  assert.throws(() => ebayScraper.normalize({ title: null }), (err) => err instanceof ScrapingError && err.source === 'ebay');
});

test('ebay normalize builds the shared shape from raw extracted fields', () => {
  const result = ebayScraper.normalize({
    title: '  Great Widget  ',
    priceText: '£4.49 each',
    description: '  A great widget  ',
    imageUrls: ['https://example.com/a.jpg'],
    specifics: { Colour: 'Black' },
    categoryBreadcrumb: ['Electronics', 'Widgets'],
    categoryId: '20349',
  });

  assert.strictEqual(result.title, 'Great Widget');
  assert.strictEqual(result.description, 'A great widget');
  assert.deepStrictEqual(result.imageUrls, ['https://example.com/a.jpg']);
  assert.strictEqual(result.priceText, '£4.49 each');
  assert.deepStrictEqual(result.specifics, { Colour: 'Black' });
  assert.deepStrictEqual(result.categoryBreadcrumb, ['Electronics', 'Widgets']);
  assert.strictEqual(result.categoryId, '20349');
  assert.deepStrictEqual(result.variants, []);
});

test('ebay normalize defaults categoryId to null when not scraped', () => {
  const result = ebayScraper.normalize({ title: 'Widget' });
  assert.strictEqual(result.categoryId, null);
});

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
