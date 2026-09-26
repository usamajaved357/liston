const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { mock } = require('node:test');
require('dotenv').config();

const { pool } = require('../../src/db/client');
const overviewService = require('../../src/modules/overview/overview.service');
const connectionService = require('../../src/modules/connections/connection.service');
const ebayService = require('../../src/modules/ebay/ebay.service');
const mirror = require('../../src/modules/ebay/ebay-mirror.repository');
const orderRepository = require('../../src/modules/orders/order.repository');
const listingRepository = require('../../src/modules/listings/listing.repository');
const exchangeRates = require('../../src/modules/rates/exchange-rates');

test.after(async () => {
  await pool.end();
});
test.afterEach(() => mock.restoreAll());

const now = new Date();
const hoursAgo = (h) => new Date(now.getTime() - h * 3600e3).toISOString();
const order = (id, total, currency, lines) => ({
  orderId: id,
  createdAt: hoursAgo(1),
  checkoutStatus: 'Complete',
  total: { amount: total, currency },
  lineItems: lines.map(([itemId, units, amount]) => ({ itemId, title: `Item ${itemId}`, quantityPurchased: units, price: { amount, currency } })),
});

test("the business Overview shows each market's sales by day and best sellers, with photos and links, and all markets together in the main currency", async () => {
  const uk = { id: crypto.randomUUID(), label: 'Walexo', status: 'active', platform_key: 'ebay', marketplace: { id: 'EBAY_GB' } };
  const au = { id: crypto.randomUUID(), label: 'Walexo AU', status: 'active', platform_key: 'ebay', marketplace: { id: 'EBAY_AU' } };
  const ordersBy = {
    [uk.id]: [order('u1', 60, 'GBP', [['111', 2, 30]]), order('u2', 5, 'GBP', [['222', 1, 5]])],
    [au.id]: [order('a1', 40, 'AUD', [['333', 3, 13.33]])],
  };
  mock.method(connectionService, 'listConnections', async () => ({ connections: [uk, au] }));
  mock.method(connectionService, 'withDecryptedCredentials', async (id, owner, action) => action({ marketplaceId: id === uk.id ? 'EBAY_GB' : 'EBAY_AU' }));
  mock.method(ebayService, 'syncOrderFinances', async () => ({ skipped: 'fresh' }));
  mock.method(ebayService, 'countActiveListings', async () => ({ totalEntries: 10 }));
  mock.method(ebayService, 'ordersInRange', async (credentials, { connectionId }) => ordersBy[connectionId]);
  mock.method(ebayService, 'overviewSales', async (credentials, connectionId) => ({
    orders: ordersBy[connectionId],
    listings: new Map(connectionId === uk.id ? [['111', { imageUrl: 'https://i.ebayimg.com/111.jpg', url: 'https://www.ebay.co.uk/itm/111' }]] : []),
  }));
  mock.method(listingRepository, 'countListingWork', async () => ({ drafted: 0, published: 0, waiting: 0 }));
  mock.method(mirror, 'loadOrderFinances', async () => new Map());
  mock.method(mirror, 'loadItemSummaries', async (ids) => new Map(ids.includes('222') ? [['222', { summary: { imageUrl: 'https://i.ebayimg.com/222.jpg' } }]] : []));
  mock.method(orderRepository, 'sourceCostsByOrder', async () => new Map());
  mock.method(orderRepository, 'listArchivedOrderIds', async () => []);
  mock.method(exchangeRates, 'ratesFor', async () => ({ rates: { AUD: 2 }, date: '2026-09-25' }));

  const o = await overviewService.getOverview('owner', null, { range: '7d', timeZone: 'Europe/London' });
  const gb = o.markets.find((m) => m.id === 'EBAY_GB');
  assert.strictEqual(gb.trend.length, 7);
  assert.strictEqual(gb.trend.at(-1).partial, true);
  assert.strictEqual(gb.trend.reduce((s, p) => s + p.value, 0), 65, "today's two UK orders");
  assert.deepStrictEqual(
    gb.bestSellers.map((b) => [b.itemId, b.units, b.image, b.url, b.live, b.account]),
    [
      ['111', 2, 'https://i.ebayimg.com/111.jpg', 'https://www.ebay.co.uk/itm/111', true, 'Walexo'],
      ['222', 1, 'https://i.ebayimg.com/222.jpg', 'https://www.ebay.co.uk/itm/222', false, 'Walexo'],
    ]
  );
  const auMarket = o.markets.find((m) => m.id === 'EBAY_AU');
  assert.strictEqual(auMarket.bestSellers[0].url, 'https://www.ebay.com.au/itm/333', 'a listing without a copy links to its own site');
  // All markets, in pounds (the UK sells most): A$40 is £20 at 2 AUD to the pound.
  assert.strictEqual(o.combined.money.currency, 'GBP');
  assert.strictEqual(o.combined.trend.reduce((s, p) => s + p.value, 0), 85);
  assert.deepStrictEqual(o.combined.bestSellers.map((b) => [b.itemId, b.currency]), [['333', 'AUD'], ['111', 'GBP'], ['222', 'GBP']]);
});
