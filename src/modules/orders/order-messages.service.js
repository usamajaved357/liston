const logger = require('../../utils/logger');
const connectionService = require('../connections/connection.service');
const connectionRepository = require('../connections/connection.repository');
const ebayService = require('../ebay/ebay.service');
const ebayOauth = require('../ebay/api/ebay.oauth');
const ebayMessage = require('../ebay/api/ebay.message');
const mirror = require('../ebay/ebay-mirror.repository');
const orderRepository = require('./order.repository');
const orderMessages = require('./order-messages');

// Messages Liston sends buyers by itself, when the account's Settings turn
// them on:
//   placed     a welcome as soon as they order, thanking them and asking
//              them to reply rather than open a case if anything's wrong.
//              Sent when eBay pushes the new order (welcomeOrder, from
//              ebay-push), with the hourly run catching any push eBay
//              dropped; orders placed within the last day (those from
//              just before it was switched on too), paid and not yet
//              dispatched.
//   delivered  a thank-you once the order is delivered, asking for
//              feedback. Delivery comes from the order mirror (eBay's
//              delivery scan, read again every few hours for dispatched
//              orders, ebay.service); deliveries within the last few days
//              (those from just before it was switched on too).
// Never twice: each order and kind is claimed in the database before eBay
// is asked (order.repository claimMessage), so the push and the hourly run,
// or two servers, can't both send it; whatever eBay answers is kept and
// never retried. A buyer is welcomed at most once a day (a second order
// that day is noted as skipped), and each run sends at most PER_RUN per
// account. A real message to a real buyer: off until the owner switches it on.

const SCOPE = 'https://api.ebay.com/oauth/api_scope/commerce.message';
const PER_RUN = 20; // messages per account and kind per run, so a backlog trickles out

const settingOf = (settings, kind) => settings?.messages?.[kind] || null;
const anyOn = (settings) => orderMessages.KINDS.some((kind) => settingOf(settings, kind)?.enabled);

/**
 * The name the messages sign off with: the store name in the account's
 * description template, else eBay's name for its Shop (kept from the last
 * read; no call), else the account's name in Liston.
 */
async function storeNameOf(connection) {
  const typed = String(connection.settings?.template?.storeName || '').trim();
  if (typed) return typed;
  const profile = await mirror.loadSnapshot(String(connection.id), 'store_profile').catch(() => null);
  return String(profile?.value?.storeName || '').trim() || connection.label || '';
}

/**
 * Sends one order its message, unless it was already (or is being) sent:
 * 'sent', 'failed', 'skipped' (the buyer had this message lately) or
 * 'taken'. Never throws for eBay's refusal, which is kept with the order.
 */
async function sendOne({ connection, accessToken, marketplaceId, store }, kind, setting, order) {
  const text = orderMessages.fill(setting.text, order, { store, kind });
  const itemId = order.lineItems[0].itemId;
  const base = { connectionId: connection.id, orderId: order.orderId, kind };
  const claim = await orderRepository.claimMessage({ ...base, buyer: order.buyerUserId, itemId, text, buyerGapHours: kind === 'placed' ? orderMessages.BUYER_GAP_HOURS : 0 });
  if (claim !== 'claimed') return claim;
  try {
    const out = await ebayMessage.sendMessage(accessToken, { buyerUsername: order.buyerUserId, itemId, text }, marketplaceId);
    await orderRepository.finishMessage({ ...base, status: 'sent', conversationId: out.conversationId });
    await orderRepository.addEvent({ connectionId: connection.id, orderId: order.orderId, kind: `message.${kind}`, detail: { conversationId: out.conversationId } }).catch(() => {});
    logger.info('Order messages: message sent', { connectionId: connection.id, orderId: order.orderId, kind });
    return 'sent';
  } catch (err) {
    await orderRepository.finishMessage({ ...base, status: 'failed', error: err.message });
    logger.warn('Order messages: message not sent', { connectionId: connection.id, orderId: order.orderId, kind, error: err.message });
    return 'failed';
  }
}

const isCancelled = (o) => ebayService.classifyOrderStatus(o) === 'cancelled';

/**
 * Sends every due order on one account the messages switched on: how many
 * went. Never throws (a failure is logged, or kept on the order it was for).
 */
