// eBay pushing changes to Liston (Notification API) instead of Liston
// asking: the Orders and Listings pages update within seconds, and the
// scarce Trading allowance isn't spent re-reading whole accounts.
//
//   ORDER_CONFIRMATION  a buyer checked out → that order, read on its own
//                       from the Fulfillment API (no Trading call), joins the
//                       list; the listing's stock drops from the
//                       notification's quantities (no call)
//   LISTING             a listing was CREATED, UPDATED or ENDED → ended ones
//                       leave the list (no call); a change caused by a sale
//                       was already applied (no call); any other is read on
//                       its own (1 Trading GetItem), or, for a burst, the
//                       account's listings are read once
//
// Setup, once per app and once per account:
//   - one destination: our /api/ebay/commerce-notifications URL + token
//     (config.ebay.commerceNotifications*); eBay checks we own it with a GET
//     challenge, so the endpoint must be live (production) when it's made;
//   - one subscription per seller and topic, with their token — made when an
//     account connects or reconnects, or for every account by
//     scripts/enable-ebay-push.js.
// Replaces Trading's Platform Notifications, which eBay didn't deliver for a
// subscribed account over two days of sales (GetNotificationsUsage, Sep 2026).
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

const SCOPE = (s) => `https://api.ebay.com/oauth/api_scope/${s}`;
// Each topic, where its bookkeeping lives in settings.ebay, and the scopes
// (any one) the seller's token needs for it.
const TOPICS = {
  ORDER_CONFIRMATION: { setting: 'orderPush', scopes: [SCOPE('sell.fulfillment'), SCOPE('sell.fulfillment.readonly')] },
  LISTING: { setting: 'listingPush', scopes: [SCOPE('sell.listing'), SCOPE('sell.listing.read')] },
};
const DESTINATION_KEY = 'ebay-commerce-destination';
const SUBSCRIPTION_SCOPE = SCOPE('commerce.notification.subscription');
// Listing changes are gathered for a moment per account, so a bulk edit
// (or eBay's retries) costs one round of reads, not one per notification.
const LISTING_BATCH_MS = 15 * 1000;

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
 * Subscribes one account to every topic its token allows (idempotent).
 * `credentials` are the connection's decrypted ones. Resolves to
 * { topics: { ORDER_CONFIRMATION: subscriptionId|null, LISTING: … },
 * username, credentialsChanged, credentials } — the caller saves refreshed
 * credentials, as withDecryptedCredentials does.
 */
async function subscribeAccount(connectionId, credentials) {
  if (!configured()) throw new Error('eBay push is not configured (EBAY_COMMERCE_NOTIFICATIONS_URL / token)');
  const allowed = Object.entries(TOPICS).filter(([, t]) => t.scopes.some((s) => ebayOauth.hasScope(credentials, s)));
  if (!ebayOauth.hasScope(credentials, SUBSCRIPTION_SCOPE) || !allowed.length) {
    const err = new Error('This account was connected without the notification permissions; reconnect it.');
    err.code = 'EBAY_SCOPE_MISSING';
    throw err;
  }
  const { accessToken, credentials: refreshed, credentialsChanged } = await ebayService.ensureValidAccessToken(credentials);
  const [destinationId, user] = await Promise.all([ensureDestination(), ebayIdentity.getUser(accessToken)]);
  let existing = await notificationApi.getSubscriptions(accessToken);
  const topics = {};
  const settings = { ...(user.username ? { username: user.username } : {}), ...(user.userId ? { userId: user.userId } : {}) };
  for (const [topicId, topic] of allowed) {
    const current = existing.find((s) => s.topicId === topicId);
    let subscriptionId = current?.subscriptionId || null;
    if (!subscriptionId) {
      subscriptionId = await notificationApi.createSubscription(accessToken, { topicId, destinationId });
      if (!subscriptionId) {
        existing = await notificationApi.getSubscriptions(accessToken);
        subscriptionId = existing.find((s) => s.topicId === topicId)?.subscriptionId || null;
      }
    } else if (current.destinationId !== destinationId || current.status !== 'ENABLED') {
      await notificationApi.updateSubscription(accessToken, subscriptionId, { destinationId });
    }
    topics[topicId] = subscriptionId;
    settings[topic.setting] = { subscriptionId, destinationId, subscribedAt: new Date().toISOString() };
  }
  await connectionRepository.mergeEbaySettings(connectionId, settings);
  ebayService.forgetMarketScopes();
  // eBay sends a test notification per subscription to the destination.
  for (const subscriptionId of Object.values(topics)) {
    if (subscriptionId) await notificationApi.testSubscription(accessToken, subscriptionId).catch(() => {});
  }
  return { topics, username: user.username, credentialsChanged, credentials: refreshed };
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
    .then((r) => logger.info('eBay push subscribed', { connectionId, seller: r.username, topics: Object.keys(r.topics) }))
    .catch((err) => logger.warn('eBay push subscription failed', { connectionId, error: err.message }));
}

