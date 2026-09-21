const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { mock } = require('node:test');
require('dotenv').config();

const { pool } = require('../../src/db/client');
const authService = require('../../src/modules/auth/auth.service');
const connectionService = require('../../src/modules/connections/connection.service');
const ebayService = require('../../src/modules/ebay/ebay.service');
const budget = require('../../src/modules/ebay/analytics-budget');
const repo = require('../../src/modules/analytics/analytics.repository');
const service = require('../../src/modules/analytics/analytics.service');
const days = require('../../src/modules/analytics/analytics-days');

// Against the real local DB (fixture users are @example.com, removed by
// tests/cleanup.js). eBay is mocked twice over: the account's cached
// listings and orders at the service boundary (analyticsInputs), and the
// traffic report itself at fetch, so the real client, parser, budget and
// sync run end to end.

test.after(async () => {
  await pool.end();
});

test.afterEach(() => {
  mock.restoreAll();
  budget._reset();
});

async function fixture() {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { user } = await authService.signup({ email, password: 'testpassword123' });
  const connection = await connectionService.createConnection(user.id, {
    platformKey: 'ebay',
    label: 'Analytics test',
    credentials: { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: Date.now() + 3600e3, scopes: ['https://api.ebay.com/oauth/api_scope/sell.analytics.readonly'] },
  });
  return { userId: user.id, connectionId: connection.id };
}

const ITEMS = [
  { itemId: '111', title: 'Garden light', imageUrl: null, viewItemUrl: 'https://www.ebay.co.uk/itm/111', price: { amount: 4.5, currency: 'GBP' }, quantityAvailable: 9 },
  { itemId: '222', title: 'Fishing line', imageUrl: null, viewItemUrl: 'https://www.ebay.co.uk/itm/222', price: { amount: 10, currency: 'GBP' }, quantityAvailable: 3 },
];

function mockInputs({ scope = true, orders = [] } = {}) {
  mock.method(ebayService, 'analyticsInputs', async (credentials) => ({
    accessToken: 'tok',
    marketplaceId: 'EBAY_GB',
    hasAnalyticsScope: scope,
    items: ITEMS,
    orders,
    listingsSyncedAt: Date.now(),
    credentialsChanged: false,
    credentials,
  }));
}

