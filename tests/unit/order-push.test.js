const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const commerce = require('../../src/modules/ebay/commerce-notifications');
const ebayFulfillment = require('../../src/modules/ebay/api/ebay.fulfillment');
const ebayService = require('../../src/modules/ebay/ebay.service');

// eBay signs each push with an ECDSA key it publishes one-line (no breaks);
// the header is base64 JSON naming the key.
function signer() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).replace(/\n/g, '');
  const header = (body, kid = 'k1') =>
    Buffer.from(JSON.stringify({ alg: 'ECDSA', kid, signature: crypto.sign('sha1', Buffer.from(body), privateKey).toString('base64'), digest: 'SHA1' })).toString('base64');
  return { header, getKey: async (kid) => (kid === 'k1' ? { key: pem, algorithm: 'ECDSA', digest: 'SHA1' } : null) };
}

const ORDER_PUSH = {
  metadata: { topic: 'ORDER_CONFIRMATION', schemaVersion: '1.0', deprecated: false },
  notification: {
    notificationId: 'n-1',
    eventDate: '2026-09-22T17:04:00.000Z',
    publishDate: '2026-09-22T17:04:02.000Z',
    publishAttemptCount: 1,
    data: { user: { userId: 'u-123', username: 'seller1' }, order: { orderId: '12-34567-89012', orderLineItems: [{ orderLineItemId: 'li-1', listingId: '4071', quantity: 2 }] } },
  },
};

test('eBay’s endpoint check: sha256 of challenge code, token and endpoint', () => {
  const expected = crypto.createHash('sha256').update('abc' + 't'.repeat(40) + 'https://x.test/api/ebay/commerce-notifications').digest('hex');
  assert.strictEqual(commerce.challengeResponse('abc', 't'.repeat(40), 'https://x.test/api/ebay/commerce-notifications'), expected);
});

test('a push is accepted only with eBay’s signature over its body', async () => {
  const { header, getKey } = signer();
  const body = JSON.stringify(ORDER_PUSH);
  assert.strictEqual(await commerce.verifySignature(body, header(body), getKey), true);
  assert.strictEqual(await commerce.verifySignature(body.replace('12-34567', '99-34567'), header(body), getKey), false, 'a changed body');
  assert.strictEqual(await commerce.verifySignature(body, header(body, 'other'), getKey), false, 'an unknown key');
  assert.strictEqual(await commerce.verifySignature(body, 'not-a-header', getKey), false);
  assert.strictEqual(await commerce.verifySignature(body, undefined, getKey), false);
  // Signed compact, received pretty-printed: checked again as compact JSON.
  assert.strictEqual(await commerce.verifySignature(JSON.stringify(ORDER_PUSH, null, 2), header(body), getKey), true);
});

test('an order push names the seller, the order and its lines', () => {
  assert.deepStrictEqual(commerce.parseNotification(ORDER_PUSH), {
    topic: 'ORDER_CONFIRMATION',
    notificationId: 'n-1',
    eventDate: '2026-09-22T17:04:00.000Z',
    attempt: 1,
    seller: { userId: 'u-123', username: 'seller1' },
    orderId: '12-34567-89012',
    lineItems: [{ lineItemId: 'li-1', listingId: '4071', quantity: 2 }],
  });
  assert.strictEqual(commerce.parseNotification({ nothing: true }), null);
});

test('a Fulfillment order takes the order list’s (Trading) shape', () => {
  const order = ebayFulfillment.toListOrder({
    orderId: '12-34567-89012',
    creationDate: '2026-09-22T17:03:55.000Z',
    orderPaymentStatus: 'PAID',
    salesRecordReference: '493',
    cancelStatus: { cancelState: 'NONE_REQUESTED' },
    buyer: { username: 'buyer_1', buyerRegistrationAddress: { fullName: 'Ann Buyer', email: 'relay@members.ebay.com' } },
    pricingSummary: { priceSubtotal: { value: '9.00', currency: 'GBP' }, total: { value: '11.50', currency: 'GBP' } },
    paymentSummary: { payments: [{ paymentDate: '2026-09-22T17:04:00.000Z' }] },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: 'Ann Buyer', primaryPhone: { phoneNumber: '0700' }, contactAddress: { addressLine1: '1 High St', city: 'Leeds', postalCode: 'LS1 1AA', countryCode: 'GB' } } } }],
    lineItems: [
      {
        legacyItemId: '4071',
        title: 'Garden light',
        quantity: 2,
        lineItemCost: { value: '9.00', currency: 'GBP' },
        variationAspects: [{ name: 'Colour', value: 'Black' }],
        lineItemFulfillmentInstructions: { shipByDate: '2026-09-24T22:59:59.000Z', minEstimatedDeliveryDate: '2026-09-25T00:00:00.000Z', maxEstimatedDeliveryDate: '2026-09-27T00:00:00.000Z' },
      },
    ],
  });
  assert.deepStrictEqual(
    [order.status, order.checkoutStatus, order.cancelStatus, order.buyerUserId, order.buyerName, order.salesRecordNumber, order.itemId, order.itemCount],
    ['Completed', 'Complete', 'NotApplicable', 'buyer_1', 'Ann Buyer', '493', '4071', 1]
  );
  assert.deepStrictEqual(order.total, { amount: 11.5, currency: 'GBP' });
  assert.deepStrictEqual(order.lineItems[0].price, { amount: 4.5, currency: 'GBP' }, 'the unit price, as Trading gives it');
  assert.strictEqual(order.lineItems[0].quantityPurchased, 2);
  assert.strictEqual(order.dispatchByTime, '2026-09-24T22:59:59.000Z');
  assert.strictEqual(order.shippingAddress.country, 'United Kingdom', 'the country name, as Trading gives it');
  assert.strictEqual(order.shippedTime, null);
});

test('push is trusted only while it is actually arriving, per kind', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const hoursAgo = (h) => new Date(now - h * 3600e3).toISOString();
  const conn = (ebay) => ({ settings: { ebay } });
  assert.deepStrictEqual(ebayService.pushEnabled(conn({ notificationsEnabledAt: hoursAgo(500) }), now), { listings: false, orders: false }, 'subscribed, nothing ever received');
  assert.deepStrictEqual(ebayService.pushEnabled(conn({ notificationsEnabledAt: hoursAgo(500), lastPushAt: hoursAgo(3) }), now), { listings: true, orders: false });
  assert.deepStrictEqual(ebayService.pushEnabled(conn({ orderPush: { subscriptionId: 's1', lastReceivedAt: hoursAgo(20) } }), now), { listings: false, orders: true });
  assert.deepStrictEqual(ebayService.pushEnabled(conn({ orderPush: { subscriptionId: 's1', lastReceivedAt: hoursAgo(72) } }), now).orders, false, 'silent for three days');
  assert.deepStrictEqual(ebayService.pushEnabled(null, now), { listings: false, orders: false });
});
