const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { mock } = require('node:test');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const config = require('../../src/config');
const appState = require('../../src/db/app-state.repository');
const authService = require('../../src/modules/auth/auth.service');
const connectionService = require('../../src/modules/connections/connection.service');
const connectionRepository = require('../../src/modules/connections/connection.repository');
const accountEvents = require('../../src/modules/ebay/account-events');
const notificationApi = require('../../src/modules/ebay/api/ebay.notification-api');
const appToken = require('../../src/modules/ebay/api/ebay.app-token');
const ebayPush = require('../../src/modules/ebay/ebay-push');
const mirror = require('../../src/modules/ebay/ebay-mirror.repository');
const commerce = require('../../src/modules/ebay/commerce-notifications');

// Against the real local DB and the real HTTP app (fixture users are
// @example.com, removed by tests/cleanup.js). eBay is mocked at fetch;
// requests to the test server itself pass through.

const realFetch = global.fetch;
const app = createApp();
let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test.afterEach(() => mock.restoreAll());

const SCOPES = ['sell.fulfillment', 'sell.listing', 'commerce.notification.subscription'].map((s) => `https://api.ebay.com/oauth/api_scope/${s}`);

async function fixture(ebay = {}) {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { user } = await authService.signup({ email, password: 'testpassword123' });
  const connection = await connectionService.createConnection(user.id, {
    platformKey: 'ebay',
    label: 'Push test',
    credentials: { accessToken: 'user-token', refreshToken: 'r', accessTokenExpiresAt: Date.now() + 3600e3, scopes: SCOPES, marketplaceId: 'EBAY_GB' },
  });
  const seller = { userId: `u-${crypto.randomUUID()}`, username: `seller-${crypto.randomUUID().slice(0, 8)}` };
  await connectionRepository.mergeEbaySettings(connection.id, { ...seller, ...ebay });
  return { userId: user.id, connectionId: connection.id, seller };
}

const settingsOf = async (id) => (await pool.query('SELECT settings FROM connections WHERE id = $1', [id])).rows[0].settings.ebay;

/** Mocks eBay at fetch: `routes` maps a URL substring to (url, init) => { status, body, location }. */
function mockEbay(routes) {
  const calls = [];
  mock.method(global, 'fetch', async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(baseUrl)) return realFetch(url, init);
    calls.push({ url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const route = Object.keys(routes).find((k) => u.includes(k) && (!routes[k].method || routes[k].method === (init.method || 'GET')));
    if (!route) throw new Error(`Unexpected eBay call in test: ${init.method || 'GET'} ${u}`);
    const { status = 200, body = {}, location = null } = routes[route].reply(u, init);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(location ? { Location: location } : {}) } });
  });
  return calls;
}

function signer() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).replace(/\n/g, '');
  mock.method(notificationApi, 'getPublicKey', async (kid) => (kid === 'k1' ? { key: pem, algorithm: 'ECDSA', digest: 'SHA1' } : null));
  return (body) => Buffer.from(JSON.stringify({ alg: 'ECDSA', kid: 'k1', signature: crypto.sign('sha1', Buffer.from(body), privateKey).toString('base64'), digest: 'SHA1' })).toString('base64');
}

const orderPushPayload = (seller, orderId) => ({
  metadata: { topic: 'ORDER_CONFIRMATION', schemaVersion: '1.0', deprecated: false },
  notification: { notificationId: crypto.randomUUID(), eventDate: new Date().toISOString(), publishDate: new Date().toISOString(), publishAttemptCount: 1, data: { user: seller, order: { orderId, orderLineItems: [{ orderLineItemId: 'li-1', listingId: '4071', quantity: 1 }] } } },
});

