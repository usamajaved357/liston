const logger = require('../../utils/logger');
const connectionService = require('../connections/connection.service');
const connectionRepository = require('../connections/connection.repository');
const ebayService = require('../ebay/ebay.service');
const ebayOauth = require('../ebay/api/ebay.oauth');
const ebayMessage = require('../ebay/api/ebay.message');
const orderRepository = require('./order.repository');
const orderMessages = require('./order-messages');

// Messages Liston sends buyers by itself, when the account's Settings turn
// them on: after an order is delivered, a thank-you asking for feedback on
// the item and the service and inviting the buyer to reply if anything's
// wrong. Delivery comes from the order mirror (eBay's delivery scan, read
// again every few hours for dispatched orders, ebay.service); each order is
// messaged once (order_messages), only for deliveries after it was switched
// on and within the last few days. A real message to a real buyer: off
// until the owner switches it on.

const SCOPE = 'https://api.ebay.com/oauth/api_scope/commerce.message';
const PER_RUN = 20; // messages per account per run, so a backlog trickles out

const settingOf = (settings) => settings?.messages?.delivered || null;

/**
 * Sends the delivered message to every due order on one account: how many
 * went. Never throws (a failure is logged, or kept on the order it was for).
 */
async function runFor(connection) {
  const setting = settingOf(connection.settings);
  if (!setting?.enabled) return 0;
  try {
    const result = await connectionService.withDecryptedCredentials(connection.id, connection.user_id, async (credentials, full) => {
      if (!ebayOauth.hasScope(credentials, SCOPE)) return { sent: 0, scopeMissing: true };
      const { accessToken, siteId, credentials: fresh, credentialsChanged } = await ebayService.ensureValidAccessToken(credentials);
      const orders = await ebayService.getOrdersLast90Cached(connection.id, accessToken, siteId);
      const done = await orderRepository.messagedOrderIds(connection.id, 'delivered');
      const due = orderMessages.dueOrders(orders, { since: setting.enabledAt, done, isCancelled: (o) => ebayService.classifyOrderStatus(o) === 'cancelled' }).slice(0, PER_RUN);
      const marketplaceId = full.settings?.ebay?.marketplaceId || credentials.marketplaceId || 'EBAY_GB';
      let sent = 0;
      for (const order of due) {
        const text = orderMessages.fill(setting.text, order);
        const base = { connectionId: connection.id, orderId: order.orderId, kind: 'delivered', buyer: order.buyerUserId, itemId: order.lineItems[0].itemId, text };
        try {
          const out = await ebayMessage.sendMessage(accessToken, { buyerUsername: order.buyerUserId, itemId: order.lineItems[0].itemId, text }, marketplaceId);
          await orderRepository.saveMessage({ ...base, status: 'sent', conversationId: out.conversationId });
          await orderRepository.addEvent({ connectionId: connection.id, orderId: order.orderId, kind: 'message.delivered', detail: { conversationId: out.conversationId } }).catch(() => {});
          sent += 1;
        } catch (err) {
          await orderRepository.saveMessage({ ...base, status: 'failed', error: err.message });
          logger.warn('Order messages: delivered message not sent', { connectionId: connection.id, orderId: order.orderId, error: err.message });
        }
      }
      return { sent, credentials: fresh, credentialsChanged };
    });
    return result?.sent || 0;
  } catch (err) {
    logger.warn('Order messages: account skipped', { connectionId: connection.id, error: err.message });
    return 0;
  }
}

/** One run over every eBay account with the message switched on: how many went. */
async function runAll() {
  const connections = await connectionRepository.findAllEbay();
  let sent = 0;
  for (const connection of connections) if (settingOf(connection.settings)?.enabled) sent += await runFor(connection);
  return sent;
}

/** The account's message settings for its Settings page, with how it's gone lately and whether eBay allows it. */
async function getSettings(connectionId, ownerId) {
  const connection = await connectionService.getConnectionWithDecryptedCredentials(connectionId, ownerId);
  const setting = settingOf(connection.settings) || {};
  const recent = await orderRepository.recentMessages(connectionId);
  return {
    delivered: { enabled: Boolean(setting.enabled), text: setting.text || null, enabledAt: setting.enabledAt || null, defaultText: orderMessages.DELIVERED_DEFAULT },
    canMessage: ebayOauth.hasScope(connection.credentials, SCOPE),
    recent,
  };
}

/** Turns the delivered message on or off and words it. Switched on, it counts deliveries from now. */
async function updateSettings(connectionId, ownerId, { enabled, text }) {
  const connection = await connectionService.getConnectionWithDecryptedCredentials(connectionId, ownerId);
  const previous = settingOf(connection.settings) || {};
  const wording = typeof text === 'string' && text.trim() && text.trim() !== orderMessages.DELIVERED_DEFAULT ? text.trim().slice(0, ebayMessage.MAX_TEXT) : null;
  const delivered = { enabled: Boolean(enabled), text: wording, enabledAt: enabled ? previous.enabled ? previous.enabledAt : new Date().toISOString() : null };
  await connectionService.updateConnectionSettings(connectionId, ownerId, { messages: { ...(connection.settings?.messages || {}), delivered } });
  return getSettings(connectionId, ownerId);
}

module.exports = { runFor, runAll, getSettings, updateSettings, SCOPE, PER_RUN };
