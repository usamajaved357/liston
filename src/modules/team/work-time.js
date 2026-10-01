// A team member's time in Liston, defined once: the areas a minute can be
// spent in, which areas each kind of recorded work belongs to, and how a
// period's minutes (member_minutes, one row a minute a tab of theirs was
// open) add up: working and idle by day, the stretches of each day, and
// where the working time went. Pure: no DB.
//
// How a minute is judged (in the page, useWorkClock): working when there
// was a click, key press, scroll or touch in a Liston tab in the last
// couple of minutes (time to read what's on screen), idle when a tab is
// open with nothing done, for at most half an hour; after that they're
// away and no minute is kept, so a tab left open overnight isn't counted.
const days = require('../analytics/analytics-days');

// Where in Liston a minute was spent, with its name.
const AREAS = {
  dashboard: 'Dashboard',
  overview: 'Overview',
  inbox: 'Inbox',
  orders: 'Orders',
  listings: 'Listings',
  hunting: 'Hunting',
  research: 'Research',
  analytics: 'Analytics',
  campaigns: 'Campaigns',
  settings: 'Settings',
  other: 'Elsewhere in Liston',
};

const areaKey = (area) => (Object.prototype.hasOwnProperty.call(AREAS, area) ? area : 'other');

// The area each kind of recorded work is done in (logins are no one area's).
function areaOfKind(kind) {
  const k = String(kind || '');
  if (k.startsWith('order.')) return 'orders';
  if (k.startsWith('listing.')) return 'listings';
  if (k.startsWith('hunt.')) return 'hunting';
  if (k.startsWith('inbox.')) return 'inbox';
  if (k.startsWith('account.')) return 'settings';
  return null;
}

const MINUTE = 60 * 1000;
const dayStart = (day, timeZone) => new Date(`${day}T00:00:00${days.offsetAt(day, timeZone)}`).getTime();

/**
 * A period's minutes ({ minute, working, area, connection_id }) as
 * { totals: { working, idle }, days: [{ day, working, idle, first, last,
 * spans: [{ from, to, working, area }] }], areas: [{ area, label, working,
 * idle }] }: minutes counted, days from `from` to `to` in `timeZone` (every
 * day, worked or not), spans in minutes after that day's midnight (one per
 * unbroken stretch of the same state in the same area), areas by working
 * time.
 */
function summarize(minutes, { from, to, timeZone }) {
  const tz = timeZone || 'Europe/London';
  const byDay = new Map(days.daysBetween(from, to).map((d) => [d, { day: d, working: 0, idle: 0, first: null, last: null, spans: [], start: dayStart(d, tz) }]));
  const areas = new Map();
  const sorted = [...minutes].sort((a, b) => new Date(a.minute) - new Date(b.minute));
  for (const m of sorted) {
    const at = new Date(m.minute).getTime();
    const d = byDay.get(days.dayOf(m.minute, tz));
    if (!d) continue;
    const area = areaKey(m.area);
    const working = Boolean(m.working);
    if (working) d.working += 1;
    else d.idle += 1;
    if (!d.first) d.first = new Date(at).toISOString();
    d.last = new Date(at + MINUTE).toISOString();
    const a = areas.get(area) || { area, label: AREAS[area], working: 0, idle: 0 };
    if (working) a.working += 1;
    else a.idle += 1;
    areas.set(area, a);
    const offset = Math.round((at - d.start) / MINUTE);
    const last = d.spans[d.spans.length - 1];
    if (last && last.to === offset && last.working === working && last.area === area) last.to = offset + 1;
    else d.spans.push({ from: offset, to: offset + 1, working, area });
  }
  // Each day without its midnight (only needed to place the spans).
  const list = [...byDay.values()].map((d) => ({ day: d.day, working: d.working, idle: d.idle, first: d.first, last: d.last, spans: d.spans }));
  return {
    totals: { working: list.reduce((n, d) => n + d.working, 0), idle: list.reduce((n, d) => n + d.idle, 0) },
    days: list,
    areas: [...areas.values()].sort((x, y) => y.working - x.working || y.idle - x.idle),
  };
}

/** Working and idle minutes in all of a period's minutes: { working, idle }. */
function totalsOf(minutes) {
  let working = 0;
  for (const m of minutes) if (m.working) working += 1;
  return { working, idle: minutes.length - working };
}

module.exports = { AREAS, areaKey, areaOfKind, summarize, totalsOf };
