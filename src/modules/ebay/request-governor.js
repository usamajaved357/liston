const { AsyncLocalStorage } = require('async_hooks');
const config = require('../../config');
const logger = require('../../utils/logger');
const appState = require('../../db/app-state.repository');

// Every call to eBay's Trading API passes through here. Two jobs:
//
// 1. BUDGET. eBay gives the whole app one daily allowance (5,000 calls by
//    default) shared by every company and account on Liston. Without a
//    budget, a busy day anywhere burns it for everyone and every account
//    goes dark at once. So calls carry a priority and the allowance is
//    tiered: background re-reads stop first, eBay's push-triggered re-reads
//    next, and what a person is waiting on (a publish, a manual refresh, the
//    first read of a new account) keeps the last slice to itself. Pages keep
//    working throughout, from the local copy; they just say "Updated 40 min
//    ago" instead of failing.
//
// 2. FLOW. At most a few calls in flight per account and overall, ordered by
//    priority, so a burst of sales on one account can't crowd out a seller
//    publishing on another, and eBay never sees a flood.
//
// Usage is counted locally (persisted, so restarts don't lose it) and
// corrected against eBay's own figure from its Analytics API a few times an
// hour. Process-local otherwise; moves to Redis with the cache when Liston
// runs on more than one instance.

const PRIORITY_RANK = { user: 0, push: 1, background: 2 };
// Share of the allowance each priority may use up to.
const CEILING = { background: 0.8, push: 0.92, user: 1 };
const DEFAULT_LIMIT = 5000;
const MAX_IN_FLIGHT_PER_ACCOUNT = 3;
const MAX_IN_FLIGHT = 12;
const ANALYTICS_SYNC_MS = 15 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 5 * 1000;
const STATE_KEY = 'ebay-trading-usage';

class GovernorError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const context = new AsyncLocalStorage();

const state = {
  limit: DEFAULT_LIMIT,
  used: 0,
  resetAt: null, // ISO string from eBay
  exhausted: false, // eBay said "exceeded usage limit" this window
  byCall: {},
  byAccount: {},
  lastSyncedWithEbay: null,
  deferred: { background: 0, push: 0 }, // calls held back this window
};

let inFlight = 0;
const inFlightByAccount = new Map();
const waiting = []; // { rank, resolve }
let persistTimer = null;
let loaded = false;

// ---- window handling ------------------------------------------------------

function windowExpired() {
  return state.resetAt && Date.now() >= new Date(state.resetAt).getTime();
}

// eBay's Trading allowance resets at 07:00 UTC (midnight Pacific).
function nextReset(from = new Date()) {
  const reset = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 7, 0, 0));
  if (reset <= from) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset.toISOString();
}

function rollWindowIfNeeded() {
  if (!state.resetAt) state.resetAt = nextReset();
  if (!windowExpired()) return;
  Object.assign(state, { used: 0, exhausted: false, byCall: {}, byAccount: {}, deferred: { background: 0, push: 0 }, resetAt: nextReset() });
  schedulePersist();
}

// ---- persistence ------------------------------------------------------------

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = await appState.get(STATE_KEY);
    if (saved && saved.resetAt && Date.now() < new Date(saved.resetAt).getTime()) {
      Object.assign(state, saved, { deferred: saved.deferred || { background: 0, push: 0 } });
    }
  } catch (err) {
    logger.warn('Could not load eBay usage state', { error: err.message });
  }
  rollWindowIfNeeded();
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    appState.set(STATE_KEY, { ...state }).catch((err) => logger.warn('Could not save eBay usage state', { error: err.message }));
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref();
}

// ---- eBay's own figure --------------------------------------------------------

// eBay reports, per Trading call, how much of the shared allowance is used.
// The total is the same across calls (one pool), so any row gives it.
async function syncWithEbay() {
  if (!config.ebay.clientId || config.env === 'test') return;
  try {
    const { getApplicationToken } = require('./ebay.app-token');
    const token = await getApplicationToken();
    const res = await fetch('https://api.ebay.com/developer/analytics/v1_beta/rate_limit/?api_context=tradingapi', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10 * 1000),
    });
    if (!res.ok) throw new Error(`analytics ${res.status}`);
    const data = await res.json();
    const trading = (data.rateLimits || []).find((api) => /trading/i.test(api.apiName));
    const rate = trading?.resources?.[0]?.rates?.[0];
    if (!rate) return;
    rollWindowIfNeeded();
    state.limit = Number(rate.limit) || state.limit;
    state.used = Math.max(0, state.limit - Number(rate.remaining));
    state.resetAt = rate.reset || state.resetAt;
    state.exhausted = Number(rate.remaining) <= 0;
    state.lastSyncedWithEbay = new Date().toISOString();
    // eBay's per-call breakdown is the accurate one; keep ours in step.
    for (const resource of trading.resources || []) {
      const count = Number(resource.rates?.[0]?.count || 0);
      if (count > 0) state.byCall[resource.name] = count;
    }
    schedulePersist();
  } catch (err) {
    logger.warn('Could not read eBay usage from the Analytics API', { error: err.message });
  }
}

