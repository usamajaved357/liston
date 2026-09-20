// eBay's Fulfillment API (REST): the order as eBay sees it after checkout —
// line items with the ids every order action needs, the buyer's delivery
// details and checkout note, payment/fulfillment state — plus the actions
// themselves: mark dispatched with tracking, refund. It has its own generous
// rate limit, unlike the rationed Trading API the order list is read with.
// Needs the sell.fulfillment scope on the seller's token (see ebay.oauth).
const { request } = require('./ebay.client');
const ebayOauth = require('./ebay.oauth');

// The Fulfillment API is served from apiz.ebay.com (eBay's docs give that
// host for every method); api.ebay.com answers too, but the documented one
// is used.
function baseUrl() {
  return ebayOauth.isSandbox() ? 'https://apiz.sandbox.ebay.com' : 'https://apiz.ebay.com';
}

function call(accessToken, method, path, body, marketplaceId, options = {}) {
  return request(accessToken, method, `/sell/fulfillment/v1${path}`, body, marketplaceId, { baseUrl: baseUrl(), ...options });
}

function getOrder(accessToken, orderId, marketplaceId) {
  return call(accessToken, 'GET', `/order/${encodeURIComponent(orderId)}?fieldGroups=TAX_BREAKDOWN`, undefined, marketplaceId);
}

function getShippingFulfillments(accessToken, orderId, marketplaceId) {
  return call(accessToken, 'GET', `/order/${encodeURIComponent(orderId)}/shipping_fulfillment`, undefined, marketplaceId);
}

// Marks line items dispatched. `lineItems` = [{ lineItemId, quantity }];
// omit tracking to mark dispatched without a number (eBay allows it, buyers
// see "dispatched" with no tracking). Returns { fulfillmentId }.
function createShippingFulfillment(accessToken, orderId, { lineItems, shippingCarrierCode, trackingNumber, shippedDate }, marketplaceId) {
  const body = {
    lineItems,
    ...(shippingCarrierCode ? { shippingCarrierCode } : {}),
    ...(trackingNumber ? { trackingNumber } : {}),
    ...(shippedDate ? { shippedDate } : {}),
  };
  return call(accessToken, 'POST', `/order/${encodeURIComponent(orderId)}/shipping_fulfillment`, body, marketplaceId);
}

// Refunds part or all of an order. eBay requires a digital signature on
// this call from UK/EU sellers, so it takes the connection's signing key
// (see ebay.signature). Returns { refundId, refundStatus }.
function issueRefund(accessToken, orderId, { reasonForRefund, comment, refundItems, orderLevelRefundAmount }, marketplaceId, signingKey) {
  const body = {
    reasonForRefund,
    ...(comment ? { comment } : {}),
    ...(refundItems?.length ? { refundItems } : {}),
    ...(orderLevelRefundAmount ? { orderLevelRefundAmount } : {}),
  };
  return call(accessToken, 'POST', `/order/${encodeURIComponent(orderId)}/issue_refund`, body, marketplaceId, { signingKey });
}

// --- shape the order detail page renders ---------------------------------

function amount(node) {
  if (!node || node.value === undefined) return null;
  return { value: Number(node.value), currency: node.currency };
}

function mapAddress(shipTo) {
  if (!shipTo) return null;
  const a = shipTo.contactAddress || {};
  return {
    name: shipTo.fullName || '',
    street1: a.addressLine1 || '',
    street2: a.addressLine2 || '',
    city: a.city || '',
    state: a.stateOrProvince || '',
    postalCode: a.postalCode || '',
    country: a.countryCode || '',
    phone: shipTo.primaryPhone?.phoneNumber || '',
    email: shipTo.email || '',
  };
}

