// Listing analytics: how an account's live listings are doing — eBay's
// traffic (impressions, views, click-through) from its Analytics API, and
// sales from the mirrored orders.
//
// eBay allows the whole app ~100 traffic calls a day, so traffic is kept as
// a daily history (analytics.repository) and every page is a sum over it.
// eBay is read:
//   - once a day per account, at 02:00 Pacific (10:00 UK), when eBay's day
//     is complete: yesterday's account totals and per-listing figures
//     (analytics.scheduler, or the first page view after that time);
//   - on an account's first sync: 180 days of account totals (2 calls) and
//     the last month of per-listing days, then older days trickle in from
//     whatever the allowance has spare (budget tier "backfill");
//   - when someone presses "Refresh today": today's partial figures, at most
//     REFRESHES_PER_DAY times per account per eBay day.
const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const traffic = require('../ebay/traffic');
const budget = require('../ebay/analytics-budget');
const accountEvents = require('../ebay/account-events');
const logger = require('../../utils/logger');
const repo = require('./analytics.repository');
const d = require('./analytics-days');

// eBay's traffic report covers these sites only.
const SUPPORTED_MARKETPLACES = new Set(['EBAY_AU', 'EBAY_DE', 'EBAY_ES', 'EBAY_FR', 'EBAY_GB', 'EBAY_IT', 'EBAY_US', 'EBAY_MOTORS_US']);
const REFRESHES_PER_DAY = 3;
const FIRST_RUN_LISTING_DAYS = 31; // a new account's 7-day, 30-day and this-month views are complete at once
const BACKFILL_DAYS_PER_RUN = 15;
const BACKFILL_INTERVAL_MS = 30 * 60 * 1000;
// States that mean "nothing to read until the seller acts"; re-checked
// every few hours, not every tick.
const BLOCKED = { reconnect: 'needs_reconnect', unsupported: 'unsupported_marketplace' };
const BLOCKED_RECHECK_MS = 6 * 60 * 60 * 1000;

class AnalyticsError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.expose = true;
  }
}

// ---- when to read eBay ---------------------------------------------------------

/** Final per-listing days still to fetch, newest first. */
function missingListingDays(state, now = new Date()) {
  const lastFinal = d.lastFinalDay(now);
  const done = new Set(state.listing_days || []);
  const out = [];
  for (let i = 0; i < d.LISTING_HISTORY_DAYS; i += 1) {
    const day = d.addDays(lastFinal, -i);
    if (!done.has(day)) out.push(day);
  }
  return out;
}

/** The first day of the unbroken run of fetched listing days ending at the last final day. */
function listingCoverageFrom(state, now = new Date()) {
  const lastFinal = d.lastFinalDay(now);
  const done = new Set(state.listing_days || []);
  let from = null;
  for (let day = lastFinal; done.has(day); day = d.addDays(day, -1)) from = day;
  return from;
}

/**
 * Whether the per-listing history covers a range: every final day in it has
 * been read. Today (still running) only counts for a range that is nothing
 * but today, and then only once "Refresh today" has read it.
 */
function listingsCover(coverageFrom, { lastFinal, todayRead }, from) {
  if (from > lastFinal) return todayRead;
  // The fetched days run unbroken from coverageFrom to the last final day.
  return Boolean(coverageFrom) && coverageFrom <= from;
}

/** Whether an account's history needs a read from eBay now. */
function isDue(state, now = new Date()) {
  const since = state.last_synced_at ? now - new Date(state.last_synced_at) : Infinity;
  if (Object.values(BLOCKED).includes(state.last_error) && since < BLOCKED_RECHECK_MS) return false;
  const lastFinal = d.lastFinalDay(now);
  if (!state.account_through || state.account_through < lastFinal) return true;
  if (!(state.listing_days || []).includes(lastFinal)) return true;
  return missingListingDays(state, now).length > 0 && since >= BACKFILL_INTERVAL_MS && budget.allows('backfill');
}

// ---- reading eBay ------------------------------------------------------------------

const running = new Map(); // connectionId -> the sync in progress

/**
 * Brings an account's traffic history up to date. `mode` "auto" reads what's
 * due (final days, then backfill); "essential" the same without backfill
 * (a first visit waits for this much only); "refresh" today's partial
 * figures. One sync per account at a time: a second caller shares the
 * first's.
 */