async function runFor(connection) {
  if (!anyOn(connection.settings)) return 0;
  try {
    const result = await connectionService.withDecryptedCredentials(connection.id, connection.user_id, async (credentials, full) => {
      if (!ebayOauth.hasScope(credentials, SCOPE)) {
        logger.warn('Order messages: account needs reconnecting to send messages', { connectionId: connection.id });
        return { sent: 0, scopeMissing: true };
      }
      const { accessToken, siteId, credentials: fresh, credentialsChanged } = await ebayService.ensureValidAccessToken(credentials);
      const placed = settingOf(full.settings, 'placed');
      const delivered = settingOf(full.settings, 'delivered');
      // Deliveries need the latest scans; welcomes only need what push keeps current.
      const push = delivered?.enabled ? false : ebayService.pushEnabled(full);
      const orders = await ebayService.getOrdersLast90Cached(connection.id, accessToken, siteId, push);
      const ctx = { connection: full, accessToken, marketplaceId: full.settings?.ebay?.marketplaceId || credentials.marketplaceId || 'EBAY_GB', store: await storeNameOf(full) };
      let sent = 0;
      const found = {};
      if (placed?.enabled) {
        const done = await orderRepository.messagedOrderIds(connection.id, 'placed');
        const due = orderMessages.placedDue(orders, { since: placed.enabledAt, done, statusOf: ebayService.classifyOrderStatus }).slice(0, PER_RUN);
        found.placed = due.length;
        for (const order of due) if ((await sendOne(ctx, 'placed', placed, order)) === 'sent') sent += 1;
      }
      if (delivered?.enabled) {
        const done = await orderRepository.messagedOrderIds(connection.id, 'delivered');
        const due = orderMessages.dueOrders(orders, { since: delivered.enabledAt, done, isCancelled }).slice(0, PER_RUN);
        found.delivered = due.length;
        for (const order of due) if ((await sendOne(ctx, 'delivered', delivered, order)) === 'sent') sent += 1;
      }
      logger.info('Order messages: account checked', { connectionId: connection.id, orders: orders.length, due: found, sent });
      return { sent, credentials: fresh, credentialsChanged };
    });
    return result?.sent || 0;
  } catch (err) {
    logger.warn('Order messages: account skipped', { connectionId: connection.id, error: err.message });
    return 0;
  }
}

/** One run over every eBay account with a message switched on: how many went. */
async function runAll() {
  await orderRepository.closeStaleClaims().catch((err) => logger.warn('Order messages: stale claims not closed', { error: err.message }));
  const connections = await connectionRepository.findAllEbay();
  let sent = 0;
  for (const connection of connections) if (anyOn(connection.settings)) sent += await runFor(connection);
  return sent;
}

/**
 * The welcome for an order eBay just pushed (ebay-push, after the order is
 * read): sent at once if the account has it on and the order is due one.
 * Resolves to what happened ('sent', 'off', 'not-due', …). Never throws.
 */
async function welcomeOrder(connectionId, ownerId, order) {
  try {
    const result = await connectionService.withDecryptedCredentials(connectionId, ownerId, async (credentials, full) => {
      const setting = settingOf(full.settings, 'placed');
      if (!setting?.enabled) return { outcome: 'off' };
      if (!ebayOauth.hasScope(credentials, SCOPE)) return { outcome: 'no-scope' };
      const done = await orderRepository.messagedOrderIds(connectionId, 'placed');
      const [due] = orderMessages.placedDue([order], { since: setting.enabledAt, done, statusOf: ebayService.classifyOrderStatus });
      if (!due) return { outcome: 'not-due' };
      const { accessToken, credentials: fresh, credentialsChanged } = await ebayService.ensureValidAccessToken(credentials);
      const ctx = { connection: full, accessToken, marketplaceId: full.settings?.ebay?.marketplaceId || credentials.marketplaceId || 'EBAY_GB', store: await storeNameOf(full) };
      return { outcome: await sendOne(ctx, 'placed', setting, due), credentials: fresh, credentialsChanged };
    });
    const outcome = result?.outcome || 'off';
    if (outcome !== 'off') logger.info('Order messages: new order', { connectionId, orderId: order?.orderId, outcome });
    return outcome;
  } catch (err) {
    logger.warn('Order messages: welcome not sent', { connectionId, orderId: order?.orderId, error: err.message });
    return 'error';
  }
}

/** The account's message settings for its Settings page, with how they've gone lately and whether eBay allows it. */
async function getSettings(connectionId, ownerId) {
  const connection = await connectionService.getConnectionWithDecryptedCredentials(connectionId, ownerId);
  const recent = await orderRepository.recentMessages(connectionId);
  const view = (kind) => {
    const setting = settingOf(connection.settings, kind) || {};
    return { enabled: Boolean(setting.enabled), text: setting.text || null, enabledAt: setting.enabledAt || null, defaultText: orderMessages.DEFAULTS[kind] };
  };
  return {
    placed: view('placed'),
    delivered: view('delivered'),
    store: await storeNameOf(connection),
    canMessage: ebayOauth.hasScope(connection.credentials, SCOPE),
    recent,
  };
}

/**
 * Turns the messages on or off and words them (`changes`: { placed?,
 * delivered? }, each { enabled, text }). Switched on, a message covers the
 * last day's orders (the last few days' deliveries) and everything after;
 * the default wording is stored as none.
 */
async function updateSettings(connectionId, ownerId, changes) {
  const connection = await connectionService.getConnectionWithDecryptedCredentials(connectionId, ownerId);
  const messages = { ...(connection.settings?.messages || {}) };
  for (const kind of orderMessages.KINDS) {
    const change = changes?.[kind];
    if (!change) continue;
    const previous = messages[kind] || {};
    const text = change.text === undefined ? previous.text : change.text;
    const wording = typeof text === 'string' && text.trim() && text.trim() !== orderMessages.DEFAULTS[kind] ? text.trim().slice(0, ebayMessage.MAX_TEXT) : null;
    const enabled = Boolean(change.enabled);
    messages[kind] = { enabled, text: wording, enabledAt: enabled ? (previous.enabled && previous.enabledAt) || new Date().toISOString() : null };
  }
  await connectionService.updateConnectionSettings(connectionId, ownerId, { messages });
  return getSettings(connectionId, ownerId);
}

module.exports = { runFor, runAll, welcomeOrder, getSettings, updateSettings, storeNameOf, SCOPE, PER_RUN };