// A fake traffic report: every day 100 impressions (80 in search), 10 views
// (4 from search); per listing, 111 gets 60/6 and 222 gets 40/4.
function mockTrafficReports() {
  const calls = [];
  const header = {
    metrics: ['LISTING_IMPRESSION_TOTAL', 'LISTING_IMPRESSION_SEARCH_RESULTS_PAGE', 'LISTING_VIEWS_TOTAL', 'LISTING_VIEWS_SOURCE_SEARCH_RESULTS_PAGE', 'LISTING_VIEWS_SOURCE_STORE'].map((key) => ({ key })),
  };
  mock.method(global, 'fetch', async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    const [from, to] = u.searchParams.get('filter').match(/date_range:\[(\d{8})\.\.(\d{8})\]/).slice(1).map((d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`);
    const records =
      u.searchParams.get('dimension') === 'DAY'
        ? days.daysBetween(from, to).map((day) => ({ dimensionValues: [{ value: day.replace(/-/g, '') }], metricValues: [100, 80, 10, 4, 3].map((value) => ({ value })) }))
        : [
            { dimensionValues: [{ value: '111' }], metricValues: [60, 50, 6, 3, 2].map((value) => ({ value })) },
            { dimensionValues: [{ value: '222' }], metricValues: [40, 30, 4, 1, 1].map((value) => ({ value })) },
          ];
    return { ok: true, status: 200, json: async () => ({ header, records }) };
  });
  return calls;
}

test('a first sync stores 180 days of account totals, yesterday per listing, then fills in the last month', async () => {
  const { userId, connectionId } = await fixture();
  mockInputs();
  const calls = mockTrafficReports();
  budget._reset({ limit: 100 });
  const now = new Date();
  const today = days.ebayToday(now);
  const lastFinal = days.lastFinalDay(now);

  const first = await service.syncAccount(connectionId, userId, { mode: 'essential', now });
  assert.strictEqual(first.calls, 3, '2 account-total calls + 1 listing day');
  let state = await repo.getSyncState(connectionId);
  assert.strictEqual(state.account_through, lastFinal);
  assert.deepStrictEqual(state.listing_days, [lastFinal]);
  const acct = await repo.accountDays(connectionId, days.addDays(today, -179), today);
  assert.strictEqual(acct.length, 180);
  assert.strictEqual(acct.find((r) => r.day === today).final, false, 'today is kept as partial');
  assert.strictEqual(acct.find((r) => r.day === lastFinal).final, true);

  const second = await service.syncAccount(connectionId, userId, { now });
  assert.strictEqual(second.calls, 31, 'the first backfill run reads the last month');
  state = await repo.getSyncState(connectionId);
  assert.strictEqual(state.listing_days.length, 32);
  assert.strictEqual(service.listingCoverageFrom(state, now), days.addDays(lastFinal, -31));
  assert.ok(calls.every((u) => u.searchParams.get('filter').includes('marketplace_ids:{EBAY_GB}')));

  // Nothing is due now: another sync makes no calls.
  assert.strictEqual(service.isDue(state, now), false);
});

test('the Analytics page sums the stored days and counts sales from the orders', async () => {
  const { userId, connectionId } = await fixture();
  const now = new Date();
  const lastFinal = days.lastFinalDay(now);
  // Two sales of 111 yesterday (eBay day), one of 222 two days ago, one cancelled.
  const at = (day) => new Date(`${day}T20:00:00Z`).toISOString();
  const orders = [
    { createdAt: at(lastFinal), cancelStatus: 'NotApplicable', lineItems: [{ itemId: '111', quantityPurchased: 2, price: { amount: 4.5, currency: 'GBP' } }] },
    { createdAt: at(days.addDays(lastFinal, -1)), lineItems: [{ itemId: '222', quantityPurchased: 1, price: { amount: 10, currency: 'GBP' } }] },
    { createdAt: at(lastFinal), cancelStatus: 'CancelComplete', lineItems: [{ itemId: '222', quantityPurchased: 3, price: { amount: 10, currency: 'GBP' } }] },
  ];
  mockInputs({ orders });
  mockTrafficReports();
  budget._reset({ limit: 100 });
  await service.syncAccount(connectionId, userId, { mode: 'essential', now });
  await service.syncAccount(connectionId, userId, { now });

  const { data } = await service.getAnalytics(connectionId, userId, { range: '7d' });
  assert.strictEqual(data.status, 'ok');
  assert.strictEqual(data.range.days, 7);
  assert.strictEqual(data.series.length, 7);
  assert.strictEqual(data.previousSeries.length, 7);
  // 7 days of 100 impressions / 10 views (today's partial row included).
  assert.strictEqual(data.totals.impressions, 700);
  assert.strictEqual(data.totals.views, 70);
  assert.strictEqual(data.totals.ctr, 28 / 560);
  assert.strictEqual(data.totals.sold, 3);
  assert.strictEqual(data.totals.sales, 19);
  assert.strictEqual(data.currency, 'GBP');
  assert.strictEqual(data.changes.impressions, 0, 'same traffic as the week before');
  assert.strictEqual(data.coverage.listingsComplete, true);

  const garden = data.listings.find((l) => l.itemId === '111');
  // 6 final days per listing are stored in this week (today isn't read until "Refresh today").
  assert.strictEqual(garden.impressions, 360);
  assert.strictEqual(garden.views, 36);
  assert.strictEqual(garden.sold, 2);
  assert.strictEqual(garden.sales, 9);
  assert.strictEqual(data.sources.find((s) => s.key === 'search').views, 28);

  const listing = await service.getListingAnalytics(connectionId, userId, '222', { range: '7d' });
  assert.strictEqual(listing.data.listing.title, 'Fishing line');
  assert.strictEqual(listing.data.totals.views, 24);
  assert.strictEqual(listing.data.totals.sold, 1);
  assert.strictEqual(listing.data.series.find((d) => d.day === days.ebayToday(now)).views, null, 'today unknown per listing until refreshed');
  await assert.rejects(service.getListingAnalytics(connectionId, userId, '999', { range: '7d' }), (err) => err.statusCode === 404);

  const summary = await service.getListingSummaries(connectionId, userId);
  assert.strictEqual(summary.data.items['111'].sold, 2);
  assert.ok(summary.data.items['111'].views > 0);
});

test('"Refresh today" reads today so far and is limited per account per day', async () => {
  const { userId, connectionId } = await fixture();
  mockInputs();
  const calls = mockTrafficReports();
  budget._reset({ limit: 100 });
  const now = new Date();
  const today = days.ebayToday(now);
  await service.syncAccount(connectionId, userId, { mode: 'essential', now });
  const before = calls.length;

  for (let i = 0; i < service.REFRESHES_PER_DAY; i += 1) await service.refreshToday(connectionId, userId, now);
  assert.strictEqual(calls.length - before, 2 * service.REFRESHES_PER_DAY, 'one account call and one listing call per refresh');
  const state = await repo.getSyncState(connectionId);
  assert.strictEqual(state.today_day, today);
  assert.strictEqual(state.refresh_count, service.REFRESHES_PER_DAY);
  const todayRows = await repo.listingTotals(connectionId, today, today);
  assert.strictEqual(todayRows.get('111').views, 6);
  await assert.rejects(service.refreshToday(connectionId, userId, now), (err) => err.statusCode === 429);
  assert.strictEqual(budget.snapshot().byKind.refresh, 2 * service.REFRESHES_PER_DAY);
});

test('an account without the analytics scope makes no traffic calls and asks to reconnect', async () => {
  const { userId, connectionId } = await fixture();
  mockInputs({ scope: false });
  const calls = mockTrafficReports();
  const outcome = await service.syncAccount(connectionId, userId);
  assert.deepStrictEqual(outcome, { calls: 0, status: 'needs_reconnect' });
  assert.strictEqual(calls.length, 0);
  const { data } = await service.getAnalytics(connectionId, userId, { range: '30d' });
  assert.strictEqual(data.status, 'reconnect');
  assert.strictEqual(data.totals.impressions, 0);
  assert.strictEqual(data.previous.impressions, null);
  await assert.rejects(service.refreshToday(connectionId, userId), (err) => err.statusCode === 403);
});

test('a later day reads only what is new, and a failed read is recorded without losing progress', async () => {
  const { userId, connectionId } = await fixture();
  mockInputs();
  const calls = mockTrafficReports();
  budget._reset({ limit: 100 });
  const dayOne = new Date();
  await service.syncAccount(connectionId, userId, { mode: 'essential', now: dayOne });
  const dayTwo = new Date(dayOne.getTime() + 24 * 3600e3);
  const before = calls.length;
  await service.syncAccount(connectionId, userId, { mode: 'essential', now: dayTwo });
  assert.strictEqual(calls.length - before, 2, 'one account call for the new day, one listing call');
  const state = await repo.getSyncState(connectionId);
  assert.strictEqual(state.account_through, days.lastFinalDay(dayTwo));
  assert.deepStrictEqual(state.listing_days, [days.lastFinalDay(dayOne), days.lastFinalDay(dayTwo)]);

  // eBay failing mid-backfill: the days already read are kept, the error noted.
  mock.restoreAll();
  mockInputs();
  let n = 0;
  mock.method(global, 'fetch', async () => {
    n += 1;
    if (n > 3) return { ok: false, status: 500, json: async () => ({ errors: [{ errorId: 1, message: 'eBay had a problem' }] }) };
    return { ok: true, status: 200, json: async () => ({ header: { metrics: [] }, records: [] }) };
  });
  await assert.rejects(service.syncAccount(connectionId, userId, { now: dayTwo }), /eBay had a problem/);
  const after = await repo.getSyncState(connectionId);
  assert.strictEqual(after.listing_days.length, 5, 'the three days read before the failure are kept');
  assert.match(after.last_error, /eBay had a problem/);
});
