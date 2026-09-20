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
  assert.strictEqual(buildGalleryMock.mock.calls[0].arguments[0].categoryId, '123');
});

test('generateDraftInput keeps every usable gallery image the pipeline returns', async () => {
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
    imageUrls: sourceImageUrls,
    warnings: [],
  }));
  mock.method(imagePipeline, 'buildVariantImage', async ({ sourceImageUrl }) => sourceImageUrl || null);

  const { draftInput } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    merchantLocationKey: 'main',
  });

  assert.strictEqual(buildGalleryMock.mock.calls[0].arguments[0].sourceImageUrls.length, 12);
  assert.strictEqual(draftInput.imageUrls.length, 12);
});

test('generateDraftInput keeps every group image and exactly 1 image per variant', async () => {
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
    imageUrls: sourceImageUrls,
    warnings: [],
  }));
  mock.method(imagePipeline, 'buildVariantImage', async ({ sourceImageUrl }) => sourceImageUrl || null);

  const { draftInput } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    merchantLocationKey: 'main',
  });

  assert.strictEqual(draftInput.imageUrls.length, 12);
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
  // Fixture source has no variantAxes, so the model's single axis name is
  // used — the multi-axis path is covered by its own test below.
  assert.deepStrictEqual(draftInput.variesBy.specifications, [{ name: 'Colour', values: ['Black', 'Red'] }]);
  assert.deepStrictEqual(draftInput.variesBy.aspectsImageVariesBy, ['Colour']);
  assert.strictEqual(draftInput.categoryId, '123');
  assert.strictEqual(buildGalleryMock.mock.calls[0].arguments[0].categoryId, '123');
});

