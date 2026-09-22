const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const days = require('../../src/modules/analytics/analytics-days');
const ebayAnalytics = require('../../src/modules/ebay/api/ebay.analytics');
const budget = require('../../src/modules/ebay/analytics-budget');
const traffic = require('../../src/modules/ebay/traffic');

const UK = 'Europe/London';

test.afterEach(() => {
  mock.restoreAll();
  budget._reset();
});

// ---- the seller's day ----------------------------------------------------------------

// Days follow the seller's own time zone, as Seller Hub does; a day is
// complete, and read, at 02:00 local time — summer and winter.
test('the last complete day moves on at 02:00 in the seller’s time zone', () => {
  assert.strictEqual(days.lastFinalDay(UK, new Date('2026-09-22T00:30:00Z')), '2026-09-20'); // 01:30 BST
  assert.strictEqual(days.lastFinalDay(UK, new Date('2026-09-22T01:30:00Z')), '2026-09-21'); // 02:30 BST
  assert.strictEqual(days.lastFinalDay(UK, new Date('2026-12-10T01:30:00Z')), '2026-12-08'); // 01:30 GMT
  assert.strictEqual(days.lastFinalDay(UK, new Date('2026-12-10T02:30:00Z')), '2026-12-09'); // 02:30 GMT
  assert.strictEqual(days.nextSyncAt(UK, new Date('2026-09-21T20:00:00Z')).toISOString(), '2026-09-22T01:00:00.000Z'); // 02:00 BST
  assert.strictEqual(days.nextSyncAt(UK, new Date('2026-12-09T20:00:00Z')).toISOString(), '2026-12-10T02:00:00.000Z'); // 02:00 GMT
  assert.strictEqual(days.lastFinalDay('America/Los_Angeles', new Date('2026-09-22T09:30:00Z')), '2026-09-21');
});

test('orders fall on the seller’s calendar day, and each site has its time zone', () => {
  assert.strictEqual(days.dayOf('2026-09-21T22:59:00Z', UK), '2026-09-21');
  assert.strictEqual(days.dayOf('2026-09-21T23:01:00Z', UK), '2026-09-22');
  assert.strictEqual(days.timeZoneFor('EBAY_GB'), UK);
  assert.strictEqual(days.timeZoneFor('EBAY_US'), 'America/Los_Angeles');
  assert.strictEqual(days.timeZoneFor('EBAY_CA'), null, 'not covered by eBay’s traffic report');
});

test('each day starts at its own midnight: UTC offsets either side of the clock changes', () => {
  assert.strictEqual(days.offsetAt('2026-09-21', UK), '+01:00');
  assert.strictEqual(days.offsetAt('2026-12-01', UK), '+00:00');
  assert.strictEqual(days.offsetAt('2026-03-29', UK), '+00:00', 'clocks go forward at 01:00, midnight was still GMT');
  assert.strictEqual(days.offsetAt('2026-10-25', UK), '+01:00', 'clocks go back at 02:00, midnight was still BST');
  assert.strictEqual(days.offsetAt('2026-09-21', 'America/Los_Angeles'), '-07:00');
  assert.strictEqual(days.offsetAt('2026-09-21', 'Australia/Sydney'), '+10:00');
});

test('ranges are complete days (there is no Today) and compare with the period before', () => {
  const ctx = { today: '2026-09-22', lastFinal: '2026-09-21' };
  assert.ok(!days.RANGES.includes('today'));
  assert.strictEqual(days.rangeWindow('today', ctx).range, '30d', 'an unknown range falls back to 30 days');
  assert.deepStrictEqual(days.rangeWindow('7d', ctx), { range: '7d', from: '2026-09-15', to: '2026-09-21', days: 7, partial: false, previous: { from: '2026-09-08', to: '2026-09-14' } });
  assert.strictEqual(days.rangeWindow('90d', ctx).from, '2026-06-24');
  assert.deepStrictEqual(days.rangeWindow('this_month', ctx).previous, { from: '2026-08-01', to: '2026-08-21' });
  assert.deepStrictEqual(days.rangeWindow('last_month', ctx), { range: 'last_month', from: '2026-08-01', to: '2026-08-31', days: 31, partial: false, previous: { from: '2026-07-01', to: '2026-07-31' } });
  // On the 1st, "this month" has no complete day yet: it is today so far.
  const first = days.rangeWindow('this_month', { today: '2026-10-01', lastFinal: '2026-09-30' });
  assert.strictEqual(first.range, 'this_month');
  assert.deepStrictEqual([first.partial, first.previous], [true, { from: '2026-09-30', to: '2026-09-30' }]);
  // A single day is charted at the end of the 14 days leading up to it.
  assert.deepStrictEqual(days.leadIn(first), { from: '2026-09-18', to: '2026-10-01' });
  assert.strictEqual(days.leadIn(days.rangeWindow('7d', ctx)), null);
  assert.strictEqual(first.from, '2026-10-01');
});

