// The Orders page's orders, applied to every order in the range before it's
// paged (the mirror holds them all, so sorting never calls eBay). Awaiting
// dispatch defaults to the nearest dispatch deadline — the order they're
// worked in; every other tab to newest first.

const SORTS = ['newest', 'oldest', 'dispatch_soonest', 'total_high'];

const time = (iso) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};
const placed = (o) => time(o.paidTime || o.createdAt);
const total = (o) => {
  const n = Number(o.total?.amount ?? o.total?.value);
  return Number.isFinite(n) ? n : null;
};
// Ascending with unknowns last.
const asc = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b);
const desc = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a);

const COMPARE = {
  newest: (a, b) => desc(placed(a), placed(b)),
  oldest: (a, b) => asc(placed(a), placed(b)),
  dispatch_soonest: (a, b) => asc(time(a.dispatchByTime), time(b.dispatchByTime)) || asc(placed(a), placed(b)),
  total_high: (a, b) => desc(total(a), total(b)) || desc(placed(a), placed(b)),
};

function sortFor(sort, status) {
  if (SORTS.includes(sort)) return sort;
  return status === 'awaiting_dispatch' ? 'dispatch_soonest' : 'newest';
}

/** A new array in the chosen order; ties fall back to the order id, so paging is stable. */
function sortOrders(orders, sort, status) {
  const compare = COMPARE[sortFor(sort, status)];
  return [...orders].sort((a, b) => compare(a, b) || String(b.orderId).localeCompare(String(a.orderId)));
}

module.exports = { SORTS, sortFor, sortOrders };