test('generateDraftInput writes variation options under eBay spelling when the category lists them', async () => {
  const ebayTaxonomy = require('../../src/modules/ebay/ebay.taxonomy');
  mock.method(ebaySource, 'fetchListing', async () => ({ title: 'Competitor', categoryId: '57989', variants: [] }));
  mock.method(aliexpressSource, 'fetchProduct', async () => ({
    title: 'Source',
    priceText: '£2.00',
    imageUrls: ['https://example.com/group.jpg'],
    variants: [
      { attributes: { Size: 'XL' }, imageUrl: 'https://example.com/a.jpg' },
      { attributes: { Size: 'XXL' }, imageUrl: 'https://example.com/a.jpg' },
    ],
  }));
  // Mirrors EBAY_GB Men's Trousers, where eBay refused "XXL" at publish
  // while its schema still called Size free text.
  const schema = [{ name: 'Size', required: true, variation: true, selectionOnly: false, allowedValues: ['S', 'M', 'L', 'XL', '2XL'], hasMoreValues: false }];
  mock.method(ebayTaxonomy, 'getAspectSchema', async () => schema);
  mock.method(ebayTaxonomy, 'getEditorAspectSchema', async () => schema);
  mock.method(textGenerator, 'generateListingContent', async () => ({
    commonTitle: 'Joggers',
    commonDescription: 'desc',
    condition: 'NEW',
    sharedAspects: {},
    varyingAspectName: 'Size',
    variantAspectValues: { XL: 'XL', XXL: 'XXL' },
  }));
  mock.method(imagePipeline, 'buildGalleryImages', async ({ sourceImageUrls }) => ({ imageUrls: sourceImageUrls, warnings: [] }));
  mock.method(imagePipeline, 'buildVariantImage', async ({ sourceImageUrl }) => sourceImageUrl || null);

  const { draftInput } = await orchestrator.generateDraftInput({
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://aliexpress.com/item/1.html',
    merchantLocationKey: 'main',
  });

  assert.deepStrictEqual(draftInput.variesBy.specifications, [{ name: 'Size', values: ['XL', '2XL'] }]);
  assert.deepStrictEqual(draftInput.variants.map((v) => v.aspects.Size[0]), ['XL', '2XL']);
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

// --- two-step drafting: read, choose, then generate -------------------------

const twoAxisSource = {
  title: 'Case',
  priceText: '£2.00',
  imageUrls: ['https://x/g.jpg'],
  variants: [
    { attributes: { Colour: 'Black', Model: '15' }, imageUrl: 'https://x/b.jpg' },
    { attributes: { Colour: 'Black', Model: '16' }, imageUrl: 'https://x/b.jpg' },
    { attributes: { Colour: 'Pink', Model: '15' }, imageUrl: 'https://x/p.jpg' },
    { attributes: { Colour: 'Pink', Model: '16' }, imageUrl: 'https://x/p.jpg' },
  ],
  variantAxes: [
    { name: 'Colour', values: ['Black', 'Pink'], hasImages: true },
    { name: 'Model', values: ['15', '16'], hasImages: false },
  ],
};

test('selectVariants keeps only combinations whose value on every axis was chosen', () => {
  const selected = orchestrator.selectVariants(twoAxisSource, { Colour: ['Black'], Model: ['16'] });

  assert.strictEqual(selected.variants.length, 1);
  assert.deepStrictEqual(selected.variants[0].attributes, { Colour: 'Black', Model: '16' });
  // The axes shrink to match, so eBay is never told about an option nobody can buy.
  assert.deepStrictEqual(selected.variantAxes.map((a) => a.values), [['Black'], ['16']]);
});

test('selectVariants treats an unmentioned axis as "keep everything on it"', () => {
  const selected = orchestrator.selectVariants(twoAxisSource, { Colour: ['Pink'] });
  assert.strictEqual(selected.variants.length, 2);
  assert.ok(selected.variants.every((v) => v.attributes.Colour === 'Pink'));
  assert.deepStrictEqual(selected.variantAxes[1].values, ['15', '16']);
});

test('selectVariants with no selection returns the source untouched', () => {
  assert.strictEqual(orchestrator.selectVariants(twoAxisSource, undefined), twoAxisSource);
  assert.strictEqual(orchestrator.selectVariants(twoAxisSource, {}), twoAxisSource);
});

test('generateDraftInput uses pre-read listings and drafts only the chosen variations', async () => {
  // Step two must not read anything again — the whole point is that the
  // ~30s AliExpress scrape happened once, in step one.
  const fetchListing = mock.method(ebaySource, 'fetchListing', async () => {
    throw new Error('must not re-read the competitor');
  });
  const fetchProduct = mock.method(aliexpressSource, 'fetchProduct', async () => {
    throw new Error('must not re-read the source');
  });
  mock.method(textGenerator, 'generateListingContent', async () => ({
    commonTitle: 'T',
    commonDescription: 'D',
    condition: 'NEW',
    sharedAspects: {},
    varyingAspectName: 'Colour',
    variantAspectValues: { Black: 'Black', Pink: 'Pink' },
    imageScenePrompt: 's',
    aspectWarnings: [],
  }));
  mock.method(imagePipeline, 'buildGalleryImages', async ({ sourceImageUrls }) => ({ imageUrls: sourceImageUrls, warnings: [] }));
  const variantImage = mock.method(imagePipeline, 'buildVariantImage', async ({ sourceImageUrl }) => sourceImageUrl);

  const { draftInput } = await orchestrator.generateDraftInput({
    competitor: { title: 'Comp', categoryId: '123', priceText: 'GBP 9.99', specifics: {}, variants: [], referenceImages: [] },
    source: twoAxisSource,
    variantSelection: { Colour: ['Black'] },
    merchantLocationKey: 'main',
  });

  assert.strictEqual(fetchListing.mock.calls.length, 0);
  assert.strictEqual(fetchProduct.mock.calls.length, 0);
  assert.strictEqual(draftInput.variants.length, 2);
  // Only Black was kept, so colour is no longer a choice: it becomes a
  // property of the product, and the variations differ by model alone.
  assert.ok(draftInput.variants.every((v) => v.aspects.Colour === undefined && v.aspects.Model?.length === 1));
  assert.deepStrictEqual(draftInput.variesBy.specifications.map((s) => s.name), ['Model']);
  // One distinct photo among the kept variants → one image build, not four.
  assert.strictEqual(variantImage.mock.calls.length, 1);
});

test('generateDraftInput refuses a selection that matches nothing rather than drafting an empty listing', async () => {
  await assert.rejects(
    () =>
      orchestrator.generateDraftInput({
        competitor: { title: 'Comp', categoryId: '123', specifics: {}, variants: [] },
        source: twoAxisSource,
        variantSelection: { Colour: ['Green'] },
        merchantLocationKey: 'main',
      }),
    /None of the variations you selected/
  );
});

test('generateDraftInput drafts a single chosen combination as a plain listing, not a 1-variant group', async () => {
  mock.method(textGenerator, 'generateListingContent', async ({ source }) => {
    // The chosen colour/model must reach the model as ordinary specifics.
    assert.strictEqual(source.specifics.Colour, 'Black');
    assert.strictEqual(source.specifics.Model, '16');
    return { title: 'T', description: 'D', condition: 'NEW', aspects: { Colour: ['Black'] }, imageScenePrompt: 's', aspectWarnings: [] };
  });
  mock.method(imagePipeline, 'buildGalleryImages', async ({ sourceImageUrls }) => ({ imageUrls: sourceImageUrls, warnings: [] }));
  const variantImage = mock.method(imagePipeline, 'buildVariantImage', async () => 'x');

  const { draftInput } = await orchestrator.generateDraftInput({
    competitor: { title: 'Comp', categoryId: '123', priceText: 'GBP 9.99', specifics: {}, variants: [], referenceImages: [] },
    source: twoAxisSource,
    variantSelection: { Colour: ['Black'], Model: ['16'] },
    merchantLocationKey: 'main',
  });

  assert.strictEqual(draftInput.variants, undefined);
  assert.strictEqual(draftInput.title, 'T');
  // Its own photo leads the gallery, and no per-variant image work runs.
  assert.strictEqual(draftInput.imageUrls[0], 'https://x/b.jpg');
  assert.strictEqual(variantImage.mock.calls.length, 0);
});

test('applyOrigin replaces any origin-shaped aspect with the seller’s country', () => {
  // Supplier and competitor data both said China and it was copied straight
  // into the listing. The seller dispatches from the UK.
  const result = orchestrator.applyOrigin(
    { 'Country of Origin': ['China'], 'Country/Region of Manufacture': ['China'], Brand: ['X'] },
    'United Kingdom'
  );
  assert.deepStrictEqual(result, { Brand: ['X'], 'Country/Region of Manufacture': ['United Kingdom'] });
});

test('applyOrigin adds the standard eBay origin aspect when none was present', () => {
  const result = orchestrator.applyOrigin({ Brand: ['X'] }, 'United Kingdom');
  assert.deepStrictEqual(result['Country/Region of Manufacture'], ['United Kingdom']);
});

test('generateDraftInput drafts without a competitor, taking the category from eBay’s suggestions', async () => {
  const ebayTaxonomy = require('../../src/modules/ebay/ebay.taxonomy');
  const fetchListingMock = mock.method(ebaySource, 'fetchListing', async () => {
    throw new Error('should not be called');
  });
  mock.method(aliexpressSource, 'fetchProduct', async () => ({
    title: 'Coin dispenser holder',
    priceText: '£2.00',
    imageUrls: ['https://example.com/a.jpg'],
    specifics: {},
    variants: [],
  }));
  mock.method(ebayTaxonomy, 'suggestCategories', async () => [
    { id: '63691', name: 'Cup Holders', path: ['Vehicle Parts & Accessories', 'Cup Holders'] },
    { id: '549', name: 'Supplies/Equipment', path: ['Coins', 'Supplies/Equipment'] },
  ]);
  mock.method(ebayTaxonomy, 'getAspectSchema', async () => null);
  const generateMock = mock.method(textGenerator, 'generateListingContent', async ({ competitor, categoryPath }) => {
    assert.strictEqual(competitor, null);
    assert.deepStrictEqual(categoryPath, ['Vehicle Parts & Accessories', 'Cup Holders']);
    return { title: 'x'.repeat(72), description: 'desc', condition: 'NEW', aspects: {} };
  });
  mock.method(imagePipeline, 'buildGalleryImages', async ({ sourceImageUrls }) => ({ imageUrls: sourceImageUrls, warnings: [] }));

  const { draftInput, competitor, warnings } = await orchestrator.generateDraftInput({
    sourceUrl: 'https://aliexpress.com/item/1.html',
    merchantLocationKey: 'main',
  });

  assert.strictEqual(fetchListingMock.mock.calls.length, 0);
  assert.strictEqual(generateMock.mock.calls.length, 1);
  assert.strictEqual(competitor, null);
  assert.strictEqual(draftInput.categoryId, '63691');
  assert.deepStrictEqual(draftInput.categoryPath, ['Vehicle Parts & Accessories', 'Cup Holders']);
  assert.strictEqual(draftInput.categorySuggestions.length, 2);
  // No competitor means no "couldn't read the competitor's price" noise.
  assert.ok(!warnings.some((w) => /competitor/.test(w)), warnings.join(' | '));
});

test('readSources refuses a no-competitor draft when eBay has no category suggestion', async () => {
  const ebayTaxonomy = require('../../src/modules/ebay/ebay.taxonomy');
  mock.method(aliexpressSource, 'fetchProduct', async () => ({ title: 'zzz', priceText: '£1', imageUrls: [], specifics: {}, variants: [] }));
  mock.method(ebayTaxonomy, 'suggestCategories', async () => []);
  await assert.rejects(() => orchestrator.readSources({ sourceUrl: 'https://aliexpress.com/item/1.html' }), ScrapingError);
});

test('closestVariationAspect maps a supplier axis onto the aspect eBay allows, or nothing', () => {
  const allowed = ['Colour', 'Size', 'Compatible Model', 'MPN'];
  assert.strictEqual(orchestrator.closestVariationAspect('Color', allowed), 'Colour');
  assert.strictEqual(orchestrator.closestVariationAspect('Shoe Size', allowed), 'Size');
  assert.strictEqual(orchestrator.closestVariationAspect('Phone Model', allowed), 'Compatible Model');
  assert.strictEqual(orchestrator.closestVariationAspect('Unit Quantity', allowed), null);
});

test('dedupeSourceVariants keeps the first of two supplier options with the same labels and says so', () => {
  const source = {
    variants: [
      { attributes: { Color: 'Camo Brown', Size: '25LB' }, imageUrl: 'a' },
      { attributes: { Color: 'camo  brown', Size: '25lb' }, imageUrl: 'b' },
      { attributes: { Color: 'Camo Brown', Size: '35LB' }, imageUrl: 'c' },
    ],
  };
  const { source: kept, warnings } = orchestrator.dedupeSourceVariants(source);
  assert.deepStrictEqual(kept.variants.map((v) => v.imageUrl), ['a', 'c']);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /camo  brown \/ 25lb/);
  assert.deepStrictEqual(orchestrator.dedupeSourceVariants({ variants: kept.variants }).warnings, []);
});
