const test = require('node:test');
const assert = require('node:assert');

const { supplierState, FILTERS } = require('../../src/modules/orders/order-supplier');
const analyticsDays = require('../../src/modules/analytics/analytics-days');
const marketplaces = require('../../src/modules/ebay/marketplaces');

test('an order with nothing ordered from the supplier yet is pending', () => {
  assert.strictEqual(supplierState([], 1), 'pending');
  assert.strictEqual(supplierState(['to_order'], 1), 'pending');
  // Two lines, one ordered: the other still has to be.
  assert.strictEqual(supplierState(['ordered'], 2), 'pending');
});

test('an order dispatched or cancelled on eBay with no supplier order in Liston is untracked, not pending', () => {
  assert.strictEqual(supplierState([], 1, { settled: true }), 'untracked');
  assert.strictEqual(supplierState(['delivered'], 1, { settled: true }), 'delivered');
  assert.strictEqual(supplierState([], 1, { settled: false }), 'pending');
});

test('an order is as far along as its least advanced line, and a problem shows first', () => {
  assert.strictEqual(supplierState(['shipped', 'ordered'], 2), 'ordered');
  assert.strictEqual(supplierState(['delivered', 'shipped'], 2), 'shipped');
  assert.strictEqual(supplierState(['delivered'], 1), 'delivered');
  assert.strictEqual(supplierState(['problem', 'to_order'], 2), 'problem');
  assert.deepStrictEqual(FILTERS, ['any', 'pending', 'ordered', 'shipped', 'delivered', 'problem']);
});

test('a viewer’s time zone is taken only when it is a real one', () => {
  assert.strictEqual(analyticsDays.validTimeZone('Asia/Karachi'), 'Asia/Karachi');
  assert.strictEqual(analyticsDays.validTimeZone('Mars/Olympus'), null);
  assert.strictEqual(analyticsDays.validTimeZone(''), null);
  assert.strictEqual(analyticsDays.validTimeZone(['Europe/London']), null);
});

test('every account carries its eBay site’s time zone', () => {
  assert.strictEqual(marketplaces.summary('EBAY_GB').timeZone, 'Europe/London');
  assert.strictEqual(marketplaces.summary('EBAY_US').timeZone, 'America/Los_Angeles');
  for (const m of marketplaces.MARKETPLACES) assert.ok(analyticsDays.validTimeZone(marketplaces.summary(m.id).timeZone), m.id);
});
