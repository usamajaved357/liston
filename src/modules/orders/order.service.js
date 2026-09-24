// One eBay order, in full, with what Liston knows on top: which supplier
// order was placed for each line, by whom, and the timeline of both.
const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const listingRepository = require('../listings/listing.repository');
const orderRepository = require('./order.repository');
const { CARRIERS, detectCarrier } = require('./carriers');
const { SELLER_CANCEL_REASONS } = require('../ebay/api/ebay.postorder');
const logger = require('../../utils/logger');

class OrderError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sourcingView(row) {
  if (!row) return null;
  return {
    id: row.id,
    lineItemId: row.line_item_id,
    status: row.status,
    sourcePlatform: row.source_platform,
    sourceAccountId: row.source_account_id,
    sourceAccountLabel: row.source_account_label || null,
    sourceAccountEmail: row.source_account_email || null,
    sourceEmail: row.source_email || null,
    sourcePassword: row.source_password || null,
    sourceOrderNo: row.source_order_no,
    placedAt: row.placed_at,
    placedBy: row.placed_by ? { id: row.placed_by, name: row.placed_by_name || row.placed_by_email || null } : null,
    cardLabel: row.card_label,
    cost: row.cost_value !== null && row.cost_value !== undefined ? { value: Number(row.cost_value), currency: row.cost_currency } : null,
    trackingNumber: row.tracking_number,
    carrier: row.carrier,
    notes: row.notes,
    dispatchedAt: row.dispatched_at,
    dispatchedBy: row.dispatched_by ? { id: row.dispatched_by, name: row.dispatched_by_name || null } : null,
    ebayFulfillmentId: row.ebay_fulfillment_id,
    updatedAt: row.updated_at,
  };
}

function eventView(row) {
  return {
    id: row.id,
    kind: row.kind,
    lineItemId: row.line_item_id,
    detail: row.detail || {},
    actor: row.actor_user_id ? { id: row.actor_user_id, name: row.actor_name || row.actor_email || null } : null,
    at: row.created_at,
  };
}

// eBay's own milestones, as timeline entries, so one list tells the story.
function ebayEvents(order) {
  const out = [];
  if (order.createdAt) out.push({ id: `ebay-created`, kind: 'ebay.ordered', at: order.createdAt, detail: {}, actor: null });
  for (const p of order.payments || []) if (p.date) out.push({ id: `ebay-paid-${p.date}`, kind: 'ebay.paid', at: p.date, detail: { amount: p.amount }, actor: null });
  for (const f of order.fulfillments || []) if (f.shippedDate) out.push({ id: `ebay-shipped-${f.fulfillmentId || f.shippedDate}`, kind: 'ebay.dispatched', at: f.shippedDate, detail: { carrier: f.carrier, trackingNumber: f.trackingNumber }, actor: null });
  for (const r of order.refunds || []) if (r.date) out.push({ id: `ebay-refund-${r.referenceId || r.date}`, kind: 'ebay.refunded', at: r.date, detail: { amount: r.amount, status: r.status }, actor: null });
  for (const c of order.cancelRequests || []) if (c.requestedAt) out.push({ id: `ebay-cancel-${c.id}`, kind: 'ebay.cancel_requested', at: c.requestedAt, detail: { state: c.state, reason: c.reason, initiator: c.initiator }, actor: null });
  return out;
}

// Liston-published lines carry their own cost/ROI working; it's shown per
// line so the order's real margin is visible without opening the listing.
async function marginFor(connectionId, lineItems) {
  const itemIds = [...new Set(lineItems.map((li) => li.itemId).filter(Boolean))];
  const byItem = new Map();
  await Promise.all(
    itemIds.map(async (itemId) => {
      const row = await listingRepository.findPublishedByItemId(connectionId, itemId).catch(() => null);
      if (row) byItem.set(itemId, row);
    })
  );
  return lineItems.map((li) => {
    const row = li.itemId ? byItem.get(li.itemId) : null;
    if (!row) return li;
    const draft = row.generated_data || {};
    const variant = Array.isArray(draft.variants) ? draft.variants.find((v) => v.sku === li.sku) || draft.variants[0] : null;
    const breakdown = variant?.priceBreakdown || draft.priceBreakdown || null;
    return { ...li, listingId: row.id, priceBreakdown: breakdown };
  });
}

