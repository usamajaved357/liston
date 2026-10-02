// The messages Liston sends a buyer by itself: a welcome once they place an
// order, and a thank-you once it's delivered. The wording (the account's
// own, or these defaults), with the buyer's name, the item, the order
// number and the store filled in, and which orders are due one. Pure.

const PLACED_DEFAULT =
  "Hi {buyer},\n\nThank you so much for your order of {item}! We've received it and we're getting it ready now, so it'll be on its way to you soon.\n\n" +
  "If anything about it isn't quite right when it arrives, please reply to this message first. We read every message and sort things out quickly, so there's no need to open a case with eBay.\n\n" +
  'We really appreciate your business and hope you love it!\n\nBest regards,\n{store}';

const DELIVERED_DEFAULT =
  "Hi {buyer},\n\nYour order of {item} has been delivered. We hope you're happy with it!\n\n" +
  "If you have a moment, we'd be really grateful for your feedback on the item and our service: it helps a small shop like ours a lot.\n\n" +
  "If anything isn't right, please don't open a case: just reply to this message and we'll sort it out for you straight away.\n\nBest regards,\n{store}";

const DEFAULTS = { placed: PLACED_DEFAULT, delivered: DELIVERED_DEFAULT };
const KINDS = Object.keys(DEFAULTS);
const TOKENS = ['buyer', 'item', 'order', 'store'];

// An order older than this when it's first seen gets no welcome (it's on its way by then).
const PLACED_WITHIN_HOURS = 24;
// A delivery older than this when the job first sees it is left alone (no thanks a week late).
const DELIVERED_WITHIN_DAYS = 3;
// One welcome a day per buyer: a second order within this is noted, not messaged.
const BUYER_GAP_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

/** The option the buyer chose ("Colour: Black, Size: M"), from the line or the "[…]" eBay adds to its title. */
function optionOf(line) {
  const named = (line?.variation || []).filter((v) => v?.name && v?.value).map((v) => `${v.name}: ${v.value}`);
  if (named.length) return named.join(', ');
  const tail = /\[([^[\]]+)\]\s*$/.exec(String(line?.title || ''));
  return tail ? tail[1].trim() : '';
}

/** The item as the buyer knows it: its title (cut to 80 characters) and option, and "and more" for several. */
function itemName(order) {
  const lines = order.lineItems || [];
  const title = clean(lines[0]?.title || order.itemTitle || 'your item');
  const short = title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
  if (lines.length > 1) return `${short} and the rest of your order`;
  const option = optionOf(lines[0]);
  return option ? `${short} (${option})` : short;
}

/** The message with {buyer}, {item}, {order} and {store} filled in. */
function fill(template, order, { store = '', kind = 'delivered' } = {}) {
  return String(template || DEFAULTS[kind] || DELIVERED_DEFAULT)
    .replace(/\{buyer\}/gi, buyerName(order))
    .replace(/\{item\}/gi, itemName(order))
    .replace(/\{order\}/gi, order.orderId || '')
    .replace(/\{store\}/gi, store || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 2000);
}

/** Whether an order can be written about at all: a buyer, and an item to send the message on. */
const writable = (o) => Boolean(o.orderId) && Boolean(o.buyerUserId) && Boolean(o.lineItems?.[0]?.itemId);

/**
 * The new orders due a welcome: placed after it was switched on (`since`)
 * and within the last day, paid and not yet dispatched or cancelled
 * (`statusOf` gives 'awaiting_dispatch' for those), and not already
 * messaged (`done`: a Set of order ids).
 */
function placedDue(orders, { since, done, now = Date.now(), statusOf = () => 'awaiting_dispatch' }) {
  const from = Math.max(since ? new Date(since).getTime() : now, now - PLACED_WITHIN_HOURS * HOUR_MS);
  return orders.filter((o) => {
    if (!o.createdAt || done.has(o.orderId) || !writable(o)) return false;
    const at = new Date(o.createdAt).getTime();
    return at >= from && at <= now + 5 * 60 * 1000 && statusOf(o) === 'awaiting_dispatch';
  });
}

/**
 * The delivered orders due a message: delivered after it was switched on
 * (`since`) and within the last few days, not cancelled, with a buyer and
 * an item to write about, and not already messaged (`done`: a Set of order ids).
 */
function dueOrders(orders, { since, done, now = Date.now(), isCancelled = () => false }) {
  const from = Math.max(since ? new Date(since).getTime() : now, now - DELIVERED_WITHIN_DAYS * DAY_MS);
  return orders.filter((o) => {
    if (!o.deliveredAt || done.has(o.orderId) || isCancelled(o) || !writable(o)) return false;
    const at = new Date(o.deliveredAt).getTime();
    return at >= from && at <= now;
  });
}

module.exports = {
  PLACED_DEFAULT,
  DELIVERED_DEFAULT,
  DEFAULTS,
  KINDS,
  TOKENS,
  PLACED_WITHIN_HOURS,
  DELIVERED_WITHIN_DAYS,
  BUYER_GAP_HOURS,
  fill,
  placedDue,
  dueOrders,
  buyerName,
  firstName,
  itemName,
  optionOf,
};
