const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const connectionService = require('../../src/modules/connections/connection.service');
const ebayService = require('../../src/modules/ebay/ebay.service');
const orderRepository = require('../../src/modules/orders/order.repository');
const orderService = require('../../src/modules/orders/order.service');

test.afterEach(() => mock.restoreAll());

const CONNECTION = 'c1';
const USER = 'u1';

function fulfillmentOrder(overrides = {}) {
  return {
    order: {
      orderId: '04-15201-50944',
      legacyOrderId: '04-15201-50944',
      createdAt: '2026-09-20T10:26:41.000Z',
      paymentStatus: 'PAID',
      fulfillmentStatus: 'NOT_STARTED',
      cancelState: 'NONE_REQUESTED',
      cancelRequests: [],
      payments: [{ date: '2026-09-20T10:26:40.658Z' }],
      pricing: { total: { value: 4.74, currency: 'GBP' } },
      lineItems: [
        { lineItemId: 'li-1', quantity: 1, fulfillmentStatus: 'NOT_STARTED' },
        { lineItemId: 'li-2', quantity: 2, fulfillmentStatus: 'FULFILLED' },
      ],
      ...overrides,
    },
    source: 'fulfillment',
    actionsEnabled: true,
  };
}

function stubOrder(detail) {
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't', marketplaceId: 'EBAY_GB' }, {}));
  mock.method(ebayService, 'getOrderDetail', async () => detail);
}

test('dispatchOrder marks only the undispatched lines dispatched, records tracking on their sourcing rows, and logs it', async () => {
  stubOrder(fulfillmentOrder());
  let sent;
  mock.method(ebayService, 'dispatchOrder', async (credentials, input) => {
    sent = input;
    return { fulfillmentId: 'f-9' };
  });
  const upserts = mock.method(orderRepository, 'upsertSourcing', async (row) => row);
  const events = mock.method(orderRepository, 'addEvent', async (e) => e);

  const out = await orderService.dispatchOrder(CONNECTION, USER, 'actor', '04-15201-50944', { trackingNumber: 'H06R 4A02 25077758' });
  assert.deepStrictEqual(out, { fulfillmentId: 'f-9', lines: 1 });
  assert.deepStrictEqual(sent.lineItems, [{ lineItemId: 'li-1', quantity: 1 }]);
  assert.strictEqual(sent.trackingNumber, 'H06R4A0225077758', 'spaces stripped');
  assert.ok(sent.carrier, 'a carrier is detected or defaulted');
  assert.strictEqual(upserts.mock.calls.length, 1);
  assert.strictEqual(upserts.mock.calls[0].arguments[0].tracking_number, 'H06R4A0225077758');
  assert.strictEqual(events.mock.calls[0].arguments[0].kind, 'ebay.dispatched_by_liston');
});

test('dispatchOrder without tracking ("Mark as dispatched") sends no carrier or number', async () => {
  stubOrder(fulfillmentOrder());
  let sent;
  mock.method(ebayService, 'dispatchOrder', async (credentials, input) => {
    sent = input;
    return { fulfillmentId: 'f-1' };
  });
  mock.method(orderRepository, 'upsertSourcing', async (row) => row);
  mock.method(orderRepository, 'addEvent', async (e) => e);
  await orderService.dispatchOrder(CONNECTION, USER, 'actor', '04-15201-50944', {});
  assert.strictEqual(sent.trackingNumber, undefined);
  assert.strictEqual(sent.carrier, undefined);
});

test('dispatchOrder refuses when everything is already dispatched, and on a connection without order scopes', async () => {
  stubOrder(fulfillmentOrder({ lineItems: [{ lineItemId: 'li-1', quantity: 1, fulfillmentStatus: 'FULFILLED' }] }));
  await assert.rejects(() => orderService.dispatchOrder(CONNECTION, USER, 'actor', 'o', {}), /already dispatched/);
  mock.restoreAll();
  stubOrder({ ...fulfillmentOrder(), source: 'trading' });
  await assert.rejects(() => orderService.dispatchOrder(CONNECTION, USER, 'actor', 'o', {}), /Reconnect this eBay account/);
});

