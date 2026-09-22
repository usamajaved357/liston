const config = require('../../config');
const logger = require('../../utils/logger');
const appState = require('../../db/app-state.repository');

// Every call to eBay's traffic report passes through here. eBay allows the
// whole app about 100 traffic_report calls a day (its published default,
// shared by every account on Liston), far fewer than Trading's 5,000, so
// this is its own allowance and never takes from Trading's.
//
// Calls carry a kind, and the allowance is tiered the way request-governor
// tiers Trading's, cheapest-to-lose first:
//   detail    day-by-day figures for an account's busiest 200 listings —
//             a nice-to-have, stops at 40%;
//   sync      the once-a-day read of each account's totals — up to 70%;
//   view      a range of listing figures someone opened (and "Load all
//             listings", a listing asked for on its own) — up to 90%;
//   refresh   a person pressing "Refresh today" — keeps the last 10%.
// When the allowance is gone, pages keep showing what's stored.
//
// Usage is counted locally and persisted, so a restart doesn't forget it.
// eBay's own figure is read from its developer Analytics API when eBay
// reports one for this API, and wins over ours.

const DEFAULT_LIMIT = config.analytics.dailyLimit || 100;
const CEILING = { detail: 0.4, sync: 0.7, view: 0.9, refresh: 1 };
const KINDS = Object.keys(CEILING);
const STATE_KEY = 'ebay-analytics-usage';
const emptyKinds = () => Object.fromEntries(KINDS.map((k) => [k, 0]));
const PERSIST_DEBOUNCE_MS = 5 * 1000;
const EBAY_SYNC_MS = 30 * 60 * 1000;

class AnalyticsBudgetError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 429;
    this.code = 'ANALYTICS_BUDGET';
    this.expose = true;
  }
}

const state = {
  limit: DEFAULT_LIMIT,
  used: 0,
  resetAt: null,
  exhausted: false, // eBay refused a call as over its limit this window
  byKind: emptyKinds(),
  byAccount: {},
  lastSyncedWithEbay: null,
};

let persistTimer = null;
let syncTimer = null;
let loaded = false;

// eBay's daily allowances reset at 07:00 UTC (midnight Pacific).
function nextReset(from = new Date()) {
  const reset = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 7, 0, 0));
  if (reset <= from) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset.toISOString();
}

function rollWindowIfNeeded() {
  if (!state.resetAt) state.resetAt = nextReset();
  if (Date.now() < new Date(state.resetAt).getTime()) return;
  Object.assign(state, { used: 0, exhausted: false, byKind: emptyKinds(), byAccount: {}, resetAt: nextReset() });
  schedulePersist();
}

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = await appState.get(STATE_KEY);
    if (saved && saved.resetAt && Date.now() < new Date(saved.resetAt).getTime()) {
      Object.assign(state, saved, { byKind: { ...emptyKinds(), ...(saved.byKind || {}) }, byAccount: saved.byAccount || {} });
    }
  } catch (err) {
    logger.warn('Could not load eBay analytics usage', { error: err.message });
  }
  rollWindowIfNeeded();
}

function schedulePersist() {
  if (persistTimer || config.env === 'test') return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    appState.set(STATE_KEY, { ...state }).catch((err) => logger.warn('Could not save eBay analytics usage', { error: err.message }));
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref();
}

// eBay's figure for this API, when its rate-limit report lists it (it lists
// an API once the app has used it). Our own count stands otherwise.
async function syncWithEbay() {
  if (!config.ebay.clientId || config.env === 'test') return;
  try {
    const { getApplicationToken } = require('./api/ebay.app-token');
    const token = await getApplicationToken();
    const res = await fetch('https://api.ebay.com/developer/analytics/v1_beta/rate_limit/?api_context=sell', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10 * 1000),
    });
    if (!res.ok) throw new Error(`rate_limit ${res.status}`);
    const data = await res.json();
    const api = (data.rateLimits || []).find((a) => /analytics/i.test(a.apiName));
    const resource = (api?.resources || []).find((r) => /traffic/i.test(r.name)) || api?.resources?.[0];
    const rate = resource?.rates?.[0];
    if (!rate) return;
    rollWindowIfNeeded();
    state.limit = Number(rate.limit) || state.limit;
    state.used = Math.max(state.used, state.limit - Number(rate.remaining));
    state.resetAt = rate.reset || state.resetAt;
    state.exhausted = Number(rate.remaining) <= 0;
    state.lastSyncedWithEbay = new Date().toISOString();
    schedulePersist();
  } catch (err) {
    logger.warn('Could not read eBay analytics usage from eBay', { error: err.message });
  }
}

function start() {
  load().then(() => syncWithEbay());
  if (!syncTimer) {
    syncTimer = setInterval(syncWithEbay, EBAY_SYNC_MS);
    syncTimer.unref();
  }
}

// ---- the gate ------------------------------------------------------------------

function ceilingFor(kind) {
  return Math.floor(state.limit * (CEILING[kind] ?? 0));
}

/** Calls of this kind still allowed in this window. */
function available(kind) {
  rollWindowIfNeeded();
  if (state.exhausted) return 0;
  return Math.max(0, ceilingFor(kind) - state.used);
}

function allows(kind, calls = 1) {
  return available(kind) >= calls;
}

function record(kind, connectionId, calls = 1) {
  rollWindowIfNeeded();
  state.used += calls;
  state.byKind[kind] = (state.byKind[kind] || 0) + calls;
  if (connectionId) state.byAccount[connectionId] = (state.byAccount[connectionId] || 0) + calls;
  schedulePersist();
}

/**
 * Runs one traffic_report call `fn` if the allowance has room for `kind`,
 * counting it whatever the outcome (eBay counts failed calls too). eBay
 * saying the app is over its limit closes the window for everyone.
 */
async function spend(kind, connectionId, fn) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown analytics call kind: ${kind}`);
  if (!allows(kind)) {
    throw new AnalyticsBudgetError(
      state.exhausted
        ? "eBay's daily limit for traffic data has been reached. Figures update again after the reset."
        : "Today's allowance for eBay traffic data is used up. Figures update again after the reset."
    );
  }
  record(kind, connectionId);
  try {
    return await fn();
  } catch (err) {
    if (err.statusCode === 429 || /rate limit|call limit|usage limit/i.test(err.message || '')) {
      state.exhausted = true;
      schedulePersist();
    }
    throw err;
  }
}

function snapshot() {
  rollWindowIfNeeded();
  return {
    limit: state.limit,
    used: state.used,
    remaining: Math.max(0, state.limit - state.used),
    resetAt: state.resetAt,
    exhausted: state.exhausted,
    lastSyncedWithEbay: state.lastSyncedWithEbay,
    ceilings: Object.fromEntries(KINDS.map((k) => [k, ceilingFor(k)])),
    paused: { detail: !allows('detail'), sync: !allows('sync'), view: !allows('view') },
    byKind: { ...state.byKind },
    byAccount: { ...state.byAccount },
  };
}

// Test hook.
function _reset({ limit = DEFAULT_LIMIT, used = 0 } = {}) {
  Object.assign(state, {
    limit,
    used,
    resetAt: nextReset(),
    exhausted: false,
    byKind: emptyKinds(),
    byAccount: {},
    lastSyncedWithEbay: null,
  });
}

module.exports = { start, load, spend, allows, available, snapshot, syncWithEbay, AnalyticsBudgetError, CEILING, _reset };