let syncTimer = null;
function start() {
  load().then(() => syncWithEbay());
  if (!syncTimer) {
    syncTimer = setInterval(syncWithEbay, ANALYTICS_SYNC_MS);
    syncTimer.unref();
  }
}

// ---- the gate --------------------------------------------------------------------

function current() {
  return context.getStore() || { priority: 'user', connectionId: null };
}

// Runs `fn` with every Trading call inside it tagged with this account and
// priority. Nested contexts win over outer ones.
function withContext(ctx, fn) {
  return context.run({ ...current(), ...ctx }, fn);
}

function budgetAllows(priority) {
  rollWindowIfNeeded();
  if (state.exhausted) return priority === 'user' ? 'exhausted' : false;
  const ceiling = CEILING[priority] ?? 1;
  return state.used < state.limit * ceiling;
}

function slotFree(connectionId) {
  if (inFlight >= MAX_IN_FLIGHT) return false;
  if (connectionId && (inFlightByAccount.get(connectionId) || 0) >= MAX_IN_FLIGHT_PER_ACCOUNT) return false;
  return true;
}

function takeSlot(connectionId) {
  inFlight += 1;
  if (connectionId) inFlightByAccount.set(connectionId, (inFlightByAccount.get(connectionId) || 0) + 1);
}

function releaseSlot(connectionId) {
  inFlight = Math.max(0, inFlight - 1);
  if (connectionId) {
    const n = (inFlightByAccount.get(connectionId) || 0) - 1;
    if (n <= 0) inFlightByAccount.delete(connectionId);
    else inFlightByAccount.set(connectionId, n);
  }
  // Wake the highest-priority waiter whose account has room.
  waiting.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
  const index = waiting.findIndex((w) => slotFree(w.connectionId));
  if (index !== -1) {
    const [next] = waiting.splice(index, 1);
    takeSlot(next.connectionId);
    next.resolve();
  }
}

let seq = 0;

// Waits for a slot (by priority) and checks the budget. Resolves with a
// release function; throws GovernorError when the call must not be made.
async function acquire(callName) {
  const { priority, connectionId } = current();
  const allowed = budgetAllows(priority);
  if (allowed === 'exhausted') {
    throw new GovernorError(
      "eBay's daily API allowance for Liston is used up for today. Live figures return when eBay resets it (midnight Pacific time).",
      429,
      'EBAY_EXHAUSTED'
    );
  }
  if (!allowed) {
    state.deferred[priority] = (state.deferred[priority] || 0) + 1;
    throw new GovernorError(`eBay call ${callName} held back to protect today's allowance`, 503, 'EBAY_BUDGET');
  }

  if (slotFree(connectionId)) takeSlot(connectionId);
  else {
    await new Promise((resolve) => waiting.push({ rank: PRIORITY_RANK[priority] ?? 2, seq: seq++, connectionId, resolve }));
  }
  return () => releaseSlot(connectionId);
}

// Every completed call, successful or not, is one against the allowance.
function record(callName, { rateLimited = false } = {}) {
  rollWindowIfNeeded();
  const { connectionId } = current();
  state.used += 1;
  state.byCall[callName] = (state.byCall[callName] || 0) + 1;
  if (connectionId) state.byAccount[connectionId] = (state.byAccount[connectionId] || 0) + 1;
  if (rateLimited) {
    state.exhausted = true;
    state.used = Math.max(state.used, state.limit);
    // eBay's word beats our count; ask it exactly where we stand.
    syncWithEbay();
  }
  schedulePersist();
}

// Convenience: acquire, run, record, release.
async function run(callName, fn) {
  const release = await acquire(callName);
  let rateLimited = false;
  try {
    return await fn();
  } catch (err) {
    rateLimited = err?.statusCode === 429 && /allowance|usage limit/i.test(err.message || '');
    throw err;
  } finally {
    record(callName, { rateLimited });
    release();
  }
}

function snapshot() {
  rollWindowIfNeeded();
  const ceilings = Object.fromEntries(Object.entries(CEILING).map(([k, v]) => [k, Math.floor(state.limit * v)]));
  return {
    limit: state.limit,
    used: state.used,
    remaining: Math.max(0, state.limit - state.used),
    resetAt: state.resetAt,
    exhausted: state.exhausted,
    lastSyncedWithEbay: state.lastSyncedWithEbay,
    ceilings,
    paused: {
      background: !budgetAllows('background'),
      push: !budgetAllows('push'),
    },
    deferred: { ...state.deferred },
    byCall: { ...state.byCall },
    byAccount: { ...state.byAccount },
    inFlight,
    waiting: waiting.length,
  };
}

// Test hook.
function _reset() {
  Object.assign(state, {
    limit: DEFAULT_LIMIT,
    used: 0,
    resetAt: null,
    exhausted: false,
    byCall: {},
    byAccount: {},
    lastSyncedWithEbay: null,
    deferred: { background: 0, push: 0 },
  });
  inFlight = 0;
  inFlightByAccount.clear();
  waiting.length = 0;
}

module.exports = { GovernorError, withContext, current, acquire, record, run, snapshot, start, syncWithEbay, _reset, _state: state };