function syncAccount(connectionId, ownerId, { mode = 'auto', now = new Date() } = {}) {
  const key = String(connectionId);
  if (running.has(key)) return running.get(key);
  const promise = runSync(key, ownerId, { mode, now }).finally(() => running.delete(key));
  running.set(key, promise);
  return promise;
}

async function runSync(connectionId, ownerId, { mode, now }) {
  let failure = null;
  let outcome = { calls: 0, status: 'ok' };
  await connectionService.withDecryptedCredentials(connectionId, ownerId, async (credentials, connection) => {
    if (connection.platform_key !== 'ebay') throw new AnalyticsError(`Analytics aren't available for ${connection.platform_name} yet`);
    const inputs = await ebayService.analyticsInputs(credentials, connectionId, { push: ebayService.pushEnabled(connection) });
    const result = { credentialsChanged: inputs.credentialsChanged, credentials: inputs.credentials };

    const blocked = !inputs.hasAnalyticsScope ? BLOCKED.reconnect : !SUPPORTED_MARKETPLACES.has(inputs.marketplaceId) ? BLOCKED.unsupported : null;
    if (blocked) {
      await repo.saveSyncState(connectionId, { last_error: blocked, last_synced_at: now.toISOString() });
      outcome = { calls: 0, status: blocked };
      return result;
    }

    const state = await repo.getSyncState(connectionId);
    const done = new Set(state.listing_days || []);
    const today = d.ebayToday(now);
    const lastFinal = d.lastFinalDay(now);
    const ctx = { connectionId, marketplaceId: inputs.marketplaceId };
    const listingIds = inputs.items.map((item) => String(item.itemId));
    const before = budget.snapshot().used;
    const save = () =>
      repo.saveSyncState(connectionId, {
        listing_days: [...done].filter((day) => day >= d.addDays(lastFinal, -(d.LISTING_HISTORY_DAYS - 1))).sort(),
      });

    try {
      // Account totals: whatever final days are missing, plus today so far.
      const accountFrom = state.account_through ? d.addDays(state.account_through, 1) : d.addDays(today, -(d.ACCOUNT_HISTORY_DAYS - 1));
      if (accountFrom <= lastFinal || mode === 'refresh') {
        const from = accountFrom <= lastFinal ? accountFrom : today;
        const rows = await traffic.fetchAccountDays(inputs.accessToken, { ...ctx, from, to: today, kind: mode === 'refresh' ? 'refresh' : 'sync' });
        await repo.upsertTraffic(connectionId, rows.filter((r) => r.day <= lastFinal), { final: true });
        await repo.upsertTraffic(connectionId, rows.filter((r) => r.day > lastFinal), { final: false });
        if (accountFrom <= lastFinal) await repo.saveSyncState(connectionId, { account_through: lastFinal });
      }

      const readListingDay = async (day, kind, final) => {
        const rows = await traffic.fetchListingDay(inputs.accessToken, { ...ctx, day, listingIds, kind });
        await repo.clearListingDay(connectionId, day);
        await repo.upsertTraffic(connectionId, rows.map((r) => ({ ...r, day })), { final });
      };

      if (mode === 'refresh') {
        await readListingDay(today, 'refresh', false);
        await repo.saveSyncState(connectionId, { today_day: today, today_fetched_at: now.toISOString() });
      } else {
        if (!done.has(lastFinal)) {
          await readListingDay(lastFinal, 'sync', true);
          done.add(lastFinal);
          await save();
        }
        // Older days, newest first, from the spare allowance only.
        const limit = mode === 'essential' ? 0 : (state.listing_days || []).length > 1 ? BACKFILL_DAYS_PER_RUN : FIRST_RUN_LISTING_DAYS;
        for (const day of missingListingDays({ listing_days: [...done] }, now).slice(0, limit)) {
          if (!budget.allows('backfill', traffic.callsForListingDay(listingIds.length))) break;
          await readListingDay(day, 'backfill', true);
          done.add(day);
        }
        await save();
      }

      await repo.pruneBefore(connectionId, {
        accountBefore: d.addDays(today, -(d.ACCOUNT_HISTORY_DAYS - 1)),
        listingBefore: d.addDays(lastFinal, -(d.LISTING_HISTORY_DAYS - 1)),
      });
      await repo.saveSyncState(connectionId, { last_error: null, last_synced_at: now.toISOString() });
    } catch (err) {
      failure = err;
      await save().catch(() => {});
      await repo.saveSyncState(connectionId, { last_error: String(err.message || err).slice(0, 500), last_synced_at: now.toISOString() }).catch(() => {});
    }
    outcome = { calls: budget.snapshot().used - before, status: failure ? 'error' : 'ok' };
    return result;
  });

  if (outcome.calls > 0) accountEvents.emitUpdated(connectionId, 'analytics');
  if (failure) {
    logger.warn('Listing analytics sync stopped early', { connectionId, mode, error: failure.message });
    throw failure;
  }
  return outcome;
}

