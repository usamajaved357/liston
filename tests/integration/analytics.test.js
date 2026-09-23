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

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const item = (id, title, startTime = daysAgo(20)) => ({ itemId: id, title, imageUrl: null, viewItemUrl: `https://www.ebay.co.uk/itm/${id}`, price: { amount: 4.5, currency: 'GBP' }, quantityAvailable: 9, watchCount: 3, startTime });
const SMALL_STORE = [item('111', 'Garden light'), item('222', 'Fishing line')];
// The last two hours before eBay's reset: leftover allowance goes on history.
const spareHours = (limit = 100) => budget._reset({ limit, resetAt: new Date(Date.now() + 3600e3).toISOString() });

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
// (800 in search), 100 views (20 from search), except `quietDay` (none).
// Per listing, per call: 111 gets 600 total impressions / 6 views, 222 gets
// 400 / 4; unfiltered requests return `topCount` listings (the busiest of a
// big store).
function mockTrafficReports({ topCount = 2, quietDay = null } = {}) {
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
      records = days.daysBetween(from, to).map((day) => ({ dimensionValues: [{ value: day.replace(/-/g, '') }], metricValues: values(day === quietDay ? [0, 0, 0, 0] : [70000, 800, 100, 20]) }));
    } else {
      const ids = filter.match(/listing_ids:\{([^}]*)\}/);
      const list = ids ? ids[1].split('|') : ['111', '222', ...Array.from({ length: topCount - 2 }, (_, i) => String(9000 + i))];
      records = list.map((id) => ({ dimensionValues: [{ value: id }], metricValues: values(listingRow(id)) }));
    }
    return { ok: true, status: 200, json: async () => ({ header, records }) };
  });
  return calls;
}

/** Syncs until nothing is due (history fills 15 days a run). */
async function syncUntilDone(connectionId, userId, now = new Date()) {
  for (let i = 0; i < 20 && service.isDue(await repo.getSyncState(connectionId), now); i += 1) await service.syncAccount(connectionId, userId, { now });
}

test('each night reads the day just ended for every listing; older days only from leftover allowance before the reset', async () => {
  const { userId, connectionId } = await fixture();
  mockInputs();
  const now = new Date();
  const today = days.today(UK, now);
  const lastFinal = days.lastFinalDay(UK, now);
  const quietDay = days.addDays(lastFinal, -3);
  const calls = mockTrafficReports({ quietDay });
  budget._reset({ limit: 100 });

  const first = await service.syncAccount(connectionId, userId, { mode: 'essential', now });
  const segments = service.accountSegments(days.addDays(today, -179), today, UK).length;
  assert.strictEqual(first.calls, segments, 'one call per segment (split at clock changes)');
  let state = await repo.getSyncState(connectionId);
  assert.deepStrictEqual([state.time_zone, state.account_through], [UK, lastFinal]);
  const acct = await repo.accountDays(connectionId, days.addDays(today, -179), today);
  assert.strictEqual(acct.length, days.dayCount(days.addDays(today, -179), lastFinal), 'complete days only');
  assert.ok(acct.every((r) => r.day <= lastFinal && r.final), 'a running day is never stored: a few hours would read as a collapse');
  assert.ok(calls.every((u) => /T00:00:00\.000\+0[01]:00/.test(u.searchParams.get('filter'))), 'every range is sent at UK midnight');

  // The nightly read on its own (as a page view catches it up): the day
  // just ended, naming every live listing.
  const nightly = await service.syncAccount(connectionId, userId, { now, fill: false });
  assert.strictEqual(nightly.calls, 1);
  assert.ok(calls.at(-1).searchParams.get('filter').includes('listing_ids:{111|222}'));
  state = await repo.getSyncState(connectionId);
  assert.deepStrictEqual(state.detail_days, [lastFinal]);
  assert.strictEqual(state.history_from, days.dayOf(SMALL_STORE[0].startTime, UK), 'history reaches back to the oldest live listing');
  assert.strictEqual(service.isDue(state, now, { history: false }), false, 'a page view has nothing more to read');
  assert.strictEqual(service.isDue(state, now), false, 'older days wait for the last hours before the reset');
  const [read] = await repo.dayReads(connectionId, lastFinal, lastFinal);
  assert.deepStrictEqual([read.listing_ids, read.cutoff, read.final], [['111', '222'], null, true]);

  // The spare hours: the rest of the history, a day a call — except a day
  // the account had no traffic at all, which needs none.
  spareHours();
  const before = calls.length;
  await syncUntilDone(connectionId, userId, now);
  state = await repo.getSyncState(connectionId);
  const needed = days.dayCount(state.history_from, lastFinal);
  assert.strictEqual(state.detail_days.length, needed);
  assert.strictEqual(calls.length - before, needed - 2, 'every missing day but the quiet one');
  assert.strictEqual(budget.snapshot().byKind.history, needed - 2);
  assert.strictEqual(service.isDue(state, now), false);
});

