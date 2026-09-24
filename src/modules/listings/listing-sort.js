// The orders the Listings tab offers, applied to the account's whole list
// (Liston holds it all, so sorting never calls eBay) before it's paged.
// eBay's own order for the active list is "time left", which for Good 'Til
// Cancelled listings is only the day of the month each one renews.
//
// Each item may carry `lastSoldAt` (its latest sale in the orders Liston
// holds) and `lastEditedAt` (its latest edit from Liston).

const SORTS = ['newest', 'edited', 'best_selling', 'last_sold', 'not_selling', 'low_stock', 'price_high', 'price_low'];
// Stock and "not selling" mean nothing for a listing that has ended.
const INACTIVE_SORTS = ['newest', 'edited', 'best_selling', 'last_sold', 'price_high', 'price_low'];
const DEFAULT_SORT = 'newest';

const time = (iso) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};
const price = (item) => {
  const n = Number(item.price?.value ?? item.price?.amount);
  return Number.isFinite(n) ? n : null;
};
// eBay's ended-listings list can say 0 sold for one that sold; a known sale counts.
const sold = (item) => Number(item.quantitySold) || (item.lastSoldAt ? 1 : 0);

// Newest first, with unknowns last; the same for any "latest" date.
const latest = (a, b) => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
};
// An ended listing's "newest" is when it ended.
const listedAt = (item, status) => time(status === 'inactive' ? item.endTime || item.startTime : item.startTime);

const COMPARE = {
  newest: (a, b, s) => latest(listedAt(a, s), listedAt(b, s)),
  edited: (a, b, s) => latest(time(a.lastEditedAt), time(b.lastEditedAt)) || COMPARE.newest(a, b, s),
  best_selling: (a, b, s) => sold(b) - sold(a) || latest(time(a.lastSoldAt), time(b.lastSoldAt)) || COMPARE.newest(a, b, s),
  last_sold: (a, b, s) => latest(time(a.lastSoldAt), time(b.lastSoldAt)) || sold(b) - sold(a) || COMPARE.newest(a, b, s),
  // Never sold first, the longest-listed at the top: the ones to fix or end.
  not_selling: (a, b, s) => {
    const ta = listedAt(a, s);
    const tb = listedAt(b, s);
    const oldest = ta === tb ? 0 : ta === null ? 1 : tb === null ? -1 : ta - tb;
    return sold(a) - sold(b) || oldest;
  },
  low_stock: (a, b, s) => (Number(a.quantityAvailable) || 0) - (Number(b.quantityAvailable) || 0) || sold(b) - sold(a) || COMPARE.newest(a, b, s),
  price_high: (a, b) => latest(price(a), price(b)),
  price_low: (a, b) => {
    const pa = price(a);
    const pb = price(b);
    if (pa === pb) return 0;
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa - pb;
  },
};

function sortFor(sort, status) {
  const allowed = status === 'inactive' ? INACTIVE_SORTS : SORTS;
  return allowed.includes(sort) ? sort : DEFAULT_SORT;
}

/** A new array in the chosen order; ties fall back to the item number, so paging is stable. */
function sortListings(items, sort, status = 'active') {
  const key = sortFor(sort, status);
  const compare = COMPARE[key];
  return [...items].sort((a, b) => compare(a, b, status) || String(b.itemId).localeCompare(String(a.itemId)));
}

module.exports = { SORTS, INACTIVE_SORTS, DEFAULT_SORT, sortFor, sortListings };
