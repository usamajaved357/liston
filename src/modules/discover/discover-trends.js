const analyticsDays = require('../analytics/analytics-days');

// What a watched category or keyword sold lately, from Discover's daily
// readings of its leading listings: a listing's sales between two days are
// the difference between its sold counts on them. Until a listing has a
// week of readings, its recent sales cover the days it has. Pure.

const WEEK = 7;

const daysApart = (from, to) => analyticsDays.daysBetween(from, to).length - 1;

/**
 * Each listing's sales over (up to) the last week of readings.
 *
 * @param reads [{ item_id, day ('YYYY-MM-DD'), sold }], any order
 * @returns Map item_id -> { sold, days, from, to } (days: how many days the
 *          two readings are apart; listings with one reading are left out)
 */
function recentSales(reads, { days = WEEK } = {}) {
  const byItem = new Map();
  for (const r of reads) {
    const list = byItem.get(r.item_id) || [];
    list.push({ day: String(r.day).slice(0, 10), sold: Number(r.sold) || 0 });
    byItem.set(r.item_id, list);
  }
  const out = new Map();
  for (const [itemId, list] of byItem) {
    list.sort((a, b) => (a.day < b.day ? -1 : 1));
    const last = list[list.length - 1];
    const cutoff = analyticsDays.addDays(last.day, -days);
    // The reading a week before the last, else the earliest there is.
    const base = [...list].reverse().find((r) => r.day <= cutoff) || list[0];
    if (base === last) continue;
    out.set(itemId, { sold: Math.max(0, last.sold - base.sold), days: daysApart(base.day, last.day), from: base.day, to: last.day });
  }
  return out;
}

/**
 * A watched subject's recent sales, and its listings selling faster lately
 * than over their life (rising) — each with its recent sales added.
 *
 * @param listings the subject's listings with soldPerMonth (lifetime pace)
 * @param recent   recentSales(...) for them
 */
function summarise(listings, recent) {
  let sold = 0;
  let days = 0;
  let measured = 0;
  const withRecent = listings.map((l) => {
    const r = recent.get(String(l.legacyItemId || l.itemId)) || null;
    if (r) {
      sold += r.sold;
      days = Math.max(days, r.days);
      measured += 1;
    }
    return { ...l, recent: r };
  });
  const rising = withRecent
    .filter((l) => l.recent && l.recent.days >= 2 && l.recent.sold >= 2)
    .map((l) => {
      const perDayNow = l.recent.sold / l.recent.days;
      const perDayLife = (l.soldPerMonth || 0) / 30;
      return { ...l, lift: perDayLife ? Math.round((perDayNow / perDayLife) * 10) / 10 : null };
    })
    .filter((l) => l.lift === null || l.lift >= 1.5)
    .sort((a, b) => b.recent.sold - a.recent.sold)
    .slice(0, 5);
  return { recent: measured ? { sold, days, listings: measured } : null, rising, listings: withRecent };
}

/**
 * Sales day by day over the last `days` days, from the daily readings: a
 * listing's sales between two readings land on the days between them
 * (spread evenly over a gap). A day no two readings span is null (not
 * known). Null altogether until at least two days are known.
 *
 * @returns [{ day, value }] | null
 */
function dailySales(reads, { today, days = 14 } = {}) {
  const from = analyticsDays.addDays(today, -(days - 1));
  const totals = new Map();
  const byItem = new Map();
  for (const r of reads) {
    const list = byItem.get(r.item_id) || [];
    list.push({ day: String(r.day).slice(0, 10), sold: Number(r.sold) || 0 });
    byItem.set(r.item_id, list);
  }
  for (const list of byItem.values()) {
    list.sort((a, b) => (a.day < b.day ? -1 : 1));
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1];
      const b = list[i];
      const gap = daysApart(a.day, b.day);
      if (gap <= 0) continue;
      const each = Math.max(0, b.sold - a.sold) / gap;
      for (let k = 1; k <= gap; k += 1) {
        const day = analyticsDays.addDays(a.day, k);
        if (day >= from && day <= today) totals.set(day, (totals.get(day) || 0) + each);
      }
    }
  }
  if (totals.size < 2) return null;
  return analyticsDays.daysBetween(from, today).map((day) => ({ day, value: totals.has(day) ? Math.round(totals.get(day) * 10) / 10 : null }));
}

// New or selling faster lately, per listing: rising — at least 2 sold over 2
// days of readings or more, at 1.5 times its lifetime pace or faster — or
// new: live NEW_DAYS or less and already selling NEW_PACE a month.
const NEW_DAYS = 90;
const NEW_PACE = 10;
const RISING_LIFT = 1.5;

/**
 * How many of a subject's leading listings are new or rising (listings
 * from summarise, each with soldPerMonth, recent and createdAt): { rising,
 * read } — read: how many have a sold count. eBay doesn't share buyers'
 * search volume, so this momentum stands in for "trending".
 */
function momentumOf(listings, now = Date.now()) {
  let rising = 0;
  let read = 0;
  for (const l of listings) {
    if (l.soldPerMonth === null || l.soldPerMonth === undefined) continue;
    read += 1;
    const lifePerDay = l.soldPerMonth / 30;
    const recentOk = l.recent && l.recent.days >= 2 && l.recent.sold >= 2;
    const faster = recentOk && (!lifePerDay || l.recent.sold / l.recent.days / lifePerDay >= RISING_LIFT);
    const days = l.createdAt ? Math.floor((now - Date.parse(l.createdAt)) / 86400000) : null;
    const fresh = days !== null && days >= 0 && days <= NEW_DAYS && l.soldPerMonth >= NEW_PACE;
    if (faster || fresh) rising += 1;
  }
  return { rising, read };
}

module.exports = { recentSales, summarise, dailySales, momentumOf, WEEK, NEW_DAYS };
