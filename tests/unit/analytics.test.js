const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const days = require('../../src/modules/analytics/analytics-days');
const ebayAnalytics = require('../../src/modules/ebay/api/ebay.analytics');
const budget = require('../../src/modules/ebay/analytics-budget');
const traffic = require('../../src/modules/ebay/traffic');

test.afterEach(() => {
  mock.restoreAll();
  budget._reset();
});

// ---- eBay's day ------------------------------------------------------------------

// eBay's traffic report splits days on US Pacific time; a day is read (and
// final) at 02:00 Pacific, which is 10:00 UK in both summer and winter.
test('the last final day moves on at 02:00 Pacific, summer and winter', () => {
  assert.strictEqual(days.lastFinalDay(new Date('2026-09-22T08:30:00Z')), '2026-09-20'); // 01:30 PDT
  assert.strictEqual(days.lastFinalDay(new Date('2026-09-22T09:15:00Z')), '2026-09-21'); // 02:15 PDT
  assert.strictEqual(days.lastFinalDay(new Date('2026-12-10T09:30:00Z')), '2026-12-08'); // 01:30 PST
  assert.strictEqual(days.lastFinalDay(new Date('2026-12-10T10:15:00Z')), '2026-12-09'); // 02:15 PST
  assert.strictEqual(days.nextSyncAt(new Date('2026-09-22T03:00:00Z')).toISOString(), '2026-09-22T09:00:00.000Z'); // 10:00 BST
  assert.strictEqual(days.nextSyncAt(new Date('2026-12-10T03:00:00Z')).toISOString(), '2026-12-10T10:00:00.000Z'); // 10:00 GMT
});

test('orders are bucketed into eBay days (US Pacific)', () => {
  assert.strictEqual(days.ebayDayOf('2026-09-21T06:59:00Z'), '2026-09-20');
  assert.strictEqual(days.ebayDayOf('2026-09-21T07:01:00Z'), '2026-09-21');
  assert.strictEqual(days.ebayToday(new Date('2026-09-21T22:00:00Z')), '2026-09-21');
});

test('ranges and the periods they are compared with', () => {
  const today = '2026-09-21';
  assert.deepStrictEqual(days.rangeWindow('today', today), { range: 'today', from: today, to: today, days: 1, previous: { from: '2026-09-20', to: '2026-09-20' } });
  assert.deepStrictEqual(days.rangeWindow('7d', today).previous, { from: '2026-09-08', to: '2026-09-14' });
  assert.strictEqual(days.rangeWindow('90d', today).from, '2026-06-24');
  // This month so far vs the same days of last month; last month vs the one before.
  assert.deepStrictEqual(days.rangeWindow('this_month', today), { range: 'this_month', from: '2026-09-01', to: today, days: 21, previous: { from: '2026-08-01', to: '2026-08-21' } });
  assert.deepStrictEqual(days.rangeWindow('this_month', '2026-03-31').previous, { from: '2026-02-01', to: '2026-02-28' });
  assert.deepStrictEqual(days.rangeWindow('last_month', today), { range: 'last_month', from: '2026-08-01', to: '2026-08-31', days: 31, previous: { from: '2026-07-01', to: '2026-07-31' } });
  assert.strictEqual(days.rangeWindow('nonsense', today).range, '30d');
});

// ---- figures ---------------------------------------------------------------------

