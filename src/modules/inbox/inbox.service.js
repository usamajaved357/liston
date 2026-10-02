const connectionService = require('../connections/connection.service');
const connectionRepository = require('../connections/connection.repository');
const teamRepository = require('../team/team.repository');
const ebayService = require('../ebay/ebay.service');
const ebayOauth = require('../ebay/api/ebay.oauth');
const ebayMessage = require('../ebay/api/ebay.message');
const accountEvents = require('../ebay/account-events');
const referencesRepository = require('../references/references.repository');
const referencesService = require('../references/references.service');
const userEvents = require('../realtime/user-events');
const inboxRepository = require('./inbox.repository');
const rules = require('./inbox-rules');
const orderMessages = require('../orders/order-messages');
const orderIssues = require('./order-issues.service');
const marketplaces = require('../ebay/marketplaces');
const mirror = require('../ebay/ebay-mirror.repository');
const orderRepository = require('../orders/order.repository');
const threadFacts = require('./thread-facts');
const activityRepository = require('../team/activity.repository');
const notificationsService = require('../notifications/notifications.service');
const chatRepository = require('../chat/chat.repository');
const chatRules = require('../chat/chat-rules');
const logger = require('../../utils/logger');
const filesService = require('../files/files.service');
const eps = require('../ai-generation/image-pipeline/eps');

// The Inbox's eBay messages: every conversation an account has with buyers
// and with eBay, read from eBay's Message API into Liston (the first time
// all of them, the inbox and the archive; after that only what changed,
// from the newest down until nothing on a page is new; all again every few
// hours to catch what moved on eBay's own site), so the Inbox opens at once
// from what's kept and eBay is asked in the background. A conversation's
// messages are read when it's opened and something's new in it; opening one
// marks it read on eBay, as eBay's own Messages does. Beside each thread:
// the buyer's orders on the account (from the orders mirror), the listing
// it's about, and their other conversations. Reading is safe on a live
// account; nothing here sends anything to a buyer on its own.
//
// eBay pushes each new message (NEW_MESSAGE, ebay-push.js): the account's
// latest conversations are read at once and the pushed message kept, and a
// buyer's new message reaches the team's devices (everyone with the Inbox
// on that account; each person's eBay setting, quiet hours and "hide the
// text" respected; never while they're reading it). A buyer's conversation
// carries notes only the team sees; notes and replies are the person's work
// on record (member_activity), a reply with how long the buyer had waited.
// "Message buyer" starts a conversation from an order.

class InboxError extends Error {
  constructor(message, statusCode = 400, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.expose = true;
    if (code) this.code = code;
  }
}

const SCOPE = 'https://api.ebay.com/oauth/api_scope/commerce.message';
const FRESH_MS = 60 * 1000; // a list opened within this of the last read isn't read again
const FULL_EVERY_MS = 6 * 60 * 60 * 1000;
const PAGE = 50;
const FULL_PAGES = 40; // 2,000 conversations per type and folder at most
const QUICK_PAGES = 4;
const THREAD_PAGES = 10;
const syncing = new Map(); // connectionId -> the read running now
// A buyer's message newer than this when Liston first sees it isn't pushed to devices (an old one found late).
const TELL_WITHIN_MS = 24 * 60 * 60 * 1000;
// Pushed messages are gathered for a moment per account: a burst costs one read.
const PUSH_BATCH_MS = 1500;
const MAX_NOTE = 2000;

// ---- who may see what ---------------------------------------------------------------

/** The accounts whose eBay messages this person may read: [{ id, label }]. */
async function accountsFor(auth) {
  const all = (await connectionRepository.findAllByUser(auth.ownerId)).filter((c) => c.platform_key === 'ebay');
  const shape = (c) => ({ id: c.id, label: c.label, marketplaceId: c.settings?.ebay?.marketplaceId || 'EBAY_GB' });
  if (auth.role === 'owner') return all.map(shape);
  const ok = await Promise.all(all.map((c) => teamRepository.resolvePermission(auth.userId, c.id, 'inbox')));
  return all.filter((c, i) => ok[i]).map(shape);
}

async function requireAccount(auth, connectionId) {
  const accounts = await accountsFor(auth);
  const account = accounts.find((a) => a.id === connectionId);
  if (!account) throw new InboxError("You don't have access to this account's messages.", 403);
  return account;
}

// Who's told when an account's messages change: its owner and the members with Inbox there.
const viewersCache = new Map();
async function viewersOf(connectionId, ownerId) {
  const hit = viewersCache.get(connectionId);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.ids;
  const members = (await teamRepository.listMembers(ownerId)).filter((m) => !m.deactivated_at);
  const ok = await Promise.all(members.map((m) => teamRepository.resolvePermission(m.id, connectionId, 'inbox')));
  const ids = [String(ownerId), ...members.filter((m, i) => ok[i]).map((m) => String(m.id))];
  viewersCache.set(connectionId, { at: Date.now(), ids });
  return ids;
}

async function announce(connectionId, ownerId, detail = {}) {
  accountEvents.emitUpdated(connectionId, 'inbox');
  userEvents.emitMany(await viewersOf(connectionId, ownerId).catch(() => [String(ownerId)]), { type: 'inbox.updated', connectionId, ...detail });
}

// ---- eBay ---------------------------------------------------------------------------

