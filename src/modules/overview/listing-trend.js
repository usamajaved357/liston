const { rangeDays, trendSlots } = require('./trend-slots');

// The Overview's Listings tab under its cards: the listing pipeline day by
// day (Today hour by hour) over the chosen dates (products hunted, approved
// and rejected, drafts made and listings published), the stretch before
// alongside. Pure: event
// times in, figures out. Liston keeps its own drafts and hunts for good, so
// the stretch before is always there.

const KEYS = ['hunted', 'approved', 'rejected', 'drafted', 'published'];

/** The days a range covers (Today: today) and as many just before (overview/trend-slots). */
const listingDays = (range, today) => rangeDays(range, today);

/**
 * [{ day, previousDay, partial, future, values: { hunted, approved,
 * rejected, drafted, published }, previous: { … } }] from { hunted: [time],
 * … }: one point a day, or for Today one an hour (`day` is then the hour,
 * "2026-09-29T14").
 */
function listingTrend(events, { timeZone, range, today, now = new Date() }) {
  const { slots, previousSlots, current, slotOf } = trendSlots(range, { timeZone, today, now });
  const counts = Object.fromEntries(KEYS.map((k) => [k, new Map()]));
  for (const k of KEYS) {
    for (const at of events[k] || []) {
      const slot = slotOf(at);
      if (slot) counts[k].set(slot, (counts[k].get(slot) || 0) + 1);
    }
  }
  const on = (slot) => Object.fromEntries(KEYS.map((k) => [k, counts[k].get(slot) || 0]));
  return slots.map((slot, i) => ({ day: slot, previousDay: previousSlots[i], partial: slot === current, future: slot > current, values: on(slot), previous: on(previousSlots[i]) }));
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
