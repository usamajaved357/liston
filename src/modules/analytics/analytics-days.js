// Pure date and number logic for listing analytics. No I/O.
//
// Every day here is eBay's reporting day: eBay's traffic report splits days
// on US Pacific time (midnight Pacific = 07:00/08:00 UTC), so orders are
// bucketed the same way and a day's sales line up with that day's views.
// Days are "YYYY-MM-DD" strings throughout.

const EBAY_TIME_ZONE = 'America/Los_Angeles';
// eBay's day ends at midnight Pacific; its figures for that day are read two
// hours later, so the day is complete and final when stored.
const SYNC_HOUR_PACIFIC = 2;
// Per-listing history kept (the orders mirror keeps 90 days too), and the
// account totals kept, which reach further back for period comparisons.
const LISTING_HISTORY_DAYS = 90;
const ACCOUNT_HISTORY_DAYS = 180;

const RANGES = ['today', '7d', '30d', 'this_month', 'last_month', '90d'];

const pacificParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: EBAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

function partsOf(date) {
  const parts = Object.fromEntries(pacificParts.formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** eBay's current day. */
function ebayToday(now = new Date()) {
  return partsOf(now).day;
}

/** The eBay day a moment falls on (an order's createdAt, say). */
function ebayDayOf(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : partsOf(date).day;
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function dayCount(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
}

/**
 * The newest day whose figures are final: yesterday once it's 02:00
 * Pacific (10:00 UK), the day before until then.
 */
function lastFinalDay(now = new Date()) {
  const { day, hour } = partsOf(now);
  return addDays(day, hour >= SYNC_HOUR_PACIFIC ? -1 : -2);
}

/** When the next daily sync becomes due (02:00 Pacific), as a Date. */
function nextSyncAt(now = new Date()) {
  // Walk forward in 15-minute steps to the first moment the final day moves
  // on; DST-proof without a time-zone library.
  const current = lastFinalDay(now);
  let t = new Date(Math.ceil(now.getTime() / 900000) * 900000);
  for (let i = 0; i < 4 * 50 && lastFinalDay(t) === current; i += 1) t = new Date(t.getTime() + 900000);
  return t;
}

function monthStart(day) {
  return `${day.slice(0, 7)}-01`;
}

function monthEnd(day) {
  const d = new Date(`${monthStart(day)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/**
 * A range's days and the period it's compared with: the same number of days
 * straight before it, or for the month ranges the matching part of the
 * month before (this month so far vs the same days of last month).
 */
function rangeWindow(range, today) {
  const key = RANGES.includes(range) ? range : '30d';
  let from;
  let to = today;
  switch (key) {
    case 'today':
      from = today;
      break;
    case '7d':
      from = addDays(today, -6);
      break;
    case '90d':
      from = addDays(today, -(LISTING_HISTORY_DAYS - 1));
      break;
    case 'this_month':
      from = monthStart(today);
      break;
    case 'last_month': {
      const last = addDays(monthStart(today), -1);
      from = monthStart(last);
      to = last;
      break;
    }
    default:
      from = addDays(today, -29);
  }
  const days = dayCount(from, to);
  let previous;
  if (key === 'this_month' || key === 'last_month') {
    const prevEnd = addDays(from, -1);
    const prevFrom = monthStart(prevEnd);
    const prevTo = key === 'last_month' ? prevEnd : [addDays(prevFrom, days - 1), prevEnd].sort()[0];
    previous = { from: prevFrom, to: prevTo };
  } else {
    previous = { from: addDays(from, -days), to: addDays(from, -1) };
  }
  return { range: key, from, to, days, previous };
}

// ---- totals and rates -----------------------------------------------------

const TRAFFIC_COLUMNS = [
  'impressions',
  'impressions_search',
  'impressions_store',
  'total_impressions',
  'views',
  'views_search',
  'views_store',
  'views_direct',
  'views_off_ebay',
  'views_other_ebay',
  'transactions',
];

function emptyTraffic() {
  return Object.fromEntries(TRAFFIC_COLUMNS.map((c) => [c, 0]));
}

function sumTraffic(rows) {
  const out = emptyTraffic();
  for (const row of rows) for (const c of TRAFFIC_COLUMNS) out[c] += Number(row[c]) || 0;
  return out;
}

const ratio = (a, b) => (b > 0 ? a / b : null);

/**
 * The figures a page shows, from summed counts. Click-through is eBay's
 * definition (views from search / impressions in search); conversion is
 * sales per view. Sales and units come from our orders, not eBay's
 * TRANSACTION count, so they include today and match the Orders tab.
 */
function metricsFrom(traffic, sales) {
  return {
    impressions: traffic.impressions,
    views: traffic.views,
    ctr: ratio(traffic.views_search, traffic.impressions_search),
    sold: sales.units,
    orders: sales.orders,
    sales: sales.amount,
    conversion: ratio(sales.units, traffic.views),
  };
}

/** Change from `previous` to `current` as a fraction, or null when there's nothing to compare. */
function change(current, previous) {
  if (current == null || previous == null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / previous;
}

// ---- sales from orders ------------------------------------------------------

function isCancelled(order) {
  return Boolean(order.cancelStatus && !['NotApplicable', 'None', 'CancelFailed'].includes(order.cancelStatus));
}

/**
 * Units and item revenue (price × quantity, excluding postage) per eBay day
 * and per listing, from the mirrored orders. Cancelled orders don't count.
 */
function salesIndex(orders) {
  const byDay = new Map(); // day -> { units, amount, orders }
  const byListingDay = new Map(); // itemId -> Map(day -> { units, amount })
  let currency = null;
  for (const order of orders || []) {
    if (isCancelled(order)) continue;
    const day = ebayDayOf(order.createdAt);
    if (!day) continue;
    const dayTotal = byDay.get(day) || { units: 0, amount: 0, orders: 0 };
    dayTotal.orders += 1;
    for (const line of order.lineItems || []) {
      const units = Number(line.quantityPurchased) || 1;
      const amount = (Number(line.price?.amount) || 0) * units;
      currency = currency || line.price?.currency || order.total?.currency || null;
      dayTotal.units += units;
      dayTotal.amount += amount;
      if (!line.itemId) continue;
      const perDay = byListingDay.get(String(line.itemId)) || new Map();
      const cell = perDay.get(day) || { units: 0, amount: 0 };
      cell.units += units;
      cell.amount += amount;
      perDay.set(day, cell);
      byListingDay.set(String(line.itemId), perDay);
    }
    byDay.set(day, dayTotal);
  }
  return { byDay, byListingDay, currency };
}

function salesWithin(dayMap, from, to) {
  const out = { units: 0, amount: 0, orders: 0 };
  if (!dayMap) return out;
  for (const [day, cell] of dayMap) {
    if (day < from || day > to) continue;
    out.units += cell.units;
    out.amount += cell.amount;
    out.orders += cell.orders || 0;
  }
  out.amount = Math.round(out.amount * 100) / 100;
  return out;
}

// ---- what to look at ----------------------------------------------------------

/**
 * One plain suggestion for a listing over a range, or null. Thresholds need
 * enough traffic to mean something, so a quiet week says nothing.
 */
function hintFor(m, { days }) {
  if (m.impressions === 0 && days >= 7) {
    return { kind: 'no_impressions', label: 'No impressions', detail: "Not showing in search. Check the title, category and item specifics match what buyers search for." };
  }
  if (m.impressions >= 500 && m.ctr != null && m.ctr < 0.005) {
    return { kind: 'low_ctr', label: 'Seen, rarely clicked', detail: 'Plenty of impressions but few clicks. A stronger main photo or a sharper title usually helps.' };
  }
  if (m.views >= 40 && m.sold === 0) {
    return { kind: 'no_sales', label: 'Viewed, not selling', detail: 'Buyers look but don’t buy. Compare the price and postage with similar listings.' };
  }
  if (m.sold >= 3 && m.conversion != null && m.conversion >= 0.05) {
    return { kind: 'converting', label: 'Converting well', detail: 'A strong seller. Worth promoting or keeping well stocked.' };
  }
  return null;
}

module.exports = {
  EBAY_TIME_ZONE,
  SYNC_HOUR_PACIFIC,
  LISTING_HISTORY_DAYS,
  ACCOUNT_HISTORY_DAYS,
  RANGES,
  TRAFFIC_COLUMNS,
  ebayToday,
  ebayDayOf,
  addDays,
  daysBetween,
  dayCount,
  lastFinalDay,
  nextSyncAt,
  rangeWindow,
  emptyTraffic,
  sumTraffic,
  metricsFrom,
  change,
  salesIndex,
  salesWithin,
  hintFor,
};