function mapLineItem(li) {
  return {
    lineItemId: li.lineItemId,
    itemId: li.legacyItemId ? String(li.legacyItemId) : null,
    legacyVariationId: li.legacyVariationId ? String(li.legacyVariationId) : null,
    sku: li.sku || null,
    title: li.title || null,
    quantity: Number(li.quantity ?? 1),
    unitPrice: amount(li.lineItemCost),
    total: amount(li.total),
    deliveryCost: amount(li.deliveryCost?.shippingCost),
    variation: (li.variationAspects || []).map((v) => ({ name: v.name, value: v.value })),
    fulfillmentStatus: li.lineItemFulfillmentStatus || null,
    shipByDate: li.lineItemFulfillmentInstructions?.shipByDate || null,
    minEstimatedDelivery: li.lineItemFulfillmentInstructions?.minEstimatedDeliveryDate || null,
    maxEstimatedDelivery: li.lineItemFulfillmentInstructions?.maxEstimatedDeliveryDate || null,
    promotions: (li.appliedPromotions || []).map((p) => ({ description: p.description || null, discount: amount(p.discountAmount) })),
    refunds: (li.refunds || []).map((r) => ({ amount: amount(r.amount), date: r.refundDate, referenceId: r.refundReferenceId })),
    ebayCollectedTax: amount(li.ebayCollectAndRemitTaxes?.[0]?.amount),
  };
}

function mapOrder(o, fulfillments = []) {
  const instruction = (o.fulfillmentStartInstructions || [])[0] || {};
  const shipping = instruction.shippingStep || {};
  const payments = o.paymentSummary?.payments || [];
  const refunds = o.paymentSummary?.refunds || [];
  return {
    orderId: o.orderId,
    legacyOrderId: o.legacyOrderId || null,
    salesRecordReference: o.salesRecordReference || null,
    createdAt: o.creationDate,
    lastModified: o.lastModifiedDate,
    paymentStatus: o.orderPaymentStatus || null, // PAID, PENDING, FAILED, FULLY_REFUNDED, PARTIALLY_REFUNDED
    fulfillmentStatus: o.orderFulfillmentStatus || null, // NOT_STARTED, IN_PROGRESS, FULFILLED
    cancelState: o.cancelStatus?.cancelState || 'NONE_REQUESTED',
    cancelRequests: (o.cancelStatus?.cancelRequests || []).map((r) => ({
      id: r.cancelRequestId,
      state: r.cancelRequestState,
      reason: r.cancelReason,
      requestedAt: r.cancelRequestedDate,
      completedAt: r.cancelCompletedDate,
      initiator: r.cancelInitiator,
    })),
    buyer: {
      username: o.buyer?.username || null,
      taxIdentifier: o.buyer?.taxIdentifier?.taxpayerId || null,
    },
    buyerCheckoutNotes: o.buyerCheckoutNotes || null,
    shipTo: mapAddress(shipping.shipTo),
    shippingService: shipping.shippingServiceCode || null,
    shippingCarrier: shipping.shippingCarrierCode || null,
    ebayShipment: instruction.ebaySupportedFulfillment || false,
    estimatedDelivery: { min: instruction.minEstimatedDeliveryDate || null, max: instruction.maxEstimatedDeliveryDate || null },
    pricing: {
      subtotal: amount(o.pricingSummary?.priceSubtotal),
      discount: amount(o.pricingSummary?.priceDiscount),
      delivery: amount(o.pricingSummary?.deliveryCost),
      deliveryDiscount: amount(o.pricingSummary?.deliveryDiscount),
      tax: amount(o.pricingSummary?.tax),
      adjustment: amount(o.pricingSummary?.adjustment),
      total: amount(o.pricingSummary?.total),
    },
    payments: payments.map((p) => ({ method: p.paymentMethod, status: p.paymentStatus, amount: amount(p.amount), date: p.paymentDate, referenceId: (p.paymentReferenceId || [])[0]?.referenceId || null })),
    refunds: refunds.map((r) => ({ amount: amount(r.amount), date: r.refundDate, status: r.refundStatus, referenceId: r.refundReferenceId })),
    totalDueSeller: amount(o.paymentSummary?.totalDueSeller),
    totalMarketplaceFee: amount(o.totalMarketplaceFee),
    lineItems: (o.lineItems || []).map(mapLineItem),
    fulfillments: fulfillments.map((f) => ({
      fulfillmentId: f.fulfillmentId,
      carrier: f.shippingCarrierCode || null,
      trackingNumber: f.shipmentTrackingNumber || null,
      shippedDate: f.shippedDate || null,
      lineItems: (f.lineItems || []).map((li) => ({ lineItemId: li.lineItemId, quantity: Number(li.quantity ?? 1) })),
    })),
  };
}

module.exports = { getOrder, getShippingFulfillments, createShippingFulfillment, issueRefund, mapOrder, mapLineItem, baseUrl };
