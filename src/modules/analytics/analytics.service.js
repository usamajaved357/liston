// Listing analytics: how an account's live listings are doing — eBay's
// traffic (impressions, views, click-through) from its Analytics API, sales
// and units from the mirrored orders, watchers from the listings copy.
//
// eBay allows the whole app ~100 traffic calls a day, and nothing pushes
// traffic to us (no notification topic carries it), so every figure is
// read, once, and kept (see ARCHITECTURE.md §6):
//   - each night, at 02:00 in the seller's time zone, the day just ended:
//     the account's totals (1 call) and every live listing's figures for
//     that day (1 call per 200 listings, up to 1,000 listings; a bigger
//     store gets eBay's busiest 200);
//   - older days of that listing history, back 180 days, from allowance
//     left over in the last hours before eBay's daily reset — allowance
//     that would otherwise expire unused;
//   - any date range and its previous period is then ADDED UP from the
//     stored days: opening a range, switching ranges, the listing panel
//     and the Listings tab read nothing from eBay. Only while the history
//     is still filling (a new account's first nights), or for a big
//     store's quieter listings, is a range read as one report and kept for
//     the day;
//   - "Refresh today": today so far, 3 times per account per day.
// Every day is the seller's own calendar day, as in Seller Hub.
const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const traffic = require('../ebay/traffic');
const budget = require('../ebay/analytics-budget');
const accountEvents = require('../ebay/account-events');
const logger = require('../../utils/logger');
const repo = require('./analytics.repository');
const d = require('./analytics-days');

const REFRESHES_PER_DAY = 3;
// Stores up to this size have every listing read each day (5 calls); a
// bigger one gets eBay's busiest 200 (1 call).
const DAY_READ_MAX_LISTINGS = 1000;
// Days of history one account may fill per run, so each account gets a
// share of the spare allowance (the scheduler runs every 10 minutes).
const HISTORY_DAYS_PER_RUN = 15;
const REPORT_KEEP_MS = 3 * 24 * 3600e3;
// States that mean "nothing to read until the seller acts"; re-checked
// every few hours, not every tick.
const BLOCKED = { reconnect: 'needs_reconnect', unsupported: 'unsupported_marketplace' };
// Not a failure: today's allowance ran out before this account's read; it
// happens after the reset.
const WAITING = 'waiting_allowance';
const BLOCKED_RECHECK_MS = 6 * 60 * 60 * 1000;

class AnalyticsError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.expose = true;
  }
}

// ---- dates in eBay's terms ---------------------------------------------------------

/** A range as eBay reads it: each end at local midnight in the seller's time zone. */
function ebayRange(from, to, timeZone) {
  return { from, to, fromOffset: d.offsetAt(from, timeZone), toOffset: d.offsetAt(to, timeZone) };
}

/**
 * Account-total ranges for eBay's DAY report: at most 90 days each, and
 * split where the clocks change so every day starts at its own midnight.
 */
function accountSegments(from, to, timeZone) {
  const segments = [];
  let start = from;
  let offset = d.offsetAt(from, timeZone);
  let length = 1;
  for (let day = d.addDays(from, 1); ; day = d.addDays(day, 1)) {
    const past = day > to;
    const next = past ? null : d.offsetAt(day, timeZone);
    if (past || next !== offset || length === 90) {
      segments.push({ from: start, to: d.addDays(day, -1), fromOffset: offset, toOffset: offset });
      if (past) break;
      start = day;
      offset = next;
      length = 0;
    }
    length += 1;
  }
  return segments;
}

/**
 * Which listings a "busiest" range read asks for. A store with up to 200
 * live listings names them all — still one call, but every live listing
 * comes back exactly and nothing is cut off (unfiltered, eBay's 200 would
 * include listings that ended or sold out in the range). A bigger store
 * gets eBay's 200 with the most impressions, and a cutoff for the rest.
 */
function busiestListingIds(inputs) {
  return inputs.items.length <= 200 ? inputs.items.map((i) => String(i.itemId)) : null;
}

/** Which listings a day read names: every live one up to 1,000, else eBay's busiest 200. */
function dayListingIds(inputs) {
  return inputs.items.length <= DAY_READ_MAX_LISTINGS ? inputs.items.map((i) => String(i.itemId)) : null;
}

function callsPerDay(inputsOrCount) {
  const n = typeof inputsOrCount === 'number' ? inputsOrCount : inputsOrCount.items.length;
  return n <= DAY_READ_MAX_LISTINGS ? traffic.callsForAllListings(n) : 1;
}

/** Listing id -> the seller day it was listed (null when unknown). */
function listedOnMap(items, timeZone) {
  return new Map(items.map((i) => [String(i.itemId), i.startTime ? d.dayOf(i.startTime, timeZone) : null]));
}

