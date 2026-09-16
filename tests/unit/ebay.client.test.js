const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const ebayClient = require('../../src/modules/ebay/ebay.client');

function fakeJsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

test.afterEach(() => {
  mock.restoreAll();
});

test('getFulfillmentPolicies GETs the fulfillment_policy endpoint with the marketplace id and auth header', async () => {
  const fetchMock = mock.method(global, 'fetch', async (url, options) => {
    assert.ok(url.includes('/sell/account/v1/fulfillment_policy'));
    assert.ok(url.includes('marketplace_id=EBAY_GB'));
    assert.strictEqual(options.method, 'GET');
    assert.strictEqual(options.headers.Authorization, 'Bearer tok-1');
    return fakeJsonResponse({ fulfillmentPolicies: [{ fulfillmentPolicyId: 'f1' }] });
  });

  const result = await ebayClient.getFulfillmentPolicies('tok-1', 'EBAY_GB');

  assert.strictEqual(fetchMock.mock.calls.length, 1);
  assert.deepStrictEqual(result.fulfillmentPolicies, [{ fulfillmentPolicyId: 'f1' }]);
});

test('getPaymentPolicies GETs the payment_policy endpoint with the marketplace id', async () => {
  mock.method(global, 'fetch', async (url) => {
    assert.ok(url.includes('/sell/account/v1/payment_policy?marketplace_id=EBAY_US'));
    return fakeJsonResponse({ paymentPolicies: [] });
  });

  const result = await ebayClient.getPaymentPolicies('tok-1', 'EBAY_US');
  assert.deepStrictEqual(result.paymentPolicies, []);
});

test('getReturnPolicies GETs the return_policy endpoint with the marketplace id', async () => {
  mock.method(global, 'fetch', async (url) => {
    assert.ok(url.includes('/sell/account/v1/return_policy?marketplace_id=EBAY_US'));
    return fakeJsonResponse({ returnPolicies: [] });
  });

  const result = await ebayClient.getReturnPolicies('tok-1', 'EBAY_US');
  assert.deepStrictEqual(result.returnPolicies, []);
});

test('a non-2xx policy response throws EbayApiError with eBay\'s error message', async () => {
  mock.method(global, 'fetch', async () => fakeJsonResponse({ errors: [{ message: 'Invalid marketplace' }] }, 400));

  await assert.rejects(
    () => ebayClient.getFulfillmentPolicies('tok-1', 'BAD'),
    (err) => err instanceof ebayClient.EbayApiError && err.message === 'Invalid marketplace'
  );
});

// A SKU/offer's marketplace visibility is tied to the Content-Language of the
// write calls that created it — confirmed live: en-US headers made a SKU
// invisible to EBAY_GB's createOffer (errorId 25751), en-GB headers fixed it.
test('createOrReplaceInventoryItem sends en-GB Content-Language/Accept-Language for EBAY_GB', async () => {
  mock.method(global, 'fetch', async (url, options) => {
    assert.strictEqual(options.headers['Content-Language'], 'en-GB');
    assert.strictEqual(options.headers['Accept-Language'], 'en-GB');
    return fakeJsonResponse({}, 204);
  });

  await ebayClient.createOrReplaceInventoryItem('tok-1', 'sku-1', { condition: 'NEW' }, 'EBAY_GB');
});

test('createOrReplaceInventoryItem defaults to en-US when no marketplaceId is given', async () => {
  mock.method(global, 'fetch', async (url, options) => {
    assert.strictEqual(options.headers['Content-Language'], 'en-US');
    assert.strictEqual(options.headers['Accept-Language'], 'en-US');
    return fakeJsonResponse({}, 204);
  });

  await ebayClient.createOrReplaceInventoryItem('tok-1', 'sku-1', { condition: 'NEW' });
});

test('createOffer derives the locale from offer.marketplaceId', async () => {
  mock.method(global, 'fetch', async (url, options) => {
    assert.strictEqual(options.headers['Content-Language'], 'en-GB');
    assert.strictEqual(options.headers['Accept-Language'], 'en-GB');
    return fakeJsonResponse({ offerId: 'o1' });
  });

  const result = await ebayClient.createOffer('tok-1', { sku: 'sku-1', marketplaceId: 'EBAY_GB' });
  assert.strictEqual(result.offerId, 'o1');
});

test('publishOfferByInventoryItemGroup sends the matching marketplace locale', async () => {
  mock.method(global, 'fetch', async (url, options) => {
    assert.strictEqual(options.headers['Content-Language'], 'de-DE');
    return fakeJsonResponse({ listingId: 'l1' });
  });

  const result = await ebayClient.publishOfferByInventoryItemGroup('tok-1', 'group-1', 'EBAY_DE');
  assert.strictEqual(result.listingId, 'l1');
});
