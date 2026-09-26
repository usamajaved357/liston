// A hunted product's sales over time and its sales score. Pure.
//
// eBay tells this app how many a listing (and each variation) has sold in
// all, not when: its dated sales history (Marketplace Insights) is a
// limited release not granted to Liston. So Liston reads the competitor's
// sold counts when the product is checked and once a day after, and the
// differences between readings are the sales: per day, the last 7 and 30
// days, the trend against the listing's lifetime rate, and per variation.

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_AFTER_DAYS = 3;

const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * The history from the readings ({ taken_at, sold, variations }), oldest
 * first: { readings, since, coveredDays, days: [{ day, sold }], soldLast7,
 * soldLast30, perDay, trend: 'up' | 'flat' | 'down' | null, byVariation:
 * [{ label, sold }] }. `lifetimePerDay`: the listing's own average, what
 * the trend is judged against.
 */
function history(readings, { now = Date.now(), lifetimePerDay = null } = {}) {
  const list = (readings || []).filter((r) => r.sold !== null && r.sold !== undefined).sort((a, b) => new Date(a.taken_at) - new Date(b.taken_at));
  const out = { readings: list.length, since: list[0]?.taken_at || null, coveredDays: 0, days: [], soldLast7: null, soldLast30: null, perDay: null, trend: null, byVariation: [] };
  if (list.length < 2) return out;
  const first = list[0];
  const last = list[list.length - 1];
  out.coveredDays = Math.round(((new Date(last.taken_at) - new Date(first.taken_at)) / DAY_MS) * 10) / 10;

  // Each reading's rise over the one before, on the day it was read.
  const perDay = new Map();
  for (let i = 1; i < list.length; i += 1) {
    const rise = Math.max(0, list[i].sold - list[i - 1].sold);
    const day = dayOf(list[i].taken_at);
    perDay.set(day, (perDay.get(day) || 0) + rise);
  }
  for (let day = dayOf(first.taken_at); day <= dayOf(last.taken_at); day = addDays(day, 1)) out.days.push({ day, sold: perDay.get(day) || 0 });

  // The rises read in the window, added up: eBay's count can dip (a
  // cancellation, a variation taken off) and a dip mustn't cancel sales.
  const riseSince = (ms) => {
    let total = 0;
    for (let i = 1; i < list.length; i += 1) {
      if (new Date(list[i].taken_at).getTime() > now - ms) total += Math.max(0, list[i].sold - list[i - 1].sold);
    }
    return total;
  };
  out.soldLast7 = riseSince(7 * DAY_MS);
  out.soldLast30 = riseSince(30 * DAY_MS);
  const window = Math.min(7, Math.max(out.coveredDays, 1 / 24));
  out.perDay = Math.round((out.soldLast7 / window) * 10) / 10;
  if (out.coveredDays >= TREND_AFTER_DAYS && lifetimePerDay !== null && lifetimePerDay !== undefined) {
    const ratio = lifetimePerDay > 0 ? out.perDay / lifetimePerDay : out.perDay > 0 ? 2 : 1;
    out.trend = ratio >= 1.25 ? 'up' : ratio <= 0.75 ? 'down' : 'flat';
  }

  // Per variation over the tracked stretch.
  const firstBy = new Map((first.variations || []).map((v) => [v.label ?? '', v.sold]));
  out.byVariation = (last.variations || [])
    .map((v) => ({ label: v.label, sold: firstBy.has(v.label ?? '') && v.sold !== null && firstBy.get(v.label ?? '') !== null ? Math.max(0, v.sold - firstBy.get(v.label ?? '')) : null }))
    .filter((v) => v.sold !== null)
    .sort((a, b) => b.sold - a.sold);
  return out;
}

const BANDS = [
  [80, 'hot', 'Hot'],
  [60, 'strong', 'Strong'],
  [40, 'steady', 'Steady'],
  [20, 'slow', 'Slow'],
  [0, 'cold', 'Cold'],
];
const logShare = (n, full) => Math.min(1, Math.log10(1 + Math.max(0, n)) / Math.log10(1 + full));

/**
 * How well it sells, 0–100, with the parts it's made of: how many sell a
 * month (45: 60 a month is full marks), how many have sold in all (20: 500),
 * the trend from Liston's own readings (20; half marks until there are 3
 * days of them), and how many of the options sell (15). Null without a
 * competitor (nothing to judge).
 */
function salesScore({ demand, variations = [], history: h = null, exact = null }) {
  if (!demand || demand.sold === null || demand.sold === undefined) return null;
  // eBay's dated sales, when pasted, are the real recent pace.
  const spm = exact ? exact.perMonth : demand.soldPerMonth ?? 0;
  const velocity = Math.round(45 * logShare(spm, 60));
  const proven = Math.round(20 * logShare(demand.sold, 500));
  let trend;
  let trendDetail;
  if (exact && exact.daysSinceLast >= 14) {
    trend = 0;
    trendDetail = `No sale in ${exact.daysSinceLast} days (eBay's sold history).`;
  } else if (exact && exact.trend) {
    trend = { up: 20, flat: 12, down: 4 }[exact.trend];
    trendDetail = { up: 'Selling faster in the last 15 days than the 15 before (eBay’s sold history).', flat: 'Selling at a steady pace (eBay’s sold history).', down: 'Selling slower in the last 15 days than the 15 before (eBay’s sold history).' }[exact.trend];
  } else if (exact) {
    trend = exact.daysSinceLast <= 2 ? 16 : exact.daysSinceLast <= 7 ? 12 : 6;
    trendDetail = `Last sold ${exact.daysSinceLast === 0 ? 'today' : `${exact.daysSinceLast} day${exact.daysSinceLast === 1 ? '' : 's'} ago`} (eBay's sold history).`;
  } else if (h && h.coveredDays >= 7 && h.soldLast7 === 0) {
    trend = 0;
    trendDetail = 'None sold in the last 7 days of Liston’s readings.';
  } else if (h && h.trend) {
    trend = { up: 20, flat: 12, down: 4 }[h.trend];
    trendDetail = { up: 'Selling faster lately than its average.', flat: 'Selling at its usual pace.', down: 'Selling slower lately than its average.' }[h.trend];
  } else {
    trend = 10;
    trendDetail = 'Liston reads its sales daily; the trend shows after 3 days.';
  }
  const withVariations = (variations || []).filter((v) => v.label);
  const selling = withVariations.filter((v) => (v.sold || 0) > 0).length;
  const breadth = withVariations.length > 1 ? Math.round(15 * (selling / withVariations.length)) : demand.sold > 0 ? 15 : 0;
  const score = Math.max(0, Math.min(100, velocity + proven + trend + breadth));
  const [, band, label] = BANDS.find(([min]) => score >= min);
  return {
    score,
    band,
    label,
    estimate: !exact && !(h && h.trend),
    exact: Boolean(exact),
    parts: [
      { key: 'velocity', label: 'Sells a month', points: velocity, max: 45, detail: exact ? `${spm} a month at the last 30 days' pace (eBay's sold history).` : `${spm} a month on the competitor's listing.` },
      { key: 'proven', label: 'Sold in all', points: proven, max: 20, detail: `${demand.sold} sold since it was listed.` },
      { key: 'trend', label: 'Trend', points: trend, max: 20, detail: trendDetail },
      {
        key: 'breadth',
        label: 'Options selling',
        points: breadth,
        max: 15,
        detail: withVariations.length > 1 ? `${selling} of ${withVariations.length} options have sold.` : demand.sold > 0 ? 'The listing sells.' : 'Nothing sold yet.',
      },
    ],
  };
}

module.exports = { history, salesScore, BANDS };
