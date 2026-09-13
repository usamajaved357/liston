const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const ebayScraper = require('../../src/modules/scraping/ebay-listing.scraper');
const aliexpressScraper = require('../../src/modules/scraping/aliexpress-listing.scraper');
const textGenerator = require('../../src/modules/ai-generation/text-generator.service');
const imageTransformer = require('../../src/modules/ai-generation/image-transformer.service');
const { ScrapingError } = require('../../src/modules/scraping/scraping.errors');
const orchestrator = require('../../src/modules/ai-generation/generation.orchestrator');

test.afterEach(() => {
  mock.restoreAll();
});

test('generateDraftInput skips scrapeListing entirely when competitorRaw/sourceRaw are provided', async () => {
  const ebayScrapeListingMock = mock.method(ebayScraper, 'scrapeListing', async () => {
    throw new Error('should not be called — competitorRaw was provided');
  });
  const aliexpressScrapeListingMock = mock.method(aliexpressScraper, 'scrapeListing', async () => {
    throw new Error('should not be called — sourceRaw was provided');
  });
  mock.method(textGenerator, 'generateListingContent', async () => ({
    title: 'Great Widget',
    description: 'desc',
    condition: 'NEW',
    aspects: {},
    imageScenePrompt: 'clean white studio background',
  }));
  mock.method(imageTransformer, 'transformImages', async (urls) => urls);

  const { draftInput, competitor, source } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    competitorRaw: { title: 'Competitor (from extension)', categoryId: '123' },
    sourceRaw: { title: 'Source (from extension)', imageUrls: ['https://example.com/a.jpg'] },
    costPrice: 5,
    sellPrice: 15,
    currency: 'GBP',
    merchantLocationKey: 'main',
  });

  assert.strictEqual(ebayScrapeListingMock.mock.calls.length, 0);
  assert.strictEqual(aliexpressScrapeListingMock.mock.calls.length, 0);
  assert.strictEqual(competitor.title, 'Competitor (from extension)');
  assert.strictEqual(competitor.sourceUrl, 'https://ebay.co.uk/itm/1');
  assert.strictEqual(source.title, 'Source (from extension)');
  assert.strictEqual(source.sourceUrl, 'https://aliexpress.com/item/1.html');
  assert.strictEqual(draftInput.categoryId, '123');
});

test('generateDraftInput still throws via normalize() when competitorRaw has no title', async () => {
  mock.method(aliexpressScraper, 'scrapeListing', async () => ({ title: 'Source', imageUrls: [], variants: [] }));

  await assert.rejects(
    () =>
      orchestrator.generateDraftInput({
        competitorUrl: 'https://ebay.co.uk/itm/1',
        sourceUrl: 'https://aliexpress.com/item/1.html',
        competitorRaw: { title: null },
        costPrice: 5,
        sellPrice: 15,
        currency: 'GBP',
        merchantLocationKey: 'main',
      }),
    (err) => err instanceof ScrapingError && err.source === 'ebay'
  );
});

test('generateDraftInput assembles a single-SKU draftInput when the source has no variants', async () => {
  mock.method(ebayScraper, 'scrapeListing', async () => ({ title: 'Competitor', categoryId: '123', variants: [] }));
  mock.method(aliexpressScraper, 'scrapeListing', async () => ({
    title: 'Source',
    imageUrls: ['https://example.com/a.jpg'],
    variants: [],
  }));
  mock.method(textGenerator, 'generateListingContent', async () => ({
    title: 'Great Widget',
    description: 'desc',
    condition: 'NEW',
    aspects: { Colour: ['Black'] },
    imageScenePrompt: 'clean white studio background',
  }));
  const transformImagesMock = mock.method(imageTransformer, 'transformImages', async (urls) => urls);

  const { draftInput, competitor, source } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    costPrice: 5,
    sellPrice: 15,
    currency: 'GBP',
    merchantLocationKey: 'main',
  });

  assert.strictEqual(draftInput.title, 'Great Widget');
  assert.strictEqual(draftInput.price.value, '15');
  assert.strictEqual(draftInput.merchantLocationKey, 'main');
  assert.strictEqual(draftInput.quantity, 1);
  assert.strictEqual(draftInput.variants, undefined);
  assert.strictEqual(competitor.title, 'Competitor');
  assert.strictEqual(source.title, 'Source');
  assert.strictEqual(draftInput.categoryId, '123');
  assert.strictEqual(transformImagesMock.mock.calls[0].arguments[1], 'clean white studio background');
});

test('generateDraftInput caps single-SKU gallery images at 5, even when the source has more', async () => {
  mock.method(ebayScraper, 'scrapeListing', async () => ({ title: 'Competitor', categoryId: '123', variants: [] }));
  mock.method(aliexpressScraper, 'scrapeListing', async () => ({
    title: 'Source',
    imageUrls: Array.from({ length: 12 }, (_, i) => `https://example.com/${i}.jpg`),
    variants: [],
  }));
  mock.method(textGenerator, 'generateListingContent', async () => ({
    title: 'Great Widget',
    description: 'desc',
    condition: 'NEW',
    aspects: {},
    imageScenePrompt: 'clean white studio background',
  }));
  const transformImagesMock = mock.method(imageTransformer, 'transformImages', async (urls) => urls);

  const { draftInput } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    costPrice: 5,
    sellPrice: 15,
    currency: 'GBP',
    merchantLocationKey: 'main',
  });

  assert.strictEqual(transformImagesMock.mock.calls[0].arguments[0].length, 5);
  assert.strictEqual(draftInput.imageUrls.length, 5);
});