/** The earliest day any live listing could have had traffic, or null when unknown. */
function earliestListed(listedOn) {
  const days = [...listedOn.values()];
  if (!days.length || days.some((day) => !day)) return null;
  return days.sort()[0];
}

function contextFor(timeZone, now = new Date()) {
  return { timeZone, today: d.today(timeZone, now), lastFinal: d.lastFinalDay(timeZone, now) };
}

// ---- when to read eBay ---------------------------------------------------------

/** Whether an account's stored figures need a read from eBay now. */
function isDue(state, now = new Date()) {
  const since = state.last_synced_at ? now - new Date(state.last_synced_at) : Infinity;
  if (Object.values(BLOCKED).includes(state.last_error) && since < BLOCKED_RECHECK_MS) return false;
  if (state.last_error === WAITING && !budget.allows('sync')) return false;
  if (!state.account_through || !state.time_zone) return true;
  const lastFinal = d.lastFinalDay(state.time_zone, now);
  if (state.account_through < lastFinal) return true;
  const done = state.detail_days || [];
  // The day just ended, for every listing.
  if (!done.includes(lastFinal)) return budget.allows('sync');
  // Older days, only from the spare allowance before the reset.
  return budget.allows('history') && d.historyDaysMissing({ lastFinal, historyFrom: state.history_from, done }).length > 0;
}

// ---- reading eBay ------------------------------------------------------------------

const running = new Map(); // connectionId -> the sync in progress

function blockedStatus(inputs) {
  if (!inputs.hasAnalyticsScope) return BLOCKED.reconnect;
  if (!d.timeZoneFor(inputs.marketplaceId)) return BLOCKED.unsupported;
  return null;
}

/**
 * Brings an account's stored figures up to date. `mode`:
 *   auto       what's due: account totals, every listing's day just
 *              ended, then older listing days from spare allowance
 *   essential  account totals only (a first visit waits for this much)
 *   refresh    today so far: account total and every listing
 * One sync per account at a time: a second caller shares the first's.
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

    const blocked = blockedStatus(inputs);
    if (blocked) {
      await repo.saveSyncState(connectionId, { last_error: blocked, last_synced_at: now.toISOString() });
      outcome = { calls: 0, status: blocked };
      return result;
    }

    const timeZone = d.timeZoneFor(inputs.marketplaceId);
    let state = await repo.getSyncState(connectionId);
    if (state.time_zone && state.time_zone !== timeZone) {
      // The account moved site: its days no longer line up. Start again.
      await repo.clearAccount(connectionId);
      state = await repo.getSyncState(connectionId);
    }
    const { today, lastFinal } = contextFor(timeZone, now);
    const ctx = { connectionId, marketplaceId: inputs.marketplaceId };
    const done = new Set(state.detail_days || []);
    const historyFrom = earliestListed(listedOnMap(inputs.items, timeZone));
    const historyFloor = d.addDays(lastFinal, -(d.LISTING_HISTORY_DAYS - 1));
    const perDay = callsPerDay(inputs);
    const before = budget.snapshot().used;
    const saveDays = () =>
      repo.saveSyncState(connectionId, { time_zone: timeZone, history_from: historyFrom, detail_days: [...done].filter((day) => day >= historyFloor).sort() });

    // Every listing's figures for one day, stored day by day, with which
    // listings the read covered (a listing it named and eBay didn't return
    // had no traffic that day).
    const readListingDay = async (day, kind, final) => {
      const listingIds = dayListingIds(inputs);
      const { rows, cutoff } = await traffic.fetchListingReport(inputs.accessToken, { ...ctx, range: ebayRange(day, day, timeZone), listingIds, kind });
      await repo.clearListingDay(connectionId, day);
      await repo.upsertTraffic(connectionId, rows.map((r) => ({ ...r, day })), { final });
      await repo.saveReport(connectionId, { from: day, to: day, scope: 'day', cutoff, final, listingIds });
    };
    // A complete day: read it, unless the account had no traffic at all
    // that day (its stored total says so), which needs no call.
    const storeDay = async (day, kind) => {
      const [total] = await repo.accountDays(connectionId, day, day);
      if (total && Number(total.total_impressions) === 0 && Number(total.views) === 0) {
        await repo.clearListingDay(connectionId, day);
        await repo.saveReport(connectionId, { from: day, to: day, scope: 'day', cutoff: null, final: true, listingIds: null });
      } else {
        await readListingDay(day, kind, true);
      }
      done.add(day);
    };

    try {
      // Account totals: any complete days not yet stored, and today so far.
      const accountFrom = state.account_through ? d.addDays(state.account_through, 1) : d.addDays(today, -(d.ACCOUNT_HISTORY_DAYS - 1));
      if (accountFrom <= lastFinal || mode === 'refresh') {
        const from = accountFrom <= lastFinal ? accountFrom : today;
        const rows = await traffic.fetchAccountDays(inputs.accessToken, { ...ctx, segments: accountSegments(from, today, timeZone), kind: mode === 'refresh' ? 'refresh' : 'sync' });
        await repo.upsertTraffic(connectionId, rows.filter((r) => r.day <= lastFinal), { final: true });
        await repo.upsertTraffic(connectionId, rows.filter((r) => r.day > lastFinal), { final: false });
        await repo.saveSyncState(connectionId, { time_zone: timeZone, ...(accountFrom <= lastFinal ? { account_through: lastFinal } : {}) });
      }

      if (mode === 'refresh') {
        await readListingDay(today, 'refresh', false);
        await repo.saveSyncState(connectionId, { today_day: today, today_fetched_at: now.toISOString() });
      } else if (mode === 'auto') {
        // The day just ended, then older days while the spare allowance lasts.
        if (!done.has(lastFinal) && budget.allows('sync', perDay)) await storeDay(lastFinal, 'sync');
        const missing = d.historyDaysMissing({ lastFinal, historyFrom, done: [...done] }).slice(0, HISTORY_DAYS_PER_RUN);
        for (const day of missing) {
          if (!budget.allows('history', perDay)) break;
          await storeDay(day, 'history');
        }
        await saveDays();
      }

      await repo.pruneBefore(connectionId, {
        accountBefore: d.addDays(today, -(d.ACCOUNT_HISTORY_DAYS - 1)),
        listingBefore: historyFloor,
      });
      await repo.pruneReports(connectionId, new Date(now.getTime() - REPORT_KEEP_MS), historyFloor);
      await repo.saveSyncState(connectionId, { time_zone: timeZone, last_error: null, last_synced_at: now.toISOString() });
    } catch (err) {
      failure = err;
      await saveDays().catch(() => {});
      const lastError = err.code === 'ANALYTICS_BUDGET' ? WAITING : String(err.message || err).slice(0, 500);
      await repo.saveSyncState(connectionId, { last_error: lastError, last_synced_at: now.toISOString() }).catch(() => {});
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
 * "Refresh today": today's figures so far. Limited per account per day, and
 * by the allowance's last slice, which only this uses.
 */