/**
 * "Refresh today": today's figures so far. Limited per account per eBay day,
 * and by the allowance's last slice, which only this uses.
 */
async function refreshToday(connectionId, ownerId, now = new Date()) {
  const state = await repo.getSyncState(connectionId);
  const today = d.ebayToday(now);
  const used = state.refresh_day === today ? state.refresh_count : 0;
  if (used >= REFRESHES_PER_DAY) {
    throw new AnalyticsError(`Today's ${REFRESHES_PER_DAY} refreshes are used. Figures update again at 10:00 UK time tomorrow.`, 429);
  }
  if (!budget.allows('refresh', 2)) {
    throw new AnalyticsError("eBay's daily allowance for traffic data is used up. Try again after the reset.", 429);
  }
  const outcome = await syncAccount(connectionId, ownerId, { mode: 'refresh', now });
  if (outcome.status === BLOCKED.reconnect) throw new AnalyticsError('Reconnect this eBay account to read its traffic.', 403);
  await repo.saveSyncState(connectionId, { refresh_day: today, refresh_count: used + 1 });
  return { refreshesLeft: REFRESHES_PER_DAY - used - 1 };
}

// ---- building a page ------------------------------------------------------------

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function withChanges(current, previous) {
  const changes = {};
  for (const key of Object.keys(current)) changes[key] = previous ? d.change(current[key], previous[key]) : null;
  return changes;
}

function sourcesFrom(t) {
  return [
    { key: 'search', label: 'eBay search', views: t.views_search },
    { key: 'store', label: 'Your store', views: t.views_store },
    { key: 'direct', label: 'Direct', views: t.views_direct },
    { key: 'other_ebay', label: 'Other eBay pages', views: t.views_other_ebay },
    { key: 'off_ebay', label: 'Off eBay', views: t.views_off_ebay },
  ];
}

// Before reading figures: an account never synced waits for its first read
// (so the first visit has figures); one that is merely due is read in the
// background while the stored figures are shown, and the page is told when
// the new ones land (account event "analytics").
async function ensureFresh(connectionId, ownerId) {
  const state = await repo.getSyncState(connectionId);
  const now = new Date();
  if (!isDue(state, now)) return;
  if (state.account_through) {
    syncAccount(connectionId, ownerId, { now }).catch(() => {});
    return;
  }
  // First visit: wait for account totals and yesterday per listing (a few
  // calls), then fill in the last month in the background.
  await syncAccount(connectionId, ownerId, { mode: 'essential', now }).catch(() => {});
  syncAccount(connectionId, ownerId).catch(() => {});
}

/**
 * The Analytics tab for one range: headline figures with the change from the
 * previous period, the daily series, where views came from, and every live
 * listing's figures.
 */
