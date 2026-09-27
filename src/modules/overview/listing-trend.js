const analyticsDays = require('../analytics/analytics-days');

// The Overview's Listings tab under its cards: the listing pipeline day by
// day over the chosen dates (products hunted, approved and rejected, drafts
// made and listings published), the stretch before alongside. Pure: event
// times in, figures out. Liston keeps its own drafts and hunts for good, so
// the stretch before is always there.

const KEYS = ['hunted', 'approved', 'rejected', 'drafted', 'published'];

/** The days a range is drawn over ("Today" as the last 7 days) and as many just before. */
function listingDays(range, today) {
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
  const previousDays = analyticsDays.daysBetween(analyticsDays.addDays(from, -days.length), analyticsDays.addDays(from, -1));
  return { days, previousDays };
}

/**
 * [{ day, previousDay, partial, values: { hunted, approved, rejected,
 * drafted, published }, previous: { … } }] from { hunted: [time], … }.
 */
function listingTrend(events, { timeZone, range, today }) {
  const { days, previousDays } = listingDays(range, today);
  const counts = Object.fromEntries(KEYS.map((k) => [k, new Map()]));
  for (const k of KEYS) {
    for (const at of events[k] || []) {
      const day = analyticsDays.dayOf(at, timeZone);
      if (day) counts[k].set(day, (counts[k].get(day) || 0) + 1);
    }
  }
  const on = (day) => Object.fromEntries(KEYS.map((k) => [k, counts[k].get(day) || 0]));
  return days.map((day, i) => ({ day, previousDay: previousDays[i], partial: day === today, values: on(day), previous: on(previousDays[i]) }));
}

/** The event times listingTrend needs, from an account's hunts and listings rows. */
function eventsFrom(hunts, listings) {
  return {
    hunted: hunts.map((h) => h.created_at),
    approved: hunts.filter((h) => h.status === 'approved' && h.decided_at).map((h) => h.decided_at),
    rejected: hunts.filter((h) => h.status === 'rejected' && h.decided_at).map((h) => h.decided_at),
    drafted: listings.map((l) => l.created_at),
    published: listings.filter((l) => l.status === 'published').map((l) => l.updated_at),
  };
}

/** Accounts' trends added up day by day (they share the same days). */
function addListingTrends(trends) {
  const list = trends.filter((t) => Array.isArray(t) && t.length);
  if (!list.length) return null;
  return list[0].map((point, i) => ({
    ...point,
    values: Object.fromEntries(KEYS.map((k) => [k, list.reduce((n, t) => n + (t[i]?.values[k] || 0), 0)])),
    previous: Object.fromEntries(KEYS.map((k) => [k, list.reduce((n, t) => n + (t[i]?.previous[k] || 0), 0)])),
  }));
}

module.exports = { KEYS, listingDays, listingTrend, eventsFrom, addListingTrends };
