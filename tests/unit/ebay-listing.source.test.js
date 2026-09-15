const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const browse = require('../../src/modules/ebay/ebay.browse');
const source = require('../../src/modules/sourcing/ebay-listing.source');
const { ScrapingError } = require('../../src/modules/scraping/scraping.errors');

// Fixtures mirror real Browse API responses captured live during
// implementation (a single-SKU seat-belt clip and a 133-variant Fruit of the
// Loom t-shirt listing), trimmed to the fields we actually read.
const SINGLE_ITEM = {
  title: 'Seat Buckle Adjustable Seat Accessories',
  description: '<p>A <b>great</b> clip &amp; buckle</p><script>evil()</script>',
  image: { imageUrl: 'https://i.ebayimg.com/a.jpg' },
  additionalImages: [{ imageUrl: 'https://i.ebayimg.com/b.jpg' }, { imageUrl: 'https://i.ebayimg.com/a.jpg' }],
  price: { value: '4.99', currency: 'GBP' },
  categoryId: '9887',
  categoryPath: 'Vehicle Parts & Accessories|Car Parts|Interior Parts',
  localizedAspects: [
    { name: 'Brand', value: 'Unbranded' },
    { name: 'Material', value: 'ABS' },
  ],
};

const GROUP = {
  title: 'Fruit of the Loom Mens T-Shirts',
  commonDescriptions: [{ description: '<div>100% cotton</div>' }],
  items: [
    {
      title: 'Fruit of the Loom Mens T-Shirts',
      image: { imageUrl: 'https://i.ebayimg.com/white-s.jpg' },
      price: { value: '4.90', currency: 'GBP' },
      categoryId: '15687',
      categoryPath: 'Clothes|Men|T-Shirts',
      localizedAspects: [
        { name: 'Colour', value: 'White' },
        { name: 'Size', value: 'S' },
        { name: 'Material', value: 'Cotton' },
      ],
    },
    {
      title: 'Fruit of the Loom Mens T-Shirts',
      image: { imageUrl: 'https://i.ebayimg.com/black-m.jpg' },
      price: { value: '5.90', currency: 'GBP' },
      categoryId: '15687',
      categoryPath: 'Clothes|Men|T-Shirts',
      localizedAspects: [
        { name: 'Colour', value: 'Black' },
        { name: 'Size', value: 'M' },
        { name: 'Material', value: 'Cotton' },
      ],
    },
  ],
};

test.afterEach(() => {
  mock.restoreAll();
});

test('legacyItemIdFromUrl accepts plain and slugged /itm/ URLs', () => {
  assert.strictEqual(source.legacyItemIdFromUrl('https://www.ebay.co.uk/itm/147565754825'), '147565754825');
  assert.strictEqual(
    source.legacyItemIdFromUrl('https://www.ebay.co.uk/itm/mens-t-shirt/167039151658?hash=xyz'),
    '167039151658'
  );
  assert.strictEqual(source.legacyItemIdFromUrl('https://www.ebay.com/itm/123456789012'), '123456789012');
});

test('legacyItemIdFromUrl rejects a URL that is not an eBay item', () => {
  assert.throws(
    () => source.legacyItemIdFromUrl('https://www.aliexpress.com/item/1005006113546205.html'),
    (err) => err instanceof ScrapingError && err.source === 'ebay'
  );
});

test('fetchListing normalizes a single-SKU item and strips description markup', async () => {
  mock.method(browse, 'getItemByLegacyId', async () => SINGLE_ITEM);

  const result = await source.fetchListing('https://www.ebay.co.uk/itm/147565754825');

  assert.strictEqual(result.categoryId, '9887');
  assert.deepStrictEqual(result.categoryBreadcrumb, ['Vehicle Parts & Accessories', 'Car Parts', 'Interior Parts']);
  assert.strictEqual(result.description, 'A great clip & buckle');
  assert.strictEqual(result.priceText, 'GBP 4.99');
  assert.deepStrictEqual(result.specifics, { Brand: 'Unbranded', Material: 'ABS' });
  assert.deepStrictEqual(result.variants, []);
});

