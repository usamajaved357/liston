const appState = require('../../db/app-state.repository');
const logger = require('../../utils/logger');

// Daily exchange rates, for adding up money across eBay sites (pounds,
// dollars, Australian dollars…) into one figure on the Overview. The
// European Central Bank's reference rates, published once each working day,
// through Frankfurter (free, no key). Nothing is ever converted with a rate
// Liston made up: without a rate, the caller shows each currency apart.
//
// Kept in memory and in app_state, so a restart or a second instance
// doesn't ask again; asked at most every RATES_FRESH_MS per base currency.

const RATES_URL = 'https://api.frankfurter.dev/v1/latest';
const RATES_FRESH_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const memory = new Map(); // base -> { rates, date, fetchedAt }

const stateKey = (base) => `exchange-rates:${base}`;

async function fetchRates(base, symbols) {
  const url = `${RATES_URL}?base=${encodeURIComponent(base)}&symbols=${symbols.map(encodeURIComponent).join(',')}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Exchange rates answered ${res.status}`);
  const body = await res.json();
  if (!body?.rates) throw new Error('Exchange rates came back without rates');
  return { rates: body.rates, date: body.date || null };
}

/**
 * How many of each currency one unit of `base` buys, for the currencies
 * asked: { rates: { USD: 1.322, … }, date: '2026-09-24' }, or null when no
 * rate can be had (never a guess). A stale copy is used if a fresh one
 * can't be fetched.
 */
async function ratesFor(base, currencies) {
  const wanted = [...new Set(currencies.filter((c) => c && c !== base))];
  if (!wanted.length) return { rates: {}, date: null };
  let known = memory.get(base) || (await appState.get(stateKey(base)).catch(() => null));
  const covers = known && wanted.every((c) => Number(known.rates?.[c]) > 0);
  if (!covers || Date.now() - (known.fetchedAt || 0) > RATES_FRESH_MS) {
    try {
      const fresh = await fetchRates(base, [...new Set([...wanted, ...Object.keys(known?.rates || {})])]);
      known = { ...fresh, fetchedAt: Date.now() };
      await appState.set(stateKey(base), known).catch(() => {});
    } catch (err) {
      logger.warn('Exchange rates not read', { base, error: err.message });
    }
  }
  if (!known || !wanted.every((c) => Number(known.rates?.[c]) > 0)) return null;
  memory.set(base, known);
  return { rates: Object.fromEntries(wanted.map((c) => [c, Number(known.rates[c])])), date: known.date };
}

/** Test hook. */
function forget() {
  memory.clear();
}

module.exports = { ratesFor, forget };