async function getAnalytics(connectionId, ownerId, { range = '30d' } = {}) {
  await ensureFresh(connectionId, ownerId);
  return connectionService.withDecryptedCredentials(connectionId, ownerId, async (credentials, connection) => {
    const inputs = await ebayService.analyticsInputs(credentials, connectionId, { push: ebayService.pushEnabled(connection) });
    const base = { credentialsChanged: inputs.credentialsChanged, credentials: inputs.credentials };
    const status = !inputs.hasAnalyticsScope ? 'reconnect' : !SUPPORTED_MARKETPLACES.has(inputs.marketplaceId) ? 'unsupported' : 'ok';

    const now = new Date();
    const today = d.ebayToday(now);
    const lastFinal = d.lastFinalDay(now);
    const win = d.rangeWindow(range, today);
    const state = await repo.getSyncState(connectionId);
    const sales = d.salesIndex(inputs.orders);
    const currency = sales.currency || (inputs.items[0]?.price?.currency ?? null);
    const ordersFrom = d.addDays(today, -89);

    // Account totals and the daily series.
    const accountRows = await repo.accountDays(connectionId, win.previous.from, win.to);
    const inRange = (from, to) => accountRows.filter((r) => r.day >= from && r.day <= to);
    const hasTraffic = Boolean(state.account_through);
    const todayRow = accountRows.find((r) => r.day === today);
    const currentTraffic = d.sumTraffic(inRange(win.from, win.to));
    const previousTraffic = d.sumTraffic(inRange(win.previous.from, win.previous.to));
    const salesCurrent = d.salesWithin(sales.byDay, win.from, win.to);
    const salesPrevious = win.previous.from >= ordersFrom ? d.salesWithin(sales.byDay, win.previous.from, win.previous.to) : null;
    const totals = d.metricsFrom(currentTraffic, salesCurrent);
    const previous = d.metricsFrom(previousTraffic, salesPrevious || { units: 0, amount: 0, orders: 0 });
    if (!salesPrevious) Object.assign(previous, { sold: null, orders: null, sales: null, conversion: null });
    if (!hasTraffic) Object.assign(previous, { impressions: null, views: null, ctr: null });

    const rowsByDay = new Map(accountRows.map((r) => [r.day, r]));
    const dayPoint = (day) => {
      const row = rowsByDay.get(day);
      const known = hasTraffic && Boolean(row || day <= state.account_through);
      const t = row || d.emptyTraffic();
      const salesKnown = day >= ordersFrom;
      const s = d.salesWithin(sales.byDay, day, day);
      return {
        day,
        impressions: known ? t.impressions : null,
        views: known ? t.views : null,
        ctr: known ? d.metricsFrom(t, s).ctr : null,
        sold: salesKnown ? s.units : null,
        sales: salesKnown ? round2(s.amount) : null,
        partial: day > lastFinal,
      };
    };
    const series = d.daysBetween(win.from, win.to).map(dayPoint);
    const previousSeries = d.daysBetween(win.previous.from, win.previous.to).map(dayPoint);

    // Per-listing figures, over the days the per-listing history covers.
    const coverageFrom = listingCoverageFrom(state, now);
    const todayListings = state.today_day === today;
    const listingComplete = listingsCover(coverageFrom, { lastFinal, todayRead: todayListings }, win.from);
    const prevCovered = listingsCover(coverageFrom, { lastFinal, todayRead: false }, win.previous.from);
    const [listingNow, listingPrev] = await Promise.all([
      coverageFrom ? repo.listingTotals(connectionId, [coverageFrom, win.from].sort()[1], win.to) : new Map(),
      prevCovered ? repo.listingTotals(connectionId, win.previous.from, win.previous.to) : null,
    ]);
    const listings = inputs.items.map((item) => {
      const id = String(item.itemId);
      const m = d.metricsFrom(listingNow.get(id) || d.emptyTraffic(), d.salesWithin(sales.byListingDay.get(id), win.from, win.to));
      let prev = null;
      if (listingPrev) {
        const pSales = win.previous.from >= ordersFrom ? d.salesWithin(sales.byListingDay.get(id), win.previous.from, win.previous.to) : null;
        prev = d.metricsFrom(listingPrev.get(id) || d.emptyTraffic(), pSales || { units: 0, amount: 0, orders: 0 });
        if (!pSales) Object.assign(prev, { sold: null, sales: null, conversion: null, orders: null });
      }
      return {
        itemId: id,
        title: item.title,
        imageUrl: item.imageUrl || null,
        url: item.viewItemUrl || null,
        price: item.price || null,
        quantityAvailable: item.quantityAvailable ?? null,
        ...m,
        sales: round2(m.sales),
        changes: withChanges(m, prev),
        hint: listingComplete && status === 'ok' ? d.hintFor(m, win) : null,
      };
    });

    const listingDaysDone = (state.listing_days || []).length;
    return {
      ...base,
      data: {
        status,
        range: { key: win.range, from: win.from, to: win.to, days: win.days, previous: win.previous },
        currency,
        totals: { ...totals, sales: round2(totals.sales) },
        previous: { ...previous, sales: round2(previous.sales) },
        changes: withChanges(totals, hasTraffic || salesPrevious ? previous : null),
        series,
        previousSeries,
        sources: sourcesFrom(currentTraffic),
        listings,
        coverage: {
          account: hasTraffic,
          listingsFrom: coverageFrom,
          listingsComplete: listingComplete,
          listingDaysDone,
          listingDaysTotal: d.LISTING_HISTORY_DAYS,
        },
        sync: {
          lastSyncedAt: state.last_synced_at,
          lastError: Object.values(BLOCKED).includes(state.last_error) ? null : state.last_error,
          finalThrough: state.account_through,
          nextSyncAt: d.nextSyncAt(now).toISOString(),
          todayUpdatedAt: todayRow ? todayRow.fetched_at || null : null,
          todayListingsUpdatedAt: todayListings ? state.today_fetched_at : null,
          refreshesLeft: Math.max(0, REFRESHES_PER_DAY - (state.refresh_day === today ? state.refresh_count : 0)),
          refreshLimit: REFRESHES_PER_DAY,
          syncing: running.has(String(connectionId)),
        },
        listingsSyncedAt: inputs.listingsSyncedAt,
      },
    };
  });
}