// ---- listing changes, gathered per account ----------------------------------------

const pendingListings = new Map(); // connectionId -> { row, changes: Map(listingId -> reason), timer }

function queueListingChange(row, listingId, reason) {
  const key = String(row.id);
  let batch = pendingListings.get(key);
  if (!batch) {
    batch = { row, changes: new Map(), timer: null };
    pendingListings.set(key, batch);
    batch.timer = setTimeout(() => flushListings(key), LISTING_BATCH_MS);
    batch.timer.unref?.();
  }
  // An end outranks anything else about the same listing.
  if (batch.changes.get(listingId) !== 'ENDED') batch.changes.set(listingId, reason);
}

async function flushListings(key) {
  const batch = pendingListings.get(key);
  if (!batch) return null;
  pendingListings.delete(key);
  clearTimeout(batch.timer);
  const changes = [...batch.changes].map(([listingId, reason]) => ({ listingId, reason }));
  try {
    const result = await connectionService.withDecryptedCredentials(batch.row.id, batch.row.user_id, (credentials) =>
      ebayService.applyListingChanges(credentials, batch.row.id, changes)
    );
    logger.info('eBay listing changes applied', { connectionId: key, ...result.summary });
    return result.summary;
  } catch (err) {
    logger.warn('eBay listing changes not applied', { connectionId: key, error: err.message });
    return null;
  }
}

/** Test hook: how many listing changes are gathered for an account. */
function _pendingCount(connectionId) {
  return pendingListings.get(String(connectionId))?.changes.size || 0;
}

/** Test hook: apply every gathered listing change now. */
async function _flushAll() {
  return Promise.all([...pendingListings.keys()].map(flushListings));
}

// ---- a verified notification ---------------------------------------------------------

/** Records the receipt and acts on it. Resolves to what was done, for the log. */
async function handle(payload) {
  const n = commerce.parseNotification(payload);
  if (!n) return { handled: false, reason: 'unreadable' };
  const topic = TOPICS[n.topic];
  if (!topic) return { handled: false, topic: n.topic, reason: 'topic' };
  const rows = await connectionRepository.findIdsByEbayUser(n.seller);
  const receivedAt = new Date().toISOString();
  for (const row of rows) {
    await connectionRepository.mergeEbaySettings(row.id, { [topic.setting]: { lastReceivedAt: receivedAt } });
    if (n.topic === 'ORDER_CONFIRMATION' && n.orderId) {
      connectionService
        .withDecryptedCredentials(row.id, row.user_id, (credentials) => ebayService.applyNewOrder(credentials, row.id, { orderId: n.orderId, lineItems: n.lineItems }))
        .catch((err) => logger.warn('New order from eBay push not read', { connectionId: row.id, orderId: n.orderId, error: err.message }));
    } else if (n.topic === 'LISTING' && n.listingId && n.reason) {
      queueListingChange(row, n.listingId, n.reason);
    }
    // Anything else (eBay's test notification): a receipt, nothing to read.
  }
  return { handled: true, topic: n.topic, seller: n.seller.username || n.seller.userId, orderId: n.orderId || undefined, listingId: n.listingId || undefined, reason: n.reason || undefined, accounts: rows.length, attempt: n.attempt };
}

module.exports = { TOPICS, configured, ensureDestination, subscribeAccount, subscribeConnection, subscribeInBackground, handle, _flushAll, _pendingCount, LISTING_BATCH_MS };
