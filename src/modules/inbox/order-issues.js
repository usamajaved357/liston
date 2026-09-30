// What a buyer's conversation should be marked with: an open return,
// item-not-received request or payment dispute about its item from that
// buyer, or a cancellation they asked for that the seller hasn't answered.
// Pure: the account's open cases (from eBay, kept as a snapshot) and the
// buyer's orders (from what Liston keeps) come in.

const LABELS = { dispute: 'Payment dispute', inquiry: 'Item not received', return: 'Return open', cancel: 'Cancel requested' };
// The one to show when there are several: money held first, then the buyer's claims.
const RANK = { dispute: 0, inquiry: 1, return: 2, cancel: 3 };

const lower = (v) => String(v || '').trim().toLowerCase();

/**
 * `conv`: { otherParty, referenceId }; `orders`: that buyer's orders as
 * [{ orderId, itemIds, cancelRequested }]; `cases`: the account's open
 * cases [{ id, kind, orderId, buyer, itemId, respondBy }]. A case is this
 * conversation's when it's on one of the buyer's orders for the item, or
 * names the buyer and the item. { kind, label, respondBy, orderId } or null.
 */
function issueFor(conv, { orders = [], cases = [] } = {}) {
  const buyer = lower(conv.otherParty);
  const item = String(conv.referenceId || '');
  if (!buyer || !item) return null;
  const forItem = orders.filter((o) => (o.itemIds || []).map(String).includes(item));
  const orderIds = new Set(forItem.map((o) => String(o.orderId)));
  const found = cases
    .filter((c) => (c.orderId && orderIds.has(String(c.orderId))) || (c.buyer && lower(c.buyer) === buyer && c.itemId && String(c.itemId) === item))
    .map((c) => ({ kind: c.kind, respondBy: c.respondBy || null, orderId: c.orderId && orderIds.has(String(c.orderId)) ? String(c.orderId) : forItem[0]?.orderId || null }));
  const asked = forItem.find((o) => o.cancelRequested);
  if (asked) found.push({ kind: 'cancel', respondBy: null, orderId: String(asked.orderId) });
  if (!found.length) return null;
  found.sort((a, b) => RANK[a.kind] - RANK[b.kind] || String(a.respondBy || '9').localeCompare(String(b.respondBy || '9')));
  const top = found[0];
  return { kind: top.kind, label: LABELS[top.kind] || 'Case open', respondBy: top.respondBy, orderId: top.orderId };
}

/**
 * The snapshot after one order's cases were read afresh (the order page, or
 * a conversation's details): that order's old entries out, its open ones in.
 */
function withOrderCases(snapshot, { orderIds = [], buyer = null, itemIds = [], cases = [] }) {
  const ids = new Set(orderIds.filter(Boolean).map(String));
  const caseIds = new Set(cases.map((c) => String(c.id)));
  const items = new Set(itemIds.filter(Boolean).map(String));
  const kept = (snapshot || []).filter(
    (c) => !caseIds.has(String(c.id)) && !(c.orderId && ids.has(String(c.orderId))) && !(buyer && c.buyer && lower(c.buyer) === lower(buyer) && c.itemId && items.has(String(c.itemId)))
  );
  const fresh = cases
    .filter((c) => !c.closed)
    .map((c) => ({ id: String(c.id), kind: c.kind, orderId: orderIds[0] ? String(orderIds[0]) : null, buyer: buyer || null, itemId: c.itemId ? String(c.itemId) : [...items][0] || null, respondBy: c.respondBy || null }));
  return [...kept, ...fresh];
}

module.exports = { LABELS, issueFor, withOrderCases };