test('refundOrder sends a partial amount in the order currency and refuses more than the total', async () => {
  stubOrder(fulfillmentOrder());
  let sent;
  mock.method(ebayService, 'refundOrder', async (credentials, input) => {
    sent = input;
    return { refundId: 'r-1', refundStatus: 'PENDING' };
  });
  const events = mock.method(orderRepository, 'addEvent', async (e) => e);

  const out = await orderService.refundOrder(CONNECTION, USER, 'actor', '04-15201-50944', { amount: '2.5', reason: 'ITEM_NOT_AS_DESCRIBED', comment: ' Sorry ' });
  assert.deepStrictEqual(sent.amount, { value: '2.50', currency: 'GBP' });
  assert.strictEqual(sent.comment, 'Sorry');
  assert.deepStrictEqual(out, { refundId: 'r-1', status: 'PENDING', amount: { value: 2.5, currency: 'GBP' } });
  assert.strictEqual(events.mock.calls[0].arguments[0].kind, 'ebay.refunded_by_liston');

  await assert.rejects(() => orderService.refundOrder(CONNECTION, USER, 'actor', 'o', { amount: '9.99', reason: 'BUYER_CANCEL' }), /can't be more than the order total \(4.74 GBP\)/);
  await assert.rejects(() => orderService.refundOrder(CONNECTION, USER, 'actor', 'o', { amount: null, reason: 'NOPE' }), /Pick a refund reason/);
});

test('refundOrder with no amount refunds the whole order', async () => {
  stubOrder(fulfillmentOrder());
  let sent;
  mock.method(ebayService, 'refundOrder', async (credentials, input) => {
    sent = input;
    return { refundId: 'r-2', refundStatus: 'REFUNDED' };
  });
  mock.method(orderRepository, 'addEvent', async (e) => e);
  const out = await orderService.refundOrder(CONNECTION, USER, 'actor', 'o', { amount: null, reason: 'BUYER_CANCEL' });
  assert.strictEqual(sent.amount, null, 'eBay refunds in full when no amount is given');
  assert.deepStrictEqual(out.amount, { value: 4.74, currency: 'GBP' });
});

test("cancelOrder approves the buyer's open request when there is one, otherwise opens a seller cancellation", async () => {
  stubOrder(fulfillmentOrder({ cancelRequests: [{ id: 'cr-1', state: 'REQUESTED', reason: 'ORDER_MISTAKE' }] }));
  let sent;
  mock.method(ebayService, 'cancelOrder', async (credentials, input) => {
    sent = input;
    return { cancelId: input.pendingCancelId || 'new-1', approved: Boolean(input.pendingCancelId) };
  });
  const events = mock.method(orderRepository, 'addEvent', async (e) => e);

  const approved = await orderService.cancelOrder(CONNECTION, USER, 'actor', 'o', {});
  assert.strictEqual(sent.pendingCancelId, 'cr-1');
  assert.strictEqual(approved.approved, true);
  assert.strictEqual(events.mock.calls[0].arguments[0].kind, 'ebay.cancel_approved_by_liston');

  mock.restoreAll();
  stubOrder(fulfillmentOrder());
  mock.method(ebayService, 'cancelOrder', async (credentials, input) => {
    sent = input;
    return { cancelId: 'new-1', approved: false };
  });
  mock.method(orderRepository, 'addEvent', async (e) => e);
  await assert.rejects(() => orderService.cancelOrder(CONNECTION, USER, 'actor', 'o', { reason: 'BECAUSE' }), /Pick a reason/);
  await orderService.cancelOrder(CONNECTION, USER, 'actor', 'o', { reason: 'OUT_OF_STOCK_OR_CANNOT_FULFILL' });
  assert.strictEqual(sent.pendingCancelId, null);
  assert.strictEqual(sent.buyerPaid, true);
  assert.strictEqual(sent.buyerPaidDate, '2026-09-20T10:26:40.658Z');
  assert.deepStrictEqual(sent.refundAmount, { value: 4.74, currency: 'GBP' });
});

test('cancelOrder refuses a dispatched order', async () => {
  stubOrder(fulfillmentOrder({ fulfillmentStatus: 'FULFILLED' }));
  await assert.rejects(() => orderService.cancelOrder(CONNECTION, USER, 'actor', 'o', { reason: 'ADDRESS_ISSUES' }), /has been dispatched/);
});
