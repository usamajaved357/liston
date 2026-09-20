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

// Declines a cancellation the buyer requested (the item has already been
// sent, say). No money moves, so no signature.
function rejectCancellation(accessToken, cancelId, marketplaceId) {
  return call(accessToken, 'POST', `/cancellation/${encodeURIComponent(cancelId)}/reject`, {}, marketplaceId);
}

// --- returns ---------------------------------------------------------------

function searchReturns(accessToken, { orderId, states } = {}, marketplaceId) {
  const params = new URLSearchParams();
  if (orderId) params.set('order_id', orderId);
  if (states) params.set('return_state', states);
  params.set('limit', '50');
  return call(accessToken, 'GET', `/return/search?${params.toString()}`, undefined, marketplaceId);
}

function getReturn(accessToken, returnId, marketplaceId) {
  return call(accessToken, 'GET', `/return/${encodeURIComponent(returnId)}`, undefined, marketplaceId);
}

// The seller's answer to a return request. ACCEPT (buyer sends it back) or
// DECLINE (with a reason and a note); eBay's own "decide" call. The refund
// itself is a separate step once the item is back (issueReturnRefund).
function decideReturn(accessToken, returnId, { decision, comment, declineReason, rmaNumber }, marketplaceId, signingKey) {
  const body = {
    decision,
    ...(comment ? { comments: { content: comment } } : {}),
    ...(declineReason ? { declineReason } : {}),
    ...(rmaNumber ? { RMANumber: rmaNumber } : {}),
  };
  return call(accessToken, 'POST', `/return/${encodeURIComponent(returnId)}/decide`, body, marketplaceId, signingKey);
}

function markReturnReceived(accessToken, returnId, { comment } = {}, marketplaceId) {
  return call(accessToken, 'POST', `/return/${encodeURIComponent(returnId)}/mark_as_received`, comment ? { comments: { content: comment } } : {}, marketplaceId);
}

// Refunds the buyer for a return: the full amount, or a partial one.
function issueReturnRefund(accessToken, returnId, { amount, comment }, marketplaceId, signingKey) {
  const body = {
    ...(comment ? { comments: { content: comment } } : {}),
    ...(amount
      ? {
          refundDetail: {
            itemizedRefundDetail: [{ refundAmount: { value: String(amount.value), currency: amount.currency }, refundFeeType: 'PURCHASE_PRICE' }],
            totalAmount: { value: String(amount.value), currency: amount.currency },
          },
        }
      : {}),
  };
  return call(accessToken, 'POST', `/return/${encodeURIComponent(returnId)}/issue_refund`, body, marketplaceId, signingKey);
}

function sendReturnMessage(accessToken, returnId, content, marketplaceId) {
  return call(accessToken, 'POST', `/return/${encodeURIComponent(returnId)}/send_message`, { message: { content } }, marketplaceId);
}

// --- item-not-received inquiries --------------------------------------------

function searchInquiries(accessToken, { orderId } = {}, marketplaceId) {
  const params = new URLSearchParams();
  if (orderId) params.set('order_id', orderId);
  params.set('limit', '50');
  return call(accessToken, 'GET', `/inquiry/search?${params.toString()}`, undefined, marketplaceId);
}

function getInquiry(accessToken, inquiryId, marketplaceId) {
  return call(accessToken, 'GET', `/inquiry/${encodeURIComponent(inquiryId)}`, undefined, marketplaceId);
}

// "It was sent, here is the tracking" — the usual answer to an INR.
function provideInquiryShipmentInfo(accessToken, inquiryId, { carrier, trackingNumber, shippedDate, message }, marketplaceId) {
  const body = {
    shipmentInfo: {
      shippingCarrierName: carrier,
      trackingNumber,
      shippedWithTracking: Boolean(trackingNumber),
      ...(shippedDate ? { shippedDate: { value: shippedDate } } : {}),
    },
    ...(message ? { message } : {}),
  };
  return call(accessToken, 'POST', `/inquiry/${encodeURIComponent(inquiryId)}/provide_shipment_info`, body, marketplaceId);
}

function issueInquiryRefund(accessToken, inquiryId, { comment } = {}, marketplaceId, signingKey) {
  return call(accessToken, 'POST', `/inquiry/${encodeURIComponent(inquiryId)}/issue_refund`, comment ? { comments: { content: comment } } : {}, marketplaceId, signingKey);
}

function sendInquiryMessage(accessToken, inquiryId, content, marketplaceId) {
  return call(accessToken, 'POST', `/inquiry/${encodeURIComponent(inquiryId)}/send_message`, { message: content }, marketplaceId);
}

module.exports = {
  createCancellation,
  approveCancellation,
  rejectCancellation,
  searchReturns,
  getReturn,
  decideReturn,
  markReturnReceived,
  issueReturnRefund,
  sendReturnMessage,
  searchInquiries,
  getInquiry,
  provideInquiryShipmentInfo,
  issueInquiryRefund,
  sendInquiryMessage,
  SELLER_CANCEL_REASONS,
  baseUrl,
};
