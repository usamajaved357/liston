const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const marketScope = require('../../src/modules/ebay/market-scope');
const ebayTrading = require('../../src/modules/ebay/api/ebay.trading');
const ebayFulfillment = require('../../src/modules/ebay/api/ebay.fulfillment');
const ebayService = require('../../src/modules/ebay/ebay.service');
const connectionRepository = require('../../src/modules/connections/connection.repository');

test.afterEach(() => {
  mock.restoreAll();
  ebayService.forgetMarketScopes();
});

const credentials = () => ({ accessToken: 't', accessTokenExpiresAt: Date.now() + 3600e3, refreshToken: 'r', marketplaceId: 'EBAY_GB' });

const listing = (itemId, host, currency) => ({
  itemId,
  title: `Item ${itemId}`,
  price: { amount: 10, currency },
  quantity: 1,
  quantityAvailable: 1,
  viewItemUrl: host ? `https://${host}/itm/${itemId}` : null,
});

const order = (orderId, { site, currency = 'GBP' } = {}) => ({
  orderId,
  status: 'Completed',
  createdAt: new Date(Date.now() - 86400e3).toISOString(),
  total: { amount: 10, currency },
  checkoutStatus: 'Complete',
  paidTime: new Date().toISOString(),
  shippedTime: null,
  cancelStatus: 'NotApplicable',
  lineItems: [{ itemId: '1', title: 'x', site: site || null, quantityPurchased: 1, price: { amount: 10, currency }, variation: [] }],
});

test('a listing is placed on its site by its URL, then by a currency only one site uses', () => {
  assert.strictEqual(marketScope.marketOfListing(listing('1', 'www.ebay.com.au', 'AUD')), 'EBAY_AU');
  assert.strictEqual(marketScope.marketOfListing(listing('2', 'www.ebay.co.uk', 'GBP')), 'EBAY_GB');
  assert.strictEqual(marketScope.marketOfListing(listing('3', 'www.ebay.de', 'EUR')), 'EBAY_DE');
  assert.strictEqual(marketScope.marketOfListing(listing('4', null, 'AUD')), 'EBAY_AU');
  // Euros alone could be any of five sites.
  assert.strictEqual(marketScope.marketOfListing(listing('5', null, 'EUR')), null);
});

test('an order is placed on its listing site, then by its currency', () => {
  assert.strictEqual(marketScope.marketOfOrder(order('A', { site: 'Australia', currency: 'AUD' })), 'EBAY_AU');
  assert.strictEqual(marketScope.marketOfOrder(order('B', { site: 'UK' })), 'EBAY_GB');
  assert.strictEqual(marketScope.marketOfOrder(order('C', { currency: 'AUD' })), 'EBAY_AU');
  assert.strictEqual(marketScope.marketOfOrder({ orderId: 'D', lineItems: [{ marketplaceId: 'EBAY_US' }] }), 'EBAY_US');
});

test('a connection keeps its own site and anything no other site of the account claims', () => {
  const uk = { own: 'EBAY_GB', claimed: ['EBAY_AU'] };
  assert.strictEqual(marketScope.keeps(uk, 'EBAY_GB'), true);
  assert.strictEqual(marketScope.keeps(uk, 'EBAY_AU'), false);
  assert.strictEqual(marketScope.keeps(uk, 'EBAY_US'), true); // not linked separately: stays visible
  assert.strictEqual(marketScope.keeps(uk, null), true);
  // Linked on one site only: everything, as before.
  const items = [listing('1', 'www.ebay.co.uk', 'GBP'), listing('2', 'www.ebay.com.au', 'AUD')];
  assert.strictEqual(marketScope.listingsIn({ own: 'EBAY_GB', claimed: [] }, items), items);
  assert.deepStrictEqual(marketScope.listingsIn(uk, items).map((i) => i.itemId), ['1']);
});

test('GetOrders asks for each line\'s listing site and maps it', async () => {
  let sent = '';
  mock.method(global, 'fetch', async (url, init) => {
    sent = init.body;
    return new Response(
      `<?xml version="1.0"?><GetOrdersResponse><Ack>Success</Ack><PaginationResult><TotalNumberOfEntries>1</TotalNumberOfEntries><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult>
       <OrderArray><Order><OrderID>O-1</OrderID><OrderStatus>Completed</OrderStatus><Total currencyID="AUD">20</Total>
       <TransactionArray><Transaction><Item><ItemID>9</ItemID><Title>Thing</Title><Site>Australia</Site></Item><QuantityPurchased>1</QuantityPurchased></Transaction></TransactionArray></Order></OrderArray></GetOrdersResponse>`,
      { status: 200 }
    );
  });
  const { orders } = await ebayTrading.getOrders('t', { orderIds: ['O-1'] });
  assert.match(sent, /Transaction\.Item\.Site/);
  assert.strictEqual(orders[0].lineItems[0].site, 'Australia');
  assert.strictEqual(marketScope.marketOfOrder(orders[0]), 'EBAY_AU');
});

test('a Fulfillment order carries its listing marketplace per line', () => {
  const mapped = ebayFulfillment.toListOrder({
    orderId: 'O-2',
    creationDate: new Date().toISOString(),
    orderPaymentStatus: 'PAID',
    pricingSummary: { total: { value: '5', currency: 'AUD' } },
    lineItems: [{ legacyItemId: '9', title: 'Thing', quantity: 1, lineItemCost: { value: '5', currency: 'AUD' }, listingMarketplaceId: 'EBAY_AU' }],
  });
  assert.strictEqual(mapped.lineItems[0].marketplaceId, 'EBAY_AU');
});

