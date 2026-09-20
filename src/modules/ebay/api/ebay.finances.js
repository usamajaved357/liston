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
//   totalFees, earnings } for an order, or null when eBay recorded no sale
// against it yet (payment still settling).
function mapOrderEarnings(response) {
  const sales = (response?.transactions || []).filter((t) => t.transactionType === 'SALE');
  if (!sales.length) return null;
  const currency = sales[0].amount?.currency || sales[0].totalFeeAmount?.currency || null;
  const byLabel = new Map();
  let totalFees = 0;
  let gross = 0;
  for (const sale of sales) {
    gross += Number(sale.amount?.value || 0);
    for (const line of sale.orderLineItems || []) {
      for (const fee of line.marketplaceFees || []) {
        const label = FEE_LABELS[fee.feeType] || humanise(fee.feeType);
        const value = Number(fee.amount?.value || 0);
        totalFees += value;
        const entry = byLabel.get(label) || { code: fee.feeType, label, amount: { value: 0, currency: fee.amount?.currency || currency } };
        entry.amount.value = Math.round((entry.amount.value + value) * 100) / 100;
        byLabel.set(label, entry);
      }
    }
  }
  const status = sales[0].transactionStatus || null;
  return {
    fundsStatus: FUNDS_STATUS[status] || humanise(status),
    fundsStatusCode: status,
    payoutId: sales[0].payoutId || null,
    fees: [...byLabel.values()],
    totalFees: { value: Math.round(totalFees * 100) / 100, currency },
    gross: { value: Math.round(gross * 100) / 100, currency },
    earnings: { value: Math.round((gross - totalFees) * 100) / 100, currency },
  };
}

module.exports = { getOrderTransactions, mapOrderEarnings, baseUrl };
