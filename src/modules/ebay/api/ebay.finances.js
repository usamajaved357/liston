// eBay's Finances API (REST): the money side of an order the way Seller
// Hub's order page shows it — each fee eBay took (final value fee, ad fee…)
// and whether the funds are still processing, available, or paid out.
// Needs the sell.finances scope on the seller's token (see ebay.oauth) and,
// for UK/EU sellers, a digital signature on every call (see ebay.signature).
const { request } = require('./ebay.client');
const ebayOauth = require('./ebay.oauth');

function baseUrl() {
  return ebayOauth.isSandbox() ? 'https://apiz.sandbox.ebay.com' : 'https://apiz.ebay.com';
}

function call(accessToken, method, path, body, marketplaceId, signingKey) {
  return request(accessToken, method, `/sell/finances/v1${path}`, body, marketplaceId, { baseUrl: baseUrl(), signingKey });
}

// Every transaction eBay recorded against an order: the SALE, and any
// refund, dispute or credit that followed.
function getOrderTransactions(accessToken, orderId, marketplaceId, signingKey) {
  return call(accessToken, 'GET', `/transaction?filter=orderId:%7B${encodeURIComponent(orderId)}%7D&limit=50`, undefined, marketplaceId, signingKey);
}

// Seller Hub's names for eBay's fee types. Anything unlisted is shown under
// eBay's own code, humanised.
const FEE_LABELS = {
  FINAL_VALUE_FEE: 'Transaction fees',
  FINAL_VALUE_FEE_FIXED_PER_ORDER: 'Transaction fees',
  FINAL_VALUE_SHIPPING_FEE: 'Transaction fees',
  REGULATORY_OPERATING_FEE: 'Regulatory operating fee',
  AD_FEE: 'Ad fee general',
  AD_FEE_PROMOTED_LISTINGS_ADVANCED: 'Ad fee advanced',
  INTERNATIONAL_FEE: 'International fee',
  INSERTION_FEE: 'Insertion fee',
  DEPOSIT_PROCESSING_FEE: 'Deposit processing fee',
  BELOW_STANDARD_FEE: 'Below standard fee',
  HIGH_ITEM_NOT_AS_DESCRIBED_FEE: 'Very high "not as described" fee',
  PAYMENT_DISPUTE_FEE: 'Payment dispute fee',
};

// Seller Hub lists the fees in this order; anything else after them.
const FEE_ORDER = ['Transaction fees', 'Regulatory operating fee', 'Ad fee general', 'Ad fee advanced', 'International fee'];
const feeRank = (label) => (FEE_ORDER.includes(label) ? FEE_ORDER.indexOf(label) : FEE_ORDER.length);

