// eBay's Notification API (REST): push notifications as signed JSON to one
// HTTPS destination, per topic and per seller — the newer service beside
// Trading's SOAP Platform Notifications (ebay.notifications.js). Liston uses
// it for ORDER_CONFIRMATION (a buyer completed checkout).
//   - destination: app-level (application token), one per endpoint URL;
//     eBay checks the endpoint owns it with a GET challenge on creation;
//   - subscription: per seller (their user token, scope
//     commerce.notification.subscription) and topic, pointing at the
//     destination;
//   - public key: the key a notification's X-EBAY-SIGNATURE was made with.
// Its own allowance (10,000 calls/day) is only spent on setup and keys.
const { apiBaseUrl } = require('./ebay.oauth');
const appToken = require('./ebay.app-token');
const logger = require('../../../utils/logger');

const BASE = '/commerce/notification/v1';
const TIMEOUT_MS = 20 * 1000;

class NotificationApiError extends Error {
  constructor(message, statusCode, errors = []) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
  }
}

async function call(token, method, path, body) {
  const res = await fetch(`${apiBaseUrl()}${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = res.status === 204 ? '' : await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const errors = (data.errors || []).map((e) => ({ errorId: e.errorId, message: e.message, longMessage: e.longMessage }));
    logger.warn('eBay Notification API error', { method, path, status: res.status, errors });
    throw new NotificationApiError(errors[0]?.longMessage || errors[0]?.message || `eBay Notification API request failed (${res.status})`, res.status, errors);
  }
  // Creates answer 201 with the new id only in the Location header.
  const location = res.headers.get('location');
  return { data, id: location ? location.split('/').pop() : null };
}

const appCall = async (method, path, body) => call(await appToken.getApplicationToken(), method, path, body);

// ---- destinations (app token) ----------------------------------------------------

async function getDestinations() {
  const { data } = await appCall('GET', '/destination?limit=100');
  return data.destinations || [];
}

async function createDestination({ name, endpoint, verificationToken }) {
  const { id } = await appCall('POST', '/destination', { name, status: 'ENABLED', deliveryConfig: { endpoint, verificationToken } });
  return id;
}

async function updateDestination(destinationId, { name, endpoint, verificationToken }) {
  await appCall('PUT', `/destination/${encodeURIComponent(destinationId)}`, { name, status: 'ENABLED', deliveryConfig: { endpoint, verificationToken } });
}

// ---- subscriptions (the seller's token) -------------------------------------------

async function getSubscriptions(accessToken) {
  const { data } = await call(accessToken, 'GET', '/subscription?limit=100');
  return data.subscriptions || [];
}

async function createSubscription(accessToken, { topicId, destinationId, schemaVersion = '1.0' }) {
  const { id } = await call(accessToken, 'POST', '/subscription', {
    topicId,
    status: 'ENABLED',
    destinationId,
    payload: { format: 'JSON', schemaVersion, deliveryProtocol: 'HTTPS' },
  });
  return id;
}

async function updateSubscription(accessToken, subscriptionId, { destinationId, schemaVersion = '1.0' }) {
  await call(accessToken, 'PUT', `/subscription/${encodeURIComponent(subscriptionId)}`, {
    status: 'ENABLED',
    destinationId,
    payload: { format: 'JSON', schemaVersion, deliveryProtocol: 'HTTPS' },
  });
}

/** Asks eBay to send a test notification for this subscription to its destination. */
async function testSubscription(accessToken, subscriptionId) {
  await call(accessToken, 'POST', `/subscription/${encodeURIComponent(subscriptionId)}/test`);
}

// ---- public keys ------------------------------------------------------------------

const keyCache = new Map(); // key id -> { key, fetchedAt }
const KEY_TTL_MS = 60 * 60 * 1000; // eBay: cache keys, they rarely change

/** The public key (and its algorithm/digest) a notification was signed with. */
async function getPublicKey(keyId) {
  const hit = keyCache.get(keyId);
  if (hit && Date.now() - hit.fetchedAt < KEY_TTL_MS) return hit.key;
  const { data } = await appCall('GET', `/public_key/${encodeURIComponent(keyId)}`);
  keyCache.set(keyId, { key: data, fetchedAt: Date.now() });
  return data;
}

module.exports = {
  NotificationApiError,
  getDestinations,
  createDestination,
  updateDestination,
  getSubscriptions,
  createSubscription,
  updateSubscription,
  testSubscription,
  getPublicKey,
  _keyCache: keyCache,
};