const fulfillmentOrder = (orderId) => ({
  orderId,
  creationDate: new Date().toISOString(),
  orderPaymentStatus: 'PAID',
  cancelStatus: { cancelState: 'NONE_REQUESTED' },
  buyer: { username: 'buyer_1', buyerRegistrationAddress: { fullName: 'Ann Buyer' } },
  pricingSummary: { priceSubtotal: { value: '4.50', currency: 'GBP' }, total: { value: '4.50', currency: 'GBP' } },
  lineItems: [{ legacyItemId: '4071', title: 'Garden light', quantity: 1, lineItemCost: { value: '4.50', currency: 'GBP' } }],
});

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test('a signed new-order push puts the order on the list within seconds, with one Fulfillment call and no Trading call', async () => {
  const { connectionId, seller } = await fixture({ orderPush: { subscriptionId: 's-1' } });
  const orderId = `12-${Date.now()}`;
  const events = [];
  mock.method(accountEvents, 'emitUpdated', (id, kind) => events.push([String(id), kind]));
  const calls = mockEbay({ '/sell/fulfillment/v1/order/': { reply: () => ({ body: fulfillmentOrder(orderId) }) } });
  const sign = signer();

  const body = JSON.stringify(orderPushPayload(seller, orderId));
  const res = await realFetch(`${baseUrl}/api/ebay/commerce-notifications`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EBAY-SIGNATURE': sign(body) }, body });
  assert.strictEqual(res.status, 204, 'eBay gets its 2xx straight away');

  const row = await until(async () => (await pool.query('SELECT data FROM ebay_orders WHERE connection_id = $1 AND order_id = $2', [connectionId, orderId])).rows[0]);
  assert.ok(row, 'the order is in the list');
  assert.deepStrictEqual([row.data.buyerUserId, row.data.status, row.data.itemId], ['buyer_1', 'Completed', '4071']);
  // eBay has its 204 before the work finishes: wait for the page event too.
  assert.ok(await until(() => events.some(([id, kind]) => id === String(connectionId) && kind === 'orders')), 'open Orders pages are told');
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.includes(`/sell/fulfillment/v1/order/${orderId}`));
  assert.ok(!calls.some((c) => c.url.includes('/ws/api.dll')), 'no Trading call');
  const ebay = await settingsOf(connectionId);
  assert.ok(ebay.orderPush.lastReceivedAt, 'the receipt is recorded');
  assert.strictEqual(ebay.orderPush.subscriptionId, 's-1', 'without dropping the subscription');
});