test('the Analytics tab: every range, and its comparison, is added up from stored days: switching ranges reads nothing', async () => {
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
  await service.syncAccount(connectionId, userId, { mode: 'essential', now });
  spareHours();
  await syncUntilDone(connectionId, userId, now);

  const before = calls.length;
  const { data } = await service.getAnalytics(connectionId, userId, { range: '7d' });
  assert.strictEqual(data.status, 'ok');
  assert.strictEqual(data.timeZone, UK);
  assert.deepStrictEqual([data.range.to, data.range.days, data.range.partial], [lastFinal, 7, false], 'complete days only');
  assert.strictEqual(data.totals.impressions, 7 * 70000, 'eBay’s total impressions');
  assert.strictEqual(data.totals.views, 700);
  assert.strictEqual(data.totals.ctr, 140 / 5600);
  assert.deepStrictEqual([data.totals.sold, data.totals.sales], [3, 19]);
  assert.strictEqual(data.changes.impressions, 0);

  const garden = data.listings.find((l) => l.itemId === '111');
  assert.deepStrictEqual([garden.traffic, garden.impressions, garden.views, garden.sold, garden.sales, garden.watchers], ['measured', 7 * 600, 7 * 6, 2, 9, 3]);
  assert.strictEqual(garden.changes.views, 0, 'the previous 7 days, also from stored days');
  assert.deepStrictEqual(data.listingReport, { ...data.listingReport, state: 'ok', scope: 'history', cutoff: null, live: 2, canLoadAll: false });
  assert.deepStrictEqual(data.sync.history, { ...data.sync.history, complete: true });

  const views = {};
  for (const range of ['30d', 'this_month', 'last_month', '90d', '7d']) {
    views[range] = (await service.getAnalytics(connectionId, userId, { range })).data;
    assert.ok(views[range].listings.every((l) => l.traffic === 'measured'), range);
  }
  const listedDays = days.dayCount(days.dayOf(SMALL_STORE[0].startTime, UK), lastFinal);
  assert.strictEqual(views['30d'].listings.find((l) => l.itemId === '111').views, listedDays * 6, 'every day since it was listed');
  assert.strictEqual(views['7d'].leadInSeries, null, 'a range of days charts itself');
  const panel = await service.getListingAnalytics(connectionId, userId, '222', { range: '30d' });
  assert.strictEqual(panel.data.traffic, 'measured');
  assert.strictEqual(panel.data.dailyTrafficDays, 30, 'a figure every day: zero before it was listed');
  const summary = await service.getListingSummaries(connectionId, userId);
  assert.strictEqual(summary.data.items['111'].views, listedDays * 6, 'the Listings tab: the same 30 days');
  assert.strictEqual(calls.length - before, 0, 'every range, the panel and the Listings tab: no eBay calls');
});

