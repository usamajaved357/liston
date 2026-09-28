const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const orderMessages = require('../../src/modules/orders/order-messages');
const service = require('../../src/modules/orders/order-messages.service');
const connectionService = require('../../src/modules/connections/connection.service');
const ebayService = require('../../src/modules/ebay/ebay.service');
const ebayMessage = require('../../src/modules/ebay/api/ebay.message');
const orderRepository = require('../../src/modules/orders/order.repository');

test.afterEach(() => mock.restoreAll());

const NOW = Date.parse('2026-09-28T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const order = (id, deliveredAt, over = {}) => ({
  orderId: id,
  deliveredAt,
  buyerUserId: `buyer-${id}`,
  shippingAddress: { name: 'Jane Smith' },
  lineItems: [{ itemId: '111', title: 'Cat Water Fountain 2L [Colour: Black]' }],
  ...over,
});

test('the delivered message names the buyer and the item, and goes only to orders delivered lately, once each', () => {
  const text = orderMessages.fill('Hi {buyer}, how is your {item}?', order('a', hoursAgo(1)));
  assert.strictEqual(text, 'Hi Jane, how is your Cat Water Fountain 2L?');
  assert.match(orderMessages.fill(null, order('a', hoursAgo(1))), /^Hi Jane,\n\nYour order of Cat Water Fountain 2L has been delivered/);
  assert.match(orderMessages.fill('{item}', order('a', null, { lineItems: [{ itemId: '1', title: 'Lamp' }, { itemId: '2', title: 'Bulb' }] })), /Lamp and the rest of your order/);
  assert.strictEqual(orderMessages.fill('{buyer}', order('a', null, { shippingAddress: null, buyerName: null })), 'buyer-a');

  const orders = [
    order('fresh', hoursAgo(2)),
    order('before-switch-on', hoursAgo(30)),
    order('done', hoursAgo(1)),
    order('not-delivered', null),
    order('cancelled', hoursAgo(1)),
    order('no-buyer', hoursAgo(1), { buyerUserId: null }),
  ];
  const due = orderMessages.dueOrders(orders, { since: hoursAgo(24), done: new Set(['done']), now: NOW, isCancelled: (o) => o.orderId === 'cancelled' });
  assert.deepStrictEqual(due.map((o) => o.orderId), ['fresh']);
  // Switched on long ago: still only deliveries of the last few days.
  const old = orderMessages.dueOrders([order('week', hoursAgo(24 * 7)), order('day', hoursAgo(20))], { since: hoursAgo(24 * 30), done: new Set(), now: NOW });
  assert.deepStrictEqual(old.map((o) => o.orderId), ['day']);
});

test('a run sends each due buyer the message once, keeps a refusal with its reason, and does nothing when it is switched off or eBay does not allow messaging', async () => {
  const connection = { id: 'c1', user_id: 'owner', settings: { messages: { delivered: { enabled: true, text: 'Thanks {buyer}!', enabledAt: new Date(Date.now() - 86400000).toISOString() } } } };
  const scopes = { scopes: [service.SCOPE] };
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't', marketplaceId: 'EBAY_GB', ...scopes }, { settings: { ebay: { marketplaceId: 'EBAY_GB' } } }));
  mock.method(ebayService, 'ensureValidAccessToken', async (credentials) => ({ accessToken: 't', siteId: 3, credentials, credentialsChanged: false }));
  const recent = new Date(Date.now() - 3600000).toISOString();
  mock.method(ebayService, 'getOrdersLast90Cached', async () => [order('ok', recent), order('refused', recent), order('sent-before', recent)]);
  mock.method(orderRepository, 'messagedOrderIds', async () => new Set(['sent-before']));
  const saved = mock.method(orderRepository, 'saveMessage', async () => {});
  mock.method(orderRepository, 'addEvent', async () => ({}));
  const sent = mock.method(ebayMessage, 'sendMessage', async (token, input) => {
    if (input.buyerUsername === 'buyer-refused') throw Object.assign(new Error('The buyer has blocked messages.'), { statusCode: 400 });
    return { messageId: 'm1', conversationId: 'conv-1' };
  });

  assert.strictEqual(await service.runFor(connection), 1);
  assert.deepStrictEqual(sent.mock.calls.map((c) => c.arguments[1]), [
    { buyerUsername: 'buyer-ok', itemId: '111', text: 'Thanks Jane!' },
    { buyerUsername: 'buyer-refused', itemId: '111', text: 'Thanks Jane!' },
  ]);
  assert.deepStrictEqual(saved.mock.calls.map((c) => [c.arguments[0].orderId, c.arguments[0].status, c.arguments[0].error || null]), [
    ['ok', 'sent', null],
    ['refused', 'failed', 'The buyer has blocked messages.'],
  ]);

  // Off: nothing read, nothing sent.
  sent.mock.resetCalls();
  assert.strictEqual(await service.runFor({ ...connection, settings: { messages: { delivered: { enabled: false } } } }), 0);
  // A token without the messaging scope (connected before it was asked for): nothing sent.
  scopes.scopes = [];
  assert.strictEqual(await service.runFor(connection), 0);
  assert.strictEqual(sent.mock.calls.length, 0);
});