async function getOrder(connectionId, userId, orderId) {
  const detail = await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) =>
    ebayService.getOrderDetail(credentials, { connectionId, orderId })
  );
  const [sourcingRows, eventRows, archived] = await Promise.all([
    orderRepository.listSourcingForOrder(connectionId, orderId),
    orderRepository.listEvents(connectionId, orderId),
    orderRepository.findArchived(connectionId, orderId),
  ]);
  const sourcingByLine = new Map(sourcingRows.map((r) => [r.line_item_id, sourcingView(r)]));
  const lineItems = (await marginFor(connectionId, detail.order.lineItems)).map((li, index) => ({
    ...li,
    // Without Fulfillment ids (old token) lines are keyed by position so the
    // sourcing panel still works; ids take over after a reconnect.
    sourcingKey: li.lineItemId || `line-${index}`,
    sourcing: sourcingByLine.get(li.lineItemId || `line-${index}`) || null,
  }));
  const events = [...eventRows.map(eventView), ...ebayEvents(detail.order)].sort((a, b) => new Date(b.at) - new Date(a.at));
  return {
    order: { ...detail.order, lineItems, archived: Boolean(archived) },
    actionsEnabled: detail.actionsEnabled,
    source: detail.source,
    events,
    carriers: CARRIERS.map((c) => ({ code: c.code, label: c.label })),
    cancelReasons: Object.entries(SELLER_CANCEL_REASONS).map(([code, label]) => ({ code, label })),
    refundReasons: Object.entries(REFUND_REASONS).map(([code, label]) => ({ code, label })),
  };
}

// --- order actions (Seller Hub's "More actions") ------------------------------

// The order as eBay's Fulfillment API holds it, for actions that need the
// line item ids or the legacy order id.
async function fulfillmentOrder(connectionId, userId, orderId) {
  const detail = await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) => ebayService.getOrderDetail(credentials, { connectionId, orderId }));
  if (detail.source !== 'fulfillment') throw new OrderError('Reconnect this eBay account (one click from Connections) to act on orders from Liston.', 403);
  return detail.order;
}

// Marks the order's undispatched lines dispatched on eBay — with a tracking
// number ("Add tracking number") or without ("Mark as dispatched"). Lines
// with a sourcing row get the number recorded there too, so the Source
// section and the eBay state agree.
async function dispatchOrder(connectionId, userId, actorId, orderId, { trackingNumber, carrier, lineItemIds }) {
  const order = await fulfillmentOrder(connectionId, userId, orderId);
  const tracking = String(trackingNumber || '').replace(/\s+/g, '') || null;
  const wanted = order.lineItems.filter((li) => li.lineItemId && (!lineItemIds?.length || lineItemIds.includes(li.lineItemId)));
  let lines = wanted.filter((li) => li.fulfillmentStatus !== 'FULFILLED');
  // Editing the tracking of a dispatched order: eBay takes a further
  // fulfillment for the same items and shows the buyer the latest number.
  if (!lines.length && tracking) lines = wanted;
  if (!lines.length) throw new OrderError('Every item on this order is already dispatched.', 400);
  const carrierCode = tracking ? carrier || detectCarrier(tracking) || 'Other' : undefined;
  const shippedDate = new Date().toISOString();
  const result = await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) =>
    ebayService.dispatchOrder(credentials, {
      connectionId,
      orderId,
      lineItems: lines.map((li) => ({ lineItemId: li.lineItemId, quantity: li.quantity })),
      carrier: carrierCode,
      trackingNumber: tracking || undefined,
      shippedDate,
    })
  );
  for (const li of lines) {
    await orderRepository.upsertSourcing({
      connectionId,
      orderId,
      lineItemId: li.lineItemId,
      dispatched_at: shippedDate,
      dispatched_by: actorId,
      ebay_fulfillment_id: result.fulfillmentId,
      status: 'shipped',
      ...(tracking ? { tracking_number: tracking, carrier: carrierCode } : {}),
    });
  }
  await orderRepository.addEvent({
    connectionId,
    orderId,
    kind: 'ebay.dispatched_by_liston',
    detail: { carrier: carrierCode || null, trackingNumber: tracking, fulfillmentId: result.fulfillmentId, lines: lines.length },
    actorUserId: actorId,
  });
  return { fulfillmentId: result.fulfillmentId, lines: lines.length };
}

