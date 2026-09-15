const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const ebaySource = require('../../src/modules/sourcing/ebay-listing.source');
const aliexpressSource = require('../../src/modules/sourcing/aliexpress');
const textGenerator = require('../../src/modules/ai-generation/text-generator.service');
const imagePipeline = require('../../src/modules/ai-generation/image-pipeline');
const { ScrapingError } = require('../../src/modules/scraping/scraping.errors');
const orchestrator = require('../../src/modules/ai-generation/generation.orchestrator');

test.afterEach(() => {
  mock.restoreAll();
});

test('generateDraftInput reads the competitor through the Browse API, not a scraper', async () => {
  const fetchListingMock = mock.method(ebaySource, 'fetchListing', async (url) => ({
    sourceUrl: url,
    title: 'Competitor',
    categoryId: '123',
    referenceImages: ['https://i.ebayimg.com/competitor.jpg'],
    specifics: {},
    variants: [],
  }));
  mock.method(aliexpressSource, 'fetchProduct', async () => ({
    title: 'Source',
    priceText: '£2.00',
    imageUrls: ['https://example.com/a.jpg'],
    variants: [],
  }));
  mock.method(textGenerator, 'generateListingContent', async () => ({
    title: 'Great Widget',
    description: 'desc',
    condition: 'NEW',
    aspects: {},
    imageScenePrompt: 'clean white studio background',
  }));
  const buildGalleryMock = mock.method(imagePipeline, 'buildGalleryImages', async ({ sourceImageUrls }) => ({
    imageUrls: sourceImageUrls.slice(0, 5),
    warnings: [],
  }));
  mock.method(imagePipeline, 'buildVariantImage', async ({ sourceImageUrl }) => sourceImageUrl || null);

  const { draftInput, competitor } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    merchantLocationKey: 'main',
  });

  assert.strictEqual(fetchListingMock.mock.calls.length, 1);
  assert.strictEqual(fetchListingMock.mock.calls[0].arguments[0], 'https://ebay.co.uk/itm/1');
  assert.strictEqual(competitor.title, 'Competitor');
  assert.strictEqual(draftInput.categoryId, '123');

  // The competitor's own photos must never be fed to the image pipeline —
  // only the AliExpress source's images are ours to publish.
  const transformed = buildGalleryMock.mock.calls[0].arguments[0].sourceImageUrls;
  assert.deepStrictEqual(transformed, ['https://example.com/a.jpg']);
  assert.deepStrictEqual(draftInput.imageUrls, ['https://example.com/a.jpg']);
});

test('generateDraftInput refuses to draft when the competitor has no eBay category', async () => {
  mock.method(ebaySource, 'fetchListing', async () => ({
    title: 'Competitor',
    categoryId: null,
    referenceImages: [],
    specifics: {},
    variants: [],
  }));
  mock.method(aliexpressSource, 'fetchProduct', async () => ({ title: 'Source', priceText: '£2.00', imageUrls: [], variants: [] }));

  await assert.rejects(
    () =>
      orchestrator.generateDraftInput({
        competitorUrl: 'https://ebay.co.uk/itm/1',
        sourceUrl: 'https://aliexpress.com/item/1.html',
        merchantLocationKey: 'main',
      }),
    (err) => err instanceof ScrapingError && err.source === 'ebay'
  );
});

