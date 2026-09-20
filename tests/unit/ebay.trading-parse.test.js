const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

// A live listing's HTML description comes back XML-escaped, thousands of
// entities in one field; the parser's default anti-bomb cap (1000) used to
// turn every "Edit" of a branded listing into "Couldn't parse eBay's response".
test('getItem parses a response whose description carries thousands of escaped entities', async () => {
  const trading = require('../../src/modules/ebay/ebay.trading');
  const html = '<div><p>lorem &amp; ipsum</p></div>'.repeat(400);
  const escaped = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack>` +
    `<Item><ItemID>1</ItemID><Title>T</Title><Description>${escaped}</Description><StartPrice currencyID="GBP">9.95</StartPrice><Quantity>1</Quantity></Item></GetItemResponse>`;
  const fetchMock = mock.method(global, 'fetch', async () => ({ status: 200, text: async () => xml }));
  try {
    const item = await trading.getItem('token', '1', { siteId: 3 });
    assert.ok(item.description.includes('<p>lorem &amp; ipsum</p>'));
    assert.ok(item.description.length > 10000);
  } finally {
    fetchMock.mock.restore();
  }
});

test('getStoreCategories treats "not a store subscriber" as no Shop, and anything else as a failure', async () => {
  const trading = require('../../src/modules/ebay/ebay.trading');
  const failure = (msg) =>
    `<?xml version="1.0"?><GetStoreResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Failure</Ack><Errors><ShortMessage>${msg}</ShortMessage><LongMessage>${msg}</LongMessage><ErrorCode>1</ErrorCode></Errors></GetStoreResponse>`;
  let body = failure('You are not a store subscriber.');
  const fetchMock = mock.method(global, 'fetch', async () => ({ status: 200, text: async () => body }));
  try {
    assert.deepStrictEqual(await trading.getStoreCategories('t', { siteId: 3 }), { categories: [], hasStore: false });
    body = failure('Internal error to the application.');
    await assert.rejects(() => trading.getStoreCategories('t', { siteId: 3 }), /Internal error/);
    body =
      `<?xml version="1.0"?><GetStoreResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Store><CustomCategories>` +
      `<CustomCategory><CategoryID>10</CategoryID><Name>Tech</Name><ChildCategory><CategoryID>11</CategoryID><Name>Cables</Name></ChildCategory></CustomCategory>` +
      `</CustomCategories></Store></GetStoreResponse>`;
    const ok = await trading.getStoreCategories('t', { siteId: 3 });
    assert.strictEqual(ok.hasStore, true);
    assert.strictEqual(ok.categories[0].children[0].name, 'Cables');
  } finally {
    fetchMock.mock.restore();
  }
});

test('addStoreCategory sends SetStoreCategories and maps the created department', async () => {
  const trading = require('../../src/modules/ebay/ebay.trading');
  let sent = '';
  const fetchMock = mock.method(global, 'fetch', async (url, init) => {
    sent = init.body;
    return {
      status: 200,
      text: async () =>
        `<?xml version="1.0"?><SetStoreCategoriesResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Status>Complete</Status><CustomCategory><CategoryID>99</CategoryID><Name>Bath &amp; Shower</Name></CustomCategory></SetStoreCategoriesResponse>`,
    };
  });
  try {
    const result = await trading.addStoreCategory('t', { name: 'Bath & Shower', parentId: '10' }, { siteId: 3 });
    assert.match(sent, /<Action>Add<\/Action>/);
    assert.match(sent, /<DestinationParentCategoryID>10<\/DestinationParentCategoryID>/);
    assert.match(sent, /<Name>Bath &amp; Shower<\/Name>/);
    assert.deepStrictEqual(result.category, { id: '99', name: 'Bath & Shower', children: [] });
    assert.strictEqual(result.status, 'Complete');
  } finally {
    fetchMock.mock.restore();
  }
});

test('getItemSummary reads per-option variation pictures', async () => {
  const trading = require('../../src/modules/ebay/ebay.trading');
  const xml =
    `<?xml version="1.0"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Item><ItemID>1</ItemID>` +
    `<PictureDetails><PictureURL>https://i/main.jpg</PictureURL></PictureDetails><Quantity>3</Quantity>` +
    `<Variations><Pictures><VariationSpecificName>Colour</VariationSpecificName>` +
    `<VariationSpecificPictureSet><VariationSpecificValue>Black Lace</VariationSpecificValue><PictureURL>https://i/black.jpg</PictureURL><PictureURL>https://i/black2.jpg</PictureURL></VariationSpecificPictureSet>` +
    `<VariationSpecificPictureSet><VariationSpecificValue>White Lace</VariationSpecificValue><PictureURL>https://i/white.jpg</PictureURL></VariationSpecificPictureSet>` +
    `</Pictures></Variations></Item></GetItemResponse>`;
  const fetchMock = mock.method(global, 'fetch', async () => ({ status: 200, text: async () => xml }));
  try {
    const summary = await trading.getItemSummary('t', '1', { siteId: 3 });
    assert.strictEqual(summary.imageUrl, 'https://i/main.jpg');
    assert.deepStrictEqual(summary.variationPictures, [{ specificName: 'Colour', byValue: { 'Black Lace': 'https://i/black.jpg', 'White Lace': 'https://i/white.jpg' } }]);
  } finally {
    fetchMock.mock.restore();
  }
});