test('sales count units and item revenue per day and listing, without cancelled orders', () => {
  const orders = [
    { createdAt: '2026-09-21T10:00:00Z', cancelStatus: 'NotApplicable', lineItems: [{ itemId: '111', quantityPurchased: 2, price: { amount: 4.5, currency: 'GBP' } }] },
    { createdAt: '2026-09-21T06:00:00Z', lineItems: [{ itemId: '111', quantityPurchased: 1, price: { amount: 4.5, currency: 'GBP' } }, { itemId: '222', quantityPurchased: 1, price: { amount: 10, currency: 'GBP' } }] },
    { createdAt: '2026-09-21T11:00:00Z', cancelStatus: 'Cancelled', lineItems: [{ itemId: '111', quantityPurchased: 5, price: { amount: 4.5, currency: 'GBP' } }] },
  ];
  const idx = days.salesIndex(orders);
  assert.strictEqual(idx.currency, 'GBP');
  assert.deepStrictEqual(days.salesWithin(idx.byDay, '2026-09-21', '2026-09-21'), { units: 2, amount: 9, orders: 1 });
  assert.deepStrictEqual(days.salesWithin(idx.byDay, '2026-09-20', '2026-09-21'), { units: 4, amount: 23.5, orders: 2 });
  assert.deepStrictEqual(days.salesWithin(idx.byListingDay.get('222'), '2026-09-20', '2026-09-20'), { units: 1, amount: 10, orders: 0 });
});

test('rates come from summed counts: click-through on search, conversion per view', () => {
  const t = days.sumTraffic([
    { impressions: 1000, impressions_search: 800, views: 40, views_search: 16 },
    { impressions: 1000, impressions_search: 200, views: 60, views_search: 4 },
  ]);
  const m = days.metricsFrom(t, { units: 5, amount: 25, orders: 4 });
  assert.strictEqual(m.impressions, 2000);
  assert.strictEqual(m.ctr, 20 / 1000);
  assert.strictEqual(m.conversion, 5 / 100);
  assert.strictEqual(days.metricsFrom(days.emptyTraffic(), { units: 0, amount: 0, orders: 0 }).ctr, null);
  assert.strictEqual(days.change(120, 100), 0.2);
  assert.strictEqual(days.change(5, 0), null);
  assert.strictEqual(days.change(0, 0), 0);
});

test('hints need enough traffic to mean something', () => {
  const m = (over) => ({ impressions: 0, views: 0, ctr: null, sold: 0, sales: 0, orders: 0, conversion: null, ...over });
  assert.strictEqual(days.hintFor(m({}), { days: 7 }).kind, 'no_impressions');
  assert.strictEqual(days.hintFor(m({}), { days: 1 }), null);
  assert.strictEqual(days.hintFor(m({ impressions: 900, ctr: 0.002, views: 3 }), { days: 7 }).kind, 'low_ctr');
  assert.strictEqual(days.hintFor(m({ impressions: 900, ctr: 0.03, views: 45 }), { days: 7 }).kind, 'no_sales');
  assert.strictEqual(days.hintFor(m({ impressions: 900, ctr: 0.03, views: 40, sold: 4, conversion: 0.1 }), { days: 7 }).kind, 'converting');
  assert.strictEqual(days.hintFor(m({ impressions: 120, ctr: 0.01, views: 10, sold: 1, conversion: 0.1 }), { days: 7 }), null);
});

// ---- the eBay client --------------------------------------------------------------

function fakeFetch(handler) {
  const calls = [];
  mock.method(global, 'fetch', async (url) => {
    calls.push(String(url));
    const body = handler(String(url));
    return { ok: true, status: 200, json: async () => body };
  });
  return calls;
}

