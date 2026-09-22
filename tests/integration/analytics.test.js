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

const UK = 'Europe/London';

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

const item = (id, title) => ({ itemId: id, title, imageUrl: null, viewItemUrl: `https://www.ebay.co.uk/itm/${id}`, price: { amount: 4.5, currency: 'GBP' }, quantityAvailable: 9, watchCount: 3 });
const SMALL_STORE = [item('111', 'Garden light'), item('222', 'Fishing line')];

function mockInputs({ scope = true, orders = [], items = SMALL_STORE } = {}) {
  mock.method(ebayService, 'analyticsInputs', async (credentials) => ({
    accessToken: 'tok',
    marketplaceId: 'EBAY_GB',
    hasAnalyticsScope: scope,
    items,
    orders,
    listingsSyncedAt: Date.now(),
    credentialsChanged: false,
    credentials,
  }));
}

// A fake traffic report. Whole account: every day 70,000 total impressions
// (800 in search), 100 views (20 from search). Per listing, per call: 111
// gets 600 total impressions / 6 views, 222 gets 400 / 4; unfiltered
// requests return `topCount` listings (the busiest of a big store).
function mockTrafficReports({ topCount = 2 } = {}) {
  const calls = [];
  const header = { metrics: ['TOTAL_IMPRESSION_TOTAL', 'LISTING_IMPRESSION_SEARCH_RESULTS_PAGE', 'LISTING_VIEWS_TOTAL', 'LISTING_VIEWS_SOURCE_SEARCH_RESULTS_PAGE'].map((key) => ({ key })) };
  const values = (arr) => arr.map((value) => ({ value }));
  const listingRow = (id) => (id === '111' ? [600, 500, 6, 3] : id === '222' ? [400, 300, 4, 1] : [300 - Number(id) % 100, 100, 2, 1]);
  mock.method(global, 'fetch', async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    const filter = u.searchParams.get('filter');
    const [from, to] = filter.match(/date_range:\[(\d{4}-\d\d-\d\d)T[^.]*\.000[+-]\d\d:\d\d\.\.(\d{4}-\d\d-\d\d)T/).slice(1);
    let records;
    if (u.searchParams.get('dimension') === 'DAY') {
      records = days.daysBetween(from, to).map((day) => ({ dimensionValues: [{ value: day.replace(/-/g, '') }], metricValues: values([70000, 800, 100, 20]) }));
    } else {
      const ids = filter.match(/listing_ids:\{([^}]*)\}/);
      const list = ids ? ids[1].split('|') : ['111', '222', ...Array.from({ length: topCount - 2 }, (_, i) => String(9000 + i))];
      records = list.map((id) => ({ dimensionValues: [{ value: id }], metricValues: values(listingRow(id)) }));
    }
    return { ok: true, status: 200, json: async () => ({ header, records }) };
  });
  return calls;
}

test('a first sync reads 180 days of account totals in the seller’s time zone, then a week of the busiest listings', async () => {
  const { userId, connectionId } = await fixture();
  mockInputs();
  const calls = mockTrafficReports();
  budget._reset({ limit: 100 });
  const now = new Date();
  const today = days.today(UK, now);
  const lastFinal = days.lastFinalDay(UK, now);

  const first = await service.syncAccount(connectionId, userId, { mode: 'essential', now });
  const segments = service.accountSegments(days.addDays(today, -179), today, UK).length;
  assert.strictEqual(first.calls, segments, 'one call per segment (split at clock changes)');
  let state = await repo.getSyncState(connectionId);
  assert.strictEqual(state.time_zone, UK);
  assert.strictEqual(state.account_through, lastFinal);
  const acct = await repo.accountDays(connectionId, days.addDays(today, -179), today);
  assert.strictEqual(acct.length, 180);
  assert.strictEqual(acct.find((r) => r.day === today).final, false, 'today is kept as partial');
  assert.ok(calls.every((u) => /T00:00:00\.000\+0[01]:00/.test(u.searchParams.get('filter'))), 'every range is sent at UK midnight');

  const second = await service.syncAccount(connectionId, userId, { now });
  assert.strictEqual(second.calls, 7, 'a week of the busiest listings, one call a day');
  state = await repo.getSyncState(connectionId);
  assert.strictEqual(state.detail_days.length, 7);
  assert.strictEqual(service.isDue(state, now), false, 'nothing more to read today');
  // A store of two names both listings (complete, no cutoff).
  const dayReport = (await repo.reportsFor(connectionId, lastFinal, lastFinal)).get('top');
  assert.strictEqual(dayReport.cutoff, null);
  assert.ok(calls.at(-1).searchParams.get('filter').includes('listing_ids:{111|222}'));
});