test('generateDraftInput caps variation group images at 5 and keeps exactly 1 image per variant', async () => {
  mock.method(ebayScraper, 'scrapeListing', async () => ({ title: 'Competitor', categoryId: '123', variants: [] }));
  mock.method(aliexpressScraper, 'scrapeListing', async () => ({
    title: 'Source',
    imageUrls: Array.from({ length: 12 }, (_, i) => `https://example.com/group-${i}.jpg`),
    variants: [
      { attributes: { Color: 'Black' }, imageUrl: 'https://example.com/black.jpg' },
      { attributes: { Color: 'Red' }, imageUrl: 'https://example.com/red.jpg' },
    ],
  }));
  mock.method(textGenerator, 'generateListingContent', async () => ({
    commonTitle: 'Great Widget',
    commonDescription: 'desc',
    condition: 'NEW',
    sharedAspects: {},
    varyingAspectName: 'Colour',
    variantAspectValues: { Black: 'Black', Red: 'Red' },
    imageScenePrompt: 'clean white studio background',
  }));
  mock.method(imageTransformer, 'transformImages', async (urls) => urls);

  const { draftInput } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    costPrice: 5,
    sellPrice: 15,
    currency: 'GBP',
    merchantLocationKey: 'main',
  });

  assert.strictEqual(draftInput.imageUrls.length, 5);
  assert.ok(draftInput.variants.every((v) => v.imageUrls.length === 1));
});

test('generateDraftInput assembles a variation draftInput when the source has variants', async () => {
  mock.method(ebayScraper, 'scrapeListing', async () => ({ title: 'Competitor', categoryId: '123', variants: [] }));
  mock.method(aliexpressScraper, 'scrapeListing', async () => ({
    title: 'Source',
    imageUrls: ['https://example.com/group.jpg'],
    variants: [
      { attributes: { Color: 'Black' }, imageUrl: 'https://example.com/black.jpg' },
      { attributes: { Color: 'Red' }, imageUrl: 'https://example.com/red.jpg' },
    ],
  }));
  mock.method(textGenerator, 'generateListingContent', async () => ({
    commonTitle: 'Great Widget',
    commonDescription: 'desc',
    condition: 'NEW',
    sharedAspects: { Material: ['Silicone'] },
    varyingAspectName: 'Colour',
    variantAspectValues: { Black: 'Black', Red: 'Red' },
    imageScenePrompt: 'clean white studio background',
  }));
  const transformImagesMock = mock.method(imageTransformer, 'transformImages', async (urls) => urls);

  const { draftInput } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    costPrice: 5,
    sellPrice: 15,
    currency: 'GBP',
    merchantLocationKey: 'main',
  });

  assert.strictEqual(draftInput.commonTitle, 'Great Widget');
  assert.strictEqual(draftInput.variants.length, 2);
  assert.deepStrictEqual(draftInput.variants[0].aspects, { Colour: ['Black'] });
  assert.deepStrictEqual(draftInput.variants[0].imageUrls, ['https://example.com/black.jpg']);
  assert.deepStrictEqual(draftInput.variesBy.specifications, [{ name: 'Colour', values: ['Black', 'Red'] }]);
  assert.deepStrictEqual(draftInput.variesBy.aspectsImageVariesBy, ['Colour']);
  assert.strictEqual(draftInput.categoryId, '123');
  assert.ok(transformImagesMock.mock.calls.every((call) => call.arguments[1] === 'clean white studio background'));
});

test('generateDraftInput throws when the competitor scrape has no category id', async () => {
  mock.method(ebayScraper, 'scrapeListing', async () => ({ title: 'Competitor', categoryId: null, variants: [] }));
  mock.method(aliexpressScraper, 'scrapeListing', async () => ({ title: 'Source', imageUrls: [], variants: [] }));

  await assert.rejects(
    () =>
      orchestrator.generateDraftInput({
        competitorUrl: 'https://ebay.co.uk/itm/1',
        sourceUrl: 'https://aliexpress.com/item/1.html',
        costPrice: 5,
        sellPrice: 15,
        currency: 'GBP',
        merchantLocationKey: 'main',
      }),
    (err) => err instanceof ScrapingError && /category/i.test(err.message)
  );
});

test('generateDraftInput lets a ScrapingError from either scraper propagate unchanged', async () => {
  mock.method(ebayScraper, 'scrapeListing', async () => {
    throw new ScrapingError('blocked', { source: 'ebay' });
  });
  mock.method(aliexpressScraper, 'scrapeListing', async () => ({ title: 'Source', imageUrls: [], variants: [] }));

  await assert.rejects(
    () =>
      orchestrator.generateDraftInput({
        competitorUrl: 'https://ebay.co.uk/itm/1',
        sourceUrl: 'https://aliexpress.com/item/1.html',
        costPrice: 5,
        sellPrice: 15,
        currency: 'GBP',
        merchantLocationKey: 'main',
      }),
    (err) => err instanceof ScrapingError && err.source === 'ebay'
  );
});
