const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const ebayClient = require('../../src/modules/ebay/ebay.client');
const ebayOauth = require('../../src/modules/ebay/ebay.oauth');
const ebayService = require('../../src/modules/ebay/ebay.service');

function freshCredentials(overrides = {}) {
  return {
    accessToken: 'valid-access-token',
    accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    refreshToken: 'refresh-token',
    refreshTokenExpiresAt: Date.now() + 1000 * 60 * 60 * 24 * 300,
    ...overrides,
  };
}

test.afterEach(() => {
  mock.restoreAll();
});

test('ensureValidAccessToken reuses the token when it is not close to expiry', async () => {
  const refreshMock = mock.method(ebayOauth, 'refreshAccessToken', async () => {
    throw new Error('should not be called');
  });

  const credentials = freshCredentials();
  const result = await ebayService.ensureValidAccessToken(credentials);

  assert.strictEqual(result.accessToken, 'valid-access-token');
  assert.strictEqual(result.credentialsChanged, false);
  assert.strictEqual(refreshMock.mock.calls.length, 0);
});

test('ensureValidAccessToken refreshes when the token is expired', async () => {
  mock.method(ebayOauth, 'refreshAccessToken', async (refreshToken) => {
    assert.strictEqual(refreshToken, 'refresh-token');
    return {
      accessToken: 'new-access-token',
      accessTokenExpiresAt: Date.now() + 7200 * 1000,
      refreshToken: 'refresh-token',
    };
  });

  const credentials = freshCredentials({ accessTokenExpiresAt: Date.now() - 1000 });
  const result = await ebayService.ensureValidAccessToken(credentials);

  assert.strictEqual(result.accessToken, 'new-access-token');
  assert.strictEqual(result.credentialsChanged, true);
});

test('ensureValidAccessToken throws a clear error when there is no refresh token to fall back on', async () => {
  const credentials = freshCredentials({ accessTokenExpiresAt: Date.now() - 1000, refreshToken: undefined });
  await assert.rejects(() => ebayService.ensureValidAccessToken(credentials), /reconnect the account/);
});

test('draftListing creates the inventory item and offer, and reports drafted status', async () => {
  const calls = [];
  mock.method(ebayClient, 'getInventoryLocations', async () => ({ locations: [{ merchantLocationKey: 'main' }] }));
  mock.method(ebayClient, 'createOrReplaceInventoryItem', async (token, sku, item) => {
    calls.push(['createOrReplaceInventoryItem', sku, item]);
  });
  mock.method(ebayClient, 'createOffer', async (token, offer) => {
    calls.push(['createOffer', offer]);
    return { offerId: 'offer-1' };
  });

  const result = await ebayService.draftListing(freshCredentials(), {
    sku: 'SKU-1',
    title: 'Great Widget',
    description: 'A widget',
    imageUrls: ['https://example.com/a.jpg'],
    aspects: { Brand: ['Acme'] },
    quantity: 5,
    marketplaceId: 'EBAY_US',
    categoryId: '12345',
    price: { value: '19.99', currency: 'USD' },
    merchantLocationKey: 'main',
  });

  assert.strictEqual(result.offerId, 'offer-1');
  assert.strictEqual(result.status, 'drafted');
  assert.strictEqual(calls[0][0], 'createOrReplaceInventoryItem');
  assert.strictEqual(calls[0][1], 'SKU-1');
  assert.strictEqual(calls[1][0], 'createOffer');
  assert.strictEqual(calls[1][1].sku, 'SKU-1');
  assert.strictEqual(calls[1][1].pricingSummary.price.value, '19.99');
});

test('draftListing refuses to fabricate a merchant location when none exists and none was supplied', async () => {
  mock.method(ebayClient, 'getInventoryLocations', async () => ({ locations: [] }));

  await assert.rejects(
    () =>
      ebayService.draftListing(freshCredentials(), {
        sku: 'SKU-2',
        title: 'Widget',
        description: 'desc',
        imageUrls: [],
        quantity: 1,
        price: { value: '10.00', currency: 'USD' },
        merchantLocationKey: 'main',
        // no locationInput supplied
      }),
    /inventory location/i
  );
});

test('draftListing creates the missing merchant location when locationInput is supplied', async () => {
  mock.method(ebayClient, 'getInventoryLocations', async () => ({ locations: [] }));
  const createLocation = mock.method(ebayClient, 'createInventoryLocation', async () => ({}));
  mock.method(ebayClient, 'createOrReplaceInventoryItem', async () => {});
  mock.method(ebayClient, 'createOffer', async () => ({ offerId: 'offer-2' }));

  await ebayService.draftListing(freshCredentials(), {
    sku: 'SKU-3',
    title: 'Widget',
    description: 'desc',
    imageUrls: [],
    quantity: 1,
    price: { value: '10.00', currency: 'USD' },
    merchantLocationKey: 'main',
    locationInput: { country: 'US', postalCode: '10001' },
  });

  assert.strictEqual(createLocation.mock.calls.length, 1);
});

test('publishDraft calls publishOffer and returns the external listing id', async () => {
  mock.method(ebayClient, 'publishOffer', async (token, offerId) => {
    assert.strictEqual(offerId, 'offer-1');
    return { listingId: 'listing-999' };
  });

  const result = await ebayService.publishDraft(freshCredentials(), 'offer-1');
  assert.strictEqual(result.externalProductId, 'listing-999');
  assert.strictEqual(result.status, 'published');
});
