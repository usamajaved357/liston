const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const connectionService = require('../../src/modules/connections/connection.service');
const ebayService = require('../../src/modules/ebay/ebay.service');
const listingRepository = require('../../src/modules/listings/listing.repository');
const orchestrator = require('../../src/modules/ai-generation/generation.orchestrator');
const listingService = require('../../src/modules/listings/listing.service');

const CONNECTION_ID = 'conn-1';
const USER_ID = 'user-1';

function ebayConnection(overrides = {}) {
  return {
    id: CONNECTION_ID,
    user_id: USER_ID,
    platform_key: 'ebay',
    platform_name: 'eBay',
    settings: {
      ebay: {
        marketplaceId: 'EBAY_GB',
        fulfillmentPolicyId: 'f1',
        paymentPolicyId: 'p1',
        returnPolicyId: 'r1',
        merchantLocationKey: 'main',
      },
    },
    credentials: { accessToken: 'token' },
    ...overrides,
  };
}

test.afterEach(() => {
  mock.restoreAll();
});

test('createEbayDraft resolves policies from connection settings and persists the draft row', async () => {
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => {
    assert.strictEqual(id, CONNECTION_ID);
    assert.strictEqual(userId, USER_ID);
    return action({ accessToken: 'token' }, ebayConnection());
  });
  const draftListingMock = mock.method(ebayService, 'draftListing', async (credentials, input) => {
    assert.deepStrictEqual(input.listingPolicies, { fulfillmentPolicyId: 'f1', paymentPolicyId: 'p1', returnPolicyId: 'r1' });
    assert.strictEqual(input.marketplaceId, 'EBAY_GB');
    return { offerId: 'offer-1', status: 'drafted' };
  });
  const createDraftMock = mock.method(listingRepository, 'createDraft', async (row) => ({ id: 'listing-1', ...row }));

  const draftInput = {
    sku: 'SKU-1',
    title: 'Widget',
    description: 'A widget',
    imageUrls: ['https://example.com/a.jpg'],
    quantity: 1,
    categoryId: '12345',
    price: { value: '9.99', currency: 'GBP' },
    merchantLocationKey: 'main',
  };

  const result = await listingService.createEbayDraft(CONNECTION_ID, USER_ID, draftInput);

  assert.strictEqual(draftListingMock.mock.calls.length, 1);
  assert.strictEqual(createDraftMock.mock.calls.length, 1);
  assert.strictEqual(createDraftMock.mock.calls[0].arguments[0].platformOfferId, 'offer-1');
  assert.strictEqual(createDraftMock.mock.calls[0].arguments[0].sku, 'SKU-1');
  assert.strictEqual(result.id, 'listing-1');
});

test('createEbayDraft refuses to draft when the connection has no policies configured', async () => {
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => {
    return action({ accessToken: 'token' }, ebayConnection({ settings: {} }));
  });

  await assert.rejects(
    () => listingService.createEbayDraft(CONNECTION_ID, USER_ID, { sku: 'SKU-2' }),
    /default business policies/i
  );
});

test('publish rejects a listing that is not pending_review', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => ({
    id: 'listing-1',
    connection_id: CONNECTION_ID,
    status: 'published',
    platform_offer_id: 'offer-1',
  }));

  await assert.rejects(() => listingService.publish('listing-1', USER_ID), /pending review/i);
});

test('publish calls publishDraft for a single-SKU listing and updates status', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => ({
    id: 'listing-1',
    connection_id: CONNECTION_ID,
    status: 'pending_review',
    platform_offer_id: 'offer-1',
    platform_group_key: null,
    generated_data: { marketplaceId: 'EBAY_GB' },
  }));
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 'token' }, ebayConnection()));
  const publishDraftMock = mock.method(ebayService, 'publishDraft', async (credentials, offerId) => {
    assert.strictEqual(offerId, 'offer-1');
    return { externalProductId: 'listing-999', status: 'published' };
  });
  const updateStatusMock = mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  const result = await listingService.publish('listing-1', USER_ID);

  assert.strictEqual(publishDraftMock.mock.calls.length, 1);
  assert.strictEqual(updateStatusMock.mock.calls[0].arguments[1], 'published');
  assert.strictEqual(result.externalProductId, 'listing-999');
});

