// What one order made, the way the Overview counts an account's money
// (money-summary.js) and the order page's "What you earned" shows it:
//
//   gross      what the buyer paid, as eBay's finances post it
//   fees       eBay's fees on the order other than ads
//   adFees     the promoted-listing fee on it
//   refunds    money returned to the buyer
//   earnings   what reached the seller: gross − fees − ad fees − refunds
//   cost       the supplier cost entered on the order page (its own currency)
//   profit     earnings − cost, only when both are known in one currency
//   margin     profit ÷ gross, as a percentage
//
// `row` is the order's finances row (ebay_order_finances, or a fresh read in
// the same shape), `cost` { value, currency } from order_sourcing. Pure.

const round = (n) => Math.round(n * 100) / 100;

function orderMoney(row, cost, unavailable = null) {
  const currency = row?.currency || null;
  const usableCost = cost && Number.isFinite(Number(cost.value)) ? { value: round(Number(cost.value)), currency: cost.currency || null } : null;
  const sameCurrency = usableCost && row && (!usableCost.currency || usableCost.currency === currency);
  const profit = sameCurrency ? round(row.earnings - usableCost.value) : null;
  return {
    currency,
    gross: row ? round(row.gross) : null,
    fees: row ? round(row.fees - (row.adFees || 0)) : null,
    adFees: row ? round(row.adFees || 0) : null,
    refunds: row ? round(row.refunds || 0) : null,
    earnings: row ? round(row.earnings) : null,
    fundsStatus: row?.fundsStatus || null,
    cost: usableCost,
    profit,
    margin: profit !== null && row.gross > 0 ? Math.round((profit / row.gross) * 1000) / 10 : null,
    unavailable: row ? null : unavailable,
  };
}

module.exports = { orderMoney };
