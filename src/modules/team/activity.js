// A team member's work, defined once: the kinds of action recorded in
// member_activity, how order-timeline events map onto them, the figures a
// member's page (and later, salaries) counts, and the date ranges they're
// counted over. Pure: no DB, no eBay.
const days = require('../analytics/analytics-days');

// Every recorded kind, with the words the activity log shows.
const KINDS = {
  'order.supplier_ordered': 'Placed the supplier order',
  'order.dispatched': 'Dispatched on eBay',
  'order.refunded': 'Refunded',
  'order.cancelled': 'Cancelled',
  'order.cancel_declined': 'Declined a cancellation',
  'order.return_handled': 'Handled a return',
  'order.inquiry_handled': 'Handled an item-not-received case',
  'order.dispute_handled': 'Handled a payment dispute',
  'order.archived': 'Archived',
  'order.unarchived': 'Unarchived',
  'order.note': 'Added a note',
  'listing.drafted': 'Drafted a listing',
  'listing.draft_deleted': 'Deleted a draft',
  'listing.published': 'Published a listing',
  'listing.edited': 'Edited a live listing',
  'listing.relisted': 'Relisted',
  'listing.ended': 'Ended a listing',
};

// An order-timeline event (order_events.kind) as an activity kind; null for
// events that aren't someone's work (eBay's own, or pushed from eBay).
function kindForOrderEvent(eventKind) {
  const k = String(eventKind || '');
  if (k === 'sourcing.ordered') return 'order.supplier_ordered';
  if (k === 'ebay.dispatched_by_liston') return 'order.dispatched';
  if (k === 'ebay.refunded_by_liston') return 'order.refunded';
  if (k === 'ebay.cancelled_by_liston' || k === 'ebay.cancel_approved_by_liston') return 'order.cancelled';
  if (k === 'ebay.cancel_declined_by_liston') return 'order.cancel_declined';
  if (/^ebay\.return_.+_by_liston$/.test(k)) return 'order.return_handled';
  if (/^ebay\.inquiry_.+_by_liston$/.test(k)) return 'order.inquiry_handled';
  if (/^ebay\.dispute_.+_by_liston$/.test(k)) return 'order.dispute_handled';
  if (k === 'archived') return 'order.archived';
  if (k === 'unarchived') return 'order.unarchived';
  if (k === 'note') return 'order.note';
  return null;
}

// The figures a member is judged (and paid) on. `distinct`: the same order
// line or listing counts once however many times it was touched in the
// range — re-saving a supplier order number is not a second order.
const METRICS = [
  { key: 'supplier_orders', label: 'Supplier orders placed', kinds: ['order.supplier_ordered'], distinct: true },
  { key: 'dispatched', label: 'Orders dispatched', kinds: ['order.dispatched'], distinct: true },
  { key: 'cases', label: 'Refunds, cancellations & cases', kinds: ['order.refunded', 'order.cancelled', 'order.cancel_declined', 'order.return_handled', 'order.inquiry_handled', 'order.dispute_handled'], distinct: false },
  { key: 'published', label: 'Listings published', kinds: ['listing.published'], distinct: true },
  { key: 'edited', label: 'Live listings edited', kinds: ['listing.edited'], distinct: false },
  { key: 'relisted', label: 'Listings relisted', kinds: ['listing.relisted'], distinct: true },
  { key: 'ended', label: 'Listings ended', kinds: ['listing.ended'], distinct: true },
  { key: 'drafted', label: 'Drafts created', kinds: ['listing.drafted'], distinct: false },
];

/**
 * The figures for a set of activity rows ({ kind, subject_id, subject_part }):
 * { supplier_orders: 12, dispatched: 30, … } by METRICS' rules.
 */
function metricsFrom(rows) {
  const out = {};
  for (const m of METRICS) {
    const own = rows.filter((r) => m.kinds.includes(r.kind));
    out[m.key] = m.distinct ? new Set(own.map((r) => `${r.subject_id}:${r.subject_part || ''}`)).size : own.length;
  }
  return out;
}

// ---- date ranges -----------------------------------------------------------------

const RANGES = ['today', 'yesterday', '7d', '30d', 'this_month', 'last_month', 'custom'];
const MAX_CUSTOM_DAYS = 366;

class RangeError_ extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const instant = (day, timeZone) => new Date(`${day}T00:00:00${days.offsetAt(day, timeZone)}`);

/**
 * A range as seller-time-zone days, the instants that bound it, and the
 * period before it of the same length (for "vs previous"). Unlike traffic,
 * activity is live, so every range runs up to now and includes today.
 */
function rangeWindow(range, { from, to, timeZone, now = new Date() } = {}) {
  const tz = timeZone || 'Europe/London';
  const today = days.today(tz, now);
  let key = RANGES.includes(range) ? range : '7d';
  let start;
  let end;
  if (key === 'today') [start, end] = [today, today];
  else if (key === 'yesterday') [start, end] = [days.addDays(today, -1), days.addDays(today, -1)];
  else if (key === '7d') [start, end] = [days.addDays(today, -6), today];
  else if (key === '30d') [start, end] = [days.addDays(today, -29), today];
  else if (key === 'this_month') [start, end] = [`${today.slice(0, 7)}-01`, today];
  else if (key === 'last_month') {
    const first = `${today.slice(0, 7)}-01`;
    end = days.addDays(first, -1);
    start = `${end.slice(0, 7)}-01`;
  } else {
    if (!isDay(from) || !isDay(to)) throw new RangeError_('Choose both a start and an end date.');
    if (from > to) throw new RangeError_('The start date is after the end date.');
    if (days.dayCount(from, to) > MAX_CUSTOM_DAYS) throw new RangeError_('A custom range can cover at most a year.');
    [start, end] = [from, to > today ? today : to];
    if (start > end) throw new RangeError_('That range is in the future.');
    key = 'custom';
  }
  const length = days.dayCount(start, end);
  // Last month compares with the whole month before; this month with the
  // same days of last month (1–24 Sept against 1–24 Aug); everything else
  // with as many days just before it.
  let prevStart;
  let prevEnd;
  if (key === 'last_month') {
    prevEnd = days.addDays(start, -1);
    prevStart = `${prevEnd.slice(0, 7)}-01`;
  } else if (key === 'this_month') {
    const lastOfPrev = days.addDays(start, -1);
    prevStart = `${lastOfPrev.slice(0, 7)}-01`;
    const sameDays = days.addDays(prevStart, length - 1);
    prevEnd = sameDays < lastOfPrev ? sameDays : lastOfPrev;
  } else {
    prevEnd = days.addDays(start, -1);
    prevStart = days.addDays(start, -length);
  }
  // A range that runs to now is compared up to the same time of day, so
  // "today so far" isn't set against the whole of yesterday.
  const unfinished = end === today ? instant(days.addDays(today, 1), tz).getTime() - now.getTime() : 0;
  return {
    key,
    from: start,
    to: end,
    days: length,
    timeZone: tz,
    startsAt: instant(start, tz),
    endsAt: end === today ? now : instant(days.addDays(end, 1), tz),
    previous: {
      from: prevStart,
      to: prevEnd,
      startsAt: instant(prevStart, tz),
      endsAt: new Date(instant(days.addDays(prevEnd, 1), tz).getTime() - unfinished),
    },
  };
}

module.exports = { KINDS, METRICS, RANGES, kindForOrderEvent, metricsFrom, rangeWindow };