/** One listing over a range: its figures, the change, its daily series. */
async function getListingAnalytics(connectionId, ownerId, itemId, { range = '30d' } = {}) {
  await ensureFresh(connectionId, ownerId);
  return connectionService.withDecryptedCredentials(connectionId, ownerId, async (credentials, connection) => {
    const inputs = await ebayService.analyticsInputs(credentials, connectionId, { push: ebayService.pushEnabled(connection) });
    const base = { credentialsChanged: inputs.credentialsChanged, credentials: inputs.credentials };
    const id = String(itemId);
    const item = inputs.items.find((i) => String(i.itemId) === id);
    if (!item) throw new AnalyticsError('That listing is not live on this account.', 404);

    const status = !inputs.hasAnalyticsScope ? 'reconnect' : !SUPPORTED_MARKETPLACES.has(inputs.marketplaceId) ? 'unsupported' : 'ok';
    const now = new Date();
    const today = d.ebayToday(now);
    const lastFinal = d.lastFinalDay(now);
    const win = d.rangeWindow(range, today);
    const state = await repo.getSyncState(connectionId);
    const sales = d.salesIndex(inputs.orders);
    const listingSales = sales.byListingDay.get(id);
    const ordersFrom = d.addDays(today, -89);
    const coverageFrom = listingCoverageFrom(state, now);
    const coveredTo = state.today_day === today ? today : lastFinal;

    const rows = coverageFrom ? await repo.listingDays(connectionId, id, win.previous.from, win.to) : [];
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const known = (day) => Boolean(coverageFrom) && day >= coverageFrom && day <= coveredTo;
    const within = (from, to) => rows.filter((r) => r.day >= from && r.day <= to);

    const totals = d.metricsFrom(d.sumTraffic(within(win.from, win.to)), d.salesWithin(listingSales, win.from, win.to));
    const prevCovered = listingsCover(coverageFrom, { lastFinal, todayRead: false }, win.previous.from);
    let previous = null;
    if (prevCovered) {
      const pSales = win.previous.from >= ordersFrom ? d.salesWithin(listingSales, win.previous.from, win.previous.to) : null;
      previous = d.metricsFrom(d.sumTraffic(within(win.previous.from, win.previous.to)), pSales || { units: 0, amount: 0, orders: 0 });
      if (!pSales) Object.assign(previous, { sold: null, sales: null, conversion: null, orders: null });
    }
    const dayPoint = (day) => {
      const t = byDay.get(day) || d.emptyTraffic();
      const s = d.salesWithin(listingSales, day, day);
      const k = known(day);
      const salesKnown = day >= ordersFrom;
      return {
        day,
        impressions: k ? t.impressions : null,
        views: k ? t.views : null,
        ctr: k ? d.metricsFrom(t, s).ctr : null,
        sold: salesKnown ? s.units : null,
        sales: salesKnown ? round2(s.amount) : null,
        partial: day > lastFinal,
      };
    };
    const series = d.daysBetween(win.from, win.to).map(dayPoint);
    const previousSeries = d.daysBetween(win.previous.from, win.previous.to).map(dayPoint);
    const complete = listingsCover(coverageFrom, { lastFinal, todayRead: state.today_day === today }, win.from);

    return {
      ...base,
      data: {
        status,
        listing: {
          itemId: id,
          title: item.title,
          imageUrl: item.imageUrl || null,
          url: item.viewItemUrl || null,
          price: item.price || null,
          quantityAvailable: item.quantityAvailable ?? null,
          quantitySold: item.quantitySold ?? null,
          startTime: item.startTime || null,
        },
        range: { key: win.range, from: win.from, to: win.to, days: win.days, previous: win.previous },
        currency: item.price?.currency || sales.currency,
        totals: { ...totals, sales: round2(totals.sales) },
        previous: previous && { ...previous, sales: round2(previous.sales) },
        changes: withChanges(totals, previous),
        series,
        previousSeries,
        sources: sourcesFrom(d.sumTraffic(within(win.from, win.to))),
        hint: complete && status === 'ok' ? d.hintFor(totals, win) : null,
        coverage: { listingsFrom: coverageFrom, listingsComplete: complete },
        sync: { finalThrough: state.account_through, todayListingsUpdatedAt: state.today_day === today ? state.today_fetched_at : null },
      },
    };
  });
}

