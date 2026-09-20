const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const ebayFulfillment = require('../../src/modules/ebay/ebay.fulfillment');
const ebayOauth = require('../../src/modules/ebay/ebay.oauth');

test('scopes: new tokens carry the order scopes, legacy ones refresh with what they had', () => {
  assert.ok(ebayOauth.SCOPES.includes(ebayOauth.SCOPE_FULFILLMENT));
  assert.strictEqual(ebayOauth.hasScope({ accessToken: 'a' }, ebayOauth.SCOPE_FULFILLMENT), false);
  assert.strictEqual(ebayOauth.hasScope({ scopes: ebayOauth.SCOPES }, ebayOauth.SCOPE_FULFILLMENT), true);
  assert.deepStrictEqual(ebayOauth.grantedScopes({}), ebayOauth.LEGACY_SCOPES);
});

test('mapOrder turns a Fulfillment order into the detail shape', () => {
  const raw = {
    orderId: '14-15180-83196',
    legacyOrderId: '14-15180-83196',
    salesRecordReference: '1234',
    creationDate: '2026-09-20T00:12:00.000Z',
    orderPaymentStatus: 'PAID',
    orderFulfillmentStatus: 'NOT_STARTED',
    buyer: { username: 'jexcell' },
    buyerCheckoutNotes: 'Leave with neighbour',
    cancelStatus: { cancelState: 'NONE_REQUESTED', cancelRequests: [] },
    fulfillmentStartInstructions: [
      {
        shippingStep: { shippingServiceCode: 'UK_RoyalMailSecondClass', shipTo: { fullName: 'Jonathan Excell', contactAddress: { addressLine1: '1 Worthing road', city: 'Horsham', postalCode: 'RH13 8NQ', countryCode: 'GB' }, primaryPhone: { phoneNumber: '+447935037706' } } },
        minEstimatedDeliveryDate: '2026-09-23T00:00:00.000Z',
        maxEstimatedDeliveryDate: '2026-09-25T00:00:00.000Z',
      },
    ],
    pricingSummary: { priceSubtotal: { value: '4.64', currency: 'GBP' }, deliveryCost: { value: '0.0', currency: 'GBP' }, total: { value: '4.64', currency: 'GBP' } },
    paymentSummary: { payments: [{ paymentMethod: 'EBAY', paymentStatus: 'PAID', amount: { value: '4.64', currency: 'GBP' }, paymentDate: '2026-09-20T00:12:10.000Z' }], refunds: [], totalDueSeller: { value: '4.01', currency: 'GBP' } },
    lineItems: [
      { lineItemId: '10012345678901', legacyItemId: '407074105960', sku: 'Liston-1-AB12', title: 'Trimmer Oil', quantity: 1, lineItemCost: { value: '4.64', currency: 'GBP' }, total: { value: '4.64', currency: 'GBP' }, variationAspects: [{ name: 'ML', value: '60ml' }], lineItemFulfillmentStatus: 'NOT_STARTED', lineItemFulfillmentInstructions: { shipByDate: '2026-09-25T00:00:00.000Z' } },
    ],
  };
  const order = ebayFulfillment.mapOrder(raw, [{ fulfillmentId: 'f1', shippingCarrierCode: 'Yodel', shipmentTrackingNumber: 'JJD1', shippedDate: '2026-09-21T00:00:00.000Z', lineItems: [{ lineItemId: '10012345678901', quantity: 1 }] }]);
  assert.strictEqual(order.buyer.username, 'jexcell');
  assert.strictEqual(order.buyerCheckoutNotes, 'Leave with neighbour');
  assert.strictEqual(order.shipTo.postalCode, 'RH13 8NQ');
  assert.strictEqual(order.shipTo.phone, '+447935037706');
  assert.strictEqual(order.shippingService, 'UK_RoyalMailSecondClass');
  assert.deepStrictEqual(order.pricing.total, { value: 4.64, currency: 'GBP' });
  assert.deepStrictEqual(order.totalDueSeller, { value: 4.01, currency: 'GBP' });
  assert.strictEqual(order.lineItems[0].lineItemId, '10012345678901');
  assert.strictEqual(order.lineItems[0].itemId, '407074105960');
  assert.deepStrictEqual(order.lineItems[0].variation, [{ name: 'ML', value: '60ml' }]);
  assert.strictEqual(order.lineItems[0].shipByDate, '2026-09-25T00:00:00.000Z');
  assert.strictEqual(order.fulfillments[0].trackingNumber, 'JJD1');
});

test('createShippingFulfillment posts the line items with carrier and tracking to apiz', async () => {
  let captured;
  const fetchMock = mock.method(global, 'fetch', async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 201, json: async () => ({ fulfillmentId: 'ful-9' }) };
  });
  try {
    const res = await ebayFulfillment.createShippingFulfillment('tok', '14-1', { lineItems: [{ lineItemId: '1', quantity: 1 }], shippingCarrierCode: 'Evri', trackingNumber: 'H06R4A0218426976' }, 'EBAY_GB');
    assert.strictEqual(res.fulfillmentId, 'ful-9');
    assert.match(captured.url, /^https:\/\/apiz\.(sandbox\.)?ebay\.com\/sell\/fulfillment\/v1\/order\/14-1\/shipping_fulfillment$/);
    assert.deepStrictEqual(captured.body, { lineItems: [{ lineItemId: '1', quantity: 1 }], shippingCarrierCode: 'Evri', trackingNumber: 'H06R4A0218426976' });
  } finally {
    fetchMock.mock.restore();
  }
});

test('a 403 insufficient-permissions answer is surfaced as a missing scope', async () => {
  const fetchMock = mock.method(global, 'fetch', async () => ({ ok: false, status: 403, json: async () => ({ errors: [{ errorId: 1100, message: 'Access denied', longMessage: 'Insufficient permissions to fulfill the request.' }] }) }));
  try {
    await assert.rejects(() => ebayFulfillment.getOrder('tok', '14-1', 'EBAY_GB'), (err) => err.code === 'EBAY_SCOPE_MISSING' && err.statusCode === 403);
  } finally {
    fetchMock.mock.restore();
  }
});