test('an unsigned or tampered push is refused and changes nothing', async () => {
  const { connectionId, seller } = await fixture({ orderPush: { subscriptionId: 's-1' } });
  const calls = mockEbay({});
  const sign = signer();
  const body = JSON.stringify(orderPushPayload(seller, '99-1'));
  const tampered = body.replace('99-1', '99-2');
  const res = await realFetch(`${baseUrl}/api/ebay/commerce-notifications`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EBAY-SIGNATURE': sign(body) }, body: tampered });
  assert.strictEqual(res.status, 412);
  const none = await realFetch(`${baseUrl}/api/ebay/commerce-notifications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.strictEqual(none.status, 412);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(calls.length, 0);
  assert.strictEqual((await settingsOf(connectionId)).orderPush.lastReceivedAt, undefined);
});

test('eBay’s endpoint check is answered with the challenge hash', async () => {
  const res = await realFetch(`${baseUrl}/api/ebay/commerce-notifications?challenge_code=abc123`);
  const data = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(data.challengeResponse, commerce.challengeResponse('abc123', config.ebay.commerceNotificationsToken, config.ebay.commerceNotificationsUrl));
});

test('subscribing an account: one destination for the app, one subscription per seller and topic (new orders, listings), idempotent', async () => {
  const saved = await appState.get('ebay-commerce-destination');
  await pool.query("DELETE FROM app_state WHERE key = 'ebay-commerce-destination'");
  try {
    const { userId, connectionId } = await fixture();
    mock.method(appToken, 'getApplicationToken', async () => 'app-token');
    let subscriptions = [];
    const calls = mockEbay({
      '/commerce/identity/v1/user/': { reply: () => ({ body: { userId: 'u-immutable-1', username: 'walexo_seller' } }) },
      '/commerce/notification/v1/destination': { method: 'GET', reply: () => ({ body: { destinations: [] } }) },
      '/commerce/notification/v1/subscription?': { method: 'GET', reply: () => ({ body: { subscriptions } }) },
      '/test': { method: 'POST', reply: () => ({ status: 202 }) },
      '/commerce/notification/v1/subscription': {
        method: 'POST',
        reply: (u, init) => {
          const req = JSON.parse(init.body);
          const subscriptionId = `s-${req.topicId}`;
          subscriptions.push({ subscriptionId, topicId: req.topicId, destinationId: req.destinationId, status: 'ENABLED' });
          return { status: 201, location: `https://api.ebay.com/commerce/notification/v1/subscription/${subscriptionId}` };
        },
      },
    });
    // Creating the destination makes eBay call our endpoint back; stood in for here.
    const createDestination = mock.method(notificationApi, 'createDestination', async () => 'd-1');

    const first = await ebayPush.subscribeConnection(connectionId, userId);
    assert.deepStrictEqual(first.topics, { ORDER_CONFIRMATION: 's-ORDER_CONFIRMATION', LISTING: 's-LISTING' });
    assert.strictEqual(createDestination.mock.callCount(), 1);
    const created = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/commerce/notification/v1/subscription'));
    assert.deepStrictEqual(created.map((c) => c.body), ['ORDER_CONFIRMATION', 'LISTING'].map((topicId) => ({ topicId, status: 'ENABLED', destinationId: 'd-1', payload: { format: 'JSON', schemaVersion: '1.0', deliveryProtocol: 'HTTPS' } })));
    assert.strictEqual(calls.filter((c) => c.url.endsWith('/test')).length, 2, 'eBay is asked for a test push per topic');
    const ebay = await settingsOf(connectionId);
    assert.deepStrictEqual([ebay.userId, ebay.username, ebay.orderPush.subscriptionId, ebay.listingPush.subscriptionId, ebay.orderPush.destinationId], ['u-immutable-1', 'walexo_seller', 's-ORDER_CONFIRMATION', 's-LISTING', 'd-1']);

    // Again: the stored destination and the existing subscriptions are reused.
    await ebayPush.subscribeConnection(connectionId, userId);
    assert.strictEqual(createDestination.mock.callCount(), 1);
    assert.strictEqual(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/commerce/notification/v1/subscription')).length, 2);
  } finally {
    await pool.query("DELETE FROM app_state WHERE key = 'ebay-commerce-destination'");
    if (saved) await appState.set('ebay-commerce-destination', saved);
  }
});

const listing = (itemId, title, quantityAvailable, extra = {}) => ({ itemId, sku: null, title, price: { amount: 4.5, currency: 'GBP' }, convertedPrice: null, quantity: quantityAvailable, quantityAvailable, quantitySold: 0, imageUrl: null, viewItemUrl: null, startTime: null, endTime: null, watchCount: 0, ...extra });
const getItemXml = (id, title, price, status = 'Active') =>
  `<?xml version="1.0" encoding="UTF-8"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Item><ItemID>${id}</ItemID><Title>${title}</Title><Quantity>7</Quantity><QuantityAvailable>7</QuantityAvailable><SellingStatus><CurrentPrice currencyID="GBP">${price}</CurrentPrice><QuantitySold>0</QuantitySold><ListingStatus>${status}</ListingStatus></SellingStatus><WatchCount>2</WatchCount></Item></GetItemResponse>`;

