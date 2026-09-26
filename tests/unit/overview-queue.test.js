const test = require('node:test');
const assert = require('node:assert');

const { countQueue } = require('../../src/modules/overview/order-queue');

test("the account Overview's queue counts the chosen dates' orders by state, archived ones left out", () => {
  const orders = [
    { orderId: '1', state: 'awaiting_dispatch' },
    { orderId: '2', state: 'awaiting_dispatch' },
    { orderId: '3', state: 'dispatched' },
    { orderId: '4', state: 'delivered' },
    { orderId: '5', state: 'cancelled' },
    { orderId: '6', state: 'awaiting_payment' },
    { orderId: '7', state: 'delivered' },
  ];
  const counts = countQueue(orders, (o) => o.state, ['7']);
  assert.deepStrictEqual(counts, { all: 6, awaiting_payment: 1, awaiting_dispatch: 2, dispatched: 1, delivered: 1, cancelled: 1 });
  assert.deepStrictEqual(countQueue([], (o) => o.state), { all: 0, awaiting_payment: 0, awaiting_dispatch: 0, dispatched: 0, delivered: 0, cancelled: 0 });
});
