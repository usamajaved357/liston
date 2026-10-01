const config = require('../../config');
const appState = require('../../db/app-state.repository');
const browseUsage = require('../ebay/browse-usage');

// Discover's share of eBay's Browse allowance, counted per eBay day (reset
// 07:00 UTC). Discover makes no Trading calls: orders, listings and
// publishing keep that pool to themselves.
//
//   searches  a subject's leading listings, one Browse search each: at most
//             DISCOVER_BROWSE_DAILY_CALLS (400) a day
//   reads     listings' sold counts, one Browse item read each: at most
//             DISCOVER_READS_DAILY_CALLS (1,500) a day, and
//             DISCOVER_ACCOUNT_DAILY_READS (400) of them per account, so one
//             busy hunter can't use everyone's day
//
// Neither runs once eBay's own count of the Browse pool (every server on
// Liston's keys, research, hunting and drafting too) passes
// DISCOVER_BROWSE_POOL_SHARE (60%): the rest is theirs.

const STATE_KEY = 'discover-usage';
const usage = { day: null, reads: 0, browse: 0, accounts: {}, loaded: false };
const today = () => browseUsage.snapshot().resetAt;

async function load() {
  if (!usage.loaded) {
    usage.loaded = true;
    const kept = await appState.get(STATE_KEY).catch(() => null);
    if (kept?.day === today()) Object.assign(usage, { day: kept.day, reads: Number(kept.reads) || 0, browse: Number(kept.browse) || 0, accounts: kept.accounts || {} });
  }
  if (usage.day !== today()) Object.assign(usage, { day: today(), reads: 0, browse: 0, accounts: {} });
}

async function persist() {
  if (config.env === 'test') return;
  await appState.set(STATE_KEY, { day: usage.day, reads: usage.reads, browse: usage.browse, accounts: usage.accounts }).catch(() => {});
}

/** Whether eBay's Browse pool is past Discover's share (or used up) right now. */
function poolPaused() {
  const pool = browseUsage.snapshot();
  return pool.exhausted || pool.used >= pool.limit * config.discover.browsePoolShare;
}

/**
 * What's left today: { reads (for this account, when given), browse,
 * paused, used, limits, resetAt }. `reads` is the smaller of the day's and
 * the account's; 0 while the Browse pool is past Discover's share.
 */
async function left(connectionId = null) {
  await load();
  const limits = { reads: config.discover.readsDailyCalls, account: config.discover.accountDailyReads, browse: config.discover.browseDailyCalls };
  const paused = poolPaused();
  const accountUsed = connectionId ? Number(usage.accounts[String(connectionId)]) || 0 : 0;
  const reads = Math.max(0, Math.min(limits.reads - usage.reads, connectionId ? limits.account - accountUsed : Infinity));
  return {
    reads: paused ? 0 : reads,
    browse: paused ? 0 : Math.max(0, limits.browse - usage.browse),
    paused,
    used: { reads: usage.reads, account: accountUsed, browse: usage.browse },
    limits,
    resetAt: today(),
  };
}

/** Counts `calls` Browse calls: 'reads' (sold counts, for the account) or 'browse' (searches). */
async function spend(kind, calls, connectionId = null) {
  if (!calls) return;
  await load();
  usage[kind] += calls;
  if (kind === 'reads' && connectionId) usage.accounts[String(connectionId)] = (Number(usage.accounts[String(connectionId)]) || 0) + calls;
  await persist();
}

function _reset() {
  Object.assign(usage, { day: null, reads: 0, browse: 0, accounts: {}, loaded: true });
}

module.exports = { left, spend, poolPaused, _reset };
