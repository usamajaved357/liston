const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const mirrorRepository = require('../ebay/ebay-mirror.repository');
const inboxRepository = require('./inbox.repository');
const rules = require('./order-issues');
const logger = require('../../utils/logger');

// The open returns, item-not-received requests and payment disputes the
// Inbox marks buyer conversations with, and the cancellations buyers asked
// for. The cases are read from eBay for the whole account (three read-only
// calls) at most every ten minutes while someone has the Inbox open, and
// kept as a snapshot; an order whose cases are read on its own (its page,
// a conversation's details) updates it at once. Cancellation requests come
// from the orders Liston keeps. The Inbox's Cases view lists every buyer
// conversation with one (openCaseConversations), counted for its tab.

const KIND = 'inbox:cases';
const FRESH_MS = 10 * 60 * 1000;
const running = new Map(); // connectionId -> the read running now
// Each account's conversations with an open case, for the Cases view and its count (the list asks every minute).
const CASES_MS = 20 * 1000;
const casesCache = new Map(); // connectionId -> { at, found }
const forgetCases = (connectionId) => casesCache.delete(String(connectionId));
const lower = (v) => String(v || '').trim().toLowerCase();

async function refresh(connectionId, ownerId) {
  if (running.has(connectionId)) return running.get(connectionId);
  const run = (async () => {
    const before = await mirrorRepository.loadSnapshot(connectionId, KIND).catch(() => null);
    const kept = before?.value?.cases || [];
    try {
      const out = await connectionService.withDecryptedCredentials(connectionId, ownerId, (credentials) => ebayService.getOpenCases(credentials));
      // None readable just now: what was known stays, tried again in ten minutes.
      if (out.unavailable === 'error') await mirrorRepository.saveSnapshot(connectionId, KIND, { cases: kept }, { error: 'unreadable' });
      else await mirrorRepository.saveSnapshot(connectionId, KIND, { cases: out.cases }, out.unavailable ? { unavailable: out.unavailable } : {});
      forgetCases(connectionId);
    } catch (err) {
      logger.warn('Inbox: open cases not read from eBay', { connectionId, error: err.message });
      await mirrorRepository.saveSnapshot(connectionId, KIND, { cases: kept }, { error: err.message }).catch(() => {});
    }
  })().finally(() => running.delete(connectionId));
  running.set(connectionId, run);
  return run;
}

/** Reads again, in the background, the accounts whose cases are over ten minutes old. */
async function refreshStale(connectionIds, ownerId) {
  for (const id of connectionIds) {
    const snap = await mirrorRepository.loadSnapshot(id, KIND).catch(() => null);
    if (!snap || Date.now() - snap.syncedAt > FRESH_MS) refresh(id, ownerId).catch(() => {});
  }
}

/** Map(conversationId -> issue) for these conversations of one account (buyers' only). */
async function issuesFor(connectionId, conversations) {
  const theirs = conversations.filter((c) => c.type === 'FROM_MEMBERS' && c.other_party && c.reference_id);
  if (!theirs.length) return new Map();
  const [snap, orders] = await Promise.all([mirrorRepository.loadSnapshot(connectionId, KIND).catch(() => null), inboxRepository.orderFactsByBuyers(connectionId, theirs.map((c) => c.other_party))]);
  const cases = snap?.value?.cases || [];
  const byBuyer = new Map();
  for (const o of orders) {
    const list = byBuyer.get(o.buyer) || [];
    list.push({ orderId: o.order_id, itemIds: o.item_ids || [], cancelRequested: ebayService.CANCEL_REQUESTED_STATUSES.has(o.cancel_status), refunded: Boolean(o.refunded) });
    byBuyer.set(o.buyer, list);
  }
  const out = new Map();
  for (const c of theirs) {
    const issue = rules.issueFor({ otherParty: c.other_party, referenceId: c.reference_id }, { orders: byBuyer.get(String(c.other_party).toLowerCase()) || [], cases });
    if (issue) out.set(c.conversation_id, issue);
  }
  return out;
}

/**
 * Every buyer conversation on the account with an open return,
 * item-not-received request or payment dispute, or a cancellation the buyer
 * asked for: [{ row, issue }], from the kept cases and orders (never eBay).
 * The buyers named by a case (or by its order) are looked up, then each of
 * their conversations is judged as the list marks rows (issuesFor).
 */
async function openCaseConversations(connectionId) {
  const hit = casesCache.get(String(connectionId));
  if (hit && Date.now() - hit.at < CASES_MS) return hit.found;
  const snap = await mirrorRepository.loadSnapshot(connectionId, KIND).catch(() => null);
  const cases = snap?.value?.cases || [];
  const [fromOrders, cancelling] = await Promise.all([
    inboxRepository.buyersOfOrders(connectionId, cases.map((c) => c.orderId)),
    inboxRepository.cancelRequestBuyers(connectionId, [...ebayService.CANCEL_REQUESTED_STATUSES]),
  ]);
  const buyers = [...new Set([...cases.map((c) => lower(c.buyer)).filter(Boolean), ...fromOrders, ...cancelling])];
  const rows = buyers.length ? await inboxRepository.buyerConversations(connectionId, buyers) : [];
  const issues = rows.length ? await issuesFor(connectionId, rows) : new Map();
  const found = rows.filter((r) => issues.has(r.conversation_id)).map((r) => ({ row: r, issue: issues.get(r.conversation_id) }));
  casesCache.set(String(connectionId), { at: Date.now(), found });
  return found;
}

/** One order's cases as just read from eBay (`cases`: returns, inquiries, disputes as the order page has them): the snapshot follows. */
async function noteOrder(connectionId, { orderIds, buyer, itemIds, cases }) {
  const snap = await mirrorRepository.loadSnapshot(connectionId, KIND);
  if (!snap) return;
  const all = [
    ...(cases.returns || []).map((c) => ({ ...c, kind: 'return' })),
    ...(cases.inquiries || []).map((c) => ({ ...c, kind: 'inquiry' })),
    ...(cases.disputes || []).map((c) => ({ ...c, kind: 'dispute' })),
  ];
  await mirrorRepository.saveSnapshot(connectionId, KIND, { cases: rules.withOrderCases(snap.value?.cases, { orderIds, buyer, itemIds, cases: all }) }, snap.meta || {});
  forgetCases(connectionId);
}

module.exports = { refresh, refreshStale, issuesFor, noteOrder, openCaseConversations, forgetCases, KIND };
