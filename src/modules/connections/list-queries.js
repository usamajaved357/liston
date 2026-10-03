// What an account's Orders and Listings pages ask for, read from the query
// string the same way for the page and its CSV download, so a download is
// exactly what the page's filters show. Pure.

const { FILTERS: SUPPLIER_FILTERS } = require('../orders/order-supplier');

const ORDER_RANGES = ['7d', '30d', '90d'];
const ORDER_STATUSES = ['all', 'awaiting_payment', 'awaiting_dispatch', 'dispatched', 'marked', 'delivered', 'cancelled'];
const ORDER_PAGE_SIZES = [25, 50, 100, 200];

function ordersQuery(q = {}) {
  return {
    range: ORDER_RANGES.includes(q.range) ? q.range : '90d',
    status: ORDER_STATUSES.includes(q.status) ? q.status : 'all',
    perPage: ORDER_PAGE_SIZES.includes(Number(q.perPage)) ? Number(q.perPage) : 25,
    page: Math.max(1, parseInt(q.page, 10) || 1),
    search: typeof q.search === 'string' ? q.search.slice(0, 100) : '',
    archived: q.archived === '1' || q.archived === 'true',
    sort: typeof q.sort === 'string' ? q.sort : undefined,
    supplier: SUPPLIER_FILTERS.includes(q.supplier) ? q.supplier : 'any',
  };
}

function listingsQuery(q = {}) {
  return {
    status: q.status === 'inactive' ? 'inactive' : 'active',
    page: Math.max(1, parseInt(q.page, 10) || 1),
    // perPage=all puts everything on one page.
    perPage: q.perPage === 'all' ? 0 : Math.min(200, Math.max(1, parseInt(q.perPage, 10) || 25)),
    search: typeof q.q === 'string' ? q.q : '',
    sort: typeof q.sort === 'string' ? q.sort : undefined,
  };
}

/** Ticked rows (`ids=a,b,c`), when only those are wanted; null for everything the filters show. */
function selectedIds(q = {}) {
  if (typeof q.ids !== 'string' || !q.ids.trim()) return null;
  return [...new Set(q.ids.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 5000);
}

module.exports = { ordersQuery, listingsQuery, selectedIds, ORDER_STATUSES };