/** Runs `fn` with a fresh token, the account's site and the seller's username. */
async function withEbay(connectionId, ownerId, fn) {
  const out = await connectionService.withDecryptedCredentials(connectionId, ownerId, async (credentials, connection) => {
    if (!ebayOauth.hasScope(credentials, SCOPE)) {
      throw new InboxError('Reconnect this eBay account so Liston can read and answer its messages (it was connected before messages were added).', 409, 'scope');
    }
    const { accessToken, credentials: fresh, credentialsChanged } = await ebayService.ensureValidAccessToken(credentials);
    let seller = connection.settings?.ebay?.username || null;
    if (!seller) {
      const found = await ebayService.identifySeller(fresh).catch(() => ({}));
      if (found.username) {
        seller = found.username;
        await connectionRepository.mergeEbaySettings(connectionId, { username: found.username, ...(found.userId ? { userId: found.userId } : {}) }).catch(() => {});
      }
    }
    const marketplaceId = connection.settings?.ebay?.marketplaceId || credentials.marketplaceId || 'EBAY_GB';
    const value = await fn({ accessToken, marketplaceId, seller });
    return { value, credentials: fresh, credentialsChanged };
  });
  return out.value;
}

function conversationRow(c, seller, status) {
  const m = c.latestMessage;
  return {
    conversationId: c.conversationId,
    type: c.type,
    status: c.status || status,
    title: c.title,
    referenceType: c.referenceType,
    referenceId: c.referenceId,
    otherParty: rules.otherPartyOf(c, seller),
    unreadCount: c.unreadCount,
    latestMessageId: m?.messageId || null,
    latestPreview: m ? rules.previewOf(m.body) : null,
    latestSubject: m?.subject || null,
    latestAt: m?.createdAt || c.createdAt || null,
    latestFromSeller: rules.fromSeller(m, seller),
    startedAt: c.createdAt || null,
  };
}

/**
 * Reads the account's conversations from eBay into Liston: all of them
 * (inbox and archive, both kinds) on the first read and every few hours,
 * else only what changed. One read per account at a time. { changed }.
 */
function sync(connectionId, ownerId, { full = false } = {}) {
  if (syncing.has(connectionId)) return syncing.get(connectionId);
  const run = (async () => {
    const state = await inboxRepository.syncState(connectionId);
    const whole = full || !state?.last_full_sync_at || Date.now() - new Date(state.last_full_sync_at).getTime() > FULL_EVERY_MS;
    // A buyer's new word since the last read (none on the first: that's the history, not news).
    const arrived = [];
    try {
      const changed = await withEbay(connectionId, ownerId, async ({ accessToken, marketplaceId, seller }) => {
        const ids = [];
        for (const type of ebayMessage.TYPES) {
          for (const status of whole ? ['ACTIVE', 'ARCHIVE'] : ['ACTIVE']) {
            let offset = 0;
            for (let page = 0; page < (whole ? FULL_PAGES : QUICK_PAGES); page += 1) {
              let found;
              try {
                found = await ebayMessage.getConversations(accessToken, { type, status, limit: PAGE, offset }, marketplaceId);
              } catch (err) {
                // The archive is a nice-to-have: eBay refusing it never stops the inbox being read.
                if (status !== 'ARCHIVE') throw err;
                logger.warn('Inbox: archive not read from eBay', { connectionId, type, error: err.message });
                break;
              }
              const { conversations, total } = found;
              if (!conversations.length) break;
              const known = await inboxRepository.latestIds(connectionId, conversations.map((c) => c.conversationId));
              const rows = conversations.map((c) => conversationRow(c, seller, status));
              const fresh = rows.filter((r) => {
                const k = known.get(r.conversationId);
                // eBay's unread count as Liston keeps it (read here stays read until the buyer writes again).
                return !k || k.latest_message_id !== r.latestMessageId || k.status !== r.status || k.unread_count !== rules.unreadAfterRead(r.unreadCount, r, k.read_at);
              });
              if (fresh.length) {
                await inboxRepository.upsertConversations(connectionId, fresh);
                ids.push(...fresh.map((r) => r.conversationId));
                if (state?.last_sync_at) arrived.push(...fresh.filter((r) => rules.isNewBuyerWord(r, known.get(r.conversationId), { within: TELL_WITHIN_MS })));
              }
              offset += conversations.length;
              if (offset >= total) break;
              // Newest first: a page with nothing new means the rest is as it was.
              if (!whole && !fresh.length) break;
            }
          }
        }
        return ids;
      });
      await inboxRepository.recordSync(connectionId, { full: whole });
      if (arrived.length) {
        tellTeam(connectionId, ownerId, arrived).catch((err) => logger.warn('Inbox: new messages not pushed', { connectionId, error: err.message }));
      }
      if (changed.length) await announce(connectionId, ownerId, { changed: changed.length });
      return { changed: changed.length, full: whole, arrived: arrived.length };
    } catch (err) {
      await inboxRepository.recordSync(connectionId, { error: err.message }).catch(() => {});
      // Whatever was read before it failed is shown.
      await announce(connectionId, ownerId, {}).catch(() => {});
      throw err;
    }
  })().finally(() => syncing.delete(connectionId));
  syncing.set(connectionId, run);
  return run;
}

// ---- eBay's push and the team's devices -------------------------------------------

const pushed = new Map(); // connectionId -> { ownerId, messages, timer }

/**
 * eBay pushed a new message to an account (NEW_MESSAGE): its latest
 * conversations are read (a read already running is waited for, then run
 * again, so the message is in it) and the message kept. Never throws.
 */