test('a store of 300: each day reads every listing (2 calls), so ranges are exact for all of them', async () => {
  const { userId, connectionId } = await fixture();
  const items = [...SMALL_STORE, ...Array.from({ length: 298 }, (_, i) => item(String(9000 + i), `Listing ${i}`, daysAgo(5)))].map((i) => ({ ...i, startTime: daysAgo(5) }));
  mockInputs({ items });
  const calls = mockTrafficReports();
  const now = new Date();
  await service.syncAccount(connectionId, userId, { mode: 'essential', now });
  let before = calls.length;
  await service.syncAccount(connectionId, userId, { now, fill: false });
  assert.strictEqual(calls.length - before, 2, '300 listings = 2 calls for the day');
  spareHours();
  await syncUntilDone(connectionId, userId, now);
  before = calls.length;
  const { data } = await service.getAnalytics(connectionId, userId, { range: '7d' });
  assert.strictEqual(data.listings.filter((l) => l.traffic === 'measured').length, 300);
  assert.strictEqual(data.listingReport.scope, 'history');
  assert.strictEqual(calls.length - before, 0);
});

test('filters never read eBay: a store over 1,000 while its history fills, then eBay’s busiest 200, "Load all" and one listing on request', async () => {
  const { userId, connectionId } = await fixture();
  const items = [...SMALL_STORE, ...Array.from({ length: 1098 }, (_, i) => item(String(9000 + i), `Listing ${i}`, null))];
  mockInputs({ items });
  const calls = mockTrafficReports({ topCount: 200 });
  budget._reset({ limit: 1000 });
  const now = new Date();
  await service.syncAccount(connectionId, userId, { mode: 'essential', now });
  let before = calls.length;
  await service.syncAccount(connectionId, userId, { now, fill: false });
  assert.strictEqual(calls.length - before, 1, 'the busiest 200: one call');
  assert.strictEqual(calls.at(-1).searchParams.get('sort'), '-TOTAL_IMPRESSION_TOTAL');

  // History still filling: every filter answers from what's stored.
  before = calls.length;
  let { data } = await service.getAnalytics(connectionId, userId, { range: '30d' });
  for (const range of ['7d', 'this_month', 'last_month', '90d']) await service.getAnalytics(connectionId, userId, { range });
  assert.strictEqual(calls.length - before, 0, 'no filter reads eBay');
  assert.ok(data.listings.every((l) => l.traffic === 'pending' && l.impressions === null));
  assert.strictEqual(data.totals.impressions, 30 * 70000, 'account figures are complete from day one');
  assert.deepStrictEqual([data.listingReport.state, data.listingReport.loadAllCalls, data.listingReport.canLoadAll], ['filling', 6, true]);

  // History filled: the busiest 200 each day are exact; the rest are below them.
  spareHours(1000);
  await syncUntilDone(connectionId, userId, now);
  before = calls.length;
  ({ data } = await service.getAnalytics(connectionId, userId, { range: '30d' }));
  const below = data.listings.filter((l) => l.traffic === 'below');
  assert.strictEqual(data.listings.filter((l) => l.traffic === 'measured').length, 200);
  assert.strictEqual(below.length, 900);
  assert.strictEqual(below[0].impressions, null, 'not read — never shown as zero');
  assert.deepStrictEqual([data.listingReport.state, data.listingReport.busiest], ['ok', true]);

  // A listing outside the 200: its panel reads nothing until asked.
  const outside = below[0].itemId;
  let panel = await service.getListingAnalytics(connectionId, userId, outside, { range: '30d' });
  assert.strictEqual(calls.length - before, 0);
  assert.deepStrictEqual([panel.data.traffic, panel.data.canRead, panel.data.readCalls], ['below', true, 2]);
  await service.readListing(connectionId, userId, outside, { range: '30d' });
  assert.strictEqual(calls.length - before, 2, 'this range and the previous one, for this listing');
  assert.ok(calls.at(-1).searchParams.get('filter').includes(`listing_ids:{${outside}}`));
  panel = await service.getListingAnalytics(connectionId, userId, outside, { range: '30d' });
  assert.strictEqual(panel.data.traffic, 'measured');
  assert.ok(panel.data.totals.impressions > 0);

  const loaded = await service.loadAllListings(connectionId, userId, { range: '30d' });
  assert.strictEqual(loaded.data.calls, 6);
  ({ data } = await service.getAnalytics(connectionId, userId, { range: '30d' }));
  assert.strictEqual(data.listings.filter((l) => l.traffic === 'measured').length, 1100, 'every listing, exactly');
  assert.strictEqual(data.listingReport.scope, 'all');
});

