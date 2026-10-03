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
const mirror = require('../../src/modules/ebay/ebay-mirror.repository');

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

test("the buyer's first name: as eBay gave it, a shouted or whispered one tidied, none when eBay gave none", () => {
  assert.strictEqual(orderMessages.firstName(order('a', null, { shippingAddress: { name: 'JAVED MIAH' } })), 'Javed');
  assert.strictEqual(orderMessages.firstName(order('a', null, { shippingAddress: { name: 'sara khan' } })), 'Sara');
  assert.strictEqual(orderMessages.firstName(order('a', null, { shippingAddress: { name: 'McKenzie Ross' } })), 'McKenzie');
  assert.strictEqual(orderMessages.firstName(order('a', null, { shippingAddress: null, buyerName: 'Tom Hale' })), 'Tom');
  assert.strictEqual(orderMessages.firstName(order('a', null, { shippingAddress: null, buyerName: null })), null);
  assert.strictEqual(orderMessages.buyerName(order('a', null, { shippingAddress: { name: 'JAVED MIAH' } })), 'Javed');
});

test('the delivered message names the buyer and the item, and goes only to orders delivered lately, once each', () => {
  const text = orderMessages.fill('Hi {buyer}, how is your {item}?', order('a', hoursAgo(1)));
  assert.strictEqual(text, 'Hi Jane, how is your Cat Water Fountain 2L (Colour: Black)?');
  assert.match(orderMessages.fill(null, order('a', hoursAgo(1))), /^Hi Jane,\n\nYour order of Cat Water Fountain 2L \(Colour: Black\) has been delivered/);
  assert.match(orderMessages.fill('{item}', order('a', null, { lineItems: [{ itemId: '1', title: 'Lamp' }, { itemId: '2', title: 'Bulb' }] })), /Lamp and the rest of your order/);
  assert.strictEqual(orderMessages.fill('{buyer}', order('a', null, { shippingAddress: null, buyerName: null })), 'buyer-a');

  const orders = [
    order('fresh', hoursAgo(2)),
    order('before-switch-on', hoursAgo(30)),
    order('four-days', hoursAgo(24 * 4)),
    order('done', hoursAgo(1)),
    order('not-delivered', null),
    order('cancelled', hoursAgo(1)),
    order('no-buyer', hoursAgo(1), { buyerUserId: null }),
  ];
  const due = orderMessages.dueOrders(orders, { since: hoursAgo(24), done: new Set(['done']), now: NOW, isCancelled: (o) => o.orderId === 'cancelled' });
  // Delivered just before it was switched on still gets one; four days ago doesn't.
  assert.deepStrictEqual(due.map((o) => o.orderId), ['fresh', 'before-switch-on']);
  // Switched on long ago: still only deliveries of the last few days.
  const old = orderMessages.dueOrders([order('week', hoursAgo(24 * 7)), order('day', hoursAgo(20))], { since: hoursAgo(24 * 30), done: new Set(), now: NOW });
  assert.deepStrictEqual(old.map((o) => o.orderId), ['day']);
});

test('a run sends each due buyer the message once, keeps a refusal with its reason, and does nothing when it is switched off or eBay does not allow messaging', async () => {
  const connection = { id: 'c1', user_id: 'owner', settings: { messages: { delivered: { enabled: true, text: 'Thanks {buyer}!', enabledAt: new Date(Date.now() - 86400000).toISOString() } } } };
  const scopes = { scopes: [service.SCOPE] };
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't', marketplaceId: 'EBAY_GB', ...scopes }, { ...connection, label: 'Shop', settings: { ...connection.settings, ebay: { marketplaceId: 'EBAY_GB' } } }));
  mock.method(ebayService, 'ensureValidAccessToken', async (credentials) => ({ accessToken: 't', siteId: 3, credentials, credentialsChanged: false }));
  const recent = new Date(Date.now() - 3600000).toISOString();
  mock.method(ebayService, 'getOrdersLast90Cached', async () => [order('ok', recent), order('refused', recent), order('sent-before', recent)]);
  mock.method(orderRepository, 'messagedOrderIds', async () => new Set(['sent-before']));
  mock.method(orderRepository, 'claimMessage', async () => 'claimed');
  const saved = mock.method(orderRepository, 'finishMessage', async () => {});
  mock.method(orderRepository, 'addEvent', async () => ({}));
  mock.method(mirror, 'loadSnapshot', async () => null);
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
  assert.strictEqual(sent.mock.calls.length, 0);
  // A token without the messaging scope (connected before it was asked for): nothing sent.
  scopes.scopes = [];
  assert.strictEqual(await service.runFor(connection), 0);
  assert.strictEqual(sent.mock.calls.length, 0);
});

