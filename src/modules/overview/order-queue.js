// The order queue for an account's Overview: how many of the orders in the
// chosen dates are in each state, the way the Orders page's tabs count them
// (orders the team archived are left out).

const STATES = ['awaiting_payment', 'awaiting_dispatch', 'dispatched', 'delivered', 'cancelled'];

/**
 * { all, awaiting_payment, awaiting_dispatch, dispatched, delivered,
 * cancelled } for `orders`; `stateOf(order)` names an order's state.
 */
function countQueue(orders, stateOf, archivedOrderIds = []) {
  const archived = new Set(archivedOrderIds.map(String));
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  let all = 0;
  for (const order of orders) {
    if (archived.has(String(order.orderId))) continue;
    all += 1;
    const state = stateOf(order);
    if (state in counts) counts[state] += 1;
  }
  return { all, ...counts };
}

module.exports = { countQueue, STATES };
