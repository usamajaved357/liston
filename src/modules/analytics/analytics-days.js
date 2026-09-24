// Pure date and number logic for listing analytics. No I/O.
//
// Days are the seller's own calendar days, in their eBay site's time zone
// (Europe/London for eBay UK), which is how Seller Hub reports traffic;
// eBay's traffic report buckets days on whatever UTC offset the request's
// date range carries (verified live). Orders are bucketed the same way, so a
// day's sales line up with that day's views. Days are "YYYY-MM-DD" strings.

// eBay's traffic report covers these sites only; each reports in its home
// time zone. eBay US's Seller Hub works in Pacific time.
const SITE_TIME_ZONES = {
  EBAY_GB: 'Europe/London',
  EBAY_US: 'America/Los_Angeles',
  EBAY_MOTORS_US: 'America/Los_Angeles',
  EBAY_AU: 'Australia/Sydney',
  EBAY_DE: 'Europe/Berlin',
  EBAY_FR: 'Europe/Paris',
  EBAY_IT: 'Europe/Rome',
  EBAY_ES: 'Europe/Madrid',
};
// A day is complete, and read, at 02:00 local time the next morning.
const SYNC_HOUR = 2;
const ACCOUNT_HISTORY_DAYS = 180; // account totals kept, for period comparisons
// Each listing's figures day by day: enough for every range — 90 days, and
// last month with the month before it (at most 92 days back) — so every
// filter and every comparison but 90 days' is added up from stored days.
// (Account totals keep 180 days, so the 90-day account comparison stays.)
const LISTING_HISTORY_DAYS = 92;
// No "Today": eBay's traffic for a day comes once the day is complete.
const RANGES = ['7d', '30d', 'this_month', 'last_month', '90d'];

const timeZoneFor = (marketplaceId) => SITE_TIME_ZONES[marketplaceId] || null;

/** `tz` when it's a time zone this runtime knows ("Asia/Karachi"), else null. */
function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

const formatters = new Map();
function partsOf(date, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '');
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), offset };
}

/** The seller's current day. */
function today(timeZone, now = new Date()) {
  return partsOf(now, timeZone).day;
}

/** The seller's day a moment falls on (an order's createdAt, say). */
function dayOf(timestamp, timeZone) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : partsOf(date, timeZone).day;
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

/** The UTC offset ("+01:00") in force at the start of a day in a time zone. */
function offsetAt(day, timeZone) {
  // Midday UTC is always on the same local date for these zones; step back
  // to local midnight by asking again at the resulting instant.
  const guess = new Date(`${day}T12:00:00Z`);
  const off = partsOf(guess, timeZone).offset;
  const sign = off[0] === '-' ? -1 : 1;
  const [h, m] = off.slice(1).split(':').map(Number);
  const midnight = new Date(Date.parse(`${day}T00:00:00Z`) - sign * (h * 60 + m) * 60000);
  return partsOf(midnight, timeZone).offset;
}

/**
 * The newest complete day: yesterday once it's 02:00 local time, the day
 * before until then.
 */
function lastFinalDay(timeZone, now = new Date()) {
  const { day, hour } = partsOf(now, timeZone);
  return addDays(day, hour >= SYNC_HOUR ? -1 : -2);
}

/** When the next day becomes complete (02:00 local), as a Date. */
function nextSyncAt(timeZone, now = new Date()) {
  // Walk forward in 15-minute steps to the first moment the final day moves
  // on: DST-proof without a time-zone library.
  const current = lastFinalDay(timeZone, now);
  let t = new Date(Math.ceil(now.getTime() / 900000) * 900000);
  for (let i = 0; i < 4 * 50 && lastFinalDay(timeZone, t) === current; i += 1) t = new Date(t.getTime() + 900000);
  return t;
}

const monthStart = (day) => `${day.slice(0, 7)}-01`;

/**
 * A range's days and the period it's compared with. Every range is made of
 * complete days, ending with the last complete day, so traffic and sales
 * cover exactly the same days (and a figure never shifts while eBay is
 * still counting) — except "this month" on the 1st, the running day so far.
 *   7d / 30d / 90d  the last N complete days, vs the N days before
 *   this_month      the 1st to the last complete day, vs the same days of
 *                   last month (on the 1st, it is today so far)
 *   last_month      the whole of last month, vs the month before
 */
function rangeWindow(range, { today: now, lastFinal }) {
  const key = RANGES.includes(range) ? range : '30d';
  let from;
  let to = lastFinal;
  if (key === 'this_month') {
    from = monthStart(now);
    if (from > lastFinal) return { range: key, from: now, to: now, days: 1, partial: true, previous: { from: addDays(now, -1), to: addDays(now, -1) } };
  } else if (key === 'last_month') {
    to = addDays(monthStart(now), -1);
    from = monthStart(to);
  } else {
    const n = key === '7d' ? 7 : key === '90d' ? 90 : 30;
    from = addDays(lastFinal, -(n - 1));
  }
  const days = dayCount(from, to);
  let previous;
  if (key === 'this_month' || key === 'last_month') {
    const prevEnd = addDays(from, -1);
    const prevFrom = monthStart(prevEnd);
    previous = { from: prevFrom, to: key === 'last_month' ? prevEnd : [addDays(prevFrom, days - 1), prevEnd].sort()[0] };
  } else {
    previous = { from: addDays(from, -days), to: addDays(from, -1) };
  }
  return { range: key, from, to, days, partial: false, previous };
}