// ---- figures ---------------------------------------------------------------------

test('impressions are eBay’s total (Seller Hub’s figure); click-through is on search', () => {
  const t = days.sumTraffic([
    { total_impressions: 70000, impressions: 1000, impressions_search: 800, views: 40, views_search: 16 },
    { total_impressions: 30000, impressions: 1000, impressions_search: 200, views: 60, views_search: 4 },
  ]);
  const m = days.metricsFrom(t, { units: 5, amount: 25, orders: 4 });
  assert.strictEqual(m.impressions, 100000);
  assert.strictEqual(m.ctr, 20 / 1000);
  assert.strictEqual(m.conversion, 5 / 100);
  assert.strictEqual(days.change(120, 100), 0.2);
  assert.strictEqual(days.change(5, 0), null);
});

test('sales count units and item revenue per seller day and listing, without cancelled orders', () => {
  const orders = [
    { createdAt: '2026-09-21T10:00:00Z', cancelStatus: 'NotApplicable', lineItems: [{ itemId: '111', quantityPurchased: 2, price: { amount: 4.5, currency: 'GBP' } }] },
    { createdAt: '2026-09-21T23:30:00Z', lineItems: [{ itemId: '222', quantityPurchased: 1, price: { amount: 10, currency: 'GBP' } }] },
    { createdAt: '2026-09-21T11:00:00Z', cancelStatus: 'Cancelled', lineItems: [{ itemId: '111', quantityPurchased: 5, price: { amount: 4.5, currency: 'GBP' } }] },
  ];
  const idx = days.salesIndex(orders, UK);
  assert.deepStrictEqual(days.salesWithin(idx.byDay, '2026-09-21', '2026-09-21'), { units: 2, amount: 9, orders: 1 });
  assert.deepStrictEqual(days.salesWithin(idx.byListingDay.get('222'), '2026-09-22', '2026-09-22'), { units: 1, amount: 10, orders: 0 }, 'after 23:00 UTC is the next UK day');
});

test('hints need enough traffic to mean something', () => {
  const m = (over) => ({ impressions: 0, views: 0, ctr: null, sold: 0, sales: 0, orders: 0, conversion: null, ...over });
  assert.strictEqual(days.hintFor(m({}), { days: 7 }).kind, 'no_impressions');
  assert.strictEqual(days.hintFor(m({ impressions: 900, ctr: 0.002, views: 3 }), { days: 7 }).kind, 'low_ctr');
  assert.strictEqual(days.hintFor(m({ impressions: 900, ctr: 0.03, views: 45 }), { days: 7 }).kind, 'no_sales');
  assert.strictEqual(days.hintFor(m({ impressions: 900, ctr: 0.03, views: 40, sold: 4, conversion: 0.1 }), { days: 7 }).kind, 'converting');
});

// ---- the eBay client --------------------------------------------------------------

function fakeFetch(handler) {
  const calls = [];
  mock.method(global, 'fetch', async (url) => {
    calls.push(new URL(String(url)));
    return { ok: true, status: 200, json: async () => handler(new URL(String(url))) };
  });
  return calls;
}

test('a range goes to eBay in the seller’s time zone, parsed by the report’s header', async () => {
  const calls = fakeFetch(() => ({
    header: { metrics: [{ key: 'LISTING_VIEWS_TOTAL' }, { key: 'TOTAL_IMPRESSION_TOTAL' }] },
    records: [{ dimensionValues: [{ value: '20260920' }], metricValues: [{ value: 253 }, { value: 77389 }] }],
  }));
  const report = await ebayAnalytics.getTrafficReport('tok', { dimension: 'DAY', marketplaceId: 'EBAY_GB', range: { from: '2026-09-17', to: '2026-09-20', fromOffset: '+01:00', toOffset: '+01:00' } });
  assert.strictEqual(calls[0].searchParams.get('filter'), 'marketplace_ids:{EBAY_GB},date_range:[2026-09-17T00:00:00.000+01:00..2026-09-20T00:00:00.000+01:00]');
  assert.ok(calls[0].searchParams.get('metric').includes('TOTAL_IMPRESSION_TOTAL'));
  const [row] = ebayAnalytics.parseTrafficReport(report, 'DAY');
  assert.deepStrictEqual([row.day, row.views, row.total_impressions, row.impressions], ['2026-09-20', 253, 77389, 0]);
  assert.strictEqual(ebayAnalytics.dateRange({ from: '2026-09-17', to: '2026-09-20' }), '[20260917..20260920]', 'no offsets: eBay’s Pacific default');
});

