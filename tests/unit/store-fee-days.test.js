const test = require('node:test');
const assert = require('node:assert');
const { chargesInDates, daysPaidFor } = require('../../src/modules/overview/store-fee-days');

// The shop subscription counted on the days it pays for, not the day eBay bills it.

const tz = 'Europe/London';
const at = (iso) => new Date(iso);
const total = (list) => Math.round(list.reduce((n, c) => n + c.amount, 0) * 100) / 100;

test("a month's store fee billed on the 1st: Today carries one day's share, the month all of it", () => {
  const fee = { kind: 'store', amount: 31, chargedAt: '2026-10-01T03:00:00Z', memo: null };
  assert.strictEqual(daysPaidFor(fee, tz).length, 31, 'no memo: the month from the day billed');
  assert.strictEqual(total(chargesInDates([fee], { start: at('2026-09-30T23:00:00Z'), end: at('2026-10-01T20:00:00Z'), timeZone: tz })), 1, 'Today on the 1st');
  assert.strictEqual(total(chargesInDates([fee], { start: at('2026-10-24T23:00:00Z'), end: at('2026-10-31T20:00:00Z'), timeZone: tz })), 7, 'a week later in the month');
  assert.strictEqual(total(chargesInDates([fee], { start: at('2026-09-30T23:00:00Z'), end: at('2026-10-31T22:00:00Z'), timeZone: tz })), 31, 'the whole month');
});

test("eBay UK's memo names the period paid for; other charges stay on the day billed", () => {
  const fee = { kind: 'store', amount: 32.4, chargedAt: '2026-09-01T02:00:00Z', memo: '2026-08-31 - 2026-09-29' };
  const listing = { kind: 'listing', amount: 0.35, chargedAt: '2026-09-15T10:00:00Z' };
  const inAugust = chargesInDates([fee, listing], { start: at('2026-07-31T23:00:00Z'), end: at('2026-08-31T22:59:59Z'), timeZone: tz });
  assert.strictEqual(total(inAugust), 1.08, "31 Aug's share, though billed in September");
  const midSept = chargesInDates([fee, listing], { start: at('2026-09-14T23:00:00Z'), end: at('2026-09-15T22:59:59Z'), timeZone: tz });
  assert.deepStrictEqual(midSept.map((c) => c.kind).sort(), ['listing', 'store']);
  assert.strictEqual(total(midSept), 1.43);
  assert.strictEqual(total(chargesInDates([fee], { start: at('2026-09-29T23:00:00Z'), end: at('2026-09-30T22:00:00Z'), timeZone: tz })), 0, 'past its period');
});
