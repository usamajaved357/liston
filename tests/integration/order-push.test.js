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
const orderPush = require('../../src/modules/ebay/order-push');
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

const SCOPES = ['https://api.ebay.com/oauth/api_scope/sell.fulfillment', 'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription'];

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
  assert.ok(events.some(([id, kind]) => id === String(connectionId) && kind === 'orders'), 'open Orders pages are told');
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

test('subscribing an account: one destination for the app, one ORDER_CONFIRMATION subscription per seller, idempotent', async () => {
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
          subscriptions = [{ subscriptionId: 's-9', topicId: req.topicId, destinationId: req.destinationId, status: 'ENABLED' }];
          return { status: 201, location: 'https://api.ebay.com/commerce/notification/v1/subscription/s-9' };
        },
      },
    });
    // Creating the destination makes eBay call our endpoint back; stood in for here.
    const createDestination = mock.method(notificationApi, 'createDestination', async () => 'd-1');

    const first = await orderPush.subscribeConnection(connectionId, userId);
    assert.strictEqual(first.subscriptionId, 's-9');
    assert.strictEqual(createDestination.mock.callCount(), 1);
    const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/commerce/notification/v1/subscription'));
    assert.deepStrictEqual(created.body, { topicId: 'ORDER_CONFIRMATION', status: 'ENABLED', destinationId: 'd-1', payload: { format: 'JSON', schemaVersion: '1.0', deliveryProtocol: 'HTTPS' } });
    assert.ok(calls.some((c) => c.url.endsWith('/subscription/s-9/test')), 'eBay is asked for a test push');
    const ebay = await settingsOf(connectionId);
    assert.deepStrictEqual([ebay.userId, ebay.username, ebay.orderPush.subscriptionId, ebay.orderPush.destinationId], ['u-immutable-1', 'walexo_seller', 's-9', 'd-1']);

    // Again: the stored destination and the existing subscription are reused.
    const creates = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/commerce/notification/v1/subscription')).length;
    await orderPush.subscribeConnection(connectionId, userId);
    assert.strictEqual(createDestination.mock.callCount(), 1);
    assert.strictEqual(creates(), 1);
  } finally {
    await pool.query("DELETE FROM app_state WHERE key = 'ebay-commerce-destination'");
    if (saved) await appState.set('ebay-commerce-destination', saved);
  }
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
  await assert.rejects(orderPush.subscribeConnection(connection.id, user.id), (err) => err.code === 'EBAY_SCOPE_MISSING');
  assert.strictEqual(calls.length, 0);
});