test('the Analytics tab: account totals from stored days, listing figures from one report per range, read once', async () => {
  const { userId, connectionId } = await fixture();
  const now = new Date();
  const lastFinal = days.lastFinalDay(UK, now);
  const at = (day) => new Date(`${day}T12:00:00Z`).toISOString();
  const orders = [
    { createdAt: at(lastFinal), cancelStatus: 'NotApplicable', lineItems: [{ itemId: '111', quantityPurchased: 2, price: { amount: 4.5, currency: 'GBP' } }] },
    { createdAt: at(days.addDays(lastFinal, -1)), lineItems: [{ itemId: '222', quantityPurchased: 1, price: { amount: 10, currency: 'GBP' } }] },
    { createdAt: at(lastFinal), cancelStatus: 'CancelComplete', lineItems: [{ itemId: '222', quantityPurchased: 3, price: { amount: 10, currency: 'GBP' } }] },
  ];
  mockInputs({ orders });
  const calls = mockTrafficReports();
  budget._reset({ limit: 100 });
  await service.syncAccount(connectionId, userId, { mode: 'essential', now });
  await service.syncAccount(connectionId, userId, { now }); // the week of detail, so only the view reads below

  const before = calls.length;
  const { data } = await service.getAnalytics(connectionId, userId, { range: '7d' });
  assert.strictEqual(calls.length - before, 2, 'the range’s listing report and the previous period’s');
  assert.strictEqual(data.status, 'ok');
  assert.strictEqual(data.timeZone, UK);
  assert.deepStrictEqual([data.range.to, data.range.days, data.range.partial], [lastFinal, 7, false], 'complete days only');
  assert.strictEqual(data.totals.impressions, 7 * 70000, 'eBay’s total impressions');
  assert.strictEqual(data.totals.views, 700);
  assert.strictEqual(data.totals.ctr, 140 / 5600);
  assert.deepStrictEqual([data.totals.sold, data.totals.sales], [3, 19]);
  assert.strictEqual(data.changes.impressions, 0);

  const garden = data.listings.find((l) => l.itemId === '111');
  assert.deepStrictEqual([garden.traffic, garden.impressions, garden.views, garden.sold, garden.sales, garden.watchers], ['measured', 600, 6, 2, 9, 3]);
  assert.strictEqual(garden.changes.views, 0);
  assert.deepStrictEqual(data.listingReport, { ...data.listingReport, state: 'ok', scope: 'top', cutoff: null, live: 2, canLoadAll: false });

  // Opening the same range again reads nothing from eBay.
  await service.getAnalytics(connectionId, userId, { range: '7d' });
  assert.strictEqual(calls.length - before, 2);
  // Today's listing figures are never read automatically.
  const todayView = await service.getAnalytics(connectionId, userId, { range: 'today' });
  assert.strictEqual(todayView.data.range.partial, true);
  assert.strictEqual(todayView.data.listings[0].traffic !== undefined, true);
});

test('a big store: the busiest 200 with a cutoff, "Load all" for the rest, and a listing read on its own', async () => {
  const { userId, connectionId } = await fixture();
  const items = [...SMALL_STORE, ...Array.from({ length: 298 }, (_, i) => item(String(9000 + i), `Listing ${i}`))];
  mockInputs({ items });
  const calls = mockTrafficReports({ topCount: 200 });
  budget._reset({ limit: 100 });
  await service.syncAccount(connectionId, userId, { mode: 'essential', now: new Date() });
  await service.syncAccount(connectionId, userId, { now: new Date() });

  let { data } = await service.getAnalytics(connectionId, userId, { range: '30d' });
  const below = data.listings.filter((l) => l.traffic === 'below');
  assert.strictEqual(data.listings.filter((l) => l.traffic === 'measured').length, 200);
  assert.strictEqual(below.length, 100);
  assert.strictEqual(below[0].impressions, null, 'not read — never shown as zero');
  assert.ok(data.listingReport.cutoff > 0);
  assert.deepStrictEqual([data.listingReport.loadAllCalls, data.listingReport.canLoadAll], [2, true]);

  // One listing outside the 200: its panel reads it on its own, exactly.
  const outside = below[0].itemId;
  const before = calls.length;
  const panel = await service.getListingAnalytics(connectionId, userId, outside, { range: '30d' });
  assert.strictEqual(panel.data.traffic, 'measured');
  assert.ok(panel.data.totals.impressions > 0);
  assert.strictEqual(calls.length - before, 2, 'this range and the previous one, for this listing');
  assert.ok(calls.at(-1).searchParams.get('filter').includes(`listing_ids:{${outside}}`));

  const loaded = await service.loadAllListings(connectionId, userId, { range: '30d' });
  assert.strictEqual(loaded.data.calls, 2);
  ({ data } = await service.getAnalytics(connectionId, userId, { range: '30d' }));
  assert.strictEqual(data.listings.filter((l) => l.traffic === 'measured').length, 300, 'every listing, exactly');
  assert.strictEqual(data.listingReport.scope, 'all');
});

