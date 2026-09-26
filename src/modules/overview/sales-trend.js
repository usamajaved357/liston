const analyticsDays = require('../analytics/analytics-days');

// The business Overview under its money cards: sales by day for the chosen
// dates (the previous stretch alongside for comparison) and the products
// selling most. Pure: orders in, figures out. Orders come from Liston's copy
// of each account's last 90 days, so a previous stretch reaching further
// back than that isn't drawn.

const ORDERS_KEPT_DAYS = 90;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The days a range is drawn over, in the seller's (or viewer's) time zone,
 * and the same number of days just before them, or null when those reach
 * past the orders Liston keeps. "Today" is drawn as the last 7 days, so the
 * day has something to stand next to.
 */
function trendDays(range, today) {
  let from;
  let to = today;
  if (range === 'this_month') from = `${today.slice(0, 7)}-01`;
  else if (range === 'last_month') {
    to = analyticsDays.addDays(`${today.slice(0, 7)}-01`, -1);
    from = `${to.slice(0, 7)}-01`;
  } else {
    const n = { today: 7, '7d': 7, '30d': 30, '90d': 90 }[range] || 7;
    from = analyticsDays.addDays(today, -(n - 1));
  }
  const days = analyticsDays.daysBetween(from, to);
  const previousFrom = analyticsDays.addDays(from, -days.length);
  const oldestKept = analyticsDays.addDays(today, -(ORDERS_KEPT_DAYS - 1));
  const previousDays = previousFrom >= oldestKept ? analyticsDays.daysBetween(previousFrom, analyticsDays.addDays(from, -1)) : null;
  return { days, previousDays };
}

/**
 * Sales by day — what buyers paid, as the Sales card counts it (order
 * totals, cancelled orders left out) — with the previous stretch's day
 * alongside each: [{ day, value, previous, previousDay, partial }]. Today
 * is still running (`partial`).
 */
function salesTrend(orders, { timeZone, range, today, isCancelled }) {
  const { days, previousDays } = trendDays(range, today);
  const byDay = new Map();
  for (const order of orders || []) {
    if (isCancelled(order)) continue;
    const day = analyticsDays.dayOf(order.createdAt, timeZone);
    if (!day) continue;
    byDay.set(day, (byDay.get(day) || 0) + (Number(order.total?.amount) || 0));
  }
  return days.map((day, i) => ({
    day,
    value: round2(byDay.get(day) || 0),
    previous: previousDays ? round2(byDay.get(previousDays[i]) || 0) : null,
    previousDay: previousDays ? previousDays[i] : null,
    partial: day === today,
  }));
}

/**
 * The listings that sold most in these orders: [{ itemId, title, units,
 * orders, sales (price × units, postage apart), currency }], most units
 * first, then most sales. Cancelled orders don't count.
 */
function bestSellers(orders, { isCancelled, limit = 6 }) {
  const byItem = new Map();
  for (const order of orders || []) {
    if (isCancelled(order)) continue;
    const counted = new Set(); // an order counts once per listing, however many lines it has of it
    for (const line of order.lineItems || []) {
      if (!line.itemId) continue;
      const id = String(line.itemId);
      const units = Number(line.quantityPurchased) || 1;
      const entry = byItem.get(id) || { itemId: id, title: line.title || null, units: 0, orders: 0, sales: 0, currency: line.price?.currency || order.total?.currency || null };
      entry.units += units;
      entry.sales += (Number(line.price?.amount) || 0) * units;
      if (!counted.has(id)) {
        counted.add(id);
        entry.orders += 1;
      }
      if (!entry.title && line.title) entry.title = line.title;
      byItem.set(id, entry);
    }
  }
  return [...byItem.values()]
    .map((e) => ({ ...e, sales: round2(e.sales) }))
    .sort((a, b) => b.units - a.units || b.sales - a.sales)
    .slice(0, limit);
}

/** Several accounts' (or markets') trends over the same days, added up. */
function addTrends(trends) {
  const list = trends.filter((t) => Array.isArray(t) && t.length);
  if (!list.length) return [];
  return list[0].map((point, i) => {
    const previous = list.map((t) => t[i]?.previous).filter((v) => v !== null && v !== undefined);
    return {
      ...point,
      value: round2(list.reduce((sum, t) => sum + (t[i]?.value || 0), 0)),
      previous: previous.length ? round2(previous.reduce((a, b) => a + b, 0)) : null,
    };
  });
}

/** A trend in another currency: `rate` of the trend's currency buys one of the other. */
function convertTrend(trend, rate) {
  if (!rate) return trend;
  return (trend || []).map((p) => ({ ...p, value: round2(p.value / rate), previous: p.previous === null ? null : round2(p.previous / rate) }));
}

/**
 * Best sellers from several accounts (or markets) as one list: most units
 * first, then most sales — compared in one currency through `rateOf(item)`
 * (how many of its currency one of the base buys) when they differ. Each
 * item keeps its own currency.
 */
function mergeBestSellers(lists, { limit = 6, rateOf = () => 1 } = {}) {
  return lists
    .flat()
    .sort((a, b) => b.units - a.units || b.sales / (rateOf(b) || 1) - a.sales / (rateOf(a) || 1))
    .slice(0, limit);
}

module.exports = { trendDays, salesTrend, bestSellers, addTrends, convertTrend, mergeBestSellers, ORDERS_KEPT_DAYS };