test('the welcome: Liston\'s wording signs off with the store, the item carries the option chosen, and the order number fills in', () => {
  const o = order('17-1', null, { createdAt: hoursAgo(1), lineItems: [{ itemId: '1', title: 'Plush Squeaky Duck Dog Toy', variation: [{ name: 'Colour', value: 'Carrot' }, { name: 'Size', value: '20CM' }] }] });
  const text = orderMessages.fill(null, o, { store: 'FlipX', kind: 'placed' });
  assert.match(text, /^Hi Jane,\n\nThank you so much for your order of Plush Squeaky Duck Dog Toy \(Colour: Carrot, Size: 20CM\)!/);
  assert.match(text, /no need to open a case with eBay/);
  assert.match(text, /Best regards,\nFlipX$/);
  assert.match(orderMessages.fill(null, o, { store: 'FlipX', kind: 'delivered' }), /Best regards,\nFlipX$/, 'the thank-you signs off the same way');
  assert.strictEqual(orderMessages.fill('Order {order} from {store}', o, { store: 'FlipX', kind: 'placed' }), 'Order 17-1 from FlipX');
  // No store to sign with: no gap left behind.
  assert.strictEqual(orderMessages.fill('Thanks!\n\n\n{store}', o, { kind: 'placed' }), 'Thanks!');
});

test('a welcome is due for the last day\'s orders, those from just before it was switched on too, paid and not dispatched, not already messaged', () => {
  const placed = (id, h, over = {}) => order(id, null, { createdAt: hoursAgo(h), ...over });
  const status = { unpaid: 'awaiting_payment', shipped: 'dispatched', cancelled: 'cancelled' };
  const orders = [
    placed('new', 0.1),
    placed('before-switch-on', 5),
    placed('yesterday', 30),
    placed('done', 0.5),
    placed('unpaid', 0.5),
    placed('shipped', 0.5),
    placed('cancelled', 0.5),
    placed('no-buyer', 0.5, { buyerUserId: null }),
    placed('no-item', 0.5, { lineItems: [] }),
  ];
  const due = orderMessages.placedDue(orders, { since: hoursAgo(2), done: new Set(['done']), now: NOW, statusOf: (o) => status[o.orderId] || 'awaiting_dispatch' });
  // Placed 5 hours ago, before it was switched on 2 hours ago, and still waiting: welcomed. Over a day old: not.
  assert.deepStrictEqual(due.map((o) => o.orderId), ['new', 'before-switch-on']);
  // Switched on long ago: still only the last day's orders, never the backlog.
  const old = orderMessages.placedDue([placed('two-days', 48), placed('today', 20)], { since: hoursAgo(24 * 30), done: new Set(), now: NOW });
  assert.deepStrictEqual(old.map((o) => o.orderId), ['today']);
  // Never switched on: nothing.
  assert.deepStrictEqual(orderMessages.placedDue([placed('x', 0.1)], { since: null, done: new Set(), now: NOW }), []);
});