// eBay's reasons for a refund, with Seller Hub's wording.
const REFUND_REASONS = {
  BUYER_CANCEL: 'Buyer cancelled',
  ITEM_NOT_RECEIVED: 'Item not received',
  ITEM_NOT_AS_DESCRIBED: 'Item not as described',
  OTHER_ADJUSTMENT: 'Other adjustment',
};

async function refundOrder(connectionId, userId, actorId, orderId, { amount, reason, comment }) {
  if (!REFUND_REASONS[reason]) throw new OrderError('Pick a refund reason.', 400);
  const order = await fulfillmentOrder(connectionId, userId, orderId);
  if (order.paymentStatus !== 'PAID' && order.paymentStatus !== 'PARTIALLY_REFUNDED') throw new OrderError("This order hasn't been paid, so there is nothing to refund.", 400);
  const total = order.pricing.total;
  const value = amount === undefined || amount === null || amount === '' ? null : Number(amount);
  if (value !== null && (!Number.isFinite(value) || value <= 0)) throw new OrderError('Enter a refund amount above zero.', 400);
  if (value !== null && total && value > total.value + 0.005) throw new OrderError(`The refund can't be more than the order total (${total.value.toFixed(2)} ${total.currency}).`, 400);
  const result = await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) =>
    ebayService.refundOrder(credentials, {
      connectionId,
      orderId,
      amount: value !== null && total ? { value: value.toFixed(2), currency: total.currency } : null,
      reason,
      comment: String(comment || '').trim().slice(0, 500) || undefined,
    })
  );
  const refunded = value !== null && total ? { value, currency: total.currency } : total;
  await orderRepository.addEvent({ connectionId, orderId, kind: 'ebay.refunded_by_liston', detail: { amount: refunded, reason, refundId: result.refundId, status: result.refundStatus }, actorUserId: actorId });
  return { refundId: result.refundId, status: result.refundStatus, amount: refunded };
}

async function cancelOrder(connectionId, userId, actorId, orderId, { reason }) {
  const order = await fulfillmentOrder(connectionId, userId, orderId);
  if (order.cancelState === 'CANCELED') throw new OrderError('This order is already cancelled.', 400);
  if (order.fulfillmentStatus === 'FULFILLED') throw new OrderError("This order has been dispatched, so it can't be cancelled. Refund the buyer instead.", 400);
  const pending = order.cancelRequests.find((r) => r.state === 'REQUESTED');
  if (!pending && !SELLER_CANCEL_REASONS[reason]) throw new OrderError('Pick a reason for cancelling.', 400);
  const paid = order.paymentStatus === 'PAID';
  const result = await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) =>
    ebayService.cancelOrder(credentials, {
      connectionId,
      orderId,
      legacyOrderId: order.legacyOrderId,
      reason,
      pendingCancelId: pending?.id || null,
      buyerPaid: paid,
      buyerPaidDate: paid ? order.payments[0]?.date || order.createdAt : null,
      refundAmount: paid ? order.pricing.total : null,
    })
  );
  await orderRepository.addEvent({
    connectionId,
    orderId,
    kind: result.approved ? 'ebay.cancel_approved_by_liston' : 'ebay.cancelled_by_liston',
    detail: { reason: pending?.reason || reason, cancelId: result.cancelId },
    actorUserId: actorId,
  });
  return result;
}

// eBay's reasons for declining a return request, with Seller Hub's wording.
const RETURN_DECLINE_REASONS = {
  ITEM_NOT_RECEIVED: "I haven't received the item back",
  ITEM_DAMAGED_BY_BUYER: 'The item was damaged by the buyer',
  RETURN_NOT_ELIGIBLE: "The item isn't eligible for return",
  OTHER: 'Other',
};