test('listing pushes: ended ones leave, a sale’s update needs no read, others are read one by one with GetItem', async () => {
  const { connectionId, seller } = await fixture({ orderPush: { subscriptionId: 's-1' }, listingPush: { subscriptionId: 's-2' } });
  await mirror.saveSnapshot(connectionId, 'listings:active', { items: [listing('4071', 'Garden light', 5), listing('4072', 'Fishing line', 3), listing('4073', 'Bird feeder', 2)] }, { totalPages: 1 });
  const orderId = `12-${Date.now()}`;
  const calls = mockEbay({
    '/sell/fulfillment/v1/order/': { reply: () => ({ body: fulfillmentOrder(orderId) }) },
    '/ws/api.dll': {
      method: 'POST',
      reply: () => ({ body: {} }),
    },
  });
  // Trading answers XML: served here by item id.
  const tradingXml = { 4072: getItemXml('4072', 'Fishing line 100m', '5.25'), 5000: getItemXml('5000', 'New lamp', '12.00') };
  const fetchMock = global.fetch;
  mock.method(global, 'fetch', async (url, init = {}) => {
    if (String(url).includes('/ws/api.dll')) {
      const id = String(init.body).match(/<ItemID>(\d+)<\/ItemID>/)[1];
      calls.push({ url: String(url), method: 'POST', body: { call: init.headers['X-EBAY-API-CALL-NAME'], id } });
      return new Response(tradingXml[id], { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }
    return fetchMock(url, init);
  });
  const sign = signer();
  const post = async (payload) => {
    const body = JSON.stringify(payload);
    const res = await realFetch(`${baseUrl}/api/ebay/commerce-notifications`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EBAY-SIGNATURE': sign(body) }, body });
    assert.strictEqual(res.status, 204);
  };
  const listingPush = (listingId, reason) => ({ metadata: { topic: 'LISTING', schemaVersion: '1.0' }, notification: { notificationId: crypto.randomUUID(), publishAttemptCount: 1, data: { listingId, reason, user: seller } } });

  await post(orderPushPayload(seller, orderId)); // sells 1 of 4071
  await until(async () => (await pool.query('SELECT 1 FROM ebay_orders WHERE connection_id = $1 AND order_id = $2', [connectionId, orderId])).rows[0]);
  await post(listingPush('4071', 'UPDATED')); // eBay's quantity update for that sale
  await post(listingPush('4072', 'UPDATED')); // a price edit in Seller Hub
  await post(listingPush('4073', 'ENDED'));
  await post(listingPush('5000', 'CREATED'));
  await post(listingPush('4072', 'UPDATED')); // a retry: gathered with the first
  // Each push is handled after its 204: wait for all four listings to be gathered.
  assert.ok(await until(() => ebayPush._pendingCount(connectionId) === 4));
  const [summary] = await ebayPush._flushAll();

  assert.deepStrictEqual(summary, { changes: 4, ended: 1, fromSales: 1, reads: 2, fullRead: false });
  const trading = calls.filter((c) => c.url.includes('/ws/api.dll'));
  assert.deepStrictEqual(trading.map((c) => [c.body.call, c.body.id]).sort(), [['GetItem', '4072'], ['GetItem', '5000']], 'one light GetItem per changed listing, none for the sale or the end');
  const items = (await mirror.loadSnapshot(connectionId, 'listings:active')).value.items;
  const byId = Object.fromEntries(items.map((i) => [i.itemId, i]));
  assert.deepStrictEqual(Object.keys(byId).sort(), ['4071', '4072', '5000']);
  assert.strictEqual(byId['4071'].quantityAvailable, 4, 'the sale, from the order push');
  assert.deepStrictEqual([byId['4072'].title, byId['4072'].price.amount, byId['4072'].watchCount], ['Fishing line 100m', 5.25, 2]);
  assert.strictEqual(byId['5000'].title, 'New lamp');
  assert.ok((await settingsOf(connectionId)).listingPush.lastReceivedAt);
});

test('an account connected without the notification permission isn’t subscribed and is told to reconnect', async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { user } = await authService.signup({ email, password: 'testpassword123' });
  const connection = await connectionService.createConnection(user.id, {
    platformKey: 'ebay',
    label: 'Old scopes',
    credentials: { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: Date.now() + 3600e3, scopes: ['https://api.ebay.com/oauth/api_scope/sell.inventory'] },
  });
  const calls = mockEbay({});
  await assert.rejects(ebayPush.subscribeConnection(connection.id, user.id), (err) => err.code === 'EBAY_SCOPE_MISSING');
  assert.strictEqual(calls.length, 0);
});