test('generateDraftInput assembles a single-SKU draftInput when the source has no variants', async () => {
  mock.method(ebaySource, 'fetchListing', async () => ({ title: 'Competitor', categoryId: '123', variants: [] }));
  mock.method(aliexpressSource, 'fetchProduct', async () => ({
    title: 'Source',
    priceText: '£2.00',
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
  const buildGalleryMock = mock.method(imagePipeline, 'buildGalleryImages', async ({ sourceImageUrls }) => ({
    imageUrls: sourceImageUrls.slice(0, 5),
    warnings: [],
  }));
  mock.method(imagePipeline, 'buildVariantImage', async ({ sourceImageUrl }) => sourceImageUrl || null);

  const { draftInput, competitor, source } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    merchantLocationKey: 'main',
  });

  assert.strictEqual(draftInput.title, 'Great Widget');
  // Derived, not typed: £2.00 supplier cost → £5.99 at 60% ROI after fees.
  assert.strictEqual(draftInput.price.value, '5.99');
  assert.ok(draftInput.priceBreakdown.roiPercent >= 60);
  assert.strictEqual(draftInput.merchantLocationKey, 'main');
  assert.strictEqual(draftInput.quantity, 1);
  assert.strictEqual(draftInput.variants, undefined);
  assert.strictEqual(competitor.title, 'Competitor');
  assert.strictEqual(source.title, 'Source');
  assert.strictEqual(draftInput.categoryId, '123');
  assert.strictEqual(buildGalleryMock.mock.calls[0].arguments[0].scenePrompt, 'clean white studio background');
});

test('generateDraftInput caps single-SKU gallery images at 5, even when the source has more', async () => {
  mock.method(ebaySource, 'fetchListing', async () => ({ title: 'Competitor', categoryId: '123', variants: [] }));
  mock.method(aliexpressSource, 'fetchProduct', async () => ({
    title: 'Source',
    priceText: '£2.00',
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
  const buildGalleryMock = mock.method(imagePipeline, 'buildGalleryImages', async ({ sourceImageUrls }) => ({
    imageUrls: sourceImageUrls.slice(0, 5),
    warnings: [],
  }));
  mock.method(imagePipeline, 'buildVariantImage', async ({ sourceImageUrl }) => sourceImageUrl || null);

  const { draftInput } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    merchantLocationKey: 'main',
  });

  assert.strictEqual(buildGalleryMock.mock.calls[0].arguments[0].sourceImageUrls.length, 12);
  assert.strictEqual(draftInput.imageUrls.length, 5);
});

test('generateDraftInput caps variation group images at 5 and keeps exactly 1 image per variant', async () => {
  mock.method(ebaySource, 'fetchListing', async () => ({ title: 'Competitor', categoryId: '123', variants: [] }));
  mock.method(aliexpressSource, 'fetchProduct', async () => ({
    title: 'Source',
    priceText: '£2.00',
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
  mock.method(imagePipeline, 'buildGalleryImages', async ({ sourceImageUrls }) => ({
    imageUrls: sourceImageUrls.slice(0, 5),
    warnings: [],
  }));
  mock.method(imagePipeline, 'buildVariantImage', async ({ sourceImageUrl }) => sourceImageUrl || null);

  const { draftInput } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    merchantLocationKey: 'main',
  });

  assert.strictEqual(draftInput.imageUrls.length, 5);
  assert.ok(draftInput.variants.every((v) => v.imageUrls.length === 1));
});

test('generateDraftInput assembles a variation draftInput when the source has variants', async () => {
  mock.method(ebaySource, 'fetchListing', async () => ({ title: 'Competitor', categoryId: '123', variants: [] }));
  mock.method(aliexpressSource, 'fetchProduct', async () => ({
    title: 'Source',
    priceText: '£2.00',
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
  const buildGalleryMock = mock.method(imagePipeline, 'buildGalleryImages', async ({ sourceImageUrls }) => ({
    imageUrls: sourceImageUrls.slice(0, 5),
    warnings: [],
  }));
  mock.method(imagePipeline, 'buildVariantImage', async ({ sourceImageUrl }) => sourceImageUrl || null);

  const { draftInput } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    merchantLocationKey: 'main',
  });

  assert.strictEqual(draftInput.commonTitle, 'Great Widget');
  assert.strictEqual(draftInput.variants.length, 2);
  assert.deepStrictEqual(draftInput.variants[0].aspects, { Colour: ['Black'] });
  assert.deepStrictEqual(draftInput.variants[0].imageUrls, ['https://example.com/black.jpg']);
  assert.deepStrictEqual(draftInput.variesBy.specifications, [{ name: 'Colour', values: ['Black', 'Red'] }]);
  assert.deepStrictEqual(draftInput.variesBy.aspectsImageVariesBy, ['Colour']);
  assert.strictEqual(draftInput.categoryId, '123');
  assert.strictEqual(buildGalleryMock.mock.calls[0].arguments[0].scenePrompt, 'clean white studio background');
});

test('generateDraftInput fills a variant with no photo of its own from the gallery', async () => {
  mock.method(ebaySource, 'fetchListing', async () => ({ title: 'Competitor', categoryId: '123', variants: [] }));
  mock.method(aliexpressSource, 'fetchProduct', async () => ({
    title: 'Source',
    priceText: '£2.00',
    imageUrls: ['https://example.com/group.jpg'],
    variants: [
      { attributes: { Color: 'Black' }, imageUrl: 'https://example.com/black.jpg' },
      { attributes: { Color: 'Red' }, imageUrl: null },
    ],
  }));
  mock.method(textGenerator, 'generateListingContent', async () => ({
    commonTitle: 'Great Widget',
    commonDescription: 'desc',
    condition: 'NEW',
    sharedAspects: {},
    varyingAspectName: 'Colour',
    variantAspectValues: { Black: 'Black', Red: 'Red' },
    imageScenePrompt: 'scene',
  }));
  mock.method(imagePipeline, 'buildGalleryImages', async ({ sourceImageUrls }) => ({
    imageUrls: sourceImageUrls,
    warnings: [],
  }));
  mock.method(imagePipeline, 'buildVariantImage', async ({ sourceImageUrl }) => sourceImageUrl || null);

  const { draftInput, warnings } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    merchantLocationKey: 'main',
  });

  // eBay rejects the entire item group if ANY variation has no image, so the
  // gap is filled — but said out loud, since mismatched variation photos are
  // a real cause of returns.
  assert.deepStrictEqual(draftInput.variants[1].imageUrls, ['https://example.com/group.jpg']);
  assert.match(warnings.join(' '), /1 of 2 variations had no photo of their own/);
  assert.ok(draftInput.variants.every((v) => v.imageUrls.length > 0));
  assert.ok(draftInput.variants.every((v) => !('ownImage' in v)));
});

test('generateDraftInput throws when the competitor scrape has no category id', async () => {
  mock.method(ebaySource, 'fetchListing', async () => ({ title: 'Competitor', categoryId: null, variants: [] }));
  mock.method(aliexpressSource, 'fetchProduct', async () => ({ title: 'Source', priceText: '£2.00', imageUrls: [], variants: [] }));

  await assert.rejects(
    () =>
      orchestrator.generateDraftInput({
        competitorUrl: 'https://ebay.co.uk/itm/1',
        sourceUrl: 'https://aliexpress.com/item/1.html',
        merchantLocationKey: 'main',
      }),
    (err) => err instanceof ScrapingError && /category/i.test(err.message)
  );
});

test('generateDraftInput lets a ScrapingError from either scraper propagate unchanged', async () => {
  mock.method(ebaySource, 'fetchListing', async () => {
    throw new ScrapingError('blocked', { source: 'ebay' });
  });
  mock.method(aliexpressSource, 'fetchProduct', async () => ({ title: 'Source', priceText: '£2.00', imageUrls: [], variants: [] }));

  await assert.rejects(
    () =>
      orchestrator.generateDraftInput({
        competitorUrl: 'https://ebay.co.uk/itm/1',
        sourceUrl: 'https://aliexpress.com/item/1.html',
        merchantLocationKey: 'main',
      }),
    (err) => err instanceof ScrapingError && err.source === 'ebay'
  );
});

test('resolveVariantAspectValues keeps the model’s tidied values when they are all distinct', () => {
  const variants = [{ attributes: { Color: 'red one' } }, { attributes: { Color: 'blue one' } }];
  const resolved = orchestrator.resolveVariantAspectValues(variants, { 'red one': 'Red', 'blue one': 'Blue' });
  assert.deepStrictEqual(resolved, ['Red', 'Blue']);
});

test('resolveVariantAspectValues falls back to supplier labels when tidied values collide', () => {
  // eBay rejects a variation group where two variants share a value. This
  // pairing is real: a live AliExpress product offered "1PC Warm White" …
  // "4PCS Cold White" and the model collapsed all four packs to "Warm White".
  const variants = [
    { attributes: { Color: '1PC Warm White' } },
    { attributes: { Color: '2PCS Warm White' } },
    { attributes: { Color: '1PC Cold White' } },
  ];
  const resolved = orchestrator.resolveVariantAspectValues(variants, {
    '1PC Warm White': 'Warm White',
    '2PCS Warm White': 'Warm White',
    '1PC Cold White': 'Cool White',
  });
  assert.deepStrictEqual(resolved, ['1PC Warm White', '2PCS Warm White', '1PC Cold White']);
});

test('resolveVariantAspectValues treats case-only differences as a collision', () => {
  const variants = [{ attributes: { Color: 'a' } }, { attributes: { Color: 'b' } }];
  const resolved = orchestrator.resolveVariantAspectValues(variants, { a: 'Black', b: 'black' });
  assert.deepStrictEqual(resolved, ['a', 'b']);
});

test('resolveVariantAspectValues falls back to the raw label for an option the model did not map', () => {
  const variants = [{ attributes: { Color: 'red one' } }, { attributes: { Color: 'blue one' } }];
  const resolved = orchestrator.resolveVariantAspectValues(variants, { 'red one': 'Red' });
  assert.deepStrictEqual(resolved, ['Red', 'blue one']);
});

test('generateDraftInput falls every variant back to the main photo when the supplier has none', async () => {
  // Very common: AliExpress products frequently publish no per-option
  // photography at all. Refusing to list would be too strict — a seller
  // doing this by hand would use the main photo for every option.
  mock.method(ebaySource, 'fetchListing', async () => ({ title: 'Competitor', categoryId: '123', variants: [] }));
  mock.method(aliexpressSource, 'fetchProduct', async () => ({
    title: 'Source',
    priceText: '£2.00',
    imageUrls: ['https://example.com/group.jpg'],
    variants: [
      { attributes: { Color: 'Black' }, imageUrl: null },
      { attributes: { Color: 'Red' }, imageUrl: null },
    ],
  }));
  mock.method(textGenerator, 'generateListingContent', async () => ({
    commonTitle: 'Great Widget',
    commonDescription: 'desc',
    condition: 'NEW',
    sharedAspects: {},
    varyingAspectName: 'Colour',
    variantAspectValues: { Black: 'Black', Red: 'Red' },
    imageScenePrompt: 'scene',
  }));
  mock.method(imagePipeline, 'buildGalleryImages', async ({ sourceImageUrls }) => ({
    imageUrls: sourceImageUrls,
    warnings: [],
  }));
  mock.method(imagePipeline, 'buildVariantImage', async ({ sourceImageUrl }) => sourceImageUrl || null);

  const { draftInput, warnings } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    merchantLocationKey: 'main',
  });

  assert.deepStrictEqual(draftInput.variants[0].imageUrls, ['https://example.com/group.jpg']);
  assert.deepStrictEqual(draftInput.variants[1].imageUrls, ['https://example.com/group.jpg']);
  assert.match(warnings.join(' '), /no separate photo per option/);
});