test('fetchListing deduplicates images and never exposes them as imageUrls', async () => {
  mock.method(browse, 'getItemByLegacyId', async () => SINGLE_ITEM);

  const result = await source.fetchListing('https://www.ebay.co.uk/itm/147565754825');

  // The competitor's photos are reference-only: the image pipeline reads
  // `imageUrls`, so the absence of that key is what structurally prevents
  // someone else's photo reaching a publish payload.
  assert.ok(!('imageUrls' in result), 'competitor photos must never appear as imageUrls');
  assert.deepStrictEqual(result.referenceImages, ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg']);
});

test('fetchListing follows eBay errorId 11006 to the item-group endpoint', async () => {
  const byLegacyId = mock.method(browse, 'getItemByLegacyId', async () => {
    const err = new Error('The legacy Id is invalid.');
    err.details = { errorId: 11006 };
    throw err;
  });
  const byGroup = mock.method(browse, 'getItemsByItemGroup', async () => GROUP);

  const result = await source.fetchListing('https://www.ebay.co.uk/itm/167039151658');

  assert.strictEqual(byLegacyId.mock.calls.length, 1);
  assert.deepStrictEqual(byGroup.mock.calls[0].arguments[0], '167039151658');
  assert.strictEqual(result.variants.length, 2);
  assert.strictEqual(result.description, '100% cotton');
});

test('fetchListing derives variation axes by diffing aspects across the group', async () => {
  mock.method(browse, 'getItemByLegacyId', async () => {
    const err = new Error('group');
    err.details = { errorId: 11006 };
    throw err;
  });
  mock.method(browse, 'getItemsByItemGroup', async () => GROUP);

  const result = await source.fetchListing('https://www.ebay.co.uk/itm/167039151658');

  // Colour and Size differ across items → variation axes. Material is the
  // same on every item → a product-level specific, not an axis.
  assert.deepStrictEqual(Object.keys(result.variants[0].attributes).sort(), ['Colour', 'Size']);
  assert.deepStrictEqual(result.variants[0].attributes, { Colour: 'White', Size: 'S' });
  assert.deepStrictEqual(result.variants[1].attributes, { Colour: 'Black', Size: 'M' });
  assert.deepStrictEqual(result.specifics, { Material: 'Cotton' });
  assert.strictEqual(result.variants[1].imageUrl, 'https://i.ebayimg.com/black-m.jpg');
  assert.strictEqual(result.variants[1].priceText, 'GBP 5.90');
});

test('varyingAspectNames ignores aspects present on only some items but never differing', () => {
  const axes = source.varyingAspectNames([
    { localizedAspects: [{ name: 'Colour', value: 'Red' }, { name: 'Brand', value: 'Acme' }] },
    { localizedAspects: [{ name: 'Colour', value: 'Blue' }] },
  ]);
  assert.deepStrictEqual(axes, ['Colour']);
});

test('fetchListing turns a 404 into a user-presentable ScrapingError', async () => {
  mock.method(browse, 'getItemByLegacyId', async () => {
    const err = new Error('Not found');
    err.details = { status: 404 };
    throw err;
  });

  await assert.rejects(
    source.fetchListing('https://www.ebay.co.uk/itm/999999999999'),
    (err) => err instanceof ScrapingError && /ended or been removed/.test(err.message)
  );
});

test('fetchListing rejects an empty item group rather than drafting from nothing', async () => {
  mock.method(browse, 'getItemByLegacyId', async () => {
    const err = new Error('group');
    err.details = { errorId: 11006 };
    throw err;
  });
  mock.method(browse, 'getItemsByItemGroup', async () => ({ items: [] }));

  await assert.rejects(source.fetchListing('https://www.ebay.co.uk/itm/167039151658'), ScrapingError);
});
