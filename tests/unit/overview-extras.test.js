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
  mock.method(mirror, 'loadAccountCharges', async () => []);
  mock.method(mirror, 'loadItemSummaries', async (ids) => new Map(ids.includes('222') ? [['222', { summary: { imageUrl: 'https://i.ebayimg.com/222.jpg' } }]] : []));
  mock.method(orderRepository, 'sourceCostsByOrder', async () => new Map());
  mock.method(orderRepository, 'listArchivedOrderIds', async () => []);
  mock.method(exchangeRates, 'ratesFor', async () => ({ rates: { AUD: 2 }, date: '2026-09-25' }));

  const o = await overviewService.getOverview('owner', null, { range: '7d', timeZone: 'Europe/London' });
  const gb = o.markets.find((m) => m.id === 'EBAY_GB');
  assert.strictEqual(gb.trend.length, 7);
  assert.strictEqual(gb.trend.at(-1).partial, true);
  assert.strictEqual(gb.trend.reduce((s, p) => s + p.values.sales, 0), 65, "today's two UK orders");
  assert.deepStrictEqual([gb.trend.at(-1).values.orders, gb.trend.at(-1).values.units], [2, 3], 'orders and units drawn too');
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
  assert.strictEqual(o.combined.trend.reduce((s, p) => s + p.values.sales, 0), 85);
  assert.strictEqual(o.combined.trend.at(-1).values.units, 6, 'units add up across markets, not converted');
  assert.deepStrictEqual(o.combined.bestSellers.map((b) => [b.itemId, b.currency]), [['333', 'AUD'], ['111', 'GBP'], ['222', 'GBP']]);
});

test("the business Overview's Today is each account's own eBay site's day, not the viewer's: an owner in Pakistan at dawn doesn't see the UK's evening before as today", async () => {
  const uk = { id: crypto.randomUUID(), label: 'Walexo', status: 'active', platform_key: 'ebay', marketplace: { id: 'EBAY_GB' } };
  // 23:00 last night in London: today in Karachi (four or five hours ahead), yesterday for eBay UK.
  const londonMidnight = ebayService.resolveRangeWindow('today', null, null, 'Europe/London')[0];
  const lastNight = { ...order('late', 20, 'GBP', [['111', 1, 20]]), createdAt: new Date(londonMidnight.getTime() - 3600e3).toISOString() };
  mock.method(connectionService, 'listConnections', async () => ({ connections: [uk] }));
  mock.method(connectionService, 'withDecryptedCredentials', async (id, owner, action) => action({ marketplaceId: 'EBAY_GB' }));
  mock.method(ebayService, 'syncOrderFinances', async () => ({ skipped: 'fresh' }));
  mock.method(ebayService, 'countActiveListings', async () => ({ totalEntries: 1 }));
  const asked = mock.method(ebayService, 'ordersInRange', async () => []);
  mock.method(ebayService, 'overviewSales', async () => ({ orders: [lastNight], listings: new Map() }));
  mock.method(listingRepository, 'countListingWork', async () => ({ drafted: 0, published: 0, waiting: 0 }));
  mock.method(mirror, 'loadOrderFinances', async () => new Map());
  mock.method(mirror, 'loadAccountCharges', async () => []);
  mock.method(mirror, 'loadItemSummaries', async () => new Map());
  mock.method(orderRepository, 'sourceCostsByOrder', async () => new Map());
  mock.method(orderRepository, 'listArchivedOrderIds', async () => []);
  mock.method(exchangeRates, 'ratesFor', async () => ({ rates: {}, date: '2026-09-25' }));

  const o = await overviewService.getOverview('owner', null, { range: 'today', timeZone: 'Asia/Karachi' });
  assert.ok(!asked.mock.calls[0].arguments[1].timeZone, "orders are windowed in the account's site's time zone, not the viewer's");
  const trend = o.markets[0].trend;
  // Today by the hour, yesterday's hours alongside.
  assert.strictEqual(trend.length, 24);
  assert.strictEqual(trend.reduce((n, p) => n + p.values.orders, 0), 0, 'nothing yet today in the UK');
  assert.deepStrictEqual([trend.at(-1).previousDay.slice(-3), trend.at(-1).previous.orders], ['T23', 1], "last night's order is in eBay UK's yesterday, at 23:00");
});