// ---- the allowance -----------------------------------------------------------------

test('the allowance is tiered: the nightly sync stops at 70%, ranges at 90%, and the last 5% is never spent', async () => {
  budget._reset({ limit: 100, used: 69 });
  assert.strictEqual(budget.allows('sync'), true);
  await budget.spend('sync', 'c1', async () => 'ok');
  assert.strictEqual(budget.allows('sync'), false);
  assert.strictEqual(budget.allows('view', 20), true);
  budget._reset({ limit: 100, used: 90 });
  assert.strictEqual(budget.allows('view'), false);
  await assert.rejects(budget.spend('view', 'c1', async () => 'never'), (err) => err.code === 'ANALYTICS_BUDGET' && err.statusCode === 429);
  assert.strictEqual(budget.snapshot().used, 90, 'a refused call is not counted');
  assert.deepStrictEqual(budget.snapshot().ceilings, { sync: 70, view: 90, history: 95 });
});

test('history fills only in the last two hours before the reset, from what is left, up to 95%', async () => {
  budget._reset({ limit: 100, used: 10 });
  assert.strictEqual(budget.allows('history'), false, 'mid-window: never');
  budget._reset({ limit: 100, used: 10, resetAt: new Date(Date.now() + 3600e3).toISOString() });
  assert.strictEqual(budget.snapshot().spareWindow.open, true);
  assert.strictEqual(budget.allows('history', 85), true);
  assert.strictEqual(budget.allows('history', 86), false, 'the last 5% is a margin');
  assert.strictEqual(budget.allows('history', 80, { reserve: 6 }), false, 'six calls held back for nightly reads');
  assert.strictEqual(budget.allows('history', 79, { reserve: 6 }), true);
  await budget.spend('history', 'c1', async () => 'ok');
  assert.strictEqual(budget.snapshot().byKind.history, 1);
});

test('failed calls still count, and eBay saying "over the limit" closes the window', async () => {
  budget._reset({ limit: 100, used: 0 });
  await assert.rejects(budget.spend('sync', 'c1', async () => Promise.reject(Object.assign(new Error('Too many'), { statusCode: 429 }))));
  assert.strictEqual(budget.snapshot().used, 1);
  assert.strictEqual(budget.snapshot().exhausted, true);
  assert.strictEqual(budget.allows('view'), false);
});

// ---- reading an account --------------------------------------------------------------

test('account totals are one call per segment', async () => {
  const calls = fakeFetch(() => ({ header: { metrics: [] }, records: [] }));
  const segments = [
    { from: '2026-03-26', to: '2026-03-29', fromOffset: '+00:00', toOffset: '+00:00' },
    { from: '2026-03-30', to: '2026-06-27', fromOffset: '+01:00', toOffset: '+01:00' },
  ];
  await traffic.fetchAccountDays('tok', { connectionId: 'c1', marketplaceId: 'EBAY_GB', segments, kind: 'sync' });
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[1].searchParams.get('filter').includes('date_range:[2026-03-30T00:00:00.000+01:00..2026-06-27T00:00:00.000+01:00]'));
});

test('a listing report: the busiest 200 with a cutoff, named listings in batches of 200 with none', async () => {
  budget._reset({ limit: 100 });
  const metrics = [{ key: 'TOTAL_IMPRESSION_TOTAL' }];
  const calls = fakeFetch((url) => {
    const ids = url.searchParams.get('filter').match(/listing_ids:\{([^}]*)\}/);
    const list = ids ? ids[1].split('|') : Array.from({ length: 200 }, (_, i) => String(1000 + i));
    return { header: { metrics }, records: list.map((id, i) => ({ dimensionValues: [{ value: id }], metricValues: [{ value: 5000 - i }] })) };
  });
  const range = { from: '2026-08-22', to: '2026-09-20', fromOffset: '+01:00', toOffset: '+01:00' };
  const top = await traffic.fetchListingReport('tok', { connectionId: 'c1', marketplaceId: 'EBAY_GB', range, kind: 'view' });
  assert.strictEqual(top.rows.length, 200);
  assert.strictEqual(top.cutoff, 4801, 'the 200th listing’s impressions');
  assert.strictEqual(calls[0].searchParams.get('sort'), '-TOTAL_IMPRESSION_TOTAL');

  const ids = Array.from({ length: 450 }, (_, i) => String(100000 + i));
  const all = await traffic.fetchListingReport('tok', { connectionId: 'c1', marketplaceId: 'EBAY_GB', range, listingIds: ids, kind: 'view' });
  assert.strictEqual(calls.length, 4, '450 listings = 3 calls');
  assert.strictEqual(all.rows.length, 450);
  assert.strictEqual(all.cutoff, null);
  assert.strictEqual(traffic.callsForAllListings(450), 3);
  assert.strictEqual(traffic.callsForAllListings(172), 1);
});