async function getOrderCases(connectionId, userId, orderId) {
  const order = await fulfillmentOrder(connectionId, userId, orderId).catch(() => null);
  const cases = await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) =>
    ebayService.getOrderCases(credentials, { orderId, legacyOrderId: order?.legacyOrderId })
  );
  return { returns: cases.returns, inquiries: cases.inquiries, disputes: cases.disputes, unavailable: cases.unavailable, returnDeclineReasons: Object.entries(RETURN_DECLINE_REASONS).map(([code, label]) => ({ code, label })) };
}

async function declineCancellation(connectionId, userId, actorId, orderId) {
  const order = await fulfillmentOrder(connectionId, userId, orderId);
  const pending = order.cancelRequests.find((r) => r.state === 'REQUESTED');
  if (!pending) throw new OrderError('There is no open cancellation request on this order.', 400);
  await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) => ebayService.declineCancellation(credentials, { connectionId, cancelId: pending.id }));
  await orderRepository.addEvent({ connectionId, orderId, kind: 'ebay.cancel_declined_by_liston', detail: { cancelId: pending.id, reason: pending.reason }, actorUserId: actorId });
  return { declined: true, cancelId: pending.id };
}

async function respondToReturn(connectionId, userId, actorId, orderId, { returnId, action, comment, declineReason, amount }) {
  if (!returnId) throw new OrderError('Which return?', 400);
  if (action === 'decline' && !RETURN_DECLINE_REASONS[declineReason]) throw new OrderError('Pick a reason for declining.', 400);
  if (action === 'message' && !String(comment || '').trim()) throw new OrderError('Write the message first.', 400);
  let refund = null;
  if (action === 'refund' && amount !== undefined && amount !== null && amount !== '') {
    const order = await fulfillmentOrder(connectionId, userId, orderId);
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw new OrderError('Enter a refund amount above zero.', 400);
    if (order.pricing.total && value > order.pricing.total.value + 0.005) throw new OrderError(`The refund can't be more than the order total (${order.pricing.total.value.toFixed(2)} ${order.pricing.total.currency}).`, 400);
    refund = { value: value.toFixed(2), currency: order.pricing.total?.currency || 'GBP' };
  }
  await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) =>
    ebayService.respondToReturn(credentials, { returnId, action, comment: String(comment || '').trim().slice(0, 1000) || undefined, declineReason, amount: refund })
  );
  await orderRepository.addEvent({ connectionId, orderId, kind: `ebay.return_${action}_by_liston`, detail: { returnId, declineReason: declineReason || null, amount: refund }, actorUserId: actorId });
  return { ok: true };
}

async function respondToInquiry(connectionId, userId, actorId, orderId, { inquiryId, action, carrier, trackingNumber, shippedDate, message }) {
  if (!inquiryId) throw new OrderError('Which inquiry?', 400);
  const tracking = String(trackingNumber || '').replace(/\s+/g, '');
  if (action === 'shipment' && !tracking) throw new OrderError('Enter the tracking number you sent it with.', 400);
  if (action === 'message' && !String(message || '').trim()) throw new OrderError('Write the message first.', 400);
  await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) =>
    ebayService.respondToInquiry(credentials, {
      inquiryId,
      action,
      carrier: action === 'shipment' ? carrier || detectCarrier(tracking) || 'Other' : undefined,
      trackingNumber: action === 'shipment' ? tracking : undefined,
      shippedDate,
      message: String(message || '').trim().slice(0, 1000) || undefined,
    })
  );
  await orderRepository.addEvent({ connectionId, orderId, kind: `ebay.inquiry_${action}_by_liston`, detail: { inquiryId, trackingNumber: tracking || null }, actorUserId: actorId });
  return { ok: true };
}

async function respondToDispute(connectionId, userId, actorId, orderId, { disputeId, action }) {
  if (!disputeId) throw new OrderError('Which dispute?', 400);
  await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) => ebayService.respondToDispute(credentials, { disputeId, action }));
  await orderRepository.addEvent({ connectionId, orderId, kind: `ebay.dispute_${action}_by_liston`, detail: { disputeId }, actorUserId: actorId });
  return { ok: true };
}

