const analyticsDays = require('../analytics/analytics-days');

// The points an Overview chart is drawn over, in the seller's time zone, the
// same dates the cards above it count. Every range but Today is days: the
// range's own (7 days is today and the six before), and as many just before.
// Today is its 24 hours, yesterday's alongside: an hour not reached yet is
// `future` (drawn as nothing, and left out of both totals, so today so far
// is set against yesterday up to the same hour).

/** The days a range covers, and the same number just before (null past `oldest`, when given). */
function rangeDays(range, today, { oldest = null } = {}) {
  let from;
  let to = today;
  if (range === 'this_month') from = `${today.slice(0, 7)}-01`;
  else if (range === 'last_month') {
    to = analyticsDays.addDays(`${today.slice(0, 7)}-01`, -1);
    from = `${to.slice(0, 7)}-01`;
  } else {
    const n = { today: 1, '7d': 7, '30d': 30, '90d': 90 }[range] || 7;
    from = analyticsDays.addDays(today, -(n - 1));
  }
  const days = analyticsDays.daysBetween(from, to);
  const previousFrom = analyticsDays.addDays(from, -days.length);
  const previousDays = oldest && previousFrom < oldest ? null : analyticsDays.daysBetween(previousFrom, analyticsDays.addDays(from, -1));
  return { days, previousDays };
}

/**
 * { slots, previousSlots, current, slotOf, hourly }: the chart's points
 * ("2026-09-29", or "2026-09-29T14" for Today's hours), the stretch before
 * (null when it can't be had), the slot running now and which slot a moment
 * falls in.
 */
function trendSlots(range, { timeZone, today, now = new Date(), oldest = null }) {
  const { days, previousDays } = rangeDays(range, today, { oldest });
  if (range !== 'today') {
    return { slots: days, previousSlots: previousDays, current: today, slotOf: (at) => analyticsDays.dayOf(at, timeZone), hourly: false };
  }
  return {
    slots: analyticsDays.hoursOf(today),
    previousSlots: previousDays ? analyticsDays.hoursOf(previousDays[0]) : null,
    current: analyticsDays.hourOf(now, timeZone),
    slotOf: (at) => analyticsDays.hourOf(at, timeZone),
    hourly: true,
  };
}

module.exports = { rangeDays, trendSlots };
