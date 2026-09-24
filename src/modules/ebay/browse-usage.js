const { AsyncLocalStorage } = require('async_hooks');
const config = require('../../config');
const logger = require('../../utils/logger');
const appState = require('../../db/app-state.repository');

// Today's use of eBay's Browse API allowance (5,000 calls a day by default,
// one pool for the whole app, separate from Trading's). Every Browse call
// is counted here (api/ebay.browse.js) under who made it — drafting reading
// a competitor listing, a listing health check, or product research — and
// corrected against eBay's own figure from its Analytics API. Research caps
// itself at its share (research.service); this is what the admin sees.

const DEFAULT_LIMIT = 5000;
const SYNC_MS = 15 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 5 * 1000;
const STATE_KEY = 'ebay-browse-usage';
// Who a call is for, when nothing says: the drafting paths predate the tag.
const DEFAULT_KIND = 'drafting';

const context = new AsyncLocalStorage();

const blank = () => ({ used: 0, exhausted: false, byCall: {}, byKind: {} });
const state = { limit: DEFAULT_LIMIT, resetAt: null, lastSyncedWithEbay: null, ...blank() };

let loaded = false;
let persistTimer = null;

// Like Trading's, eBay's Buy API allowance resets at 07:00 UTC (midnight
// Pacific) until eBay's own figure says otherwise.
function nextReset(from = new Date()) {
  const reset = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 7, 0, 0));
  if (reset <= from) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset.toISOString();
}

function rollWindowIfNeeded() {
  if (!state.resetAt) state.resetAt = nextReset();
  if (Date.now() < new Date(state.resetAt).getTime()) return;
  Object.assign(state, blank(), { resetAt: nextReset() });
  schedulePersist();
}

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = await appState.get(STATE_KEY);
    if (saved?.resetAt && Date.now() < new Date(saved.resetAt).getTime()) Object.assign(state, saved);
  } catch (err) {
    logger.warn('Could not load eBay Browse usage', { error: err.message });
  }
  rollWindowIfNeeded();
}

function schedulePersist() {
  if (persistTimer || config.env === 'test') return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    appState.set(STATE_KEY, { ...state }).catch((err) => logger.warn('Could not save eBay Browse usage', { error: err.message }));
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref();
}

/** Runs fn with its Browse calls counted as `kind` ('research', 'health', …). */
function as(kind, fn) {
  return context.run({ kind }, fn);
}

/** One Browse call made (whatever eBay answered: eBay counts it either way). */
function record(callName, { rateLimited = false } = {}) {
  rollWindowIfNeeded();
  const kind = context.getStore()?.kind || DEFAULT_KIND;
  state.used += 1;
  state.byCall[callName] = (state.byCall[callName] || 0) + 1;
  state.byKind[kind] = (state.byKind[kind] || 0) + 1;
  if (rateLimited) state.exhausted = true;
  schedulePersist();
}

// eBay's own figure for the Browse pool (resource "buy.browse").
async function syncWithEbay() {
  if (!config.ebay.clientId || config.env === 'test') return;
  try {
    const { getApplicationToken } = require('./api/ebay.app-token');
    const token = await getApplicationToken();
    const res = await fetch('https://api.ebay.com/developer/analytics/v1_beta/rate_limit/?api_context=buy', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10 * 1000),
    });
    if (!res.ok) throw new Error(`analytics ${res.status}`);
    applyEbayFigure(await res.json());
  } catch (err) {
    logger.warn('Could not read eBay Browse usage from the Analytics API', { error: err.message });
  }
}

function applyEbayFigure(data) {
  const browse = (data.rateLimits || []).find((api) => /browse/i.test(api.apiName || ''));
  const resource = browse?.resources?.find((r) => r.name === 'buy.browse') || browse?.resources?.[0];
  const rate = resource?.rates?.[0];
  if (!rate) return;
  rollWindowIfNeeded();
  state.limit = Number(rate.limit) || state.limit;
  state.used = Math.max(0, state.limit - Number(rate.remaining));
  state.resetAt = rate.reset || state.resetAt;
  state.exhausted = Number(rate.remaining) <= 0;
  state.lastSyncedWithEbay = new Date().toISOString();
  schedulePersist();
}

let syncTimer = null;
function start() {
  load().then(() => syncWithEbay());
  if (!syncTimer) {
    syncTimer = setInterval(syncWithEbay, SYNC_MS);
    syncTimer.unref();
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
    byCall: { ...state.byCall },
    byKind: { ...state.byKind },
  };
}

/** Test hook. */
function _reset() {
  Object.assign(state, { limit: DEFAULT_LIMIT, resetAt: null, lastSyncedWithEbay: null, ...blank() });
}

module.exports = { as, record, snapshot, start, syncWithEbay, applyEbayFigure, _reset, DEFAULT_KIND };
