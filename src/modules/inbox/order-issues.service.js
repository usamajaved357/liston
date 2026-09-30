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
// from the orders Liston keeps.

const KIND = 'inbox:cases';
const FRESH_MS = 10 * 60 * 1000;
const running = new Map(); // connectionId -> the read running now

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
    list.push({ orderId: o.order_id, itemIds: o.item_ids || [], cancelRequested: ebayService.CANCEL_REQUESTED_STATUSES.has(o.cancel_status) });
    byBuyer.set(o.buyer, list);
  }
  const out = new Map();
  for (const c of theirs) {
    const issue = rules.issueFor({ otherParty: c.other_party, referenceId: c.reference_id }, { orders: byBuyer.get(String(c.other_party).toLowerCase()) || [], cases });
    if (issue) out.set(c.conversation_id, issue);
  }
  return out;
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
}

module.exports = { refresh, refreshStale, issuesFor, noteOrder, KIND };
