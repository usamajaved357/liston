const test = require('node:test');
const assert = require('node:assert');
const { trackingDue, ofListOrder, ofDetail } = require('../../src/modules/orders/order-tracking');

const NOW = Date.parse('2026-10-03T12:00:00Z');
const hours = (h) => new Date(NOW + h * 60 * 60 * 1000).toISOString();

const listOrder = (overrides = {}) => ({
  orderId: '01-1',
  derivedStatus: 'awaiting_dispatch',
  dispatchByTime: hours(-5),
  markedDispatched: null,
  lineItems: [{ trackingNumber: null, estimatedDeliveryMax: hours(24 * 6) }],
  ...overrides,
});

test("tracking is overdue once eBay's dispatch-by has passed with none on eBay, and due in its last 24 hours", () => {
  assert.deepStrictEqual(trackingDue({ dispatchBy: hours(-5), tracked: false, open: true }, NOW), { state: 'overdue', by: hours(-5) });
  assert.deepStrictEqual(trackingDue({ dispatchBy: hours(6), tracked: false, open: true }, NOW), { state: 'soon', by: hours(6) });
  assert.strictEqual(trackingDue({ dispatchBy: hours(30), tracked: false, open: true }, NOW), null, 'more than a day to go');
  assert.strictEqual(trackingDue({ dispatchBy: hours(-5), tracked: true, open: true }, NOW), null, 'tracking is on eBay');
  assert.strictEqual(trackingDue({ dispatchBy: hours(-5), tracked: false, open: false }, NOW), null, 'cancelled, unpaid or delivered');
  assert.strictEqual(trackingDue({ dispatchBy: null, tracked: false, open: true }, NOW), null, 'no deadline known');
});

test("it stops counting a month past the buyer's last delivery day, when there's nothing left to add tracking for", () => {
  assert.ok(trackingDue({ dispatchBy: hours(-24 * 20), tracked: false, open: true, deliveryBy: hours(-24 * 10) }, NOW));
  assert.strictEqual(trackingDue({ dispatchBy: hours(-24 * 50), tracked: false, open: true, deliveryBy: hours(-24 * 31) }, NOW), null);
  // No delivery day known: a month past the dispatch-by.
  assert.strictEqual(trackingDue({ dispatchBy: hours(-24 * 31), tracked: false, open: true }, NOW), null);
});

test('an order on the Orders page: waiting to go, or marked dispatched without tracking, owes it; tracked or closed ones never', () => {
  assert.strictEqual(ofListOrder(listOrder(), NOW).state, 'overdue');
  // Marked dispatched (in Seller Hub or from Liston) with no number: eBay still wants one.
  assert.strictEqual(ofListOrder(listOrder({ derivedStatus: 'dispatched', markedDispatched: { tracked: false } }), NOW).state, 'overdue');
  // Dispatched from Liston with a number, before eBay's feed shows it.
  assert.strictEqual(ofListOrder(listOrder({ derivedStatus: 'dispatched', markedDispatched: { tracked: true } }), NOW), null);
  assert.strictEqual(ofListOrder(listOrder({ lineItems: [{ trackingNumber: 'H06R4A0218426976' }] }), NOW), null);
  for (const derivedStatus of ['delivered', 'cancelled', 'awaiting_payment']) assert.strictEqual(ofListOrder(listOrder({ derivedStatus }), NOW), null, derivedStatus);
  assert.strictEqual(ofListOrder(listOrder({ dispatchByTime: hours(10) }), NOW).state, 'soon');
});

test("an order's own page reads the same from eBay's Fulfillment shape", () => {
  const detail = {
    paymentStatus: 'PAID',
    cancelState: 'NONE_REQUESTED',
    deliveredAt: null,
    estimatedDelivery: { min: hours(24 * 3), max: hours(24 * 6) },
    lineItems: [{ shipByDate: hours(-2) }, { shipByDate: hours(20) }],
    fulfillments: [],
  };
  assert.deepStrictEqual(ofDetail(detail, NOW), { state: 'overdue', by: hours(-2) }, 'the earliest line decides');
  assert.strictEqual(ofDetail({ ...detail, fulfillments: [{ trackingNumber: null }] }, NOW).state, 'overdue', 'dispatched with no number');
  assert.strictEqual(ofDetail({ ...detail, fulfillments: [{ trackingNumber: 'AB123456789GB' }] }, NOW), null);
  assert.strictEqual(ofDetail({ ...detail, cancelState: 'CANCELED' }, NOW), null);
  assert.strictEqual(ofDetail({ ...detail, paymentStatus: 'FULLY_REFUNDED' }, NOW), null);
  assert.strictEqual(ofDetail({ ...detail, deliveredAt: hours(-1) }, NOW), null);
});
