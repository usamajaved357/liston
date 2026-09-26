const test = require('node:test');
const assert = require('node:assert');

const { trendDays, salesTrend, bestSellers, addTrends, convertTrend, mergeBestSellers } = require('../../src/modules/overview/sales-trend');

const TODAY = '2026-09-26';
const isCancelled = (o) => Boolean(o.cancelled);

test('a range is drawn over its days, with the same number of days before it while Liston still has those orders', () => {
  const week = trendDays('7d', TODAY);
  assert.deepStrictEqual([week.days[0], week.days.at(-1), week.days.length], ['2026-09-20', TODAY, 7]);
  assert.deepStrictEqual([week.previousDays[0], week.previousDays.at(-1)], ['2026-09-13', '2026-09-19']);
  assert.deepStrictEqual(trendDays('today', TODAY).days.length, 7, 'today stands next to the week before it');
  const month = trendDays('this_month', TODAY);
  assert.deepStrictEqual([month.days[0], month.days.length, month.previousDays[0]], ['2026-09-01', 26, '2026-08-06']);
  const last = trendDays('last_month', TODAY);
  assert.deepStrictEqual([last.days[0], last.days.at(-1)], ['2026-08-01', '2026-08-31']);
  assert.strictEqual(trendDays('90d', TODAY).previousDays, null, 'the 90 days before are older than the orders kept');
});

test("sales by day count what buyers paid, cancelled orders left out, in the viewer's time zone, with the previous stretch alongside", () => {
  const orders = [
    { createdAt: '2026-09-26T08:00:00Z', total: { amount: 8.99 } },
    { createdAt: '2026-09-26T09:30:00Z', total: { amount: 11.01 } },
    { createdAt: '2026-09-25T23:30:00Z', total: { amount: 5 } }, // 00:30 on the 26th in London
    { createdAt: '2026-09-24T10:00:00Z', total: { amount: 40 }, cancelled: true },
    { createdAt: '2026-09-19T10:00:00Z', total: { amount: 7.5 } }, // the previous week's last day
  ];
  const trend = salesTrend(orders, { timeZone: 'Europe/London', range: '7d', today: TODAY, isCancelled });
  const today = trend.at(-1);
  assert.deepStrictEqual(today, { day: TODAY, value: 25, previous: 7.5, previousDay: '2026-09-19', partial: true });
  assert.strictEqual(trend.find((p) => p.day === '2026-09-24').value, 0, 'the cancelled order is left out');
  assert.ok(trend.slice(0, -1).every((p) => !p.partial));
});

test('best sellers: most units first, then most sales; an order counts once per listing; cancelled orders left out', () => {
  const line = (itemId, units, amount, title = `Item ${itemId}`) => ({ itemId, title, quantityPurchased: units, price: { amount, currency: 'GBP' } });
  const orders = [
    { lineItems: [line('A', 2, 5), line('A', 1, 5)] },
    { lineItems: [line('B', 3, 2)] },
    { lineItems: [line('C', 1, 20)] },
    { lineItems: [line('D', 9, 1)], cancelled: true },
  ];
  const top = bestSellers(orders, { isCancelled, limit: 2 });
  assert.deepStrictEqual(top, [
    { itemId: 'A', title: 'Item A', units: 3, orders: 1, sales: 15, currency: 'GBP' },
    { itemId: 'B', title: 'Item B', units: 3, orders: 1, sales: 6, currency: 'GBP' },
  ]);
});

test("accounts' trends add up day by day, a market's converts into the main currency, and best sellers merge across currencies", () => {
  const a = [{ day: '2026-09-25', value: 10, previous: 4 }, { day: TODAY, value: 5, previous: null }];
  const b = [{ day: '2026-09-25', value: 2.5, previous: 1 }, { day: TODAY, value: 0, previous: null }];
  assert.deepStrictEqual(addTrends([a, b]).map((p) => [p.value, p.previous]), [[12.5, 5], [5, null]]);
  assert.deepStrictEqual(addTrends([]), []);
  assert.deepStrictEqual(convertTrend([{ day: TODAY, value: 26.4, previous: null }], 1.32), [{ day: TODAY, value: 20, previous: null }]);
  const uk = [{ itemId: '1', units: 4, sales: 40, currency: 'GBP' }];
  const au = [{ itemId: '2', units: 4, sales: 100, currency: 'AUD' }, { itemId: '3', units: 1, sales: 5, currency: 'AUD' }];
  // Same units: A$100 is £50 at 2.0, so it ranks above £40.
  const merged = mergeBestSellers([uk, au], { limit: 2, rateOf: (i) => (i.currency === 'AUD' ? 2 : 1) });
  assert.deepStrictEqual(merged.map((i) => i.itemId), ['2', '1']);
});