async function refreshToday(connectionId, ownerId, now = new Date()) {
  const state = await repo.getSyncState(connectionId);
  const timeZone = state.time_zone || 'Europe/London';
  const today = d.today(timeZone, now);
  const used = state.refresh_day === today ? state.refresh_count : 0;
  if (used >= REFRESHES_PER_DAY) {
    throw new AnalyticsError(`Today's ${REFRESHES_PER_DAY} refreshes are used. Figures update again overnight.`, 429);
  }
  if (!budget.allows('refresh', 2)) {
    throw new AnalyticsError("eBay's daily allowance for traffic data is used up. Try again after the reset.", 429);
  }
  const outcome = await syncAccount(connectionId, ownerId, { mode: 'refresh', now });
  if (outcome.status === BLOCKED.reconnect) throw new AnalyticsError('Reconnect this eBay account to read its traffic.', 403);
  if (outcome.status === BLOCKED.unsupported) throw new AnalyticsError("eBay's traffic report doesn't cover this account's site.", 400);
  await repo.saveSyncState(connectionId, { refresh_day: today, refresh_count: used + 1 });
  return { refreshesLeft: REFRESHES_PER_DAY - used - 1 };
}

// Before reading figures: an account never synced waits for its account
// totals (so the first visit has figures) and gets its listings' detail in
// the background; one merely due is read in the background while the
// stored figures are shown, and the page is told when new ones land
// (account event "analytics").
async function ensureFresh(connectionId, ownerId) {
  const state = await repo.getSyncState(connectionId);
  const now = new Date();
  if (!isDue(state, now)) return;
  if (state.account_through) {
    syncAccount(connectionId, ownerId, { now }).catch(() => {});
    return;
  }
  await syncAccount(connectionId, ownerId, { mode: 'essential', now }).catch(() => {});
  syncAccount(connectionId, ownerId).catch(() => {});
}

// ---- listing figures for a range ---------------------------------------------------------

/**
 * The stored report for a range and scope, read from eBay when missing. A
 * range that includes today is never read automatically (today's listing
 * figures come from "Refresh today"). Resolves to the report, null, or
 * { error } when the allowance or eBay says no — the page still shows sales.
 */