test('the traffic report is requested with eBay’s filter syntax and parsed by its header', async () => {
  const calls = fakeFetch(() => ({
    header: { metrics: [{ key: 'LISTING_VIEWS_TOTAL' }, { key: 'LISTING_IMPRESSION_TOTAL' }, { key: 'TRANSACTION' }] },
    records: [{ dimensionValues: [{ value: '20260920' }], metricValues: [{ value: 238 }, { value: 4206 }, { value: 5 }] }],
  }));
  const report = await ebayAnalytics.getTrafficReport('tok', { dimension: 'DAY', marketplaceId: 'EBAY_GB', from: '2026-09-15', to: '2026-09-21' });
  const url = new URL(calls[0]);
  assert.strictEqual(url.pathname, '/sell/analytics/v1/traffic_report');
  assert.strictEqual(url.searchParams.get('dimension'), 'DAY');
  assert.strictEqual(url.searchParams.get('filter'), 'marketplace_ids:{EBAY_GB},date_range:[20260915..20260921]');
  assert.ok(url.searchParams.get('metric').includes('LISTING_IMPRESSION_SEARCH_RESULTS_PAGE'));
  const [row] = ebayAnalytics.parseTrafficReport(report, 'DAY');
  assert.strictEqual(row.day, '2026-09-20');
  assert.strictEqual(row.views, 238);
  assert.strictEqual(row.impressions, 4206);
  assert.strictEqual(row.transactions, 5);
  assert.strictEqual(row.views_search, 0, 'metrics eBay left out read as zero');

  await ebayAnalytics.getTrafficReport('tok', { dimension: 'LISTING', marketplaceId: 'EBAY_GB', from: '2026-09-20', to: '2026-09-20', listingIds: ['111', '222'], sort: '-LISTING_IMPRESSION_TOTAL' });
  const second = new URL(calls[1]);
  assert.ok(second.searchParams.get('filter').endsWith('listing_ids:{111|222}'));
  assert.strictEqual(second.searchParams.get('sort'), '-LISTING_IMPRESSION_TOTAL');
  assert.throws(() => ebayAnalytics.getTrafficReport('tok', { dimension: 'LISTING', marketplaceId: 'EBAY_GB', from: 'a', to: 'b', listingIds: Array(201).fill('1') }), /At most 200/);
});

// ---- the allowance -----------------------------------------------------------------

test('the allowance is tiered: backfill stops at 60%, the daily update at 90%, refresh uses the rest', async () => {
  budget._reset({ limit: 100, used: 59 });
  assert.strictEqual(budget.allows('backfill'), true);
  await budget.spend('backfill', 'c1', async () => 'ok');
  assert.strictEqual(budget.allows('backfill'), false);
  assert.strictEqual(budget.allows('sync'), true);
  budget._reset({ limit: 100, used: 90 });
  assert.strictEqual(budget.allows('sync'), false);
  assert.strictEqual(budget.allows('refresh', 10), true);
  await assert.rejects(budget.spend('sync', 'c1', async () => 'never'), (err) => err.code === 'ANALYTICS_BUDGET' && err.statusCode === 429);
  const snap = budget.snapshot();
  assert.strictEqual(snap.used, 90, 'a refused call is not counted');
  assert.deepStrictEqual(snap.ceilings, { backfill: 60, sync: 90, refresh: 100 });
});

test('failed calls still count, and eBay saying "over the limit" closes the window', async () => {
  budget._reset({ limit: 100, used: 0 });
  const overLimit = Object.assign(new Error('Too many requests'), { statusCode: 429 });
  await assert.rejects(budget.spend('sync', 'c1', async () => Promise.reject(overLimit)));
  const snap = budget.snapshot();
  assert.strictEqual(snap.used, 1);
  assert.strictEqual(snap.exhausted, true);
  assert.strictEqual(budget.allows('refresh'), false);
  assert.deepStrictEqual(snap.byAccount, { c1: 1 });
});

// ---- reading an account --------------------------------------------------------------

