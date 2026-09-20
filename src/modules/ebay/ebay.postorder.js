// eBay's Post-Order API: order cancellations. A seller cancels an order
// they can't fulfil (out of stock, bad address, the buyer asked), or
// approves a cancellation the buyer requested; eBay refunds the buyer as
// part of it. Takes the same OAuth user token as the REST APIs, under the
// "IAF" scheme the Post-Order API insists on, with the sell.fulfillment
// scope, and — as money moves — eBay's digital signature (ebay.signature).
const { request } = require('./ebay.client');
const ebayOauth = require('./ebay.oauth');

function baseUrl() {
  return ebayOauth.isSandbox() ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
}

function call(accessToken, method, path, body, marketplaceId, signingKey) {
  return request(accessToken, method, `/post-order/v2${path}`, body, marketplaceId, {
    baseUrl: baseUrl(),
    authScheme: 'IAF',
    headers: { 'X-EBAY-C-MARKETPLACE-ID': marketplaceId },
    signingKey,
  });
}

// Why a seller may cancel, in eBay's vocabulary, with Seller Hub's wording.
const SELLER_CANCEL_REASONS = {
  OUT_OF_STOCK_OR_CANNOT_FULFILL: "I'm out of stock or can't fulfil the order",
  BUYER_ASKED_CANCEL: 'The buyer asked to cancel',
  ADDRESS_ISSUES: "There's a problem with the buyer's address",
};

// Seller-initiated cancellation of a paid order; eBay refunds the buyer in
// full. Returns { cancelId }.
function createCancellation(accessToken, { legacyOrderId, cancelReason, buyerPaid, buyerPaidDate, refundAmount }, marketplaceId, signingKey) {
  const body = {
    legacyOrderId,
    cancelReason,
    buyerPaid: Boolean(buyerPaid),
    ...(buyerPaid && buyerPaidDate ? { buyerPaidDate } : {}),
    ...(buyerPaid && refundAmount ? { requestRefundAmount: { currency: refundAmount.currency, value: String(refundAmount.value) } } : {}),
  };
  return call(accessToken, 'POST', '/cancellation', body, marketplaceId, signingKey);
}

// Approves a cancellation the buyer requested; eBay refunds them.
function approveCancellation(accessToken, cancelId, marketplaceId, signingKey) {
  return call(accessToken, 'POST', `/cancellation/${encodeURIComponent(cancelId)}/approve`, {}, marketplaceId, signingKey);
}

module.exports = { createCancellation, approveCancellation, SELLER_CANCEL_REASONS, baseUrl };
