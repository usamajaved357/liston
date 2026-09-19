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
