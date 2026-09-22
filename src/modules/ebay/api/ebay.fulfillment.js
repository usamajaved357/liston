// eBay's Fulfillment API (REST): the order as eBay sees it after checkout —
// line items with the ids every order action needs, the buyer's delivery
// details and checkout note, payment/fulfillment state — plus the actions
// themselves: mark dispatched with tracking, refund. It has its own generous
// rate limit, unlike the rationed Trading API the order list is read with.
// Needs the sell.fulfillment scope on the seller's token (see ebay.oauth).
const { request } = require('./ebay.client');
const ebayOauth = require('./ebay.oauth');

// The Fulfillment API answers on api.ebay.com (apiz.ebay.com is the
// Finances API's host — confirmed live: the order route is 404 there).
function baseUrl() {
  return ebayOauth.isSandbox() ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
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

// --- payment disputes (chargebacks) ----------------------------------------

function getPaymentDisputeSummaries(accessToken, { orderId } = {}, marketplaceId) {
  const params = new URLSearchParams();
  if (orderId) params.set('order_id', orderId);
  params.set('limit', '50');
  return call(accessToken, 'GET', `/payment_dispute_summary?${params.toString()}`, undefined, marketplaceId);
}

function getPaymentDispute(accessToken, disputeId, marketplaceId) {
  return call(accessToken, 'GET', `/payment_dispute/${encodeURIComponent(disputeId)}`, undefined, marketplaceId);
}

// Accepts the dispute: the buyer keeps the money. `returnAddress` lets the
// seller ask for the item back.
function acceptPaymentDispute(accessToken, disputeId, { returnAddress } = {}, marketplaceId) {
  return call(accessToken, 'POST', `/payment_dispute/${encodeURIComponent(disputeId)}/accept`, returnAddress ? { returnAddress } : {}, marketplaceId);
}

// Contests it with the evidence already attached to the dispute; eBay
// requires the dispute's current revision number.
function contestPaymentDispute(accessToken, disputeId, { revision, returnAddress }, marketplaceId) {
  return call(accessToken, 'POST', `/payment_dispute/${encodeURIComponent(disputeId)}/contest`, { revision, ...(returnAddress ? { returnAddress } : {}) }, marketplaceId);
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

// --- the order list's shape ---------------------------------------------------

// The order list is read with Trading's GetOrders (ebay.trading mapOrder).
// A new order pushed by eBay is read here instead — one Fulfillment call,
// its own generous allowance, no Trading call — and put in the same shape,
// so it joins the list at once. The next routine Trading read replaces it.
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code) => {
  try {
    return code ? regionNames.of(code) : '';
  } catch {
    return code || '';
  }
};
const money = (node) => (node && node.value !== undefined ? { amount: Number(node.value), currency: node.currency } : null);
const CANCEL_STATUS = { NONE_REQUESTED: 'NotApplicable', IN_PROGRESS: 'CancelPending', CANCELED: 'CancelComplete' };

function toListOrder(o) {
  const shipTo = (o.fulfillmentStartInstructions || [])[0]?.shippingStep?.shipTo || null;
  const address = shipTo?.contactAddress || {};
  const lineItems = (o.lineItems || []).map((li) => {
    const quantity = Number(li.quantity ?? 1);
    const cost = money(li.lineItemCost); // the line's total; Trading gives the unit price
    const instructions = li.lineItemFulfillmentInstructions || {};
    return {
      itemId: li.legacyItemId ? String(li.legacyItemId) : null,
      title: li.title || null,
      quantityPurchased: quantity,
      price: cost ? { amount: Math.round((cost.amount / quantity) * 100) / 100, currency: cost.currency } : null,
      variation: (li.variationAspects || []).map((v) => ({ name: v.name, value: v.value })),
      trackingCarrier: null,
      trackingNumber: null,
      handleByTime: instructions.shipByDate || null,
      estimatedDeliveryMin: instructions.minEstimatedDeliveryDate || null,
      estimatedDeliveryMax: instructions.maxEstimatedDeliveryDate || null,
      shippingService: null,
    };
  });
  const cancelState = o.cancelStatus?.cancelState || 'NONE_REQUESTED';
  const paid = o.orderPaymentStatus === 'PAID' || o.orderPaymentStatus === 'PARTIALLY_REFUNDED';
  const registration = o.buyer?.buyerRegistrationAddress || {};
  const street = [address.addressLine1, address.addressLine2, address.city, address.postalCode].some(Boolean);
  return {
    orderId: o.orderId,
    status: cancelState === 'CANCELED' ? 'Cancelled' : paid ? 'Completed' : 'Active',
    createdAt: o.creationDate,
    total: money(o.pricingSummary?.total),
    subtotal: money(o.pricingSummary?.priceSubtotal),
    buyerName: registration.fullName || shipTo?.fullName || null,
    buyerUserId: o.buyer?.username || null,
    buyerEmail: registration.email || shipTo?.email || null,
    salesRecordNumber: o.salesRecordReference ? String(o.salesRecordReference) : null,
    shippingAddress: street
      ? {
          name: shipTo?.fullName || '',
          street1: address.addressLine1 || '',
          street2: address.addressLine2 || '',
          city: address.city || '',
          state: address.stateOrProvince || '',
          postalCode: address.postalCode || '',
          country: countryName(address.countryCode),
          phone: shipTo?.primaryPhone?.phoneNumber || '',
        }
      : null,
    itemTitle: lineItems[0]?.title || null,
    itemId: lineItems[0]?.itemId || null,
    itemCount: lineItems.length,
    checkoutStatus: paid ? 'Complete' : 'Incomplete',
    paidTime: o.paymentSummary?.payments?.[0]?.paymentDate || null,
    shippedTime: null,
    cancelStatus: CANCEL_STATUS[cancelState] || cancelState,
    dispatchByTime: lineItems.map((li) => li.handleByTime).filter(Boolean).sort()[0] || null,
    lineItems,
  };
}

module.exports = { toListOrder, getOrder, getShippingFulfillments, createShippingFulfillment, issueRefund, getPaymentDisputeSummaries, getPaymentDispute, acceptPaymentDispute, contestPaymentDispute, mapOrder, mapLineItem, baseUrl };