test('a read is not started when the allowance can’t finish it', async () => {
  budget._reset({ limit: 100, used: 88 });
  const calls = fakeFetch(() => ({ records: [] }));
  const ids = Array.from({ length: 600 }, (_, i) => String(i + 1));
  await assert.rejects(traffic.fetchListingReport('tok', { connectionId: 'c1', marketplaceId: 'EBAY_GB', range: { from: 'a', to: 'b' }, listingIds: ids, kind: 'view' }), /allowance/);
  assert.strictEqual(calls.length, 0);
});

// ---- the service's pure parts ---------------------------------------------------------

test('account ranges split at clock changes and every 90 days', () => {
  const { accountSegments } = require('../../src/modules/analytics/analytics.service');
  assert.deepStrictEqual(accountSegments('2026-03-26', '2026-09-22', UK), [
    { from: '2026-03-26', to: '2026-03-29', fromOffset: '+00:00', toOffset: '+00:00' },
    { from: '2026-03-30', to: '2026-06-27', fromOffset: '+01:00', toOffset: '+01:00' },
    { from: '2026-06-28', to: '2026-09-22', fromOffset: '+01:00', toOffset: '+01:00' },
  ]);
  assert.deepStrictEqual(accountSegments('2026-09-21', '2026-09-21', UK), [{ from: '2026-09-21', to: '2026-09-21', fromOffset: '+01:00', toOffset: '+01:00' }]);
});

test('a listing’s traffic from a range’s reports: measured, zero when complete, or below the cutoff', () => {
  const { trafficFrom } = require('../../src/modules/analytics/analytics.service');
  const top = { rows: [{ listingId: '1', views: 3 }], cutoff: 125 };
  assert.strictEqual(trafficFrom([top], '1').traffic.views, 3);
  assert.deepStrictEqual(trafficFrom([top], '2'), { state: 'below', traffic: null, cutoff: 125 });
  assert.strictEqual(trafficFrom([{ rows: [], cutoff: null }, top], '2').traffic.views, 0, 'a complete report means no traffic');
  assert.strictEqual(trafficFrom([null, { error: 'allowance' }], '2').state, 'unknown');
});

test('an account is due once its day is complete, for older listing days only in the last hours before the reset, and not while blocked', () => {
  const { isDue } = require('../../src/modules/analytics/analytics.service');
  const now = new Date('2026-09-22T12:00:00Z'); // complete through 21 Sep in the UK
  // History reaches back to the oldest live listing (listed 19 Sep).
  const synced = { time_zone: UK, account_through: '2026-09-21', history_from: '2026-09-19', detail_days: ['2026-09-19', '2026-09-20', '2026-09-21'], last_synced_at: now.toISOString() };
  assert.strictEqual(isDue(synced, now), false);
  assert.strictEqual(isDue({ ...synced, account_through: '2026-09-20' }, now), true);
  assert.strictEqual(isDue({ ...synced, detail_days: ['2026-09-19', '2026-09-20'] }, now), true, 'the day just ended, for every listing');
  budget._reset({ limit: 100, used: 70 });
  assert.strictEqual(isDue({ ...synced, detail_days: ['2026-09-19', '2026-09-20'] }, now), false, 'the nightly tier is spent');
  budget._reset({ limit: 100, used: 0 });
  const gap = { ...synced, detail_days: ['2026-09-21'] };
  assert.strictEqual(isDue(gap, now), false, 'older days wait for the last hours before the reset');
  budget._reset({ limit: 100, used: 30, resetAt: new Date(Date.now() + 3600e3).toISOString() });
  assert.strictEqual(isDue(gap, now), true);
  assert.strictEqual(isDue(gap, now, { history: false }), false, 'a page view never fills history');
  budget._reset({ limit: 100, used: 90, resetAt: new Date(Date.now() + 3600e3).toISOString() });
  assert.strictEqual(isDue(gap, now, { reserve: 5 }), false, 'what’s left is held back for tonight');
  assert.strictEqual(isDue({ account_through: null, detail_days: [], last_error: 'needs_reconnect', last_synced_at: '2026-09-22T11:00:00Z' }, now), false);
  assert.strictEqual(isDue({ account_through: null, detail_days: [], last_error: 'needs_reconnect', last_synced_at: '2026-09-22T05:00:00Z' }, now), true);
  // Waiting for the allowance: not retried until the daily-sync tier has room.
  budget._reset({ limit: 100, used: 75 });
  assert.strictEqual(isDue({ ...synced, account_through: '2026-09-20', last_error: 'waiting_allowance' }, now), false);
  budget._reset({ limit: 100, used: 0 });
  assert.strictEqual(isDue({ ...synced, account_through: '2026-09-20', last_error: 'waiting_allowance' }, now), true);
});