/**
 * Last 30 complete days per live listing (views, impressions) plus units
 * sold, for the Listings tab's rows. Stored figures only: no traffic calls.
 */
async function getListingSummaries(connectionId, ownerId) {
  return connectionService.withDecryptedCredentials(connectionId, ownerId, async (credentials, connection) => {
    const inputs = await ebayService.analyticsInputs(credentials, connectionId, { push: ebayService.pushEnabled(connection) });
    const base = { credentialsChanged: inputs.credentialsChanged, credentials: inputs.credentials };
    const now = new Date();
    const lastFinal = d.lastFinalDay(now);
    const from = d.addDays(lastFinal, -29);
    const state = await repo.getSyncState(connectionId);
    const coverageFrom = listingCoverageFrom(state, now);
    const totals = coverageFrom ? await repo.listingTotals(connectionId, [coverageFrom, from].sort()[1], lastFinal) : new Map();
    const sales = d.salesIndex(inputs.orders);
    const items = {};
    for (const item of inputs.items) {
      const id = String(item.itemId);
      const t = totals.get(id) || d.emptyTraffic();
      items[id] = { views: t.views, impressions: t.impressions, sold: d.salesWithin(sales.byListingDay.get(id), from, d.ebayToday(now)).units };
    }
    return {
      ...base,
      data: {
        status: inputs.hasAnalyticsScope ? 'ok' : 'reconnect',
        from,
        to: lastFinal,
        // Views cover this far back while the history is still filling in.
        viewsFrom: coverageFrom ? [coverageFrom, from].sort()[1] : null,
        complete: Boolean(coverageFrom) && coverageFrom <= from,
        items,
      },
    };
  });
}

/**
 * For the admin's usage page: the traffic allowance today, by kind and by
 * account, and where each account's history stands. `labels` maps
 * connection id -> account name.
 */
async function adminUsage(labels) {
  const snap = budget.snapshot();
  const states = await repo.allSyncStates();
  const byAccount = states
    .map((s) => ({
      connectionId: String(s.connection_id),
      label: labels.get(String(s.connection_id)) || 'Removed account',
      calls: snap.byAccount[String(s.connection_id)] || 0,
      finalThrough: s.account_through,
      listingDays: s.listing_day_count || 0,
      listingDaysTotal: d.LISTING_HISTORY_DAYS,
      refreshesToday: s.refresh_day === d.ebayToday() ? s.refresh_count || 0 : 0,
      lastSyncedAt: s.last_synced_at,
      status: s.last_error === BLOCKED.reconnect ? 'reconnect' : s.last_error === BLOCKED.unsupported ? 'unsupported' : s.last_error ? 'error' : 'ok',
      lastError: s.last_error && !Object.values(BLOCKED).includes(s.last_error) ? s.last_error : null,
    }))
    .sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label));
  return { ...snap, refreshesPerAccount: REFRESHES_PER_DAY, nextSyncAt: d.nextSyncAt().toISOString(), byAccount };
}

module.exports = {
  AnalyticsError,
  syncAccount,
  refreshToday,
  getAnalytics,
  getListingAnalytics,
  getListingSummaries,
  adminUsage,
  isDue,
  missingListingDays,
  listingCoverageFrom,
  REFRESHES_PER_DAY,
  SUPPORTED_MARKETPLACES,
};