async function reportFor({ connectionId, inputs, timeZone, from, to, scope, lastFinal, allowFetch = true }) {
  const stored = (await repo.reportsFor(connectionId, from, to)).get(scope);
  if (stored) return stored;
  if (!allowFetch || to > lastFinal) return null;
  const listingIds = scope === 'all' ? inputs.items.map((i) => String(i.itemId)) : scope.startsWith('item:') ? [scope.slice(5)] : busiestListingIds(inputs);
  try {
    const { rows, cutoff } = await traffic.fetchListingReport(inputs.accessToken, {
      connectionId,
      marketplaceId: inputs.marketplaceId,
      range: ebayRange(from, to, timeZone),
      listingIds,
      kind: 'view',
    });
    await repo.saveReport(connectionId, { from, to, scope, rows, cutoff, final: true });
    return { from_day: from, to_day: to, scope, rows, cutoff, final: true, fetched_at: new Date().toISOString() };
  } catch (err) {
    logger.warn('Listing traffic report not read', { connectionId, from, to, scope, error: err.message });
    return { error: err.code === 'ANALYTICS_BUDGET' ? 'allowance' : 'ebay', message: err.message };
  }
}

/**
 * Each listing's totals for a range added up from the stored days, for the
 * listings those days cover exactly (analytics-days.historyReport).
 */
async function historyFor(connectionId, from, to, listedOn) {
  const reads = await repo.dayReads(connectionId, from, to);
  const busiestDays = reads.filter((r) => !r.listing_ids && r.cutoff != null).map((r) => r.day);
  const totals = await repo.listingTotals(connectionId, from, to, busiestDays);
  return d.historyReport({ from, to, reads, totals, listedOn });
}

/** How far each account's listing history reaches, for the page and the admin. */
function historyProgress(state, timeZone, now = new Date()) {
  const lastFinal = d.lastFinalDay(timeZone, now);
  const missing = d.historyDaysMissing({ lastFinal, historyFrom: state.history_from, done: state.detail_days }).length;
  const floor = [d.addDays(lastFinal, -(d.LISTING_HISTORY_DAYS - 1)), state.history_from || ''].sort()[1];
  const needed = d.dayCount(floor, lastFinal);
  return { stored: needed - missing, needed, complete: missing === 0 };
}

/**
 * One listing's traffic from a range's reports, best first: its row; zero
 * when a report is complete and it isn't there (no impressions at all); or
 * "below" when it wasn't among the busiest 200 (fewer impressions than the
 * cutoff; exact figures not read).
 */
function trafficFrom(reports, listingId) {
  let belowCutoff = null;
  for (const report of reports) {
    if (!report || report.error) continue;
    if (report.covers && !report.covers(listingId)) continue; // stored history, not for this listing
    const row = (report.rows || []).find((r) => String(r.listingId) === listingId);
    if (row) return { state: 'measured', traffic: row };
    if (report.cutoff == null) return { state: 'measured', traffic: d.emptyTraffic() };
    belowCutoff = belowCutoff == null ? report.cutoff : Math.min(belowCutoff, report.cutoff);
  }
  return belowCutoff == null ? { state: 'unknown', traffic: null, cutoff: null } : { state: 'below', traffic: null, cutoff: belowCutoff };
}

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function withChanges(current, previous) {
  const changes = {};
  for (const key of Object.keys(current)) changes[key] = previous ? d.change(current[key], previous[key]) : null;
  return changes;
}

/**
 * A listing only has a fair previous period if it was already live when
 * that period began; one listed since would compare against days it
 * didn't exist.
 */
function liveThroughPrevious(item, previousFrom, timeZone) {
  if (!item.startTime) return true;
  const listedOn = d.dayOf(item.startTime, timeZone);
  return !listedOn || listedOn <= previousFrom;
}

