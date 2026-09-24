const test = require('node:test');
const assert = require('node:assert');

const { sortOrders, sortFor } = require('../../src/modules/orders/order-sort');

const order = (orderId, over = {}) => ({ orderId, createdAt: '2026-09-20T10:00:00Z', paidTime: null, dispatchByTime: null, total: { amount: 5, currency: 'GBP' }, ...over });
const ORDERS = [
  order('a', { paidTime: '2026-09-21T10:00:00Z', dispatchByTime: '2026-09-25T23:00:00Z', total: { amount: 9 } }),
  order('b', { paidTime: '2026-09-23T10:00:00Z', dispatchByTime: '2026-09-24T23:00:00Z', total: { amount: 4.74 } }),
  order('c', { paidTime: '2026-09-22T10:00:00Z', total: { amount: 18.5 } }), // no deadline known
  order('d', { paidTime: '2026-09-20T10:00:00Z', dispatchByTime: '2026-09-24T23:00:00Z', total: { amount: 6.99 } }),
];
const ids = (list) => list.map((o) => o.orderId);

test('newest paid first by default; Awaiting dispatch defaults to the nearest deadline', () => {
  assert.deepStrictEqual(ids(sortOrders(ORDERS)), ['b', 'c', 'a', 'd']);
  assert.strictEqual(sortFor(undefined, 'awaiting_dispatch'), 'dispatch_soonest');
  assert.strictEqual(sortFor(undefined, 'dispatched'), 'newest');
  assert.strictEqual(sortFor('newest', 'awaiting_dispatch'), 'newest', 'a chosen sort wins');
  assert.strictEqual(sortFor('nonsense', 'all'), 'newest');
});

test('each sort puts the right orders on top', () => {
  assert.deepStrictEqual(ids(sortOrders(ORDERS, 'oldest')), ['d', 'a', 'c', 'b']);
  assert.deepStrictEqual(ids(sortOrders(ORDERS, 'dispatch_soonest')), ['d', 'b', 'a', 'c'], 'same deadline: the older order first; unknown deadline last');
  assert.deepStrictEqual(ids(sortOrders(ORDERS, 'total_high')), ['c', 'a', 'd', 'b']);
});
