// The message Liston sends a buyer once their order is delivered: the
// wording (the account's own, or this default), with the buyer's name and
// the item filled in, and which orders are due one. Pure.

const DELIVERED_DEFAULT =
  "Hi {buyer},\n\nYour order of {item} has been delivered. We hope you're happy with it!\n\n" +
  "If you have a moment, we'd be really grateful for your feedback on the item and our service: it helps a small shop like ours a lot.\n\n" +
  "If anything isn't right, please don't open a case: just reply to this message and we'll sort it out for you straight away.\n\nThank you!";

// A delivery older than this when the job first sees it is left alone (no thanks a week late).
const DELIVERED_WITHIN_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const clean = (s) => String(s || '').replace(/\s*\[[^[\]]*\]\s*$/, '').replace(/\s+/g, ' ').trim();

/** The buyer's first name as eBay gave it (shouting "JAVED" made "Javed"), else null. */
function firstName(order) {
  const first = clean(order?.shippingAddress?.name || order?.buyerName || '').split(' ')[0];
  if (!first) return null;
  return first === first.toUpperCase() || first === first.toLowerCase() ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : first;
}

/** The buyer's first name if eBay gave one, else their username. */
function buyerName(order) {
  return firstName(order) || order.buyerUserId || 'there';
}

/** The item as the buyer knows it: its title (cut to 80 characters), and "and more" for several. */
function itemName(order) {
  const lines = order.lineItems || [];
  const title = clean(lines[0]?.title || order.itemTitle || 'your item');
  const short = title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
  return lines.length > 1 ? `${short} and the rest of your order` : short;
}

/** The message with {buyer} and {item} filled in. */
function fill(template, order) {
  return String(template || DELIVERED_DEFAULT)
    .replace(/\{buyer\}/gi, buyerName(order))
    .replace(/\{item\}/gi, itemName(order))
    .slice(0, 2000);
}

/**
 * The delivered orders due a message: delivered after it was switched on
 * (`since`) and within the last few days, not cancelled, with a buyer and
 * an item to write about, and not already messaged (`done`: a Set of order ids).
 */
function dueOrders(orders, { since, done, now = Date.now(), isCancelled = () => false }) {
  const from = Math.max(since ? new Date(since).getTime() : now, now - DELIVERED_WITHIN_DAYS * DAY_MS);
  return orders.filter((o) => {
    if (!o.deliveredAt || done.has(o.orderId) || isCancelled(o)) return false;
    const at = new Date(o.deliveredAt).getTime();
    return at >= from && at <= now && Boolean(o.buyerUserId) && Boolean(o.lineItems?.[0]?.itemId);
  });
}

module.exports = { DELIVERED_DEFAULT, DELIVERED_WITHIN_DAYS, fill, dueOrders, buyerName, firstName, itemName };