function onPushedMessage(connectionId, ownerId, message) {
  const key = String(connectionId);
  let batch = pushed.get(key);
  if (!batch) {
    batch = { ownerId, messages: [], timer: null };
    pushed.set(key, batch);
    batch.timer = setTimeout(() => flushPushed(key).catch(() => {}), PUSH_BATCH_MS);
    batch.timer.unref?.();
  }
  batch.messages.push(message);
}

async function flushPushed(key) {
  const batch = pushed.get(key);
  if (!batch) return null;
  pushed.delete(key);
  clearTimeout(batch.timer);
  try {
    if (syncing.has(key)) await syncing.get(key).catch(() => {});
    const out = await sync(key, batch.ownerId);
    const seller = (await connectionRepository.findByIdForUser(key, batch.ownerId))?.settings?.ebay?.username || null;
    for (const m of batch.messages) {
      await inboxRepository.keepPushed(key, m.conversationId, { ...m, fromSeller: rules.fromSeller(m, seller) }).catch(() => false);
    }
    return out;
  } catch (err) {
    logger.warn('Inbox: pushed message not read', { connectionId: key, error: err.message });
    return null;
  }
}

/** Test hook: read every gathered push now. */
async function _flushPushed() {
  return Promise.all([...pushed.keys()].map(flushPushed));
}

/**
 * A buyer's new messages, to the devices of everyone with the Inbox on the
 * account: each one's eBay setting (every account, chosen ones, none),
 * never while they're reading that conversation, kept for the bell but not
 * pushed in their quiet hours, the text hidden when they asked.
 */
async function tellTeam(connectionId, ownerId, arrived) {
  const [viewers, connection] = await Promise.all([viewersOf(connectionId, ownerId), connectionRepository.findByIdForUser(connectionId, ownerId)]);
  if (!viewers.length) return 0;
  const settings = new Map((await chatRepository.settingsForMany(viewers)).map((x) => [String(x.user_id), x]));
  const label = connection?.label || 'eBay';
  let told = 0;
  for (const r of arrived) {
    const buyer = r.otherParty || 'A buyer';
    for (const userId of viewers) {
      const s = settings.get(userId);
      if (!rules.wantsEbayPush(s, connectionId)) continue;
      if (userEvents.isViewing(userId, `ebay:${connectionId}:${r.conversationId}`)) continue;
      const title = `${label} · ${buyer}`;
      const body = s?.hide_text ? `New message from ${buyer}` : r.latestPreview || 'New message';
      await notificationsService.notifyGrouped({
        userId,
        ownerId,
        kind: 'inbox.message',
        title,
        body,
        url: `/accounts/${connectionId}/inbox?e=${connectionId}~${encodeURIComponent(r.conversationId)}`,
        subjectType: 'conversation',
        subjectId: `${connectionId}:${r.conversationId}`,
        detail: { connectionId, conversationId: r.conversationId, buyer: r.otherParty, account: label },
        push: chatRules.inQuietHours(s) ? null : { title, body, tag: `inbox-${connectionId}-${r.conversationId}` },
      });
      told += 1;
    }
  }
  return told;
}

// Accounts connected before eBay pushed messages: subscribed once (per server start) when their Inbox is read.
const pushChecked = new Set();
function ensurePush(connectionId, ownerId) {
  if (pushChecked.has(connectionId)) return;
  pushChecked.add(connectionId);
  const ebayPush = require('../ebay/ebay-push');
  if (!ebayPush.configured()) return;
  connectionRepository
    .findByIdForUser(connectionId, ownerId)
    .then((c) => {
      if (c && !c.settings?.ebay?.messagePush?.subscriptionId) ebayPush.subscribeInBackground(connectionId, ownerId);
    })
    .catch(() => {});
}

/** Reads the accounts again in the background when their copy is older than a minute. */
async function refreshStale(connectionIds, ownerId, { force = false } = {}) {
  const states = new Map((await inboxRepository.syncStates(connectionIds)).map((s) => [s.connection_id, s]));
  for (const id of connectionIds) {
    ensurePush(id, ownerId);
    const s = states.get(id);
    const last = s?.last_sync_at ? new Date(s.last_sync_at).getTime() : 0;
    const failedLately = s?.last_error_at && Date.now() - new Date(s.last_error_at).getTime() < FRESH_MS;
    if (force || (!failedLately && Date.now() - last > FRESH_MS)) {
      sync(id, ownerId).catch((err) => logger.warn('Inbox: messages not read from eBay', { connectionId: id, error: err.message }));
    }
  }
  return states;
}

// ---- lists --------------------------------------------------------------------------