test('an account linked on two sites shows each connection only its own site\'s listings and orders', async () => {
  mock.method(connectionRepository, 'findMarketScope', async (id) =>
    id === 'mkt-uk' ? { own: 'EBAY_GB', claimed: ['EBAY_AU'] } : { own: 'EBAY_AU', claimed: ['EBAY_GB'] }
  );
  // eBay returns the account's listings and orders from both sites to either connection.
  mock.method(ebayTrading, 'getActiveListings', async () => ({
    items: [listing('1', 'www.ebay.co.uk', 'GBP'), listing('2', 'www.ebay.com.au', 'AUD'), listing('3', 'www.ebay.co.uk', 'GBP')],
    totalEntries: 3,
    totalPages: 1,
  }));
  mock.method(ebayTrading, 'getOrders', async () => ({
    orders: [order('UK-1', { site: 'UK' }), order('AU-1', { site: 'Australia', currency: 'AUD' })],
    totalEntries: 2,
    totalPages: 1,
  }));
  mock.method(ebayTrading, 'getItemSummary', async (token, itemId) => ({ itemId, imageUrl: null, quantity: null, quantityAvailable: null }));

  const ukListings = await ebayService.listListingsDetailed(credentials(), { connectionId: 'mkt-uk', status: 'active' });
  assert.deepStrictEqual(ukListings.items.map((i) => i.itemId), ['1', '3']);
  assert.strictEqual(ukListings.allCount, 2);
  const auListings = await ebayService.listListingsDetailed({ ...credentials(), marketplaceId: 'EBAY_AU' }, { connectionId: 'mkt-au', status: 'active' });
  assert.deepStrictEqual(auListings.items.map((i) => i.itemId), ['2']);

  const ukOrders = await ebayService.listOrdersDetailed(credentials(), { connectionId: 'mkt-uk', range: '30d', status: 'all', page: 1, perPage: 25 });
  assert.deepStrictEqual(ukOrders.orders.map((o) => o.orderId), ['UK-1']);
  assert.strictEqual(ukOrders.counts.all, 1);
  const auOrders = await ebayService.listOrdersDetailed({ ...credentials(), marketplaceId: 'EBAY_AU' }, { connectionId: 'mkt-au', range: '30d', status: 'all', page: 1, perPage: 25 });
  assert.deepStrictEqual(auOrders.orders.map((o) => o.orderId), ['AU-1']);

  // eBay's own active count covers both sites; a shared account counts its own.
  const count = await ebayService.countActiveListings(credentials(), 'mkt-uk');
  assert.strictEqual(count.totalEntries, 2);
});

test('amounts in different currencies are totalled apart, never added', () => {
  const money = require('../../src/utils/money');
  const split = money.splitByCurrency([{ amount: 10, currency: 'GBP' }, { amount: 191.19, currency: 'AUD' }, { amount: 5.5, currency: 'GBP' }, null], 'GBP');
  assert.deepStrictEqual(split, { main: { amount: 15.5, currency: 'GBP' }, others: [{ amount: 191.19, currency: 'AUD' }] });
  assert.deepStrictEqual(money.splitByCurrency([], 'AUD'), { main: { amount: 0, currency: 'AUD' }, others: [] });
});

test('earnings are in the account\'s own currency, with other sites\' sales beside them', async () => {
  mock.method(connectionRepository, 'findMarketScope', async () => ({ own: 'EBAY_GB', claimed: [] }));
  mock.method(ebayTrading, 'getOrders', async () => ({
    orders: [order('UK-1', { site: 'UK' }), order('AU-1', { site: 'Australia', currency: 'AUD' }), order('AU-2', { site: 'Australia', currency: 'AUD' })],
    totalEntries: 3,
    totalPages: 1,
  }));
  const result = await ebayService.getEarningsSummary(credentials(), { connectionId: 'earn-uk', range: '7d' });
  assert.deepStrictEqual(result.earnings, { amount: 10, currency: 'GBP' });
  assert.deepStrictEqual(result.otherEarnings, [{ amount: 20, currency: 'AUD' }]);
  assert.strictEqual(result.orderCount, 3);
});

test('an account\'s sites are counted from everything eBay sent, whatever the connection keeps', async () => {
  mock.method(connectionRepository, 'findMarketScope', async () => ({ own: 'EBAY_GB', claimed: ['EBAY_AU'] }));
  mock.method(ebayTrading, 'getActiveListings', async () => ({
    items: [listing('1', 'www.ebay.co.uk', 'GBP'), listing('2', 'www.ebay.com.au', 'AUD'), listing('3', 'www.ebay.com.au', 'AUD')],
    totalEntries: 3,
    totalPages: 1,
  }));
  mock.method(ebayTrading, 'getOrders', async () => ({ orders: [order('AU-1', { site: 'Australia', currency: 'AUD' })], totalEntries: 1, totalPages: 1 }));
  const sites = await ebayService.accountSites(credentials(), 'sites-uk');
  assert.deepStrictEqual(sites, [
    { marketplaceId: 'EBAY_AU', listings: 2, orders: 1 },
    { marketplaceId: 'EBAY_GB', listings: 1, orders: 0 },
  ]);
});