function humanise(code) {
  return String(code || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

// Seller Hub's "Funds status" line from the sale's transactionStatus.
const FUNDS_STATUS = {
  FUNDS_PROCESSING: 'Pending',
  FUNDS_ON_HOLD: 'On hold',
  FUNDS_AVAILABLE_FOR_PAYOUT: 'Available',
  PAYOUT: 'Paid out',
  COMPLETED: 'Paid out',
};

// { fundsStatus, fundsStatusCode, payoutId, fees: [{ code, label, amount }],
//   totalFees, gross, earnings } for an order, or null when eBay recorded no
// sale against it yet (payment still settling).
//
// Confirmed against live orders: a SALE's `amount` is what reaches the
// seller — already net of the fees listed on it — and `totalFeeBasisAmount`
// is the order total those fees were worked out on (Seller Hub's "Order
// total"). Promoted-listing ad fees are not on the sale: eBay charges them
// as a separate NON_SALE_CHARGE (feeType AD_FEE) against the same order, and
// Seller Hub takes them off the earnings too.
function mapOrderEarnings(response) {
  const transactions = response?.transactions || [];
  const sales = transactions.filter((t) => t.transactionType === 'SALE');
  if (!sales.length) return null;
  const currency = sales[0].amount?.currency || sales[0].totalFeeAmount?.currency || null;
  const byLabel = new Map();
  let totalFees = 0;
  let gross = 0;
  const addFee = (code, amountNode, sign = 1) => {
    const label = FEE_LABELS[code] || humanise(code);
    const value = sign * Number(amountNode?.value || 0);
    if (!value) return;
    totalFees += value;
    const entry = byLabel.get(label) || { code, label, amount: { value: 0, currency: amountNode?.currency || currency } };
    entry.amount.value = Math.round((entry.amount.value + value) * 100) / 100;
    byLabel.set(label, entry);
  };
  for (const sale of sales) {
    let saleFees = 0;
    for (const line of sale.orderLineItems || []) {
      for (const fee of line.marketplaceFees || []) {
        addFee(fee.feeType, fee.amount);
        saleFees += Number(fee.amount?.value || 0);
      }
    }
    const fees = sale.totalFeeAmount ? Number(sale.totalFeeAmount.value || 0) : saleFees;
    const net = Number(sale.amount?.value || 0);
    gross += sale.totalFeeBasisAmount ? Number(sale.totalFeeBasisAmount.value || 0) : net + fees;
  }
  // Fees charged apart from the sale (ad fees), and any credited back.
  for (const t of transactions) {
    if (t.transactionType !== 'NON_SALE_CHARGE' || !t.feeType) continue;
    addFee(t.feeType, t.amount, t.bookingEntry === 'CREDIT' ? -1 : 1);
  }
  const status = sales[0].transactionStatus || null;
  const round = (n) => Math.round(n * 100) / 100;
  return {
    fundsStatus: FUNDS_STATUS[status] || humanise(status),
    fundsStatusCode: status,
    payoutId: sales[0].payoutId || null,
    fees: [...byLabel.values()].filter((f) => f.amount.value !== 0).sort((a, b) => feeRank(a.label) - feeRank(b.label)),
    totalFees: { value: round(totalFees), currency },
    gross: { value: round(gross), currency },
    earnings: { value: round(gross - totalFees), currency },
  };
}

// One page of every transaction booked in a date window (sales, refunds,
// the ad fees charged apart from them…), up to 1,000 at a time: 90 days of
// a busy account is a few calls, where the order page's read is one per
// order. `from`/`to` are ISO times.
function getTransactions(accessToken, { from, to, offset = 0, limit = 1000 }, marketplaceId, signingKey) {
  const filter = encodeURIComponent(`transactionDate:[${from}..${to}]`);
  return call(accessToken, 'GET', `/transaction?filter=${filter}&limit=${limit}&offset=${offset}`, undefined, marketplaceId, signingKey);
}

const money = (node) => Number(node?.value || 0);

/**
 * Each order's money from a batch of transactions (any order, any type):
 * [{ orderId, currency, gross, fees, adFees, refunds, earnings, fundsStatus,
 * saleDate }]. The sale side is exactly what the order page shows
 * (mapOrderEarnings); refunds to the buyer come off the earnings as well.
 * Orders with no SALE yet (payment still settling) are left out.
 */
// The order a transaction belongs to. A sale or refund says so directly; an
// ad fee (NON_SALE_CHARGE) only names it among its references.
function orderIdOf(t) {
  return t.orderId || (t.references || []).find((r) => r.referenceType === 'ORDER_ID')?.referenceId || null;
}

function orderFinancesFrom(transactions = []) {
  const byOrder = new Map();
  for (const t of transactions) {
    const orderId = orderIdOf(t);
    if (!orderId) continue;
    byOrder.set(orderId, [...(byOrder.get(orderId) || []), t]);
  }
  const round = (n) => Math.round(n * 100) / 100;
  const rows = [];
  for (const [orderId, list] of byOrder) {
    const sale = mapOrderEarnings({ transactions: list });
    if (!sale) continue;
    const refunds = list
      .filter((t) => t.transactionType === 'REFUND')
      .reduce((sum, t) => sum + (t.bookingEntry === 'CREDIT' ? -1 : 1) * Math.abs(money(t.amount)), 0);
    const adFees = sale.fees.filter((f) => /^AD_FEE/.test(f.code)).reduce((sum, f) => sum + f.amount.value, 0);
    const saleDate = list.filter((t) => t.transactionType === 'SALE').map((t) => t.transactionDate).filter(Boolean).sort()[0] || null;
    rows.push({
      orderId,
      currency: sale.gross.currency,
      gross: sale.gross.value,
      fees: sale.totalFees.value,
      adFees: round(adFees),
      refunds: round(refunds),
      earnings: round(sale.earnings.value - refunds),
      fundsStatus: sale.fundsStatus,
      saleDate,
    });
  }
  return rows;
}

// What eBay charges an account apart from its orders (NON_SALE_CHARGE:
// "listing and listing upgrade fees, eBay store or other subscription fees,
// and ad fees"), grouped the way the Overview shows them: the eBay Store
// (shop) subscription on its own; other subscriptions (Terapeak Pro, eBay
// Plus…) with the rest. Taxes eBay withholds and charity donations aren't
// eBay's fees, so they're left out.
const STORE_FEES = new Set(['EBAY_STORE_SUBSCRIPTION_FEE', 'STORE_SUBSCRIPTION_EARLY_TERMINATION_FEE']);
const LISTING_FEES = new Set([
  'INSERTION_FEE',
  'VEHICLE_LOCAL_INSERTION_FEE',
  'BOLD_FEE',
  'SUBTITLE_FEE',
  'GALLERY_FEE',
  'GALLERY_PLUS_FEE',
  'FEATURED_GALLERY_FEE',
  'CATEGORY_FEATURED_FEE',
  'LARGE_PICTURE_FEE',
  'IPIXPHOTO_FEE',
  'RESERVE_PRICE_FEE',
  'BUY_IT_NOW_FEE',
  'PRIVATE_LISTING_FEE',
  'INTERNATIONAL_LISTING_FEE',
  'AUCTION_END_EARLY_FEE',
  'VALUE_PACK_BUNDLE_FEE',
  'PRO_PACK_BUNDLE_FEE',
  'PRO_PACK_PLUS_BUNDLE_FEE',
  'VEHICLES_BASIC_PACKAGE_FEE',
  'VEHICLES_PLUS_PACKAGE_FEE',
  'VEHICLES_PREMIUM_PACKAGE_FEE',
]);
const NOT_FEES = new Set(['TAX_DEDUCTION_AT_SOURCE', 'INCOME_TAX_WITHHOLDING', 'VAT_WITHHOLDING', 'CHARITY_DONATION']);

// eBay UK books its shop subscription as OTHER_FEES, not
// EBAY_STORE_SUBSCRIPTION_FEE, its memo the period it pays for
// ("2026-08-31 - 2026-09-29", £32.40 on the 1st, seen live Sept 2026). A
// charge for a period, on no listing, is the shop's whatever its type.
const BILLING_PERIOD = /^\s*\d{4}-\d{2}-\d{2}\s*-\s*\d{4}-\d{2}-\d{2}\s*$/;

/**
 * 'ads' | 'store' | 'listing' | 'other' for an account charge, or null when
 * it isn't a fee. `memo` and `itemId` tell the shop subscription eBay files
 * under another type.
 */
function chargeKind(feeType, { memo = null, itemId = null } = {}) {
  const code = String(feeType || '').toUpperCase();
  if (NOT_FEES.has(code)) return null;
  if (/^AD_FEE/.test(code) || code === 'PREMIUM_AD_FEES') return 'ads';
  if (STORE_FEES.has(code)) return 'store';
  if (LISTING_FEES.has(code)) return 'listing';
  if (!itemId && BILLING_PERIOD.test(memo || '')) return 'store';
  return 'other';
}

/**
 * The charges in a batch of transactions that name no order: [{
 * transactionId, kind, feeType, amount (a credit back is negative),
 * currency, itemId, memo, chargedAt }]. A charge against an order (an ad
 * fee on a sale) belongs to that order's money instead (orderFinancesFrom).
 * A fee credited as its own CREDIT transaction counts against the charges.
 */
function accountChargesFrom(transactions = []) {
  const rows = [];
  for (const t of transactions) {
    const charge = t.transactionType === 'NON_SALE_CHARGE';
    if (!charge && !(t.transactionType === 'CREDIT' && t.feeType)) continue;
    if (orderIdOf(t)) continue;
    const itemId = (t.references || []).find((r) => r.referenceType === 'ITEM_ID')?.referenceId || null;
    const memo = t.transactionMemo || null;
    const kind = chargeKind(t.feeType, { memo, itemId });
    const value = Math.abs(money(t.amount));
    if (!kind || !value || !t.transactionDate) continue;
    const credit = t.bookingEntry === 'CREDIT' || !charge;
    rows.push({
      transactionId: t.transactionId || `${t.transactionType}:${t.feeType || ''}:${t.transactionDate}:${value}`,
      kind,
      feeType: t.feeType || null,
      amount: Math.round((credit ? -value : value) * 100) / 100,
      currency: t.amount?.currency || null,
      itemId,
      memo,
      chargedAt: t.transactionDate,
    });
  }
  return rows;
}

module.exports = { getOrderTransactions, getTransactions, orderFinancesFrom, accountChargesFrom, chargeKind, orderIdOf, mapOrderEarnings, baseUrl };