async function setArchived(connectionId, actorId, orderId, archived) {
  if (archived) await orderRepository.archiveOrder(connectionId, orderId, actorId);
  else await orderRepository.unarchiveOrder(connectionId, orderId);
  await orderRepository.addEvent({ connectionId, orderId, kind: archived ? 'archived' : 'unarchived', detail: {}, actorUserId: actorId });
  return { archived: Boolean(archived) };
}

async function archivedOrderIds(connectionId) {
  return orderRepository.listArchivedOrderIds(connectionId);
}

// --- sourcing --------------------------------------------------------------

const SOURCING_STATUSES = ['to_order', 'ordered', 'shipped', 'delivered', 'problem'];

// Saves the supplier-order details for one line. A tracking number that is
// new (or changed) also dispatches the line on eBay — that is the moment the
// team used to copy it into Seller Hub by hand.
async function saveSourcing(connectionId, userId, actorId, orderId, lineKey, input) {
  const existing = await orderRepository.findSourcing(connectionId, orderId, lineKey);
  const patch = {};
  if (input.status !== undefined) {
    if (!SOURCING_STATUSES.includes(input.status)) throw new OrderError('Unknown sourcing status', 400);
    patch.status = input.status;
  }
  for (const [from, to] of [
    ['sourceAccountId', 'source_account_id'],
    ['sourceEmail', 'source_email'],
    ['sourcePassword', 'source_password'],
    ['sourceOrderNo', 'source_order_no'],
    ['placedAt', 'placed_at'],
    ['cardLabel', 'card_label'],
    ['notes', 'notes'],
    ['carrier', 'carrier'],
    ['sourcePlatform', 'source_platform'],
  ]) {
    if (input[from] !== undefined) patch[to] = input[from] === '' ? null : input[from];
  }
  if (input.placedBy !== undefined) patch.placed_by = input.placedBy || null;
  if (input.cost !== undefined) {
    patch.cost_value = input.cost === null || input.cost.value === '' ? null : Number(input.cost.value);
    patch.cost_currency = input.cost?.currency || null;
  }
  const tracking = input.trackingNumber !== undefined ? String(input.trackingNumber || '').replace(/\s+/g, '') : undefined;
  if (tracking !== undefined) {
    patch.tracking_number = tracking || null;
    if (tracking && !patch.carrier && !existing?.carrier) patch.carrier = detectCarrier(tracking) || 'Other';
  }
  // A supplier order number means it has been placed; a tracking number
  // means it has shipped. The status follows unless the person set one.
  if (input.status === undefined) {
    if (tracking) patch.status = 'shipped';
    else if (patch.source_order_no && (!existing || existing.status === 'to_order')) patch.status = 'ordered';
  }
  if (patch.source_order_no && !existing?.placed_by && input.placedBy === undefined) patch.placed_by = actorId;
  if (patch.source_order_no && !existing?.placed_at && input.placedAt === undefined) patch.placed_at = new Date().toISOString().slice(0, 10);

  let row = await orderRepository.upsertSourcing({ connectionId, orderId, lineItemId: lineKey, ...patch });

  const placedNow = Boolean(patch.source_order_no && patch.source_order_no !== existing?.source_order_no);
  if (placedNow) {
    await orderRepository.addEvent({ connectionId, orderId, lineItemId: lineKey, kind: 'sourcing.ordered', detail: { sourceOrderNo: patch.source_order_no, sourceAccountId: row.source_account_id }, actorUserId: actorId });
  }

  // Dispatch on eBay when the tracking is new or different, and the line
  // has a Fulfillment id to dispatch by.
  let dispatch = null;
  const trackingChanged = tracking && tracking !== existing?.tracking_number;
  const wantsDispatch = input.dispatchOnEbay !== false;
  if (trackingChanged && wantsDispatch) {
    if (!lineKey || lineKey.startsWith('line-')) {
      dispatch = { ok: false, reason: 'Reconnect this eBay account to let Liston mark orders dispatched.' };
    } else {
      try {
        const result = await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) =>
          ebayService.dispatchOrder(credentials, {
            connectionId,
            orderId,
            lineItems: [{ lineItemId: lineKey, quantity: Number(input.quantity || 1) }],
            carrier: row.carrier || 'Other',
            trackingNumber: tracking,
            shippedDate: new Date().toISOString(),
          })
        );
        row = await orderRepository.upsertSourcing({ connectionId, orderId, lineItemId: lineKey, dispatched_at: new Date().toISOString(), dispatched_by: actorId, ebay_fulfillment_id: result.fulfillmentId, status: 'shipped' });
        await orderRepository.addEvent({ connectionId, orderId, lineItemId: lineKey, kind: 'ebay.dispatched_by_liston', detail: { carrier: row.carrier, trackingNumber: tracking, fulfillmentId: result.fulfillmentId }, actorUserId: actorId });
        dispatch = { ok: true, fulfillmentId: result.fulfillmentId };
      } catch (err) {
        logger.warn('Dispatch on eBay failed', { connectionId, orderId, lineKey, message: err.message, code: err.code });
        dispatch = { ok: false, reason: err.message, code: err.code || null };
      }
    }
  }

  // Other work on the supplier order (its status, cost, a tracking number
  // not sent to eBay) goes on the timeline too, and so on the person's
  // record — once per save, and not when placing or dispatching said it.
  const changed = {};
  if (patch.status && patch.status !== (existing?.status || 'to_order')) changed.status = { from: existing?.status || 'to_order', to: patch.status };
  if (patch.cost_value !== undefined && Number(patch.cost_value) !== Number(existing?.cost_value ?? NaN)) changed.cost = { value: patch.cost_value, currency: patch.cost_currency };
  if (tracking !== undefined && tracking !== (existing?.tracking_number || '')) changed.tracking = tracking || null;
  if (Object.keys(changed).length && !placedNow && !dispatch?.ok) {
    await orderRepository.addEvent({ connectionId, orderId, lineItemId: lineKey, kind: 'sourcing.updated', detail: changed, actorUserId: actorId });
  }

  const rows = await orderRepository.listSourcingForOrder(connectionId, orderId);
  const view = sourcingView(rows.find((r) => r.line_item_id === lineKey) || row);
  return { sourcing: view, dispatch };
}