test("a pushed order is welcomed once: sent when it's on and due, left alone when off, not due, already claimed or the buyer was welcomed today", async () => {
  const settings = { messages: { placed: { enabled: true, text: null, enabledAt: new Date(Date.now() - 86400000).toISOString() } }, ebay: { marketplaceId: 'EBAY_GB' }, template: { storeName: 'FlipX' } };
  const full = { id: 'c1', label: 'FlipX account', settings };
  const credentials = { accessToken: 't', marketplaceId: 'EBAY_GB', scopes: [service.SCOPE] };
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action(credentials, full));
  mock.method(ebayService, 'ensureValidAccessToken', async (c) => ({ accessToken: 't', siteId: 3, credentials: c, credentialsChanged: false }));
  mock.method(orderRepository, 'messagedOrderIds', async () => new Set());
  const claims = ['claimed', 'taken', 'skipped'];
  const claim = mock.method(orderRepository, 'claimMessage', async () => claims.shift());
  const finished = mock.method(orderRepository, 'finishMessage', async () => {});
  mock.method(orderRepository, 'addEvent', async () => ({}));
  const sent = mock.method(ebayMessage, 'sendMessage', async () => ({ messageId: 'm1', conversationId: 'conv-1' }));
  const fresh = order('17-9', null, { createdAt: new Date().toISOString(), checkoutStatus: 'Complete', status: 'Completed', cancelStatus: 'NotApplicable', shippedTime: null });

  assert.strictEqual(await service.welcomeOrder('c1', 'owner', fresh), 'sent');
  assert.strictEqual(sent.mock.calls.length, 1);
  const input = sent.mock.calls[0].arguments[1];
  assert.deepStrictEqual([input.buyerUsername, input.itemId], ['buyer-17-9', '111']);
  assert.match(input.text, /^Hi Jane,[\s\S]*Best regards,\nFlipX$/);
  assert.deepStrictEqual(claim.mock.calls[0].arguments[0].buyerGapHours, 24, 'one welcome a day per buyer');
  assert.deepStrictEqual(finished.mock.calls.map((c) => c.arguments[0].status), ['sent']);

  // The hourly run (or a second push) finds it claimed; a buyer welcomed today is skipped: neither sends.
  assert.strictEqual(await service.welcomeOrder('c1', 'owner', fresh), 'taken');
  assert.strictEqual(await service.welcomeOrder('c1', 'owner', fresh), 'skipped');
  assert.strictEqual(sent.mock.calls.length, 1);

  // Dispatched already, or switched off: not even claimed.
  const claimsBefore = claim.mock.calls.length;
  assert.strictEqual(await service.welcomeOrder('c1', 'owner', { ...fresh, shippedTime: new Date().toISOString() }), 'not-due');
  settings.messages.placed.enabled = false;
  assert.strictEqual(await service.welcomeOrder('c1', 'owner', fresh), 'off');
  assert.strictEqual(claim.mock.calls.length, claimsBefore);
  assert.strictEqual(sent.mock.calls.length, 1);
});

test('the hourly run welcomes new orders a push missed, reading only what push keeps current', async () => {
  const enabledAt = new Date(Date.now() - 86400000).toISOString();
  const connection = { id: 'c1', user_id: 'owner', label: 'FlipX', settings: { messages: { placed: { enabled: true, text: 'Thanks {buyer}, {store}', enabledAt } }, ebay: { marketplaceId: 'EBAY_GB', orderPush: { subscriptionId: 's', lastReceivedAt: new Date().toISOString() } } } };
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't', marketplaceId: 'EBAY_GB', scopes: [service.SCOPE] }, connection));
  mock.method(ebayService, 'ensureValidAccessToken', async (c) => ({ accessToken: 't', siteId: 3, credentials: c, credentialsChanged: false }));
  const now = new Date().toISOString();
  const paid = { checkoutStatus: 'Complete', status: 'Completed', cancelStatus: 'NotApplicable', shippedTime: null };
  const read = mock.method(ebayService, 'getOrdersLast90Cached', async () => [order('missed', null, { createdAt: now, ...paid }), order('welcomed', null, { createdAt: now, ...paid })]);
  mock.method(orderRepository, 'messagedOrderIds', async () => new Set(['welcomed']));
  mock.method(orderRepository, 'claimMessage', async () => 'claimed');
  mock.method(orderRepository, 'finishMessage', async () => {});
  mock.method(orderRepository, 'addEvent', async () => ({}));
  mock.method(mirror, 'loadSnapshot', async () => null);
  const sent = mock.method(ebayMessage, 'sendMessage', async () => ({ conversationId: 'conv' }));

  assert.strictEqual(await service.runFor(connection), 1);
  assert.deepStrictEqual(sent.mock.calls.map((c) => [c.arguments[1].buyerUsername, c.arguments[1].text]), [['buyer-missed', 'Thanks Jane, FlipX']]);
  assert.deepStrictEqual(read.mock.calls[0].arguments[3], { listings: false, orders: true }, 'push arriving: the stored orders, no extra eBay read');
});
