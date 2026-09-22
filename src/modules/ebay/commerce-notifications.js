const crypto = require('crypto');

// eBay's Notification API pushes (see api/ebay.notification-api.js): pure
// helpers for the webhook at /api/ebay/commerce-notifications.
//
//   - the endpoint check: eBay GETs ?challenge_code=… when a destination is
//     created and expects sha256(challengeCode + verificationToken + endpoint);
//   - the signature: X-EBAY-SIGNATURE is base64 JSON { alg, kid, signature,
//     digest }; the signature (base64, ECDSA) covers the JSON body, checked
//     with eBay's public key `kid` (fetched and cached by the client);
//   - the payload: { metadata: { topic, schemaVersion }, notification:
//     { notificationId, eventDate, publishDate, publishAttemptCount, data } }.
//     ORDER_CONFIRMATION's data: { user: { userId, username }, order:
//     { orderId, orderLineItems: [{ orderLineItemId, listingId, quantity }] } };
//     LISTING's: { listingId, reason: CREATED | UPDATED | ENDED, user }.

function challengeResponse(challengeCode, verificationToken, endpoint) {
  return crypto.createHash('sha256').update(String(challengeCode)).update(verificationToken).update(endpoint).digest('hex');
}

/** eBay returns the key on one line; Node wants PEM with line breaks. */
function formatKey(key) {
  const match = String(key).match(/-----BEGIN PUBLIC KEY-----\s*([\s\S]*?)\s*-----END PUBLIC KEY-----/);
  if (!match) return key;
  const body = match[1].replace(/\s+/g, '');
  return `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
}

function decodeSignatureHeader(header) {
  try {
    const parsed = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'));
    return parsed && parsed.kid && parsed.signature ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a notification really comes from eBay. `getKey(kid)` resolves to
 * eBay's { key, algorithm, digest }. The body is checked as received and,
 * failing that, re-serialised (eBay signs its compact JSON).
 */
async function verifySignature(rawBody, header, getKey) {
  const sig = decodeSignatureHeader(header);
  if (!sig || !rawBody) return false;
  const publicKey = await getKey(sig.kid);
  if (!publicKey?.key) return false;
  const digest = String(publicKey.digest || sig.digest || 'SHA1').toLowerCase().replace('-', '');
  const key = formatKey(publicKey.key);
  const signature = Buffer.from(sig.signature, 'base64');
  const bodies = [rawBody];
  try {
    const compact = JSON.stringify(JSON.parse(rawBody));
    if (compact !== rawBody) bodies.push(compact);
  } catch {
    return false;
  }
  return bodies.some((body) => {
    try {
      return crypto.verify(digest, Buffer.from(body, 'utf8'), key, signature);
    } catch {
      return false;
    }
  });
}

/** What Liston needs from a notification, or null when it isn't one. */
function parseNotification(payload) {
  const topic = payload?.metadata?.topic;
  const n = payload?.notification;
  if (!topic || !n) return null;
  const data = n.data || {};
  const user = data.user || {};
  const order = data.order || {};
  return {
    topic: String(topic),
    notificationId: n.notificationId ? String(n.notificationId) : null,
    eventDate: n.eventDate || null,
    attempt: Number(n.publishAttemptCount || 1),
    seller: { userId: user.userId ? String(user.userId) : data.publicUserId ? String(data.publicUserId) : null, username: user.username ? String(user.username) : data.username ? String(data.username) : null },
    orderId: order.orderId ? String(order.orderId) : data.orderId ? String(data.orderId) : null,
    listingId: data.listingId ? String(data.listingId) : null,
    reason: data.reason ? String(data.reason).toUpperCase() : null,
    lineItems: (order.orderLineItems || []).map((li) => ({ lineItemId: li.orderLineItemId ? String(li.orderLineItemId) : null, listingId: li.listingId ? String(li.listingId) : null, quantity: Number(li.quantity || 1) })),
  };
}

module.exports = { challengeResponse, formatKey, decodeSignatureHeader, verifySignature, parseNotification };
