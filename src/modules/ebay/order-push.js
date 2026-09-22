// New orders pushed by eBay the moment a buyer checks out (Notification API
// topic ORDER_CONFIRMATION), so an open Orders page shows them within
// seconds without polling — and without a Trading call: each order is read
// on its own from the Fulfillment API (ebay.service applyNewOrder).
//
// Setup, once per app and once per account:
//   - one destination: our /api/ebay/commerce-notifications URL + token
//     (config.ebay.commerceNotifications*); eBay checks we own it with a GET
//     challenge, so the endpoint must be live (production) when it's made;
//   - one ORDER_CONFIRMATION subscription per seller, with their token —
//     made when an account connects or reconnects, or for every account by
//     scripts/enable-order-push.js.
// Replaces Trading's Platform Notifications for sales: eBay generated none
// of those for a subscribed account over two days of sales (checked with
// GetNotificationsUsage, Sep 2026).
const config = require('../../config');
const logger = require('../../utils/logger');
const appState = require('../../db/app-state.repository');
const connectionRepository = require('../connections/connection.repository');
const connectionService = require('../connections/connection.service');
const notificationApi = require('./api/ebay.notification-api');
const ebayIdentity = require('./api/ebay.identity');
const ebayOauth = require('./api/ebay.oauth');
const ebayService = require('./ebay.service');
const commerce = require('./commerce-notifications');

const TOPIC = 'ORDER_CONFIRMATION';
const DESTINATION_KEY = 'ebay-commerce-destination';
const SUBSCRIPTION_SCOPE = 'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription';

function configured() {
  const { commerceNotificationsUrl: url, commerceNotificationsToken: token } = config.ebay;
  return Boolean(url && /^https:\/\//.test(url) && token && token.length >= 32 && token.length <= 80);
}

/** The app's destination for our endpoint: the stored one, an existing match, or a new one. */
async function ensureDestination() {
  const endpoint = config.ebay.commerceNotificationsUrl;
  const saved = await appState.get(DESTINATION_KEY);
  if (saved?.destinationId && saved.endpoint === endpoint) return saved.destinationId;
  const existing = (await notificationApi.getDestinations()).find((d) => d.deliveryConfig?.endpoint === endpoint);
  const destinationId = existing
    ? existing.destinationId
    : await notificationApi.createDestination({ name: 'Liston', endpoint, verificationToken: config.ebay.commerceNotificationsToken });
  if (!destinationId) throw new Error("eBay didn't return the new destination's id");
  await appState.set(DESTINATION_KEY, { destinationId, endpoint, createdAt: new Date().toISOString() });
  return destinationId;
}

/**
 * Subscribes one account to new-order pushes (idempotent). `credentials`
 * are the connection's decrypted ones. Resolves to { subscriptionId,
 * username, credentialsChanged, credentials } — the caller saves refreshed
 * credentials, as withDecryptedCredentials does.
 */
async function subscribeAccount(connectionId, credentials) {
  if (!configured()) throw new Error('Order push is not configured (EBAY_COMMERCE_NOTIFICATIONS_URL / token)');
  if (!ebayOauth.hasScope(credentials, SUBSCRIPTION_SCOPE) || !ebayOauth.hasScope(credentials, ebayOauth.SCOPE_FULFILLMENT)) {
    const err = new Error('This account was connected without the notification permissions; reconnect it.');
    err.code = 'EBAY_SCOPE_MISSING';
    throw err;
  }
  const { accessToken, credentials: refreshed, credentialsChanged } = await ebayService.ensureValidAccessToken(credentials);
  const [destinationId, user] = await Promise.all([ensureDestination(), ebayIdentity.getUser(accessToken)]);
  const current = (await notificationApi.getSubscriptions(accessToken)).find((s) => s.topicId === TOPIC);
  let subscriptionId = current?.subscriptionId || null;
  if (!subscriptionId) {
    subscriptionId = await notificationApi.createSubscription(accessToken, { topicId: TOPIC, destinationId });
  } else if (current.destinationId !== destinationId || current.status !== 'ENABLED') {
    await notificationApi.updateSubscription(accessToken, subscriptionId, { destinationId });
  }
  if (!subscriptionId) subscriptionId = (await notificationApi.getSubscriptions(accessToken)).find((s) => s.topicId === TOPIC)?.subscriptionId || null;
  await connectionRepository.mergeEbaySettings(connectionId, {
    ...(user.username ? { username: user.username } : {}),
    ...(user.userId ? { userId: user.userId } : {}),
    orderPush: { subscriptionId, destinationId, subscribedAt: new Date().toISOString() },
  });
  // eBay sends a test notification to the destination: the first receipt,
  // which makes the account's push trusted (ebayService.pushEnabled).
  if (subscriptionId) await notificationApi.testSubscription(accessToken, subscriptionId).catch(() => {});
  return { subscriptionId, username: user.username, credentialsChanged, credentials: refreshed };
}

/** subscribeAccount for a stored connection (decrypts, saves refreshed credentials). */
function subscribeConnection(connectionId, ownerId) {
  return connectionService.withDecryptedCredentials(connectionId, ownerId, (credentials) => subscribeAccount(connectionId, credentials));
}

/**
 * After an account connects or reconnects: subscribe it in the background
 * when push is set up. Never fails the connect.
 */
function subscribeInBackground(connectionId, ownerId) {
  if (!configured()) return;
  subscribeConnection(connectionId, ownerId)
    .then((r) => logger.info('eBay order push subscribed', { connectionId, seller: r.username }))
    .catch((err) => logger.warn('eBay order push subscription failed', { connectionId, error: err.message }));
}

/**
 * A verified notification: record the receipt and bring the new order in.
 * Resolves to what was done, for the log.
 */
async function handle(payload) {
  const n = commerce.parseNotification(payload);
  if (!n) return { handled: false, reason: 'unreadable' };
  if (n.topic !== TOPIC) return { handled: false, topic: n.topic, reason: 'topic' };
  const rows = await connectionRepository.findIdsByEbayUser(n.seller);
  const receivedAt = new Date().toISOString();
  for (const row of rows) {
    await connectionRepository.mergeEbaySettings(row.id, { orderPush: { lastReceivedAt: receivedAt } });
    if (!n.orderId) continue; // eBay's test notification: a receipt, no order
    connectionService
      .withDecryptedCredentials(row.id, row.user_id, (credentials) => ebayService.applyNewOrder(credentials, row.id, { orderId: n.orderId, lineItems: n.lineItems }))
      .catch((err) => logger.warn('New order from eBay push not read', { connectionId: row.id, orderId: n.orderId, error: err.message }));
  }
  return { handled: true, topic: n.topic, seller: n.seller.username || n.seller.userId, orderId: n.orderId, accounts: rows.length, attempt: n.attempt };
}

module.exports = { TOPIC, configured, ensureDestination, subscribeAccount, subscribeConnection, subscribeInBackground, handle };