test('an account totals read splits into 90-day calls and a big account’s listing day into batches of 200', async () => {
  budget._reset({ limit: 100 });
  const calls = fakeFetch((url) => ({ header: { metrics: [{ key: 'LISTING_VIEWS_TOTAL' }] }, records: url.includes('dimension=DAY') ? [] : [{ dimensionValues: [{ value: '111' }], metricValues: [{ value: 3 }] }] }));
  await traffic.fetchAccountDays('tok', { connectionId: 'c1', marketplaceId: 'EBAY_GB', from: '2026-03-26', to: '2026-09-21', kind: 'sync' });
  assert.strictEqual(calls.length, 2, '180 days = 2 calls');
  assert.ok(new URL(calls[0]).searchParams.get('filter').includes('date_range:[20260326..20260623]'));
  assert.ok(new URL(calls[1]).searchParams.get('filter').includes('date_range:[20260624..20260921]'));

  const ids = Array.from({ length: 450 }, (_, i) => String(100000 + i));
  const rows = await traffic.fetchListingDay('tok', { connectionId: 'c1', marketplaceId: 'EBAY_GB', day: '2026-09-20', listingIds: ids, kind: 'sync' });
  assert.strictEqual(calls.length, 5, '450 listings = 3 calls');
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(traffic.callsForListingDay(172), 1);
  assert.strictEqual(traffic.callsForListingDay(450), 3);

  // Up to 200 listings: one unfiltered call, busiest first.
  await traffic.fetchListingDay('tok', { connectionId: 'c1', marketplaceId: 'EBAY_GB', day: '2026-09-20', listingIds: ['1', '2'], kind: 'sync' });
  const last = new URL(calls[5]);
  assert.ok(!last.searchParams.get('filter').includes('listing_ids'));
  assert.strictEqual(last.searchParams.get('sort'), '-LISTING_IMPRESSION_TOTAL');
  assert.strictEqual(budget.snapshot().used, 6);
});

test('a listing day is not started when the allowance can’t finish it', async () => {
  budget._reset({ limit: 100, used: 59 });
  const calls = fakeFetch(() => ({ records: [] }));
  const ids = Array.from({ length: 300 }, (_, i) => String(i + 1));
  await assert.rejects(traffic.fetchListingDay('tok', { connectionId: 'c1', marketplaceId: 'EBAY_GB', day: '2026-09-20', listingIds: ids, kind: 'backfill' }), /allowance/);
  assert.strictEqual(calls.length, 0);
});

// ---- when to read -------------------------------------------------------------------

test('an account is due for the daily read, for backfill while the allowance lasts, and not while blocked', () => {
  const { isDue, missingListingDays, listingCoverageFrom } = require('../../src/modules/analytics/analytics.service');
  const now = new Date('2026-09-22T12:00:00Z'); // after 02:00 PDT: final through 21 Sep
  const all = Array.from({ length: 90 }, (_, i) => days.addDays('2026-09-21', -i));
  const synced = { account_through: '2026-09-21', listing_days: all, last_synced_at: now.toISOString() };
  assert.strictEqual(isDue(synced, now), false);
  assert.strictEqual(isDue({ ...synced, account_through: '2026-09-20' }, now), true, 'a new final day');
  assert.strictEqual(isDue({ ...synced, listing_days: all.slice(1) }, now), true, 'yesterday per listing missing');
  const partial = { ...synced, listing_days: all.slice(0, 30) };
  assert.strictEqual(isDue(partial, now), false, 'backfill waits between runs');
  assert.strictEqual(isDue({ ...partial, last_synced_at: '2026-09-22T11:00:00Z' }, now), true, 'then continues');
  budget._reset({ limit: 100, used: 60 });
  assert.strictEqual(isDue({ ...partial, last_synced_at: '2026-09-22T11:00:00Z' }, now), false, 'but only from spare allowance');
  assert.strictEqual(isDue({ account_through: null, listing_days: [], last_error: 'needs_reconnect', last_synced_at: '2026-09-22T11:00:00Z' }, now), false);
  assert.strictEqual(isDue({ account_through: null, listing_days: [], last_error: 'needs_reconnect', last_synced_at: '2026-09-22T05:00:00Z' }, now), true, 're-checked after a few hours');

  assert.strictEqual(missingListingDays(partial, now)[0], '2026-08-22', 'newest missing day first');
  assert.strictEqual(missingListingDays(partial, now).length, 60);
  assert.strictEqual(listingCoverageFrom(partial, now), '2026-08-23');
  assert.strictEqual(listingCoverageFrom({ listing_days: ['2026-09-20'] }, now), null, 'coverage must reach the last final day');
});
