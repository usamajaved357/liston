const config = require('../../config');
const appState = require('../../db/app-state.repository');
const governor = require('../ebay/request-governor');

// Discover's share of eBay's daily allowances, counted per eBay day (both
// reset at 07:00 UTC). Sold counts are Trading GetItem reads: at most
// DISCOVER_TRADING_DAILY_CALLS (2,000) of the Trading pool's 5,000, and they
// run at background priority, so the governor also stops them once 80% of
// the day's allowance is used — orders and listings keep the rest. Scans
// are Browse searches: at most DISCOVER_BROWSE_DAILY_CALLS (400) of the
// Browse pool, shared with research, hunting and drafting.

const STATE_KEY = 'discover-usage';
const usage = { day: null, trading: 0, browse: 0, loaded: false };
const today = () => governor.snapshot().resetAt;

async function load() {
  if (!usage.loaded) {
    usage.loaded = true;
    const kept = await appState.get(STATE_KEY).catch(() => null);
    if (kept?.day === today()) Object.assign(usage, { day: kept.day, trading: Number(kept.trading) || 0, browse: Number(kept.browse) || 0 });
  }
  if (usage.day !== today()) Object.assign(usage, { day: today(), trading: 0, browse: 0 });
}

async function persist() {
  if (config.env === 'test') return;
  await appState.set(STATE_KEY, { day: usage.day, trading: usage.trading, browse: usage.browse }).catch(() => {});
}

/** What's left today: { trading, browse, limits, resetAt }. */
async function left() {
  await load();
  const limits = { trading: config.discover.tradingDailyCalls, browse: config.discover.browseDailyCalls };
  const trading = governor.snapshot();
  return {
    trading: Math.max(0, limits.trading - usage.trading),
    browse: Math.max(0, limits.browse - usage.browse),
    // The shared Trading pool is past background's share: sold counts wait.
    tradingPaused: trading.paused.background,
    used: { trading: usage.trading, browse: usage.browse },
    limits,
    resetAt: today(),
  };
}

async function spend(kind, calls) {
  if (!calls) return;
  await load();
  usage[kind] += calls;
  await persist();
}

function _reset() {
  Object.assign(usage, { day: null, trading: 0, browse: 0, loaded: true });
}

module.exports = { left, spend, _reset };