function listingMetrics(t, sales) {
  if (t.state !== 'measured') {
    return { impressions: null, views: null, ctr: null, sold: sales.units, orders: sales.orders, sales: sales.amount, conversion: null };
  }
  return d.metricsFrom(t.traffic, sales);
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

function statusOf(inputs) {
  return !inputs.hasAnalyticsScope ? 'reconnect' : !d.timeZoneFor(inputs.marketplaceId) ? 'unsupported' : 'ok';
}

function describeReport(report) {
  if (!report) return { state: 'none' };
  if (report.error) return { state: report.error === 'allowance' ? 'allowance' : 'error', message: report.message };
  if (report.scope === 'history') return { state: 'ok', scope: 'history', cutoff: null, measured: report.coveredCount, fetchedAt: null };
  return { state: 'ok', scope: report.scope, cutoff: report.cutoff, measured: (report.rows || []).length, fetchedAt: report.fetched_at };
}

/**
 * The Analytics tab for one range: account figures with the change from the
 * previous period, the daily series, where views came from, and every live
 * listing's figures.
 */
async function getAnalytics(connectionId, ownerId, { range = '30d' } = {}) {
  await ensureFresh(connectionId, ownerId);
  return connectionService.withDecryptedCredentials(connectionId, ownerId, async (credentials, connection) => {
    const inputs = await ebayService.analyticsInputs(credentials, connectionId, { push: ebayService.pushEnabled(connection) });
    const base = { credentialsChanged: inputs.credentialsChanged, credentials: inputs.credentials };
    const status = statusOf(inputs);
    const timeZone = d.timeZoneFor(inputs.marketplaceId) || 'Europe/London';
    const now = new Date();
    const { today, lastFinal } = contextFor(timeZone, now);
    const win = d.rangeWindow(range, { today, lastFinal });
    const state = await repo.getSyncState(connectionId);
    const sales = d.salesIndex(inputs.orders, timeZone);
    const currency = sales.currency || (inputs.items[0]?.price?.currency ?? null);
    const ordersFrom = d.addDays(today, -89); // the orders mirror keeps 90 days
    const hasTraffic = status === 'ok' && Boolean(state.account_through);

    // Account totals and the daily series, from the stored days.
    const accountRows = hasTraffic ? await repo.accountDays(connectionId, win.previous.from, win.to) : [];
    const rowsByDay = new Map(accountRows.map((r) => [r.day, r]));
    const inRange = (from, to) => accountRows.filter((r) => r.day >= from && r.day <= to);
    const salesCurrent = d.salesWithin(sales.byDay, win.from, win.to);
    const salesPrevious = win.previous.from >= ordersFrom ? d.salesWithin(sales.byDay, win.previous.from, win.previous.to) : null;
    const totals = d.metricsFrom(d.sumTraffic(inRange(win.from, win.to)), salesCurrent);
    const previous = d.metricsFrom(d.sumTraffic(inRange(win.previous.from, win.previous.to)), salesPrevious || { units: 0, amount: 0, orders: 0 });
    if (!salesPrevious) Object.assign(previous, { sold: null, orders: null, sales: null, conversion: null });
    if (!hasTraffic) {
      Object.assign(totals, { impressions: null, views: null, ctr: null, conversion: null });
      Object.assign(previous, { impressions: null, views: null, ctr: null, conversion: null });
    }

    const dayPoint = (day) => {
      const row = rowsByDay.get(day);
      const known = hasTraffic && Boolean(row || day <= state.account_through);
      const t = row || d.emptyTraffic();
      const salesKnown = day >= ordersFrom;
      const s = d.salesWithin(sales.byDay, day, day);
      return {
        day,
        impressions: known ? t.total_impressions : null,
        views: known ? t.views : null,
        ctr: known ? d.metricsFrom(t, s).ctr : null,
        sold: salesKnown ? s.units : null,
        sales: salesKnown ? round2(s.amount) : null,
        partial: day > lastFinal,
      };
    };

    // Listing figures: added up from the stored days. Only when those
    // don't cover every live listing yet (history still filling, or a big
    // store's quieter listings) is the range read as one report, kept for
    // the day. The previous period is never read for this: its changes
    // show once the history reaches it (or from a report already stored).
    let current = [];
    let prior = [];
    let history = null;
    if (status === 'ok') {
      const listedOn = listedOnMap(inputs.items, timeZone);
      const args = { connectionId, inputs, timeZone, lastFinal };
      const [hist, prevHist] = await Promise.all([historyFor(connectionId, win.from, win.to, listedOn), historyFor(connectionId, win.previous.from, win.previous.to, listedOn)]);
      history = hist;
      const [all, top] = hist.complete
        ? [null, null]
        : await Promise.all([reportFor({ ...args, from: win.from, to: win.to, scope: 'all', allowFetch: false }), reportFor({ ...args, from: win.from, to: win.to, scope: 'top' })]);
      const [prevAll, prevTop] = prevHist.complete
        ? [null, null]
        : await Promise.all([
            reportFor({ ...args, from: win.previous.from, to: win.previous.to, scope: 'all', allowFetch: false }),
            reportFor({ ...args, from: win.previous.from, to: win.previous.to, scope: 'top', allowFetch: false }),
          ]);
      current = [hist, all, top];
      prior = [prevHist, prevAll, prevTop];
    }
    const listings = inputs.items.map((item) => {
      const id = String(item.itemId);
      const t = trafficFrom(current, id);
      const m = listingMetrics(t, d.salesWithin(sales.byListingDay.get(id), win.from, win.to));
      const pt = trafficFrom(prior, id);
      let prev = null;
      if (pt.state === 'measured' && liveThroughPrevious(item, win.previous.from, timeZone)) {
        const pSales = win.previous.from >= ordersFrom ? d.salesWithin(sales.byListingDay.get(id), win.previous.from, win.previous.to) : null;
        prev = listingMetrics(pt, pSales || { units: 0, amount: 0, orders: 0 });
        if (!pSales) Object.assign(prev, { sold: null, sales: null, conversion: null, orders: null });
      }
      return {
        itemId: id,
        title: item.title,
        imageUrl: item.imageUrl || null,
        url: item.viewItemUrl || null,
        price: item.price || null,
        quantityAvailable: item.quantityAvailable ?? null,
        watchers: item.watchCount ?? null,
        traffic: t.state, // measured | below | unknown
        ...m,
        sales: round2(m.sales),
        changes: withChanges(m, t.state === 'measured' ? prev : null),
        hint: t.state === 'measured' && !win.partial ? d.hintFor(m, win) : null,
      };
    });

    const fallback = current.slice(1);
    const shown = history?.complete ? history : fallback.find((r) => r && !r.error) || fallback.find(Boolean) || null;
    const report = describeReport(shown);
    const loadAllCalls = traffic.callsForAllListings(inputs.items.length);
    return {
      ...base,
      data: {
        status,
        timeZone,
        range: { key: win.range, from: win.from, to: win.to, days: win.days, partial: win.partial, previous: win.previous },
        currency,
        totals: { ...totals, sales: round2(totals.sales) },
        previous: { ...previous, sales: round2(previous.sales) },
        changes: withChanges(totals, previous),
        series: d.daysBetween(win.from, win.to).map(dayPoint),
        previousSeries: d.daysBetween(win.previous.from, win.previous.to).map(dayPoint),
        sources: sourcesFrom(d.sumTraffic(inRange(win.from, win.to))),
        listings,
        listingReport: {
          ...report,
          live: inputs.items.length,
          loadAllCalls,
          canLoadAll: report.state === 'ok' && report.scope === 'top' && report.cutoff != null && !win.partial && budget.allows('view', loadAllCalls),
        },
        sync: {
          lastSyncedAt: state.last_synced_at,
          lastError: Object.values(BLOCKED).includes(state.last_error) || state.last_error === WAITING ? null : state.last_error,
          waitingForAllowance: state.last_error === WAITING,
          finalThrough: state.account_through,
          nextSyncAt: d.nextSyncAt(timeZone, now).toISOString(),
          todayUpdatedAt: rowsByDay.get(today)?.fetched_at || null,
          todayListingsUpdatedAt: state.today_day === today ? state.today_fetched_at : null,
          refreshesLeft: Math.max(0, REFRESHES_PER_DAY - (state.refresh_day === today ? state.refresh_count : 0)),
          refreshLimit: REFRESHES_PER_DAY,
          history: status === 'ok' ? historyProgress(state, timeZone, now) : null,
          syncing: running.has(String(connectionId)),
        },
        listingsSyncedAt: inputs.listingsSyncedAt,
      },
    };
  });
}

/** "Load all listings": every live listing's figures for a range (1 call per 200). */
async function loadAllListings(connectionId, ownerId, { range = '30d' } = {}) {
  return connectionService.withDecryptedCredentials(connectionId, ownerId, async (credentials, connection) => {
    const inputs = await ebayService.analyticsInputs(credentials, connectionId, { push: ebayService.pushEnabled(connection) });
    const base = { credentialsChanged: inputs.credentialsChanged, credentials: inputs.credentials };
    if (statusOf(inputs) !== 'ok') throw new AnalyticsError('Traffic data isn’t available for this account.', 403);
    const timeZone = d.timeZoneFor(inputs.marketplaceId);
    const { today, lastFinal } = contextFor(timeZone);
    const win = d.rangeWindow(range, { today, lastFinal });
    if (win.partial) throw new AnalyticsError("Today's listing figures come from Refresh today.", 400);
    const calls = traffic.callsForAllListings(inputs.items.length);
    if (!budget.allows('view', calls)) throw new AnalyticsError(`Loading every listing takes ${calls} calls, more than today's allowance has left.`, 429);
    const report = await reportFor({ connectionId, inputs, timeZone, from: win.from, to: win.to, scope: 'all', lastFinal });
    if (report?.error) throw new AnalyticsError(report.message, report.error === 'allowance' ? 429 : 502);
    accountEvents.emitUpdated(connectionId, 'analytics');
    return { ...base, data: { calls, listings: inputs.items.length } };
  });
}

/**
 * One listing over a range: exact totals (from the range's reports, or a
 * read of this listing on its own when it wasn't among the busiest), the
 * change, and its daily series — traffic for the days it was among the
 * account's busiest 200, sales every day.
 */
async function getListingAnalytics(connectionId, ownerId, itemId, { range = '30d' } = {}) {
  await ensureFresh(connectionId, ownerId);
  return connectionService.withDecryptedCredentials(connectionId, ownerId, async (credentials, connection) => {
    const inputs = await ebayService.analyticsInputs(credentials, connectionId, { push: ebayService.pushEnabled(connection) });
    const base = { credentialsChanged: inputs.credentialsChanged, credentials: inputs.credentials };
    const id = String(itemId);
    const item = inputs.items.find((i) => String(i.itemId) === id);
    if (!item) throw new AnalyticsError('That listing is not live on this account.', 404);

    const status = statusOf(inputs);
    const timeZone = d.timeZoneFor(inputs.marketplaceId) || 'Europe/London';
    const now = new Date();
    const { today, lastFinal } = contextFor(timeZone, now);
    const win = d.rangeWindow(range, { today, lastFinal });
    const state = await repo.getSyncState(connectionId);
    const sales = d.salesIndex(inputs.orders, timeZone);
    const listingSales = sales.byListingDay.get(id);
    const ordersFrom = d.addDays(today, -89);

    // Totals: added up from the stored days; failing that, whichever stored
    // report has this listing; failing that, read it on its own (exact,
    // whatever the store's size).
    const listedOn = listedOnMap([item], timeZone);
    const totalsFor = async (from, to) => {
      if (status !== 'ok') return { state: 'unknown', traffic: null, cutoff: null };
      const stored = await repo.reportsFor(connectionId, from, to);
      const t = trafficFrom([await historyFor(connectionId, from, to, listedOn), stored.get('all'), stored.get(`item:${id}`), stored.get('top')], id);
      if (t.state === 'measured') return t;
      const own = await reportFor({ connectionId, inputs, timeZone, lastFinal, from, to, scope: `item:${id}` });
      return own && !own.error ? trafficFrom([own], id) : t;
    };
    const comparable = liveThroughPrevious(item, win.previous.from, timeZone);
    const [t, pt] = await Promise.all([totalsFor(win.from, win.to), comparable ? totalsFor(win.previous.from, win.previous.to) : { state: 'unknown', traffic: null }]);
    const totals = listingMetrics(t, d.salesWithin(listingSales, win.from, win.to));
    let previous = null;
    if (pt.state === 'measured') {
      const pSales = win.previous.from >= ordersFrom ? d.salesWithin(listingSales, win.previous.from, win.previous.to) : null;
      previous = listingMetrics(pt, pSales || { units: 0, amount: 0, orders: 0 });
      if (!pSales) Object.assign(previous, { sold: null, sales: null, conversion: null, orders: null });
    }

    // Daily traffic: a day read with this listing in it has its figures; a
    // day read that covered it (named it, or had no cutoff) without a row
    // is zero, as is a day before it was listed; otherwise unknown.
    const rows = status === 'ok' ? await repo.listingDays(connectionId, id, win.previous.from, win.to) : [];
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const reads = status === 'ok' ? new Map((await repo.dayReads(connectionId, win.previous.from, win.to)).map((r) => [r.day, r])) : new Map();
    const listed = listedOn.get(id);
    const coveredZero = (day) => {
      if (listed && listed > day) return true;
      const read = reads.get(day);
      if (!read) return false;
      return read.listing_ids ? read.listing_ids.map(String).includes(id) : read.cutoff == null;
    };
    const dayPoint = (day) => {
      const s = d.salesWithin(listingSales, day, day);
      const salesKnown = day >= ordersFrom;
      let tr = null;
      if (byDay.has(day)) tr = byDay.get(day);
      else if (coveredZero(day)) tr = d.emptyTraffic();
      return {
        day,
        impressions: tr ? tr.total_impressions : null,
        views: tr ? tr.views : null,
        ctr: tr ? d.metricsFrom(tr, s).ctr : null,
        sold: salesKnown ? s.units : null,
        sales: salesKnown ? round2(s.amount) : null,
        partial: day > lastFinal,
      };
    };
    const series = d.daysBetween(win.from, win.to).map(dayPoint);

    return {
      ...base,
      data: {
        status,
        timeZone,
        listing: {
          itemId: id,
          title: item.title,
          imageUrl: item.imageUrl || null,
          url: item.viewItemUrl || null,
          price: item.price || null,
          quantityAvailable: item.quantityAvailable ?? null,
          quantitySold: item.quantitySold ?? null,
          watchers: item.watchCount ?? null,
          startTime: item.startTime || null,
        },
        range: { key: win.range, from: win.from, to: win.to, days: win.days, partial: win.partial, previous: win.previous },
        currency: item.price?.currency || sales.currency,
        traffic: t.state,
        cutoff: t.cutoff ?? null,
        totals: { ...totals, sales: round2(totals.sales) },
        previous: previous && { ...previous, sales: round2(previous.sales) },
        changes: withChanges(totals, previous),
        series,
        previousSeries: d.daysBetween(win.previous.from, win.previous.to).map(dayPoint),
        dailyTrafficDays: series.filter((p) => p.views != null).length,
        comparable,
        sources: t.state === 'measured' ? sourcesFrom(t.traffic) : [],
        hint: t.state === 'measured' && !win.partial ? d.hintFor(totals, win) : null,
        sync: { finalThrough: state.account_through, todayListingsUpdatedAt: state.today_day === today ? state.today_fetched_at : null },
      },
    };
  });
}

/**
 * The last 30 complete days per live listing (views, impressions), units
 * sold and watchers, for the Listings tab's rows. Uses the 30-day report
 * (one call the first time that day, shared with the Analytics tab).
 */
async function getListingSummaries(connectionId, ownerId) {
  return connectionService.withDecryptedCredentials(connectionId, ownerId, async (credentials, connection) => {
    const inputs = await ebayService.analyticsInputs(credentials, connectionId, { push: ebayService.pushEnabled(connection) });
    const base = { credentialsChanged: inputs.credentialsChanged, credentials: inputs.credentials };
    const status = statusOf(inputs);
    const timeZone = d.timeZoneFor(inputs.marketplaceId) || 'Europe/London';
    const { today, lastFinal } = contextFor(timeZone);
    const win = d.rangeWindow('30d', { today, lastFinal });
    let reports = [];
    if (status === 'ok') {
      const hist = await historyFor(connectionId, win.from, win.to, listedOnMap(inputs.items, timeZone));
      const args = { connectionId, inputs, timeZone, lastFinal, from: win.from, to: win.to };
      reports = hist.complete ? [hist] : [hist, await reportFor({ ...args, scope: 'all', allowFetch: false }), await reportFor({ ...args, scope: 'top' })];
    }
    const sales = d.salesIndex(inputs.orders, timeZone);
    const items = {};
    for (const item of inputs.items) {
      const id = String(item.itemId);
      const t = trafficFrom(reports, id);
      items[id] = {
        traffic: t.state,
        views: t.state === 'measured' ? t.traffic.views : null,
        impressions: t.state === 'measured' ? t.traffic.total_impressions : null,
        sold: d.salesWithin(sales.byListingDay.get(id), win.from, win.to).units,
        watchers: item.watchCount ?? null,
      };
    }
    return { ...base, data: { status: status === 'ok' ? 'ok' : 'reconnect', from: win.from, to: win.to, items } };
  });
}

/**
 * For the admin's usage page: the traffic allowance today, by kind and by
 * account, and where each account's stored figures stand.
 */
async function adminUsage(labels) {
  const snap = budget.snapshot();
  const states = await repo.allSyncStates();
  const byAccount = states
    .map((s) => ({
      connectionId: String(s.connection_id),
      label: labels.get(String(s.connection_id)) || 'Removed account',
      timeZone: s.time_zone,
      calls: snap.byAccount[String(s.connection_id)] || 0,
      finalThrough: s.account_through,
      detailDays: s.detail_day_count || 0,
      history: s.time_zone ? historyProgress({ history_from: s.history_from, detail_days: s.detail_days || [] }, s.time_zone) : null,
      refreshesToday: s.time_zone && s.refresh_day === d.today(s.time_zone) ? s.refresh_count || 0 : 0,
      lastSyncedAt: s.last_synced_at,
      status:
        s.last_error === BLOCKED.reconnect ? 'reconnect' : s.last_error === BLOCKED.unsupported ? 'unsupported' : s.last_error === WAITING ? 'waiting' : s.last_error ? 'error' : 'ok',
      lastError: s.last_error && !Object.values(BLOCKED).includes(s.last_error) && s.last_error !== WAITING ? s.last_error : null,
    }))
    .sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label));
  return { ...snap, refreshesPerAccount: REFRESHES_PER_DAY, dayReadMaxListings: DAY_READ_MAX_LISTINGS, byAccount };
}

module.exports = {
  AnalyticsError,
  syncAccount,
  refreshToday,
  getAnalytics,
  loadAllListings,
  getListingAnalytics,
  getListingSummaries,
  adminUsage,
  isDue,
  accountSegments,
  trafficFrom,
  REFRESHES_PER_DAY,
  DAY_READ_MAX_LISTINGS,
};
