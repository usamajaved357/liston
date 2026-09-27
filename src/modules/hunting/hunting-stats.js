// A hunter's and a reviewer's figures. Pure: hunted products, activity
// rows and orders in, figures out.
//
// A hunter's results are counted by when the product was hunted, so a
// week's "20 hunted: 12 approved, 5 rejected, 3 waiting" adds up. A
// reviewer's decisions are counted by when they made them. Sales are the
// orders placed in the period for listings made from hunted products,
// whenever those were hunted.

const { stageOf, REJECT_REASONS } = require('./hunt-rules');

const DECISIONS = ['hunt.approved', 'hunt.rejected', 'hunt.sent_back'];
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

/** Products hunted in a period, by where each stands now. */
function hunterFigures(hunts) {
  const f = { hunted: hunts.length, approved: 0, rejected: 0, sentBack: 0, waiting: 0, drafted: 0, listed: 0, approvalRate: null };
  for (const hunt of hunts) {
    const stage = stageOf(hunt);
    if (stage === 'pending') f.waiting += 1;
    else if (stage === 'sent_back') f.sentBack += 1;
    else if (stage === 'rejected') f.rejected += 1;
    else {
      f.approved += 1;
      if (stage === 'drafted' || stage === 'listed') f.drafted += 1;
      if (stage === 'listed') f.listed += 1;
    }
  }
  const decided = f.approved + f.rejected;
  f.approvalRate = decided ? Math.round((f.approved / decided) * 100) : null;
  return f;
}

/**
 * A reviewer's decisions in a period (their activity rows: { kind,
 * subject_id }), each product once per kind, and how long products waited
 * for them (`decided`: products they last decided in the period, with
 * submitted_at and decided_at; an owner's own finds, approved as added,
 * aren't reviews).
 */
function reviewerFigures(rows, decided = []) {
  const distinct = (kinds) => new Set(rows.filter((r) => kinds.includes(r.kind)).map((r) => r.subject_id)).size;
  const hours = decided
    .filter((h) => h.decided_at && h.submitted_at && h.reviewer_user_id !== h.hunter_user_id)
    .map((h) => (new Date(h.decided_at).getTime() - new Date(h.submitted_at).getTime()) / 3600000)
    .filter((n) => n >= 0);
  return {
    reviewed: distinct(DECISIONS),
    approved: distinct(['hunt.approved']),
    rejected: distinct(['hunt.rejected']),
    sentBack: distinct(['hunt.sent_back']),
    avgHoursToDecide: hours.length ? round1(hours.reduce((a, b) => a + b, 0) / hours.length) : null,
  };
}

/** Why products were rejected, most common first (only reasons used). */
function reasonCounts(hunts) {
  const counts = new Map();
  for (const hunt of hunts) if (stageOf(hunt) === 'rejected' && hunt.reject_reason) counts.set(hunt.reject_reason, (counts.get(hunt.reject_reason) || 0) + 1);
  return REJECT_REASONS.filter((r) => counts.has(r.key))
    .map((r) => ({ key: r.key, label: r.label, count: counts.get(r.key) }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Orders (the mirror's order data) added up per eBay item: itemId -> {
 * orders, units, sales, currency, lastAt }. Sales are price × units, postage
 * apart, as the Overview's best sellers count them; cancelled orders don't
 * count.
 */
function salesByItem(orders, { isCancelled = () => false } = {}) {
  const byItem = new Map();
  for (const order of orders || []) {
    if (isCancelled(order)) continue;
    const counted = new Set();
    for (const line of order.lineItems || []) {
      if (!line.itemId) continue;
      const id = String(line.itemId);
      const units = Number(line.quantityPurchased) || 1;
      const entry = byItem.get(id) || { orders: 0, units: 0, sales: 0, currency: line.price?.currency || order.total?.currency || null, lastAt: null };
      entry.units += units;
      entry.sales = round2(entry.sales + (Number(line.price?.amount) || 0) * units);
      if (!counted.has(id)) {
        counted.add(id);
        entry.orders += 1;
      }
      if (!entry.lastAt || new Date(order.createdAt) > new Date(entry.lastAt)) entry.lastAt = order.createdAt || entry.lastAt;
      byItem.set(id, entry);
    }
  }
  return byItem;
}

/** One product's (or a set of products') sales from the per-item totals, per currency. */
function salesFor(itemIds, byItem) {
  const byCurrency = new Map();
  for (const id of itemIds || []) {
    const entry = byItem.get(String(id));
    if (!entry) continue;
    const key = entry.currency || '';
    const total = byCurrency.get(key) || { currency: entry.currency, orders: 0, units: 0, sales: 0, lastAt: null };
    total.orders += entry.orders;
    total.units += entry.units;
    total.sales = round2(total.sales + entry.sales);
    if (entry.lastAt && (!total.lastAt || new Date(entry.lastAt) > new Date(total.lastAt))) total.lastAt = entry.lastAt;
    byCurrency.set(key, total);
  }
  return [...byCurrency.values()].sort((a, b) => b.sales - a.sales);
}

module.exports = { hunterFigures, reviewerFigures, reasonCounts, salesByItem, salesFor, DECISIONS };