test('generateEbayDraftFromUrls assigns a SKU, forwards sourceData, and creates a single-SKU draft', async () => {
  mock.method(connectionService, 'getConnectionSummary', async () => ebayConnection());
  mock.method(orchestrator, 'generateDraftInput', async (input) => {
    assert.strictEqual(input.merchantLocationKey, 'main');
    return {
      draftInput: {
        title: 'Widget',
        description: 'desc',
        imageUrls: ['https://example.com/a.jpg'],
        aspects: { Colour: ['Black'] },
        condition: 'NEW',
        quantity: 1,
        categoryId: '123',
        price: { value: '15', currency: 'GBP' },
        merchantLocationKey: 'main',
      },
      competitor: { title: 'Competitor' },
      source: { title: 'Source' },
    };
  });
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 'token' }, ebayConnection()));
  mock.method(ebayService, 'draftListing', async () => ({ offerId: 'offer-1', status: 'drafted' }));
  const createDraftMock = mock.method(listingRepository, 'createDraft', async (row) => ({ id: 'listing-1', ...row }));

  await listingService.generateEbayDraftFromUrls(CONNECTION_ID, USER_ID, {
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://www.aliexpress.com/item/1234567890.html',
    costPrice: 5,
    sellPrice: 15,
    currency: 'GBP',
  });

  const call = createDraftMock.mock.calls[0].arguments[0];
  assert.match(call.sku, /^AE1234567890-[0-9a-f]{6}$/);
  assert.deepStrictEqual(call.sourceData, { competitor: { title: 'Competitor' }, source: { title: 'Source' }, costPrice: 5 });
});

test('generateEbayDraftFromUrls assigns per-variant SKUs and a group key for a variation draft', async () => {
  mock.method(connectionService, 'getConnectionSummary', async () => ebayConnection());
  mock.method(orchestrator, 'generateDraftInput', async () => ({
    draftInput: {
      commonTitle: 'Widget',
      commonDescription: 'desc',
      imageUrls: ['https://example.com/a.jpg'],
      variesBy: { aspects: {}, aspectsImageVariesBy: ['Colour'], specifications: [{ name: 'Colour', values: ['Black', 'Red'] }] },
      variants: [
        { imageUrls: ['https://example.com/black.jpg'], aspects: { Colour: ['Black'] }, condition: 'NEW', quantity: 1, price: { value: '15', currency: 'GBP' } },
        { imageUrls: ['https://example.com/red.jpg'], aspects: { Colour: ['Red'] }, condition: 'NEW', quantity: 1, price: { value: '15', currency: 'GBP' } },
      ],
      categoryId: '123',
      merchantLocationKey: 'main',
    },
    competitor: { title: 'Competitor' },
    source: { title: 'Source' },
  }));
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 'token' }, ebayConnection()));
  mock.method(ebayService, 'draftVariationListing', async (credentials, input) => {
    assert.strictEqual(input.variants.length, 2);
    assert.ok(input.variants.every((v) => v.sku));
    return { groupKey: input.groupKey, status: 'drafted' };
  });
  const createDraftMock = mock.method(listingRepository, 'createDraft', async (row) => ({ id: 'listing-1', ...row }));

  await listingService.generateEbayDraftFromUrls(CONNECTION_ID, USER_ID, {
    competitorUrl: 'https://ebay.co.uk/itm/1',
    sourceUrl: 'https://www.aliexpress.com/item/1234567890.html',
    costPrice: 5,
    sellPrice: 15,
    currency: 'GBP',
  });

  const call = createDraftMock.mock.calls[0].arguments[0];
  assert.strictEqual(call.sku, null);
  assert.match(call.platformGroupKey, /^AE1234567890-[0-9a-f]{6}$/);
});

test('generateEbayDraftFromUrls refuses to draft when the shipping location is not configured', async () => {
  mock.method(connectionService, 'getConnectionSummary', async () => ebayConnection({ settings: { ebay: { fulfillmentPolicyId: 'f1' } } }));

  await assert.rejects(
    () =>
      listingService.generateEbayDraftFromUrls(CONNECTION_ID, USER_ID, {
        competitorUrl: 'https://ebay.co.uk/itm/1',
        sourceUrl: 'https://www.aliexpress.com/item/1.html',
        costPrice: 5,
        sellPrice: 15,
        currency: 'GBP',
      }),
    /shipping location/i
  );
});