async function addNote(connectionId, actorId, orderId, text) {
  const body = String(text || '').trim();
  if (!body) throw new OrderError('Write something first.', 400);
  const row = await orderRepository.addEvent({ connectionId, orderId, kind: 'note', detail: { text: body.slice(0, 2000) }, actorUserId: actorId });
  return eventView({ ...row, actor_name: null });
}

// --- source accounts --------------------------------------------------------

function accountView(row) {
  return {
    id: row.id,
    platform: row.platform,
    label: row.label,
    email: row.email,
    password: row.password || null,
    notes: row.notes || null,
    archived: Boolean(row.archived_at),
  };
}

async function listSourceAccounts(ownerId, opts) {
  return (await orderRepository.listSourceAccounts(ownerId, opts)).map(accountView);
}

async function createSourceAccount(ownerId, input) {
  return accountView(await orderRepository.createSourceAccount({ ownerId, ...input }));
}

async function updateSourceAccount(ownerId, id, patch) {
  const row = await orderRepository.updateSourceAccount(id, ownerId, patch);
  if (!row) throw new OrderError('Source account not found', 404);
  return accountView(row);
}

// Sourcing rows for many orders at once — the order list shows each row's
// supplier state without a call per order.
async function sourcingForOrders(connectionId, orderIds) {
  const rows = await orderRepository.listSourcingForOrders(connectionId, orderIds);
  const byOrder = {};
  for (const r of rows) (byOrder[r.order_id] ||= []).push(sourcingView(r));
  return byOrder;
}

module.exports = { OrderError, getOrder, saveSourcing, addNote, dispatchOrder, refundOrder, cancelOrder, setArchived, archivedOrderIds, listSourceAccounts, createSourceAccount, updateSourceAccount, sourcingForOrders, SOURCING_STATUSES, REFUND_REASONS, getOrderCases, declineCancellation, respondToReturn, respondToInquiry, respondToDispute, RETURN_DECLINE_REASONS };