// A single-day range ("This month" on the 1st) has one point:
// its chart and sparklines show it at the end of the 14 days leading up
// to it instead.
const LEAD_IN_DAYS = 14;
function leadIn(win) {
  if (win.days > 1) return null;
  return { from: addDays(win.to, -(LEAD_IN_DAYS - 1)), to: win.to };
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
 * The figures a page shows, from summed counts:
 *   impressions   eBay's total impressions on every page and flow — the
 *                 figure Seller Hub shows (TOTAL_IMPRESSION_TOTAL)
 *   views         listing page views
 *   ctr           eBay's click-through: views from search ÷ impressions in search
 *   sold / sales  from our orders (units, item revenue), not eBay's count
 *   conversion    units sold per view
 */
function metricsFrom(traffic, sales) {
  return {
    impressions: traffic.total_impressions,
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
 * Units and item revenue (price × quantity, excluding postage) per seller
 * day and per listing, from the mirrored orders. Cancelled orders don't
 * count.
 */
function salesIndex(orders, timeZone) {
  const byDay = new Map(); // day -> { units, amount, orders }
  const byListingDay = new Map(); // itemId -> Map(day -> { units, amount, orders })
  let currency = null;
  for (const order of orders || []) {
    if (isCancelled(order)) continue;
    const day = dayOf(order.createdAt, timeZone);
    if (!day) continue;
    const dayTotal = byDay.get(day) || { units: 0, amount: 0, orders: 0 };
    dayTotal.orders += 1;
    const counted = new Set(); // an order counts once per listing, however many lines it has of it
    for (const line of order.lineItems || []) {
      const units = Number(line.quantityPurchased) || 1;
      const amount = (Number(line.price?.amount) || 0) * units;
      currency = currency || line.price?.currency || order.total?.currency || null;
      dayTotal.units += units;
      dayTotal.amount += amount;
      if (!line.itemId) continue;
      const perDay = byListingDay.get(String(line.itemId)) || new Map();
      const cell = perDay.get(day) || { units: 0, amount: 0, orders: 0 };
      cell.units += units;
      cell.amount += amount;
      if (!counted.has(String(line.itemId))) {
        counted.add(String(line.itemId));
        cell.orders += 1;
      }
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

// ---- listing history -----------------------------------------------------------

/**
 * The days of listing history still to read, newest first (so the short
 * ranges are covered soonest): from the last complete day back to
 * LISTING_HISTORY_DAYS, or to `historyFrom` when nothing live is older.
 */
function historyDaysMissing({ lastFinal, historyFrom, done }) {
  const floor = [addDays(lastFinal, -(LISTING_HISTORY_DAYS - 1)), historyFrom || ''].sort()[1];
  const have = new Set(done || []);
  const out = [];
  for (let day = lastFinal; day >= floor; day = addDays(day, -1)) if (!have.has(day)) out.push(day);
  return out;
}

/**
 * Which live listings the stored day-by-day history gives exact totals for
 * over a range, and those totals. A listing is covered when, on every day
 * of the range, it had been read or couldn't have had traffic:
 *   - a day read naming listings (`listing_ids`) covers the ones named;
 *   - an unfiltered day read with no cutoff covers every listing;
 *   - an unfiltered day with a cutoff (eBay's busiest 200 of a big store)
 *     covers only the listings in it that day;
 *   - any day before a listing was listed counts as zero for it.
 * `listedOn` maps listing id -> the seller day it was listed (or null).
 * Returns a report trafficFrom() reads: rows, cutoff null, covers(id).
 */
function historyReport({ from, to, reads, totals, listedOn, historyFrom = null }) {
  const readByDay = new Map(reads.map((r) => [r.day, r]));
  const missing = [];
  const named = [];
  const busiest = [];
  for (const day of daysBetween(from, to)) {
    const read = readByDay.get(day);
    if (!read) missing.push(day);
    else if (read.listing_ids) named.push({ day, ids: new Set(read.listing_ids.map(String)) });
    else if (read.cutoff != null) busiest.push(day);
  }
  const latestMissing = missing.length ? missing[missing.length - 1] : null;
  const rowsById = new Map(totals.map((r) => [String(r.listing_id), r]));
  const covered = new Set();
  for (const [id, listed] of listedOn) {
    const after = (day) => Boolean(listed) && listed > day;
    if (latestMissing && !after(latestMissing)) continue;
    if (!named.every(({ day, ids }) => ids.has(id) || after(day))) continue;
    const needed = busiest.filter((day) => !after(day)).length;
    if (needed && (rowsById.get(id)?.counted_days || 0) < needed) continue;
    covered.add(id);
  }
  const rows = [...covered].filter((id) => rowsById.has(id)).map((id) => ({ ...rowsById.get(id), listingId: id }));
  // Every day of the range is stored (days before anything live was
  // listed need no read): a listing still not covered was outside a big
  // store's busiest 200, not waiting for history.
  const filled = missing.every((day) => historyFrom && day < historyFrom);
  return { scope: 'history', rows, cutoff: null, covers: (id) => covered.has(String(id)), coveredCount: covered.size, complete: covered.size === listedOn.size, filled };
}

module.exports = {
  validTimeZone,
  SITE_TIME_ZONES,
  SYNC_HOUR,
  ACCOUNT_HISTORY_DAYS,
  LISTING_HISTORY_DAYS,
  LEAD_IN_DAYS,
  leadIn,
  historyDaysMissing,
  historyReport,
  RANGES,
  TRAFFIC_COLUMNS,
  timeZoneFor,
  today,
  dayOf,
  addDays,
  daysBetween,
  dayCount,
  offsetAt,
  lastFinalDay,
  nextSyncAt,
  rangeWindow,
  emptyTraffic,
  sumTraffic,
  metricsFrom,
  change,
  salesIndex,
  salesWithin,
};