test('there is no Today: every range is complete days, so traffic and sales always cover the same days', async () => {
  const { userId, connectionId } = await fixture();
  const now = new Date();
  const lastFinal = days.lastFinalDay(UK, now);
  mockInputs({ orders: [{ createdAt: now.toISOString(), lineItems: [{ itemId: '111', quantityPurchased: 1, price: { amount: 4.5, currency: 'GBP' } }] }] });
  mockTrafficReports();
  budget._reset({ limit: 100 });
  await service.syncAccount(connectionId, userId, { mode: 'essential', now });
  await syncUntilDone(connectionId, userId, now);
  const { data } = await service.getAnalytics(connectionId, userId, { range: 'today' });
  assert.deepStrictEqual([data.range.key, data.range.to, data.range.partial], ['30d', lastFinal, false], 'an old "today" link opens 30 days');
  assert.strictEqual(data.totals.sold, 0, 'a sale today counts once the day is complete');
  assert.strictEqual(data.leadInSeries, null);
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
});

test('a later day reads only the new day; a filter the history doesn’t reach shows sales, and a failed read on request says so', async () => {
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

  // Only yesterday's listings stored: a 7-day filter loads with sales, and reads nothing.
  await service.syncAccount(connectionId, userId, { now: dayOne, fill: false });
  mock.restoreAll();
  mockInputs({ orders: [{ createdAt: new Date(Date.now() - 3 * 864e5).toISOString(), lineItems: [{ itemId: '111', quantityPurchased: 1, price: { amount: 4.5, currency: 'GBP' } }] }] });
  let fetched = 0;
  mock.method(global, 'fetch', async () => ((fetched += 1), { ok: false, status: 500, json: async () => ({ errors: [{ errorId: 1, message: 'eBay had a problem' }] }) }));
  const { data } = await service.getAnalytics(connectionId, userId, { range: '7d' });
  assert.strictEqual(fetched, 0);
  assert.strictEqual(data.listingReport.state, 'filling');
  assert.strictEqual(data.listings.find((l) => l.itemId === '111').sold, 1);
  assert.strictEqual(data.listings.find((l) => l.itemId === '111').traffic, 'pending');
  // eBay failing on a read someone asked for: an error, nothing stored.
  await assert.rejects(service.readListing(connectionId, userId, '111', { range: '7d' }), (err) => err.statusCode === 502);
});

// ---- listing health ----------------------------------------------------------------

const listingRepository = require('../../src/modules/listings/listing.repository');

// Six seasoned listings and one new one. Per day: 111 600 impressions (0.6%
// of search clicked), 222 400 (0.33%), the 9000s ~298 (1%): the account's
// typical listing clicks at 1%, so 222 is "seen, rarely clicked".
const HEALTH_STORE = [item('111', 'Garden light'), item('222', 'Fishing line'), ...['9001', '9002', '9003', '9004'].map((id) => item(id, `Item ${id}`)), item('333', 'Brand new lamp', daysAgo(3))];

async function healthFixture() {
  const { userId, connectionId } = await fixture();
  const now = new Date();
  mockInputs({ items: HEALTH_STORE });
  const calls = mockTrafficReports();
  await service.syncAccount(connectionId, userId, { mode: 'essential', now });
  spareHours();
  await syncUntilDone(connectionId, userId, now);
  return { userId, connectionId, calls };
}

