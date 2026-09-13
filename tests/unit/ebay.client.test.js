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