test('listing history: newest days first, back 92 days (every filter and its comparison) or to the oldest live listing', () => {
  const missing = days.historyDaysMissing({ lastFinal: '2026-09-21', historyFrom: null, done: ['2026-09-21', '2026-09-19'] });
  assert.strictEqual(missing[0], '2026-09-20');
  assert.strictEqual(missing[1], '2026-09-18');
  assert.strictEqual(missing.length, 90);
  assert.strictEqual(missing[missing.length - 1], days.addDays('2026-09-21', -91));
  assert.deepStrictEqual(days.historyDaysMissing({ lastFinal: '2026-09-21', historyFrom: '2026-09-18', done: ['2026-09-21', '2026-09-19'] }), ['2026-09-20', '2026-09-18']);
});

test('a range from stored days: exact for the listings every day covered, and only those', () => {
  const t = (views) => ({ ...days.emptyTraffic(), views, total_impressions: views * 10 });
  const reads = [
    { day: '2026-09-19', listing_ids: ['1', '2'], cutoff: null },
    { day: '2026-09-20', listing_ids: ['1', '2', '3'], cutoff: null },
    { day: '2026-09-21', listing_ids: ['1', '2', '3'], cutoff: null },
  ];
  const totals = [{ listing_id: '1', ...t(9), counted_days: 0 }, { listing_id: '3', ...t(4), counted_days: 0 }];
  const listedOn = new Map([['1', '2026-01-01'], ['2', '2026-01-01'], ['3', '2026-09-20'], ['4', '2026-01-01'], ['5', null]]);
  const report = days.historyReport({ from: '2026-09-19', to: '2026-09-21', reads, totals, listedOn });
  assert.strictEqual(report.covers('1'), true);
  assert.strictEqual(report.covers('2'), true, 'named every day, no traffic: zero');
  assert.strictEqual(report.covers('3'), true, 'listed on the 20th: the 19th counts as zero');
  assert.strictEqual(report.covers('4'), false, 'never named');
  assert.strictEqual(report.covers('5'), false);
  assert.strictEqual(report.complete, false);
  const { trafficFrom } = require('../../src/modules/analytics/analytics.service');
  assert.strictEqual(trafficFrom([report], '1').traffic.views, 9);
  assert.strictEqual(trafficFrom([report], '2').traffic.views, 0);
  assert.deepStrictEqual(trafficFrom([report, { rows: [{ listingId: '4', views: 2 }], cutoff: 50 }], '4').traffic, { listingId: '4', views: 2 }, 'uncovered: the next report answers');

  // A missing day covers only listings listed after it.
  const gap = days.historyReport({ from: '2026-09-18', to: '2026-09-21', reads, totals, listedOn });
  assert.deepStrictEqual(['1', '3'].map((id) => gap.covers(id)), [false, true]);

  // A big store's day of eBay's busiest 200 (a cutoff) covers the listings in it that day.
  const busiest = [{ day: '2026-09-21', listing_ids: null, cutoff: 40 }];
  const big = days.historyReport({ from: '2026-09-21', to: '2026-09-21', reads: busiest, totals: [{ listing_id: '1', ...t(9), counted_days: 1 }], listedOn: new Map([['1', null], ['2', null]]) });
  assert.deepStrictEqual([big.covers('1'), big.covers('2')], [true, false]);
});

test('92 days of listing history reach every filter and its comparison (but 90 days’) on every day of the year', () => {
  for (let day = '2026-01-01'; day <= '2026-12-31'; day = days.addDays(day, 1)) {
    for (const lag of [1, 2]) {
      const lastFinal = days.addDays(day, -lag); // before 02:00 the last complete day is two back
      const floor = days.addDays(lastFinal, -(days.LISTING_HISTORY_DAYS - 1));
      for (const range of days.RANGES) {
        const win = days.rangeWindow(range, { today: day, lastFinal });
        assert.ok(win.from >= floor, `${range} on ${day}`);
        if (range !== '90d' && !win.partial) assert.ok(win.previous.from >= floor, `${range}'s comparison on ${day}`);
      }
    }
  }
});