test('every listing gets a health verdict against the account’s typical listing, with the money at stake, from stored data only', async () => {
  const { userId, connectionId, calls } = await healthFixture();
  // Liston published 222: its draft says what the listing is like.
  await pool.query(`INSERT INTO listings (connection_id, status, external_product_id, generated_data) VALUES ($1, 'published', '222', $2)`, [
    connectionId,
    { title: 'Fishing line', imageUrls: ['a', 'b'], aspects: { Brand: ['X'] }, description: 'Strong line.', categoryId: '1' },
  ]);
  const before = calls.length;
  const { data } = await service.getAnalytics(connectionId, userId, { range: '7d' });
  assert.strictEqual(calls.length - before, 0, 'no eBay call');
  assert.deepStrictEqual([data.benchmarks.listings, data.benchmarks.ctr], [6, 0.01]);
  const health = Object.fromEntries(data.listings.map((l) => [l.itemId, l.health]));
  assert.strictEqual(health['333'].stage, 'new');
  assert.strictEqual(health['222'].stage, 'not_clicked');
  assert.ok(health['222'].opportunity.units > 0 && health['222'].opportunity.amount > 0);
  assert.deepStrictEqual(
    health['222'].reasons.map((r) => [r.key, r.status]),
    [
      ['title', 'fail'],
      ['photo', 'warn'],
      ['watchers', 'info'],
    ],
    "the title's length from Liston's draft; 3 watchers and no sale"
  );
  assert.strictEqual(data.listings.find((l) => l.itemId === '222').hint, undefined, 'health replaces the old hint');

  const panel = await service.getListingAnalytics(connectionId, userId, '222', { range: '7d' });
  assert.deepStrictEqual(panel.data.health, health['222'], 'the panel judges it the same way');
  assert.deepStrictEqual([panel.data.check, panel.data.edits, panel.data.checkCalls], [null, [], { listing: 1, competitor: 1 }]);
});

test('a deeper check reads the listing, its category’s item specifics and similar listings’ prices once, and is kept', async () => {
  const { userId, connectionId } = await healthFixture();
  const getItem = mock.method(ebayService, 'getLiveItem', async () => ({
    itemId: '222',
    title: 'Fishing line braid 100m',
    imageUrls: ['a', 'b', 'c'],
    specifics: { Brand: ['X'] },
    variationSpecificsSet: {},
    description: '<p>Strong.</p>',
    categoryId: '1',
    currency: 'GBP',
    price: { amount: 4.5, currency: 'GBP' },
    shipping: { cost: 1.99, dispatchDays: 2 },
    returnsAccepted: true,
  }));
  mock.method(ebayService, 'categoryAspectSchema', async () => [{ name: 'Brand', required: true }, { name: 'Material', recommended: true }, { name: 'Length', recommended: true }]);
  const search = mock.method(ebayService, 'searchSimilarListings', async () => ({
    itemSummaries: [
      { legacyItemId: '222', price: { value: '1.00' } }, // this listing
      { legacyItemId: '5', price: { value: '3.20' }, shippingOptions: [{ shippingCost: { value: '0.99' } }] },
      { legacyItemId: '6', price: { value: '5.00' } },
      { legacyItemId: '7', price: { value: '6.50' }, shippingOptions: [{ shippingCost: { value: '0.00' } }] },
    ],
  }));

  const { data } = await service.checkListing(connectionId, userId, '222', { competitor: true });
  assert.deepStrictEqual(data.quality.specificsMissing, ['Material', 'Length']);
  assert.deepStrictEqual(data.quality.competitor, { query: 'Fishing line braid 100m', compared: 3, cheapest: 4.19, median: 5 });
  assert.deepStrictEqual([data.quality.shippingCost, data.calls], [1.99, 2]);
  assert.strictEqual(search.mock.calls[0].arguments[0].categoryId, '1');

  const panel = await service.getListingAnalytics(connectionId, userId, '222', { range: '7d' });
  assert.strictEqual(panel.data.check.quality.competitor.cheapest, 4.19, 'kept: reopening costs nothing');
  assert.ok(panel.data.health.reasons.some((r) => r.key === 'postage' && /1\.99/.test(r.text)), "its reasons use what the check found");
  assert.strictEqual(getItem.mock.calls.length, 1);

  await service.checkListing(connectionId, userId, '222');
  assert.strictEqual(search.mock.calls.length, 1, 'similar listings only when asked for');
});

