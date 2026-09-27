const test = require('node:test');
const assert = require('node:assert');
const lt = require('../../src/modules/overview/listing-trend');

test('the listing trend draws the chosen days with as many before, today as the last 7', () => {
  const { days, previousDays } = lt.listingDays('today', '2026-09-27');
  assert.deepStrictEqual([days[0], days[6], days.length], ['2026-09-21', '2026-09-27', 7]);
  assert.deepStrictEqual([previousDays[0], previousDays[6]], ['2026-09-14', '2026-09-20']);
  const month = lt.listingDays('this_month', '2026-09-27');
  assert.strictEqual(month.days[0], '2026-09-01');
  assert.strictEqual(month.previousDays.length, month.days.length);
});

test('hunts and drafts become counts per day, in the seller time zone, with the stretch before', () => {
  const hunts = [
    { created_at: '2026-09-27T09:00:00Z', status: 'approved', decided_at: '2026-09-27T10:00:00Z' },
    { created_at: '2026-09-26T23:30:00Z', status: 'rejected', decided_at: '2026-09-27T08:00:00Z' }, // 27th in London (BST)
    { created_at: '2026-09-19T12:00:00Z', status: 'pending', decided_at: null },
  ];
  const listings = [
    { created_at: '2026-09-25T12:00:00Z', status: 'published', updated_at: '2026-09-27T12:00:00Z' },
    { created_at: '2026-09-27T12:00:00Z', status: 'draft', updated_at: '2026-09-27T12:00:00Z' },
  ];
  const trend = lt.listingTrend(lt.eventsFrom(hunts, listings), { timeZone: 'Europe/London', range: 'today', today: '2026-09-27' });
  const last = trend[trend.length - 1];
  assert.strictEqual(last.day, '2026-09-27');
  assert.strictEqual(last.partial, true);
  assert.deepStrictEqual(last.values, { hunted: 2, approved: 1, rejected: 1, drafted: 1, published: 1 });
  assert.strictEqual(trend.find((p) => p.day === '2026-09-25').values.drafted, 1);
  // The 19th sits in the stretch before, opposite the 26th.
  assert.strictEqual(trend.find((p) => p.previousDay === '2026-09-19').previous.hunted, 1);

  const added = lt.addListingTrends([trend, trend, null]);
  assert.strictEqual(added[added.length - 1].values.hunted, 4);
  assert.strictEqual(lt.addListingTrends([null]), null);
});
