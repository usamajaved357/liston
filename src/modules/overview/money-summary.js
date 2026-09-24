// One account's money for a date range, the way the order page counts it:
//
//   sales        what buyers paid (each order's total), cancelled orders out
//   fees         everything eBay took, ad fees included (Finances API)
//   adFees       the promoted-listing part of those fees
//   refunds      money returned to buyers
//   earnings     what reached the seller: sales − fees − refunds (eBay's figure)
//   sourceCost   what the supplier orders cost (the order page's Source section)
//   profit       earnings − source cost
//
// eBay posts an order's money a little after the sale, so the newest orders
// may have no earnings yet; they're counted apart (`awaitingEbay`) rather
// than as zero. Profit only covers orders eBay has figures for, and says how
// many of them have a source cost entered (`withCost`), since a missing cost
// makes profit look better than it is. All in the account's own currency.

const round = (n) => Math.round(n * 100) / 100;
const marginOf = (profit, sales) => (sales > 0 ? Math.round((profit / sales) * 1000) / 10 : null);

/**
 * @param orders      the account's orders in the range (mirror shape)
 * @param finances    Map orderId -> { gross, fees, adFees, refunds, earnings }
 * @param costs       Map orderId -> { value, currency }
 * @param isCancelled (order) => boolean
 */
function summarise(orders, finances, costs, { currency, isCancelled = () => false } = {}) {
  const totals = { sales: 0, fees: 0, adFees: 0, refunds: 0, earnings: 0, sourceCost: 0, profit: 0, settledSales: 0 };
  let placed = 0;
  let cancelled = 0;
  let withEarnings = 0;
  let withCost = 0;
  let awaitingEbay = 0;

  for (const order of orders) {
    const off = isCancelled(order);
    if (off) cancelled += 1;
    else {
      placed += 1;
      totals.sales += Number(order.total?.amount || 0);
    }
    const money = finances.get(order.orderId);
    const cost = costs.get(order.orderId);
    if (cost && (!cost.currency || cost.currency === currency)) totals.sourceCost += cost.value;
    if (!money) {
      if (!off) awaitingEbay += 1;
      continue;
    }
    withEarnings += 1;
    if (!off) totals.settledSales += Number(order.total?.amount || 0);
    totals.fees += money.fees;
    totals.adFees += money.adFees;
    totals.refunds += money.refunds;
    totals.earnings += money.earnings;
    const orderCost = cost && (!cost.currency || cost.currency === currency) ? cost.value : 0;
    if (cost) withCost += 1;
    totals.profit += money.earnings - orderCost;
  }

  const out = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, round(v)]));
  return {
    currency,
    ...out,
    orders: placed,
    cancelled,
    withEarnings,
    withCost,
    awaitingEbay,
    // Profit as a share of what the orders it covers sold for.
    margin: marginOf(out.profit, out.settledSales),
  };
}

/** Several accounts' summaries in one currency, added up. */
function addUp(summaries, currency) {
  const keys = ['sales', 'fees', 'adFees', 'refunds', 'earnings', 'sourceCost', 'profit', 'settledSales', 'orders', 'cancelled', 'withEarnings', 'withCost', 'awaitingEbay'];
  const total = Object.fromEntries(keys.map((k) => [k, round(summaries.reduce((sum, s) => sum + (s?.[k] || 0), 0))]));
  return { currency, ...total, margin: marginOf(total.profit, total.settledSales) };
}

module.exports = { summarise, addUp };
