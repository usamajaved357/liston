const test = require('node:test');
const assert = require('node:assert');
const { orderMoney } = require('../../src/modules/orders/order-money');

// What one order made, as the Inbox's details panel shows it.

const row = { currency: 'GBP', gross: 10.23, fees: 2.1, adFees: 0.52, refunds: 0, earnings: 8.13, fundsStatus: 'Available' };

test("eBay's fees are shown apart from the promoted-listing fee, and profit is earnings less the supplier cost", () => {
  assert.deepStrictEqual(orderMoney(row, { value: 4.2, currency: 'GBP' }), {
    currency: 'GBP',
    gross: 10.23,
    fees: 1.58,
    adFees: 0.52,
    refunds: 0,
    earnings: 8.13,
    fundsStatus: 'Available',
    cost: { value: 4.2, currency: 'GBP' },
    profit: 3.93,
    margin: 38.4,
    unavailable: null,
  });
});

test('a refund comes off the earnings eBay posted, and profit can go below nothing', () => {
  const money = orderMoney({ ...row, refunds: 10.23, earnings: -2.1 }, { value: 4.2, currency: 'GBP' });
  assert.strictEqual(money.refunds, 10.23);
  assert.strictEqual(money.profit, -6.3);
  assert.strictEqual(money.margin, -61.6);
});

test('without a supplier cost, or with one in another currency, there is no profit', () => {
  assert.strictEqual(orderMoney(row, null).profit, null);
  assert.strictEqual(orderMoney(row, null).cost, null);
  const usd = orderMoney(row, { value: 5, currency: 'USD' });
  assert.deepStrictEqual(usd.cost, { value: 5, currency: 'USD' }, 'the cost still shows, in its own currency');
  assert.strictEqual(usd.profit, null);
  assert.strictEqual(usd.margin, null);
  assert.strictEqual(orderMoney(row, { value: 4.2, currency: null }).profit, 3.93, 'a cost with no currency counts as the order’s');
});

test("before eBay posts the sale there are no figures, only why and the cost if it's entered", () => {
  const money = orderMoney(null, { value: 4.2, currency: 'GBP' }, 'pending');
  assert.strictEqual(money.earnings, null);
  assert.strictEqual(money.gross, null);
  assert.strictEqual(money.profit, null);
  assert.strictEqual(money.unavailable, 'pending');
  assert.deepStrictEqual(money.cost, { value: 4.2, currency: 'GBP' });
  assert.strictEqual(orderMoney(row, null, 'pending').unavailable, null, 'figures in hand: nothing is missing');
});
