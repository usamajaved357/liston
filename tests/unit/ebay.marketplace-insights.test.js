const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const config = require('../../src/config');
const { resetApplicationTokenCache } = require('../../src/modules/ebay/api/ebay.app-token');
const salesHistory = require('../../src/modules/ebay/sales-history');

test.beforeEach(() => {
  config.ebay.clientId = config.ebay.clientId || 'id';
  config.ebay.clientSecret = config.ebay.clientSecret || 'secret';
  resetApplicationTokenCache();
  salesHistory.forget();
});
test.afterEach(() => mock.restoreAll());

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

test("while eBay hasn't granted the app Marketplace Insights, sales history is 'not available', and eBay isn't asked again for an hour", async () => {
  const calls = [];
  mock.method(global, 'fetch', async (url, init) => {
    calls.push(String(url));
    assert.match(String(init.body), /buy\.marketplace\.insights/);
    return json(400, { error: 'invalid_scope', error_description: 'The requested scope is invalid' });
  });
  assert.deepStrictEqual(await salesHistory.soldListings({ q: 'smart glasses', marketplaceId: 'EBAY_GB' }), { available: false });
  assert.deepStrictEqual(await salesHistory.soldListings({ q: 'other', marketplaceId: 'EBAY_GB' }), { available: false });
  assert.strictEqual(calls.length, 1, 'one token request, then the refusal is remembered');
});

test('a 403 from the API itself also reads as not granted', async () => {
  mock.method(global, 'fetch', async (url) =>
    String(url).includes('/oauth2/token') ? json(200, { access_token: 'tok', expires_in: 7200 }) : json(403, { errors: [{ errorId: 1100, message: 'Access denied' }] })
  );
  assert.deepStrictEqual(await salesHistory.soldListings({ q: 'smart glasses', marketplaceId: 'EBAY_GB' }), { available: false });
});

test("once granted, a search's sales come back mapped: price, how many sold, when, and the legacy id to check the listing by", async () => {
  const seen = [];
  mock.method(global, 'fetch', async (url, init) => {
    if (String(url).includes('/oauth2/token')) return json(200, { access_token: 'tok', expires_in: 7200 });
    seen.push({ url: String(url), headers: init.headers });
    return json(200, {
      total: 2,
      itemSales: [
        { itemId: 'v1|128050316502|0', title: 'Lenovo AI Smart Glasses', image: { imageUrl: 'https://i.ebayimg.com/a.jpg' }, itemWebUrl: 'https://www.ebay.co.uk/itm/128050316502', lastSoldPrice: { value: '13.09', currency: 'GBP' }, totalSoldQuantity: 22, lastSoldDate: '2026-09-20T10:00:00.000Z', seller: { username: 'shop-x' }, itemLocation: { country: 'GB' } },
        { itemId: 'v1|99|0', legacyItemId: '99', title: 'Other', lastSoldPrice: { value: '9.74', currency: 'GBP' }, totalSoldQuantity: 54 },
      ],
    });
  });
  const res = await salesHistory.soldListings({ q: 'smart glasses', marketplaceId: 'EBAY_GB', condition: 'new', maxPrice: 20 });
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.items[0].legacyItemId, '128050316502');
  assert.strictEqual(res.items[0].price, 13.09);
  assert.strictEqual(res.items[0].sold, 22);
  assert.strictEqual(res.items[0].image, 'https://i.ebayimg.com/a.jpg');
  assert.strictEqual(res.items[1].legacyItemId, '99');
  const url = new URL(seen[0].url);
  assert.strictEqual(url.pathname, '/buy/marketplace_insights/v1_beta/item_sales/search');
  assert.strictEqual(url.searchParams.get('filter'), 'conditions:{NEW},price:[..20],priceCurrency:GBP');
  assert.strictEqual(seen[0].headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_GB');
  // Kept an hour: the same search asks eBay nothing.
  await salesHistory.soldListings({ q: 'Smart Glasses', marketplaceId: 'EBAY_GB', condition: 'new', maxPrice: 20 });
  assert.strictEqual(seen.length, 1);
});
