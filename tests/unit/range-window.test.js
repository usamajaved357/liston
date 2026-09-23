const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const { resolveRangeWindow } = require('../../src/modules/ebay/ebay.service');

// Sales "Today" and by month start at the seller's midnight, not UTC's: in
// British Summer Time an order at 00:30 London time is today's.
test('Today and the months start at midnight in the seller’s time zone', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-24T10:00:00Z') });
  try {
    const [start, end] = resolveRangeWindow('today', undefined, undefined, 'Europe/London');
    assert.strictEqual(start.toISOString(), '2026-09-23T23:00:00.000Z', '00:00 BST');
    assert.strictEqual(end.toISOString(), '2026-09-24T10:00:00.000Z');
    assert.strictEqual(resolveRangeWindow('this_month', undefined, undefined, 'Europe/London')[0].toISOString(), '2026-08-31T23:00:00.000Z');
    const [lmStart, lmEnd] = resolveRangeWindow('last_month', undefined, undefined, 'Europe/London');
    assert.deepStrictEqual([lmStart.toISOString(), lmEnd.toISOString()], ['2026-07-31T23:00:00.000Z', '2026-08-31T22:59:59.999Z']);
    assert.strictEqual(resolveRangeWindow('today')[0].toISOString(), '2026-09-24T00:00:00.000Z', 'no time zone: UTC as before');
  } finally {
    mock.timers.reset();
  }
});

test('in winter London is on UTC, and just after midnight it is already the new day', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-02T00:30:00Z') });
  try {
    assert.strictEqual(resolveRangeWindow('today', undefined, undefined, 'Europe/London')[0].toISOString(), '2026-12-02T00:00:00.000Z');
    assert.strictEqual(resolveRangeWindow('last_month', undefined, undefined, 'Europe/London')[0].toISOString(), '2026-11-01T00:00:00.000Z');
  } finally {
    mock.timers.reset();
  }
});
