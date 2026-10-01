// The eBay Store subscription as a cost of the days it pays for, not of the
// day eBay bills it. eBay takes a month's fee on one day (the 1st on eBay
// UK), so Today on the 1st showed the whole month's fee and every other day
// none; spread over its period, each day carries its share and every range
// (Today, 7 days, this month…) its own days' worth. eBay UK's memo names the
// period ("2026-08-31 - 2026-09-29"); without one, the month from the day it
// was billed. A credit back spreads the same way. Other charges (listing
// fees, ads) stay on the day eBay billed them. Pure.
const days = require('../analytics/analytics-days');

const PERIOD = /^\s*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/;
// How long before a range a store charge may be billed and still pay for days in it.
const LOOK_BACK_DAYS = 62;

/** The day a month after `day`, kept inside that month (31 Jan -> 28 Feb). */
function monthOn(day) {
  const [y, m, d] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
}

/** The days (both ends) a store charge pays for. */
function daysPaidFor(charge, timeZone) {
  const m = PERIOD.exec(charge.memo || '');
  if (m && m[1] <= m[2] && days.dayCount(m[1], m[2]) <= 366) return days.daysBetween(m[1], m[2]);
  const first = days.dayOf(charge.chargedAt, timeZone);
  return days.daysBetween(first, days.addDays(monthOn(first), -1));
}

/** When to read charges from for a range starting at `start`. */
const readFrom = (start) => new Date(new Date(start).getTime() - LOOK_BACK_DAYS * 86400000);

/**
 * The charges the dates from `start` to `end` bear, in `timeZone`'s days: a
 * store charge as one share for each day of its period in the dates (its
 * amount ÷ the days it pays for, dated that day's midnight), any other as
 * billed when billed in the dates. `charges`: [{ kind, amount, chargedAt,
 * memo }], read from readFrom(start).
 */
function chargesInDates(charges, { start, end, timeZone }) {
  const from = days.dayOf(start, timeZone);
  const to = days.dayOf(end, timeZone);
  const [startMs, endMs] = [new Date(start).getTime(), new Date(end).getTime()];
  const out = [];
  for (const charge of charges) {
    if (charge.kind !== 'store') {
      const at = new Date(charge.chargedAt).getTime();
      if (at >= startMs && at <= endMs) out.push(charge);
      continue;
    }
    const paid = daysPaidFor(charge, timeZone);
    const share = (Number(charge.amount) || 0) / paid.length;
    for (const day of paid) {
      if (day < from || day > to) continue;
      out.push({ ...charge, amount: share, chargedAt: new Date(`${day}T00:00:00${days.offsetAt(day, timeZone)}`) });
    }
  }
  return out;
}

module.exports = { daysPaidFor, readFrom, chargesInDates, LOOK_BACK_DAYS };
