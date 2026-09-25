// Amounts in different currencies are never added together: an account
// selling on eBay UK and eBay Australia takes pounds and Australian dollars.

/** [{ amount, currency }] summed per currency, largest first, to the penny. */
function sumByCurrency(amounts) {
  const totals = new Map();
  for (const money of amounts) {
    if (!money || !Number.isFinite(Number(money.amount)) || !money.currency) continue;
    totals.set(money.currency, (totals.get(money.currency) || 0) + Number(money.amount));
  }
  return [...totals]
    .map(([currency, amount]) => ({ amount: Math.round(amount * 100) / 100, currency }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Splits amounts into the one in `main` currency (0 when there's none) and
 * the rest, each summed: { main: { amount, currency }, others: [...] }.
 */
function splitByCurrency(amounts, main) {
  const totals = sumByCurrency(amounts);
  return {
    main: totals.find((t) => t.currency === main) || { amount: 0, currency: main },
    others: totals.filter((t) => t.currency !== main),
  };
}

module.exports = { sumByCurrency, splitByCurrency };