test('"Refresh today" reads today so far and is limited per account per day', async () => {
  const { userId, connectionId } = await fixture();
  mockInputs();
  const calls = mockTrafficReports();
  budget._reset({ limit: 100 });
  const now = new Date();
  const today = days.today(UK, now);
  await service.syncAccount(connectionId, userId, { mode: 'essential', now });
  const before = calls.length;
  for (let i = 0; i < service.REFRESHES_PER_DAY; i += 1) await service.refreshToday(connectionId, userId, now);
  assert.strictEqual(calls.length - before, 2 * service.REFRESHES_PER_DAY, 'one account call and one listing call per refresh');
  const state = await repo.getSyncState(connectionId);
  assert.deepStrictEqual([state.today_day, state.refresh_count], [today, service.REFRESHES_PER_DAY]);
  const todayReport = (await repo.reportsFor(connectionId, today, today)).get('top');
  assert.strictEqual(todayReport.final, false);
  const { data } = await service.getAnalytics(connectionId, userId, { range: 'today' });
  assert.strictEqual(data.listings.find((l) => l.itemId === '111').views, 6, 'today’s listing figures after a refresh');
  await assert.rejects(service.refreshToday(connectionId, userId, now), (err) => err.statusCode === 429);
});

test('an account without the analytics scope makes no traffic calls and asks to reconnect', async () => {
  const { userId, connectionId } = await fixture();
  mockInputs({ scope: false });
  const calls = mockTrafficReports();
  assert.deepStrictEqual(await service.syncAccount(connectionId, userId), { calls: 0, status: 'needs_reconnect' });
  const { data } = await service.getAnalytics(connectionId, userId, { range: '30d' });
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(data.status, 'reconnect');
  assert.strictEqual(data.totals.impressions, null);
  assert.strictEqual(data.listings[0].traffic, 'unknown');
  assert.strictEqual(data.listings[0].watchers, 3, 'watchers still show: they cost nothing');
  await assert.rejects(service.refreshToday(connectionId, userId), (err) => err.statusCode === 403);
});

test('a later day reads only the new day; a failed read keeps what was stored and shows sales', async () => {
  const { userId, connectionId } = await fixture();
  mockInputs();
  const calls = mockTrafficReports();
  budget._reset({ limit: 100 });
  const dayOne = new Date();
  await service.syncAccount(connectionId, userId, { mode: 'essential', now: dayOne });
  const dayTwo = new Date(dayOne.getTime() + 24 * 3600e3);
  const before = calls.length;
  await service.syncAccount(connectionId, userId, { mode: 'essential', now: dayTwo });
  assert.strictEqual(calls.length - before, 1, 'one account call for the new day');
  assert.strictEqual((await repo.getSyncState(connectionId)).account_through, days.lastFinalDay(UK, dayTwo));

  // eBay failing on a listing report: the page still loads, with sales.
  mock.restoreAll();
  mockInputs({ orders: [{ createdAt: new Date(Date.now() - 3 * 864e5).toISOString(), lineItems: [{ itemId: '111', quantityPurchased: 1, price: { amount: 4.5, currency: 'GBP' } }] }] });
  mock.method(global, 'fetch', async () => ({ ok: false, status: 500, json: async () => ({ errors: [{ errorId: 1, message: 'eBay had a problem' }] }) }));
  const { data } = await service.getAnalytics(connectionId, userId, { range: '7d' });
  assert.strictEqual(data.listingReport.state, 'error');
  assert.strictEqual(data.listings.find((l) => l.itemId === '111').sold, 1);
  assert.strictEqual(data.listings.find((l) => l.itemId === '111').traffic, 'unknown');
});
