// The numbers a product search is judged on, from the live listings eBay
// returned for it (a sample of up to 200, best match first): what they
// sell for, who sells them and from where, and — for the listings whose
// sold count was read — how fast they sell. Pure: listings in, figures out.

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round2((sorted[mid - 1] + sorted[mid]) / 2);
}

/** A listing's price with postage, what a buyer actually pays. */
function landedPrice(item) {
  return round2((item.price?.value || 0) + (item.shipping?.cost || 0));
}

/**
 * What a listing's sales have come to: its sold count at today's price with
 * postage (eBay gives no sale prices, so it's an estimate), or null.
 */
function revenueOf(item) {
  if (item.sold === null || item.sold === undefined) return null;
  return round2(item.sold * landedPrice(item));
}

/** Whole days since the listing went live, or null. */
function daysLive(item, now = Date.now()) {
  if (!item.createdAt) return null;
  return Math.max(0, Math.floor((now - new Date(item.createdAt).getTime()) / DAY_MS));
}

/**
 * How many a listing sells a month: its sold count over the months it has
 * been live (at least one), or null when the count wasn't read.
 */
function soldPerMonth(item, now = Date.now()) {
  if (item.sold === null || item.sold === undefined) return null;
  const since = item.createdAt ? new Date(item.createdAt).getTime() : null;
  const months = since ? Math.max(1, (now - since) / (30 * DAY_MS)) : 1;
  return Math.round((item.sold / months) * 10) / 10;
}

// Price bands, sized to where most prices sit: the step comes from the 90th
// percentile, so one £25 outlier doesn't squash 150 listings into a
// single "£0–5" bar; anything above the last band is grouped into it
// ("£15+", to: null).
const STEPS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
function priceBands(prices, bars = 8) {
  if (prices.length < 4) return [];
  const p90 = prices[Math.min(prices.length - 1, Math.floor(prices.length * 0.9))];
  const low = prices[0];
  const step = STEPS.find((s) => (p90 - Math.floor(low / s) * s) / s <= bars) || STEPS[STEPS.length - 1];
  const start = Math.floor(low / step) * step;
  const last = start + step * Math.max(1, Math.ceil((p90 - start) / step));
  const bands = new Map();
  for (const p of prices) {
    const from = p >= last ? last : round2(Math.floor((p - start) / step) * step + start);
    bands.set(from, (bands.get(from) || 0) + 1);
  }
  return [...bands]
    .sort(([a], [b]) => a - b)
    .map(([from, count]) => ({ from, to: from >= last ? null : round2(from + step), count }));
}

/**
 * @param items   mapped listings (see research.service mapSummary)
 * @param country the market's country ("GB"): listings posted from it are
 *                domestic, the rest ship from overseas
 */
function summarise(items, { country, total, now = Date.now() } = {}) {
  const prices = items.map(landedPrice).filter((p) => p > 0).sort((a, b) => a - b);
  const sellers = new Map();
  for (const item of items) {
    const name = item.seller?.username;
    if (!name) continue;
    const entry = sellers.get(name) || { username: name, listings: 0, feedbackScore: item.seller.feedbackScore ?? null, feedbackPercentage: item.seller.feedbackPercentage ?? null, sold: null, revenue: null };
    entry.listings += 1;
    if (item.sold !== null && item.sold !== undefined) {
      entry.sold = (entry.sold || 0) + item.sold;
      entry.revenue = round2((entry.revenue || 0) + revenueOf(item));
    }
    sellers.set(name, entry);
  }
  const topSellers = [...sellers.values()].sort((a, b) => b.listings - a.listings).slice(0, 5);
  const share = (n) => (items.length ? Math.round((n / items.length) * 100) : 0);
  const withSold = items.filter((i) => i.sold !== null && i.sold !== undefined);
  const recent = items.filter((i) => i.createdAt && now - new Date(i.createdAt).getTime() < 30 * DAY_MS).length;
  return {
    total: total ?? items.length,
    sampled: items.length,
    price: prices.length
      ? { min: prices[0], max: prices[prices.length - 1], median: median(prices), average: round2(prices.reduce((a, b) => a + b, 0) / prices.length) }
      : null,
    bands: priceBands(prices),
    sellers: sellers.size,
    topSellers,
    // The biggest seller's share of the sample: one seller owning half the
    // results is a harder market to enter than fifty with one each.
    topSellerShare: topSellers[0] ? share(topSellers[0].listings) : 0,
    freePostage: share(items.filter((i) => i.shipping?.free).length),
    domestic: share(items.filter((i) => i.location?.country && i.location.country === country).length),
    newInLast30Days: recent,
    sold: withSold.length
      ? {
          read: withSold.length,
          total: withSold.reduce((sum, i) => sum + i.sold, 0),
          perMonth: Math.round(withSold.reduce((sum, i) => sum + (soldPerMonth(i, now) || 0), 0) * 10) / 10,
          selling: withSold.filter((i) => i.sold > 0).length,
          revenue: round2(withSold.reduce((sum, i) => sum + revenueOf(i), 0)),
          revenuePerMonth: round2(withSold.reduce((sum, i) => sum + (soldPerMonth(i, now) || 0) * landedPrice(i), 0)),
        }
      : null,
  };
}

module.exports = { summarise, soldPerMonth, revenueOf, daysLive, landedPrice, median, priceBands, round2 };