test('a live edit’s effect: the listing’s figures in the days before and after it', async () => {
  const { userId, connectionId } = await healthFixture();
  const change = { fields: ['title'], before: { title: 'Old' }, after: { title: 'New' } };
  await listingRepository.recordListingChange(connectionId, '222', change);
  await pool.query(`UPDATE listing_changes SET changed_at = now() - interval '7 days' WHERE connection_id = $1`, [connectionId]);
  await listingRepository.recordListingChange(connectionId, '222', { ...change, after: { title: 'Newer' } });

  const { data } = await service.getListingAnalytics(connectionId, userId, '222', { range: '30d' });
  const [latest, earlier] = data.edits;
  assert.deepStrictEqual([latest.after.title, latest.figuresAfter, latest.waitDays], ['Newer', null, 3], 'too soon to judge: waits for 3 complete days');
  assert.deepStrictEqual(earlier.fields, ['title']);
  assert.strictEqual(earlier.figuresBefore.impressionsPerDay, 400);
  assert.strictEqual(earlier.figuresAfter.impressionsPerDay, 400);
  assert.strictEqual(earlier.figuresAfter.ctr, earlier.figuresBefore.ctr);
});

test('an edit published from Liston brings the saved deeper check up to date, without reading eBay', async () => {
  const { userId, connectionId } = await healthFixture();
  mock.method(ebayService, 'getLiveItem', async () => ({
    itemId: '222',
    title: 'Fishing line',
    imageUrls: ['a'],
    specifics: { Brand: ['X'] },
    variationSpecificsSet: {},
    description: '<p>Strong.</p>',
    categoryId: '1',
    currency: 'GBP',
    shipping: { cost: 0, dispatchDays: 4 },
    returnsAccepted: true,
  }));
  mock.method(ebayService, 'categoryAspectSchema', async () => [{ name: 'Brand', required: true }, { name: 'Material', recommended: true }, { name: 'Length', recommended: true }]);
  await service.checkListing(connectionId, userId, '222');
  const before = await repo.getHealthCheck(connectionId, '222');
  assert.deepStrictEqual(before.result.quality.specificsMissing, ['Material', 'Length']);

  const edited = { title: 'Fishing line braid 100m strong nylon', imageUrls: ['a', 'b'], aspects: { Brand: ['X'], material: ['Nylon'] }, description: '<p>Strong and long.</p>' };
  await service.checkAfterEdit(connectionId, '222', edited);

  const after = await repo.getHealthCheck(connectionId, '222');
  const q = after.result.quality;
  assert.deepStrictEqual(q.specificsMissing, ['Length'], 'a specific the edit filled is no longer empty');
  assert.deepStrictEqual([q.titleLength, q.photos, q.specificsCount], [edited.title.length, 2, 2]);
  assert.deepStrictEqual([q.dispatchDays, q.shippingCost], [4, 0], 'what a live edit cannot change stays as checked');
  assert.ok(q.editedAt);
  assert.strictEqual(after.checked_at.getTime(), before.checked_at.getTime(), 'still says when eBay was read');
  assert.strictEqual(ebayService.getLiveItem.mock.calls.length, 1, 'no eBay call');

  const { data } = await service.getListingAnalytics(connectionId, userId, '222', { range: '7d' });
  assert.ok(!data.health.reasons.some((r) => r.key === 'specifics' && /Material/.test(r.text)), 'its reasons stop asking for it');

  assert.strictEqual(await service.checkAfterEdit(connectionId, '999', edited), null, 'a listing never checked has nothing to update');
});
