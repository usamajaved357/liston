// Tracking eBay is still waiting for. eBay wants an order's tracking number
// by its dispatch-by time (late or missing tracking counts against the
// seller), so an order that's paid for and not cancelled or delivered, with
// no tracking on eBay or with Liston (marked dispatched without it counts as
// none), owes it: "soon" in its last 24 hours, "overdue" once that's passed,
// red on its row and its page and a filter of the Orders page's own. A
// month past the last delivery day eBay gave the buyer, when they can no
// longer open an item-not-received case, it stops counting: there's nothing
// left to add tracking for.

const HOUR_MS = 60 * 60 * 1000;
const SOON_MS = 24 * HOUR_MS;
const CASE_WINDOW_MS = 30 * 24 * HOUR_MS;

// The Orders page's filter: every order, only overdue, only due in the next 24 hours.
const FILTERS = ['any', 'overdue', 'soon'];

const time = (iso) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * { state: 'overdue' | 'soon', by } while tracking is owed, else null.
 * `dispatchBy`: eBay's dispatch-by time; `tracked`: a tracking number is on
 * eBay or with Liston; `open`: paid, not cancelled, not delivered;
 * `deliveryBy`: the last day eBay told the buyer it would arrive.
 */
function trackingDue({ dispatchBy, tracked, open, deliveryBy = null }, now = Date.now()) {
  const by = time(dispatchBy);
  if (!open || tracked || by === null) return null;
  if (now > (time(deliveryBy) ?? by) + CASE_WINDOW_MS) return null;
  if (by <= now) return { state: 'overdue', by: new Date(by).toISOString() };
  if (by - now <= SOON_MS) return { state: 'soon', by: new Date(by).toISOString() };
  return null;
}

const latest = (dates) => dates.filter(Boolean).sort().slice(-1)[0] || null;

/** An order on the Orders page (ebay.service listOrdersDetailed, its status and Liston's dispatch tagged on). */
function ofListOrder(order, now = Date.now()) {
  const lines = order.lineItems || [];
  return trackingDue(
    {
      dispatchBy: order.dispatchByTime,
      tracked: Boolean(order.markedDispatched?.tracked) || lines.some((li) => li.trackingNumber),
      open: order.derivedStatus === 'awaiting_dispatch' || order.derivedStatus === 'dispatched',
      deliveryBy: latest(lines.map((li) => li.estimatedDeliveryMax)),
    },
    now
  );
}

/** An order's own page (ebay.service getOrderDetail: eBay's Fulfillment shape, or the account's copy in it). */
function ofDetail(order, now = Date.now()) {
  const lines = order.lineItems || [];
  return trackingDue(
    {
      dispatchBy: lines.map((li) => li.shipByDate).filter(Boolean).sort()[0] || null,
      tracked: (order.fulfillments || []).some((f) => f.trackingNumber),
      open: ['PAID', 'PARTIALLY_REFUNDED'].includes(order.paymentStatus) && order.cancelState !== 'CANCELED' && !order.deliveredAt,
      deliveryBy: order.estimatedDelivery?.max || null,
    },
    now
  );
}

module.exports = { trackingDue, ofListOrder, ofDetail, FILTERS, SOON_MS, CASE_WINDOW_MS };
