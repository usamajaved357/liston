// The facts the Inbox's details panel adds about a conversation's listing
// and order, all from what Liston already keeps (no eBay call): the
// listing's state, watchers, when it was listed, its sales and views over
// the last 30 days, its supplier and item specifics; the order's postage,
// where it's going and the supplier order behind it. Pure.

const SUPPLIER_STATUS = { to_order: 'To order', ordered: 'Ordered', shipped: 'Shipped', delivered: 'Delivered', problem: 'Problem' };
// Item specifics that tell a buyer nothing.
const EMPTY_VALUES = new Set(['does not apply', 'n/a', 'na', 'none', 'unknown', '-']);
const SPECIFICS_MAX = 30;
const DAYS = 30;

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Units of the item sold in these orders (cancelled ones out), and in how many orders. */
function soldFrom(orders, itemId, isCancelled = () => false) {
  let units = 0;
  let count = 0;
  for (const o of orders) {
    if (isCancelled(o)) continue;
    const lines = (o.lineItems || []).filter((l) => String(l.itemId) === String(itemId));
    if (!lines.length) continue;
    count += 1;
    units += lines.reduce((sum, l) => sum + (num(l.quantityPurchased) || 1), 0);
  }
  return { units, orders: count };
}

/** An item's specifics as [{ name, value }], empty ones ("Does not apply") left out. */
function specificsFrom(specifics) {
  if (!specifics || typeof specifics !== 'object') return [];
  return Object.entries(specifics)
    .map(([name, values]) => ({ name, value: (Array.isArray(values) ? values : [values]).map((v) => String(v ?? '').trim()).filter((v) => v && !EMPTY_VALUES.has(v.toLowerCase())).join(', ') }))
    .filter((s) => s.value)
    .slice(0, SPECIFICS_MAX);
}

/**
 * What the panel says about the listing. `snapshot` { item, live } from the
 * account's kept listings (null when it's in neither), `traffic` { views,
 * impressions, days } summed over the last 30 days (days: 0 when none are
 * stored), `sold` from soldFrom, `summary` the item's kept summary (for
 * its specifics), `supplierUrl` from the draft or hunted product it came
 * from. Listings access sees the listing's own facts; Analytics access its
 * views and conversion too.
 */
function listingInsights({ snapshot = null, traffic = null, sold = null, summary = null, supplierUrl = null, canListings = false, canAnalytics = false }) {
  if (!canListings) return null;
  const item = snapshot?.item || {};
  const views = canAnalytics && traffic && traffic.days > 0 ? num(traffic.views) || 0 : null;
  const units = sold ? sold.units : null;
  return {
    live: snapshot ? Boolean(snapshot.live) : null,
    watchers: num(item.watchCount),
    listedAt: item.startTime || null,
    endedAt: snapshot && !snapshot.live ? item.endTime || null : null,
    days: DAYS,
    sold: units,
    views,
    impressions: canAnalytics && traffic && traffic.days > 0 ? num(traffic.impressions) || 0 : null,
    conversion: views && units !== null ? Math.round((units / views) * 1000) / 10 : null,
    supplierUrl: supplierUrl || null,
    specifics: specificsFrom(summary?.specifics),
  };
}

/** The supplier orders behind an eBay order's lines, without the buying account's login. */
function supplierOrders(rows = []) {
  return rows.map((r) => ({
    status: r.status,
    statusLabel: SUPPLIER_STATUS[r.status] || r.status,
    orderNo: r.source_order_no || null,
    tracking: r.tracking_number || null,
    carrier: r.carrier || null,
    placedAt: r.placed_at ? new Date(r.placed_at).toISOString() : null,
    placedBy: r.placed_by ? r.placed_by_name || (r.placed_by_email ? String(r.placed_by_email).split('@')[0] : null) : null,
  }));
}

/** Where an order is going, in a line: the town and postcode, and the country when it isn't the site's own. */
function shipTo(address, marketplace) {
  if (!address) return null;
  const country = address.country || address.countryCode || null;
  const home = marketplace && country && [marketplace.country, marketplace.countryName].map((c) => String(c).toLowerCase()).includes(String(country).toLowerCase());
  const place = [String(address.city || '').trim(), String(address.postalCode || '').trim().toUpperCase()].filter(Boolean);
  if (country && !home) place.push(String(country));
  return place.length ? place.join(', ') : null;
}

module.exports = { SUPPLIER_STATUS, DAYS, soldFrom, specificsFrom, listingInsights, supplierOrders, shipTo };