async function imagesFor(connectionIds, itemIds) {
  const ids = [...new Set(itemIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const [listings, summaries] = await Promise.all([referencesRepository.listingsByItemIds(connectionIds, ids), referencesRepository.itemImages(ids)]);
  const out = new Map();
  for (const l of listings) {
    out.set(String(l.item.itemId), { image: l.item.imageUrl ? String(l.item.imageUrl).replace(/s-l\d+\./, 's-l225.') : null, title: l.item.title || null, price: l.item.price || null });
  }
  for (const [id, image] of summaries) if (!out.has(id)) out.set(id, { image, title: null, price: null });
  return out;
}

const personOf = (id, name, email) => (id ? { id, name: name || (email ? String(email).split('@')[0] : 'Someone') } : null);

function rowShape(r, accounts, items, issues = new Map()) {
  const item = r.reference_id ? items.get(String(r.reference_id)) : null;
  return {
    conversationId: r.conversation_id,
    account: (({ id, label }) => ({ id, label }))(accounts.get(r.connection_id) || { id: r.connection_id, label: null }),
    type: r.type,
    status: r.status,
    title: r.title || item?.title || null,
    otherParty: r.other_party,
    referenceId: r.reference_id,
    image: item?.image || null,
    unread: r.unread_count,
    latestPreview: r.latest_preview,
    latestSubject: r.latest_subject,
    latestAt: r.latest_at,
    latestFromSeller: r.latest_from_seller,
    waitingSince: rules.waitingSince(r),
    labels: r.labels || [],
    // An open return, case or dispute on the buyer's order for the item, or a cancellation they asked for (Orders access only).
    issue: issues.get(`${r.connection_id}:${r.conversation_id}`) || null,
  };
}

// The accounts (of these) where this person may see orders: the owner's all, a member's with Orders access.
async function ordersAccess(auth, ids) {
  if (auth.role === 'owner') return new Set(ids);
  const ok = await Promise.all(ids.map((id) => teamRepository.resolvePermission(auth.userId, id, 'orders')));
  return new Set(ids.filter((id, i) => ok[i]));
}

function syncShape(states, ids) {
  const list = ids.map((id) => states.get(id)).filter(Boolean);
  const times = list.map((s) => s.last_sync_at).filter(Boolean).map((t) => new Date(t).getTime());
  const failed = list.find((s) => s.last_error && (!s.last_sync_at || new Date(s.last_error_at) > new Date(s.last_sync_at)));
  return {
    syncedAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    syncing: ids.some((id) => syncing.has(id)),
    neverSynced: ids.some((id) => !states.get(id)?.last_sync_at),
    error: failed ? { message: failed.last_error, scope: /Reconnect this eBay account/.test(failed.last_error) } : null,
  };
}

/**
 * A folder of conversations on one account (`connectionId`) or every
 * account the person may read: { conversations, counts, sync, hasMore }.
 */
async function list(auth, { connectionId = null, folder = 'buyers', show = 'all', q = '', before = null, limit = PAGE, refresh = false } = {}) {
  const accounts = connectionId ? [await requireAccount(auth, connectionId)] : await accountsFor(auth);
  const ids = accounts.map((a) => a.id);
  const states = await refreshStale(ids, auth.ownerId, { force: refresh });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  // Open returns, cases and disputes, and buyers' cancellation requests, for whoever may see the orders.
  const withOrders = await ordersAccess(auth, ids);
  orderIssues.refreshStale([...withOrders], auth.ownerId).catch(() => {});
  const withCases = (await Promise.all([...withOrders].map((id) => orderIssues.openCaseConversations(id).catch(() => [])))).flat();
  const issues = new Map();
  let rows;
  if (show === 'cases') {
    // Every buyer conversation with an open case (any folder), the nearest deadline first; searched here.
    const words = String(q || '').trim().toLowerCase();
    rows = withCases
      .filter(({ row: r }) => !words || [r.other_party, r.title, r.latest_preview, r.reference_id].some((v) => String(v || '').toLowerCase().includes(words)))
      .sort((a, b) => rules.byDeadline(a, b))
      .map(({ row, issue }) => {
        issues.set(`${row.connection_id}:${row.conversation_id}`, issue);
        return row;
      });
  } else {
    rows = await inboxRepository.listConversations(ids, { folder, show, q, before, limit });
    for (const id of withOrders) {
      for (const [conv, issue] of await orderIssues.issuesFor(id, rows.filter((r) => r.connection_id === id))) issues.set(`${id}:${conv}`, issue);
    }
  }
  const items = await imagesFor(ids, rows.map((r) => r.reference_id));
  return {
    conversations: rows.map((r) => rowShape(r, byId, items, issues)),
    // `cases`: conversations with an open case, for whoever may see the orders (null for no one here).
    counts: { ...(await inboxRepository.counts(ids)), cases: withOrders.size ? withCases.length : null },
    sync: syncShape(states, ids),
    hasMore: show !== 'cases' && rows.length >= limit,
    accounts: accounts.map(({ id, label }) => ({ id, label })),
  };
}

// ---- one conversation ---------------------------------------------------------------

function messageShape(m, type) {
  return {
    id: m.message_id,
    fromSeller: m.from_seller,
    sender: m.sender,
    subject: m.subject,
    text: rules.htmlToText(m.body, { dropLinks: type === 'FROM_EBAY' }),
    // eBay's notices: their links as buttons, and the notice as eBay designed it (drawn when there is one).
    links: type === 'FROM_EBAY' ? rules.linksIn(m.body) : [],
    html: type === 'FROM_EBAY' ? rules.noticeHtml(m.body) : null,
    media: (m.media || []).map((x) => ({ name: x.name, type: x.type, url: x.url, image: x.type === 'IMAGE' || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(x.url || '') })),
    read: m.read,
    createdAt: m.created_at,
  };
}

const ORDER_STATUS = { awaiting_payment: 'Awaiting payment', awaiting_dispatch: 'To dispatch', dispatched: 'Dispatched', delivered: 'Delivered', cancelled: 'Cancelled' };

function orderShape(connectionId, o, referenceId, images, { sourcing = [], marketplace = null } = {}) {
  const lines = o.lineItems || [];
  const tracking = lines.filter((l) => l.trackingNumber).map((l) => ({ number: l.trackingNumber, carrier: l.trackingCarrier || null }));
  const status = ebayService.classifyOrderStatus(o);
  return {
    orderId: o.orderId,
    status,
    statusLabel: ORDER_STATUS[status] || status,
    total: o.total || null,
    createdAt: o.createdAt || null,
    paidAt: o.paidTime || null,
    shippedAt: o.shippedTime || null,
    deliveredAt: o.deliveredAt || null,
    estimatedDelivery: lines[0]?.estimatedDeliveryMax ? { min: lines[0].estimatedDeliveryMin || null, max: lines[0].estimatedDeliveryMax } : null,
    dispatchBy: o.dispatchByTime || lines[0]?.handleByTime || null,
    tracking,
    items: lines.map((l) => ({ itemId: String(l.itemId || ''), title: l.title, quantity: l.quantityPurchased || 1, variation: (l.variation || []).map((v) => `${v.name}: ${v.value}`).join(', ') || null, image: images.get(String(l.itemId))?.image || null })),
    aboutThis: Boolean(referenceId && lines.some((l) => String(l.itemId) === String(referenceId))),
    // The buyer asked to cancel and the seller hasn't answered (the order page approves or declines it).
    cancelRequested: ebayService.CANCEL_REQUESTED_STATUSES.has(o.cancelStatus),
    // How it goes, where to, and the supplier order behind it (Liston's own records).
    postage: lines[0]?.shippingService || null,
    shipTo: threadFacts.shipTo(o.shippingAddress, marketplace),
    supplier: threadFacts.supplierOrders(sourcing),
    url: `/accounts/${connectionId}/orders/${encodeURIComponent(o.orderId)}`,
  };
}

/**
 * What the details panel adds about the listing, from Liston's own copies:
 * its state, watchers, when it was listed, sales (and with Analytics access
 * views) over the last 30 days, its supplier and specifics.
 */
async function listingInsightsFor(auth, connectionId, itemId) {
  const owner = auth.role === 'owner';
  const [canListings, canAnalytics] = owner
    ? [true, true]
    : await Promise.all([teamRepository.resolvePermission(auth.userId, connectionId, 'listings'), teamRepository.resolvePermission(auth.userId, connectionId, 'analytics')]);
  if (!canListings) return null;
  const since = new Date(Date.now() - threadFacts.DAYS * 86400000);
  const [snapshot, traffic, orders, summaries, supplierUrl] = await Promise.all([
    inboxRepository.listingSnapshotItem(connectionId, itemId),
    canAnalytics ? inboxRepository.listingTrafficSince(connectionId, itemId, since.toISOString().slice(0, 10)) : null,
    inboxRepository.ordersForItemSince(connectionId, itemId, since),
    mirror.loadItemSummaries([String(itemId)]),
    inboxRepository.supplierUrlFor(connectionId, itemId),
  ]);
  const isCancelled = (o) => ebayService.classifyOrderStatus(o) === 'cancelled';
  return threadFacts.listingInsights({
    snapshot,
    traffic,
    sold: threadFacts.soldFrom(orders, itemId, isCancelled),
    summary: summaries.get(String(itemId))?.summary || null,
    supplierUrl,
    canListings,
    canAnalytics,
  });
}

/** What sits beside a thread: the listing it's about, the buyer's orders (with Orders access), their other conversations. */
async function contextOf(auth, account, conv) {
  const connectionId = account.id;
  const buyerThread = conv.type === 'FROM_MEMBERS';
  const canOrders = auth.role === 'owner' || (await teamRepository.resolvePermission(auth.userId, connectionId, 'orders'));
  const [orders, listingCards, others, insights] = await Promise.all([
    buyerThread && canOrders ? inboxRepository.ordersByBuyer(connectionId, conv.other_party) : [],
    conv.reference_id ? referencesService.resolve(auth, [{ kind: 'listing', id: String(conv.reference_id), connectionId }]).catch(() => [null]) : [null],
    buyerThread ? inboxRepository.otherConversations(connectionId, conv.other_party, conv.conversation_id) : [],
    buyerThread && conv.reference_id ? listingInsightsFor(auth, connectionId, conv.reference_id).catch(() => null) : null,
  ]);
  const [images, sourcingRows] = await Promise.all([
    imagesFor([connectionId], [conv.reference_id, ...orders.flatMap((o) => (o.lineItems || []).map((l) => l.itemId))]),
    orders.length ? orderRepository.listSourcingForOrders(connectionId, orders.map((o) => o.orderId)) : [],
  ]);
  const marketplace = marketplaces.byId(account.marketplaceId);
  const shaped = orders.map((o) => orderShape(connectionId, o, conv.reference_id, images, { sourcing: sourcingRows.filter((r) => r.order_id === o.orderId), marketplace }));
  const item = conv.reference_id ? images.get(String(conv.reference_id)) : null;
  const listing = listingCards[0] && !listingCards[0].locked ? listingCards[0] : null;
  return {
    item: conv.reference_id
      ? {
          itemId: String(conv.reference_id),
          title: listing?.title || item?.title || conv.title || null,
          image: listing?.image || item?.image || null,
          price: item?.price || null,
          url: listing?.url || null,
          ebayUrl: `https://${marketplaces.byId(account.marketplaceId)?.itemHost || 'www.ebay.co.uk'}/itm/${conv.reference_id}`,
          insights,
        }
      : null,
    listing,
    // What to call the buyer in a reply ("@", saved replies): the first name on their latest order (Orders access only).
    buyerName: orders.length ? orderMessages.firstName(orders[0]) : null,
    orders: shaped,
    // The order this conversation is about (its item), else the buyer's latest.
    order: shaped.find((o) => o.aboutThis) || null,
    ordersHidden: buyerThread && !canOrders,
    otherConversations: others.map((c) => ({ conversationId: c.conversation_id, title: c.title, referenceId: c.reference_id, preview: c.latest_preview, at: c.latest_at })),
  };
}

function conversationShape(conv, account, items, issues) {
  return rowShape(conv, new Map([[account.id, account]]), items || new Map(), issues);
}

/**
 * One conversation: its messages (read from eBay first when something's
 * new in it), what sits beside it, and it's marked read (on eBay too).
 */
async function thread(auth, connectionId, conversationId, { markRead = true } = {}) {
  const account = await requireAccount(auth, connectionId);
  let conv = await inboxRepository.findConversation(connectionId, conversationId);
  if (!conv) throw new InboxError('Conversation not found.', 404);
  let stale = null;
  const behind = !conv.messages_synced_at || !(await inboxRepository.hasMessage(connectionId, conv.latest_message_id));
  if (behind) {
    try {
      await withEbay(connectionId, auth.ownerId, async ({ accessToken, marketplaceId, seller }) => {
        const all = [];
        for (let page = 0; page < THREAD_PAGES; page += 1) {
          const { messages, total } = await ebayMessage.getConversation(accessToken, conversationId, { type: conv.type, limit: PAGE, offset: all.length }, marketplaceId);
          all.push(...messages);
          if (!messages.length || all.length >= total) break;
        }
        await inboxRepository.upsertMessages(
          connectionId,
          conversationId,
          all.filter((m) => m.messageId && m.createdAt).map((m) => ({ ...m, fromSeller: rules.fromSeller(m, seller) }))
        );
      });
    } catch (err) {
      stale = { message: err.message };
      logger.warn('Inbox: conversation not read from eBay', { connectionId, conversationId, error: err.message });
    }
  }
  // Opened is read, here (up to its latest message, so eBay's list can't make it unread again) and on eBay when it was unread.
  if (markRead) await inboxRepository.markReadHere(connectionId, conversationId);
  if (markRead && conv.unread_count > 0) {
    withEbay(connectionId, auth.ownerId, ({ accessToken, marketplaceId }) => ebayMessage.updateConversation(accessToken, { conversationId, type: conv.type, read: true }, marketplaceId))
      .then(() => announce(connectionId, auth.ownerId, { conversationId }))
      .catch((err) => logger.warn('Inbox: not marked read on eBay', { connectionId, conversationId, error: err.message }));
    conv = { ...conv, unread_count: 0 };
  }
  // The bell's line about it (and the lock screen's) is read too.
  if (markRead) notificationsService.readSubject(auth.userId, 'inbox.message', `${connectionId}:${conversationId}`).catch(() => {});
  const [messages, context, notes] = await Promise.all([
    inboxRepository.messagesOf(connectionId, conversationId),
    contextOf(auth, account, conv),
    conv.type === 'FROM_MEMBERS' ? inboxRepository.notesOf(connectionId, conversationId) : [],
  ]);
  const items = await imagesFor([connectionId], [conv.reference_id]);
  const issues = new Map();
  if ((await ordersAccess(auth, [connectionId])).size) {
    for (const [id, issue] of await orderIssues.issuesFor(connectionId, [conv])) issues.set(`${connectionId}:${id}`, issue);
  }
  return {
    conversation: conversationShape(conv, account, items, issues),
    messages: messages.map((m) => messageShape(m, conv.type)),
    notes: notes.map((n) => noteShape(n, auth)),
    context,
    stale,
  };
}

/** How many of an account's conversations (buyers' and eBay's) are unread, for the sidebar: { unread }. Never reads eBay. */
async function unread(auth, connectionId) {
  await requireAccount(auth, connectionId);
  const counts = await inboxRepository.counts([connectionId]);
  return { unread: counts.buyers + counts.ebay };
}

/** Each account's unread conversations, for every account whose messages the person may read (the account rail's counts). */
async function unreadByAccount(auth) {
  const accounts = await accountsFor(auth);
  return { accounts: await inboxRepository.unreadByAccount(accounts.map((a) => a.id)) };
}

/** Marks a conversation read or unread, here and on eBay. */
async function setRead(auth, connectionId, conversationId, read) {
  await requireAccount(auth, connectionId);
  const conv = await inboxRepository.findConversation(connectionId, conversationId);
  if (!conv) throw new InboxError('Conversation not found.', 404);
  await withEbay(connectionId, auth.ownerId, ({ accessToken, marketplaceId }) => ebayMessage.updateConversation(accessToken, { conversationId, type: conv.type, read }, marketplaceId));
  if (read) await inboxRepository.markReadHere(connectionId, conversationId);
  else await inboxRepository.markUnreadHere(connectionId, conversationId);
  await announce(connectionId, auth.ownerId, { conversationId });
  return { ok: true };
}

/** Archives a conversation (or brings it back to the inbox), here and on eBay. */
async function setStatus(auth, connectionId, conversationId, status) {
  await requireAccount(auth, connectionId);
  const conv = await inboxRepository.findConversation(connectionId, conversationId);
  if (!conv) throw new InboxError('Conversation not found.', 404);
  await withEbay(connectionId, auth.ownerId, ({ accessToken, marketplaceId }) => ebayMessage.updateConversation(accessToken, { conversationId, type: conv.type, status }, marketplaceId));
  await inboxRepository.updateConversation(connectionId, conversationId, { status });
  await announce(connectionId, auth.ownerId, { conversationId });
  return { ok: true };
}

// eBay's attachment kinds, by the file's type.
function mediaTypeOf(mime) {
  if (/^image\/(jpeg|png|gif|webp)$/.test(mime)) return 'IMAGE';
  if (mime === 'application/pdf') return 'PDF';
  if (/^application\/(msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/.test(mime)) return 'DOC';
  if (mime === 'text/plain') return 'TXT';
  return null;
}

/**
 * What eBay is handed for each attachment: a photo put on eBay's own picture
 * service first (where eBay keeps the photos buyers and sellers attach on
 * eBay; a link to Liston reached no buyer), a document as its HTTPS link
 * from Liston, which eBay fetches.
 */
async function mediaForEbay(files, { accessToken, marketplaceId, connectionId }) {
  return Promise.all(
    files.map(async (f) => {
      const type = mediaTypeOf(f.mime);
      if (type !== 'IMAGE') {
        const url = filesService.publicUrl(f);
        if (!/^https:\/\//.test(url || '')) throw new InboxError(`${f.name} can't go to eBay from here: eBay fetches documents over HTTPS and this server's address (API_URL) isn't.`, 400);
        return { name: f.name, type, url };
      }
      const bytes = await filesService.bytesOf(f);
      if (!bytes) throw new InboxError(`${f.name} couldn't be read. Attach it again.`, 400);
      const url = await eps.upload(accessToken, bytes, { marketplaceId, pictureName: f.name, account: connectionId }).catch((err) => {
        logger.warn('Inbox: attachment not put on eBay', { connectionId, error: err.message });
        throw new InboxError(`eBay wouldn't take ${f.name}. Try again, or send it as a JPEG or PNG.`, 502);
      });
      return { name: f.name, type, url };
    })
  );
}

/**
 * Replies to a buyer in their conversation: the text (at most 2,000
 * characters) and up to 5 attachments uploaded for eBay first. Text eBay
 * blocks or flags (contact details, links off eBay, paying outside eBay)
 * comes back as `warnings` unless `confirm` says send it anyway. A real
 * message to a real buyer, sent only when someone presses Send.
 */
async function reply(auth, connectionId, conversationId, { text, fileIds = [], confirm = false }) {
  const account = await requireAccount(auth, connectionId);
  const conv = await inboxRepository.findConversation(connectionId, conversationId);
  if (!conv) throw new InboxError('Conversation not found.', 404);
  if (conv.type !== 'FROM_MEMBERS') throw new InboxError("eBay's own messages can't be answered here.", 400);
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new InboxError('Write your reply first.', 400);
  if (body.length > ebayMessage.MAX_TEXT) throw new InboxError(`eBay takes up to ${ebayMessage.MAX_TEXT.toLocaleString('en-GB')} characters in a message.`, 400);
  const ids = [...new Set(fileIds || [])];
  if (ids.length > ebayMessage.MAX_MEDIA) throw new InboxError(`eBay takes up to ${ebayMessage.MAX_MEDIA} attachments in a message.`, 400);
  const files = ids.length ? await require('../files/files.repository').findByIds(ids) : [];
  if (files.length !== ids.length || files.some((f) => f.owner_user_id !== auth.ownerId || f.purpose !== 'ebay' || String(f.uploaded_by) !== String(auth.userId))) {
    throw new InboxError("One of those attachments isn't yours to send.", 400);
  }
  if (files.some((f) => !mediaTypeOf(f.mime))) throw new InboxError('eBay takes photos, PDFs, Word documents and text files as attachments.', 400);
  const warnings = rules.warningsFor(body);
  if (warnings.length && !confirm) return { sent: false, warnings };

  const { out, media } = await withEbay(connectionId, auth.ownerId, async ({ accessToken, marketplaceId }) => {
    const hosted = await mediaForEbay(files, { accessToken, marketplaceId, connectionId });
    return { out: await ebayMessage.sendMessage(accessToken, { conversationId, text: body, media: hosted }, marketplaceId), media: hosted };
  });
  const sent = {
    messageId: out.messageId || `sent-${Date.now()}`,
    sender: null,
    recipient: conv.other_party,
    subject: null,
    body,
    media,
    createdAt: new Date().toISOString(),
    preview: rules.previewOf(body),
  };
  await inboxRepository.addSent(connectionId, conversationId, sent);
  // How long the buyer had waited for this answer (when the last word was theirs): the member's reply time.
  const waitedMinutes = !conv.latest_from_seller && conv.latest_at ? Math.max(0, Math.round((Date.now() - new Date(conv.latest_at).getTime()) / 60000)) : null;
  await activityRepository
    .record({ actorUserId: auth.userId, connectionId, kind: 'inbox.replied', subjectType: 'conversation', subjectId: conversationId, title: conv.other_party, detail: { itemId: conv.reference_id || null, files: media.length, waitedMinutes } })
    .catch(() => {});
  await announce(connectionId, auth.ownerId, { conversationId });
  const [saved] = (await inboxRepository.messagesOf(connectionId, conversationId)).filter((m) => m.message_id === sent.messageId);
  return { sent: true, message: messageShape(saved, conv.type), account: { id: account.id, label: account.label } };
}

// ---- team notes ---------------------------------------------------------------------

async function buyerConversation(auth, connectionId, conversationId) {
  await requireAccount(auth, connectionId);
  const conv = await inboxRepository.findConversation(connectionId, conversationId);
  if (!conv) throw new InboxError('Conversation not found.', 404);
  if (conv.type !== 'FROM_MEMBERS') throw new InboxError("eBay's own messages can't have notes.", 400);
  return conv;
}

function noteShape(n, auth) {
  const mine = String(n.author_user_id) === String(auth.userId);
  return { id: String(n.id), body: n.body, author: personOf(n.author_user_id, n.author_name, n.author_email), createdAt: n.created_at, mine, canDelete: mine || auth.role === 'owner' };
}

/** A note on a buyer's conversation that only the team sees. */
async function addNote(auth, connectionId, conversationId, text) {
  const conv = await buyerConversation(auth, connectionId, conversationId);
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new InboxError('Write the note first.', 400);
  if (body.length > MAX_NOTE) throw new InboxError(`Keep a note under ${MAX_NOTE.toLocaleString('en-GB')} characters.`, 400);
  const note = await inboxRepository.addNote(connectionId, conversationId, auth.userId, body);
  await activityRepository
    .record({ actorUserId: auth.userId, connectionId, kind: 'inbox.noted', subjectType: 'conversation', subjectId: conversationId, title: conv.other_party, detail: { itemId: conv.reference_id || null } })
    .catch(() => {});
  await announce(connectionId, auth.ownerId, { conversationId });
  return { note: noteShape(note, auth) };
}

/** Deletes a note: its writer, or the owner. */
async function deleteNote(auth, connectionId, conversationId, noteId) {
  await buyerConversation(auth, connectionId, conversationId);
  const note = /^\d+$/.test(String(noteId)) ? await inboxRepository.findNote(connectionId, conversationId, noteId) : null;
  if (!note) throw new InboxError('Note not found.', 404);
  if (auth.role !== 'owner' && String(note.author_user_id) !== String(auth.userId)) throw new InboxError('Only who wrote a note, the workspace owner or a co-manager, can delete it.', 403);
  await inboxRepository.deleteNote(note.id);
  await announce(connectionId, auth.ownerId, { conversationId });
  return { ok: true };
}

/**
 * "Message buyer" from an order: a message to the order's buyer about its
 * first item, threaded by eBay with anything already said; then the
 * account's conversations are read so it's in the Inbox. Warnings first as
 * for a reply. A real message to a real buyer, sent only when someone
 * presses Send. { sent, conversationId }.
 */
async function messageBuyer(auth, connectionId, { orderId, text, confirm = false }) {
  const account = await requireAccount(auth, connectionId);
  const order = orderId ? await inboxRepository.orderById(connectionId, String(orderId)) : null;
  if (!order) throw new InboxError('Order not found.', 404);
  const buyer = order.buyerUserId;
  const itemId = order.lineItems?.[0]?.itemId;
  if (!buyer || !itemId) throw new InboxError("eBay hasn't given this order's buyer and item.", 400);
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new InboxError('Write your message first.', 400);
  if (body.length > ebayMessage.MAX_TEXT) throw new InboxError(`eBay takes up to ${ebayMessage.MAX_TEXT.toLocaleString('en-GB')} characters in a message.`, 400);
  const warnings = rules.warningsFor(body);
  if (warnings.length && !confirm) return { sent: false, warnings };
  const out = await withEbay(connectionId, auth.ownerId, ({ accessToken, marketplaceId }) => ebayMessage.sendMessage(accessToken, { buyerUsername: buyer, itemId: String(itemId), text: body }, marketplaceId));
  // The conversation it's in (eBay's id, or found by reading the account's latest).
  await sync(connectionId, auth.ownerId).catch(() => null);
  const conversationId = out.conversationId || (await inboxRepository.latestWith(connectionId, buyer, String(itemId)))?.conversation_id || null;
  if (conversationId && (await inboxRepository.findConversation(connectionId, conversationId))) {
    await inboxRepository.addSent(connectionId, conversationId, { messageId: out.messageId || `sent-${Date.now()}`, sender: null, recipient: buyer, subject: null, body, media: [], createdAt: new Date().toISOString(), preview: rules.previewOf(body) });
  }
  await activityRepository
    .record({
      actorUserId: auth.userId,
      connectionId,
      kind: 'inbox.messaged',
      subjectType: conversationId ? 'conversation' : 'order',
      subjectId: conversationId || String(orderId),
      title: buyer,
      detail: { orderId: String(orderId), itemId: String(itemId) },
    })
    .catch(() => {});
  await announce(connectionId, auth.ownerId, conversationId ? { conversationId } : {});
  return { sent: true, conversationId, buyer, account: { id: account.id, label: account.label } };
}

/** Reads an account's messages from eBay now (the Refresh button). */
async function refresh(auth, connectionId) {
  await requireAccount(auth, connectionId);
  return sync(connectionId, auth.ownerId);
}

/** eBay says a member closed their eBay account: their conversations and messages go. */
async function forgetMember(username) {
  return inboxRepository.forgetMember(username);
}

module.exports = {
  list,
  thread,
  unread,
  unreadByAccount,
  setRead,
  setStatus,
  reply,
  refresh,
  sync,
  accountsFor,
  forgetMember,
  onPushedMessage,
  tellTeam,
  addNote,
  deleteNote,
  messageBuyer,
  _flushPushed,
  InboxError,
  SCOPE,
};
