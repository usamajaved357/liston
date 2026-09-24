const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const ebayClient = require('../../src/modules/ebay/api/ebay.client');
const ebayOauth = require('../../src/modules/ebay/api/ebay.oauth');
const ebayTrading = require('../../src/modules/ebay/api/ebay.trading');
const ebayService = require('../../src/modules/ebay/ebay.service');

function validListingPolicies() {
  return {
    fulfillmentPolicyId: 'fulfillment-1',
    paymentPolicyId: 'payment-1',
    returnPolicyId: 'return-1',
  };
}

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
  await assert.rejects(() => ebayService.ensureValidAccessToken(credentials), /Reconnect the account/);
});

test('createOfferWithRetry retries on the SKU-propagation-delay error and eventually succeeds', async () => {
  let attempts = 0;
  mock.method(ebayClient, 'createOffer', async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error('AE123-1 could not be found or is not available in the system for the marketplace EBAY_GB.');
    }
    return { offerId: 'offer-1' };
  });

  const result = await ebayService.createOfferWithRetry('token', { sku: 'AE123-1' }, 5, 1);

  assert.strictEqual(attempts, 3);
  assert.strictEqual(result.offerId, 'offer-1');
});

test('createOfferWithRetry does not retry a non-propagation-delay error', async () => {
  mock.method(ebayClient, 'createOffer', async () => {
    throw new Error('Category ID is invalid.');
  });

  await assert.rejects(() => ebayService.createOfferWithRetry('token', {}, 5, 1), /Category ID is invalid/);
});

test('createOfferWithRetry gives up and throws after exhausting all attempts', async () => {
  let attempts = 0;
  mock.method(ebayClient, 'createOffer', async () => {
    attempts += 1;
    throw new Error('SKU could not be found for the marketplace EBAY_GB.');
  });

  await assert.rejects(() => ebayService.createOfferWithRetry('token', {}, 3, 1), /could not be found/);
  assert.strictEqual(attempts, 3);
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
    listingPolicies: validListingPolicies(),
  });

  assert.strictEqual(result.offerId, 'offer-1');
  assert.strictEqual(result.status, 'drafted');
  assert.strictEqual(calls[0][0], 'createOrReplaceInventoryItem');
  assert.strictEqual(calls[0][1], 'SKU-1');
  assert.strictEqual(calls[1][0], 'createOffer');
  assert.strictEqual(calls[1][1].sku, 'SKU-1');
  assert.strictEqual(calls[1][1].pricingSummary.price.value, '19.99');
  assert.deepStrictEqual(calls[1][1].listingPolicies, validListingPolicies());
});

test('draftListing refuses to create an offer when no default business policies are selected', async () => {
  await assert.rejects(
    () =>
      ebayService.draftListing(freshCredentials(), {
        sku: 'SKU-1b',
        title: 'Widget',
        description: 'desc',
        imageUrls: [],
        quantity: 1,
        price: { value: '10.00', currency: 'USD' },
        merchantLocationKey: 'main',
        // no listingPolicies supplied
      }),
    /default business policies/i
  );
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
        listingPolicies: validListingPolicies(),
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
    listingPolicies: validListingPolicies(),
  });

  assert.strictEqual(createLocation.mock.calls.length, 1);
});

test('getBusinessPolicies fetches and normalizes all three policy types', async () => {
  mock.method(ebayClient, 'getFulfillmentPolicies', async (token, marketplaceId) => {
    assert.strictEqual(marketplaceId, 'EBAY_GB');
    return { fulfillmentPolicies: [{ fulfillmentPolicyId: 'f1', name: 'Standard' }] };
  });
  mock.method(ebayClient, 'getPaymentPolicies', async () => ({ paymentPolicies: [{ paymentPolicyId: 'p1', name: 'eBay Payments' }] }));
  mock.method(ebayClient, 'getReturnPolicies', async () => ({}));

  const result = await ebayService.getBusinessPolicies(freshCredentials(), 'EBAY_GB');

  assert.deepStrictEqual(result.fulfillmentPolicies, [{ fulfillmentPolicyId: 'f1', name: 'Standard' }]);
  assert.deepStrictEqual(result.paymentPolicies, [{ paymentPolicyId: 'p1', name: 'eBay Payments' }]);
  assert.deepStrictEqual(result.returnPolicies, []);
});

test('getMerchantLocations fetches and returns the connection\'s inventory locations', async () => {
  mock.method(ebayClient, 'getInventoryLocations', async (token) => {
    assert.strictEqual(token, 'valid-access-token');
    return { locations: [{ merchantLocationKey: 'main', name: 'Main warehouse' }] };
  });

  const result = await ebayService.getMerchantLocations(freshCredentials());

  assert.deepStrictEqual(result.locations, [{ merchantLocationKey: 'main', name: 'Main warehouse' }]);
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

function makeOrder(overrides = {}) {
  return {
    orderId: 'ORD-1',
    status: 'Completed',
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // inside every named range
    total: { amount: 10, currency: 'GBP' },
    subtotal: { amount: 10, currency: 'GBP' },
    buyerName: 'Jane Doe',
    buyerUserId: 'janedoe',
    itemTitle: 'Widget',
    itemId: '111',
    itemCount: 1,
    checkoutStatus: 'Complete',
    paidTime: '2026-01-05T00:05:00.000Z',
    shippedTime: '2026-01-06T00:00:00.000Z',
    cancelStatus: 'NotApplicable',
    dispatchByTime: null,
    lineItems: [{ itemId: '111', title: 'Widget', quantityPurchased: 1, price: { amount: 10, currency: 'GBP' }, variation: [], trackingCarrier: null, trackingNumber: null, handleByTime: null }],
    ...overrides,
  };
}

test('listOrdersDetailed classifies orders by payment/dispatch state and reports counts for the whole range', async () => {
  const awaitingPayment = makeOrder({ orderId: 'ORD-AP', checkoutStatus: 'Incomplete', shippedTime: null });
  const awaitingDispatch = makeOrder({ orderId: 'ORD-AD', shippedTime: null });
  const dispatched = makeOrder({ orderId: 'ORD-D' });
  const cancelled = makeOrder({ orderId: 'ORD-C', cancelStatus: 'CancelClosed' });
  const delivered = makeOrder({ orderId: 'ORD-DL', deliveredAt: '2026-01-08T10:00:00.000Z' });

  mock.method(ebayTrading, 'getOrders', async () => ({
    orders: [awaitingPayment, awaitingDispatch, dispatched, cancelled, delivered],
    totalEntries: 5,
    totalPages: 1,
  }));
  mock.method(ebayTrading, 'getItemSummary', async (token, itemId) => ({
    itemId,
    imageUrl: 'https://example.com/pic.jpg',
    quantity: 5,
    quantityAvailable: 3,
  }));

  const result = await ebayService.listOrdersDetailed(freshCredentials(), { connectionId: 'test-conn-1', range: '30d', status: 'all', search: '', page: 1, perPage: 25 });

  // A delivered order leaves Dispatched for its own tab.
  assert.deepStrictEqual(result.counts, { all: 5, awaiting_payment: 1, awaiting_dispatch: 1, dispatched: 1, delivered: 1, cancelled: 1 });
  assert.strictEqual(result.totalEntries, 5);
  assert.strictEqual(result.orders[0].lineItems[0].imageUrl, 'https://example.com/pic.jpg');
});

test('listOrdersDetailed filters by status and by search text (order id or item title)', async () => {
  const awaitingDispatch = makeOrder({ orderId: 'ORD-AD', shippedTime: null, itemTitle: 'Blue Widget', lineItems: [{ itemId: '111', title: 'Blue Widget', quantityPurchased: 1, price: null, variation: [], trackingCarrier: null, trackingNumber: null, handleByTime: null }] });
  const dispatched = makeOrder({ orderId: 'ORD-D', itemTitle: 'Red Gadget', lineItems: [{ itemId: '222', title: 'Red Gadget', quantityPurchased: 1, price: null, variation: [], trackingCarrier: null, trackingNumber: null, handleByTime: null }] });

  mock.method(ebayTrading, 'getOrders', async () => ({
    orders: [awaitingDispatch, dispatched],
    totalEntries: 2,
    totalPages: 1,
  }));
  mock.method(ebayTrading, 'getItemSummary', async (token, itemId) => ({ itemId, imageUrl: null, quantity: null, quantityAvailable: null }));

  const byStatus = await ebayService.listOrdersDetailed(freshCredentials(), { connectionId: 'test-conn-2', range: '30d', status: 'dispatched', search: '', page: 1, perPage: 25 });
  assert.strictEqual(byStatus.orders.length, 1);
  assert.strictEqual(byStatus.orders[0].orderId, 'ORD-D');

  const byOrderId = await ebayService.listOrdersDetailed(freshCredentials(), { connectionId: 'test-conn-2', range: '30d', status: 'all', search: 'ord-ad', page: 1, perPage: 25 });
  assert.strictEqual(byOrderId.orders.length, 1);
  assert.strictEqual(byOrderId.orders[0].orderId, 'ORD-AD');

  const byTitle = await ebayService.listOrdersDetailed(freshCredentials(), { connectionId: 'test-conn-2', range: '30d', status: 'all', search: 'gadget', page: 1, perPage: 25 });
  assert.strictEqual(byTitle.orders.length, 1);
  assert.strictEqual(byTitle.orders[0].orderId, 'ORD-D');
});

test('listOrdersDetailed caches the fetched order window per connection+range, so switching status/search/page does not re-hit eBay', async () => {
  const getOrdersMock = mock.method(ebayTrading, 'getOrders', async () => ({
    orders: [makeOrder({ orderId: 'ORD-CACHE' })],
    totalEntries: 1,
    totalPages: 1,
  }));
  mock.method(ebayTrading, 'getItemSummary', async (token, itemId) => ({ itemId, imageUrl: null, quantity: null, quantityAvailable: null }));

  const opts = { connectionId: 'test-conn-cache', range: '30d', status: 'all', search: '', page: 1, perPage: 25 };
  await ebayService.listOrdersDetailed(freshCredentials(), opts);
  await ebayService.listOrdersDetailed(freshCredentials(), { ...opts, status: 'dispatched' });
  await ebayService.listOrdersDetailed(freshCredentials(), { ...opts, search: 'widget' });

  assert.strictEqual(getOrdersMock.mock.calls.length, 1);
});

// eBay caps the inventory item's description at 4,000 characters; the
// branded HTML belongs on the offer. Confirmed live: "Invalid value for
// description. The length should be between 1 and 4000 characters."
test('buildInventoryItem strips HTML and caps at 4000 while buildOffer carries the HTML', () => {
  const { buildInventoryItem, buildOffer } = require('../../src/modules/ebay/ebay.service');
  const html = `<div class="eb">${'<p>lorem ipsum</p>'.repeat(600)}</div>`;
  const item = buildInventoryItem({ title: 'T', description: html, imageUrls: [], aspects: {}, condition: 'NEW', quantity: 1 });
  assert.ok(item.product.description.length <= 4000);
  assert.ok(!item.product.description.includes('<'));

  const offer = buildOffer({ sku: 's', categoryId: '1', description: 'plain', listingDescription: html, price: { value: '1', currency: 'GBP' }, merchantLocationKey: 'm', quantity: 1 });
  assert.strictEqual(offer.listingDescription, html);
  const fallback = buildOffer({ sku: 's', categoryId: '1', description: 'plain', price: { value: '1', currency: 'GBP' }, merchantLocationKey: 'm', quantity: 1 });
  assert.strictEqual(fallback.listingDescription, 'plain');
});

// A variation listing's item specifics live on the GROUP; each SKU carries
// only the varying aspect. Publishing with the shared aspects on the SKUs
// alone failed live with "The item specific Type is missing".
function variationInput(overrides = {}) {
  return {
    groupKey: 'G1',
    commonTitle: 'Hanger',
    commonDescription: 'plain',
    commonListingDescription: '<p>html</p>',
    imageUrls: ['https://example.com/a.jpg'],
    variesBy: { aspects: { Type: ['Clothes Drying Rack'], Brand: ['Unbranded'] }, aspectsImageVariesBy: ['Colour'], specifications: [{ name: 'Colour', values: ['Silver', 'Black'] }] },
    variants: [
      { sku: 'G1-1', imageUrls: ['https://example.com/s.jpg'], aspects: { Colour: ['Silver'] }, quantity: 1, price: { value: '9.99', currency: 'GBP' } },
      { sku: 'G1-2', imageUrls: ['https://example.com/b.jpg'], aspects: { Colour: ['Black'] }, quantity: 1, price: { value: '9.99', currency: 'GBP' } },
    ],
    marketplaceId: 'EBAY_GB',
    categoryId: '81241',
    merchantLocationKey: 'main',
    listingPolicies: validListingPolicies(),
    ...overrides,
  };
}

test('draftVariationListing drops the unpublished group a failed attempt left under the same key before rebuilding', async () => {
  const calls = [];
  mock.method(ebayClient, 'getInventoryLocations', async () => ({ locations: [{ merchantLocationKey: 'main' }] }));
  mock.method(ebayClient, 'getInventoryItemGroup', async () => ({ inventoryItemGroupKey: 'G1', variantSKUs: ['G1-1', 'G1-2'] }));
  mock.method(ebayClient, 'getOffersBySku', async () => ({ offers: [{ offerId: 'o1', status: 'UNPUBLISHED', marketplaceId: 'EBAY_GB' }] }));
  mock.method(ebayClient, 'deleteInventoryItemGroup', async () => calls.push('deleteGroup'));
  mock.method(ebayClient, 'createOrReplaceInventoryItem', async (token, sku) => calls.push(`item:${sku}`));
  mock.method(ebayClient, 'createOffer', async (token, offer) => ({ offerId: `offer-${offer.sku}` }));
  mock.method(ebayClient, 'createOrReplaceInventoryItemGroup', async () => calls.push('createGroup'));

  await ebayService.draftVariationListing(freshCredentials(), variationInput());

  assert.strictEqual(calls[0], 'deleteGroup', 'the stale group goes before any SKU is re-created');
  assert.strictEqual(calls[calls.length - 1], 'createGroup');
});

test('draftListing refuses a custom label that is already a live listing', async () => {
  mock.method(ebayClient, 'getInventoryLocations', async () => ({ locations: [{ merchantLocationKey: 'main' }] }));
  mock.method(ebayClient, 'getOffersBySku', async () => ({ offers: [{ offerId: 'o1', status: 'PUBLISHED', listing: { listingId: '999' } }] }));
  const put = mock.method(ebayClient, 'createOrReplaceInventoryItem', async () => {});
  await assert.rejects(
    () =>
      ebayService.draftListing(freshCredentials(), {
        sku: 'MY-LABEL',
        title: 't',
        description: 'd',
        imageUrls: ['https://example.com/a.jpg'],
        aspects: {},
        condition: 'NEW',
        quantity: 1,
        price: { value: '9.99', currency: 'GBP' },
        marketplaceId: 'EBAY_GB',
        categoryId: '1',
        merchantLocationKey: 'main',
        listingPolicies: validListingPolicies(),
      }),
    /"MY-LABEL" is already used by live listing 999/
  );
  assert.strictEqual(put.mock.calls.length, 0, 'the live item is never overwritten');
});

test('draftVariationListing refuses a custom label whose group is already a live listing', async () => {
  mock.method(ebayClient, 'getInventoryLocations', async () => ({ locations: [{ merchantLocationKey: 'main' }] }));
  mock.method(ebayClient, 'getInventoryItemGroup', async () => ({ inventoryItemGroupKey: 'G1', variantSKUs: ['G1-1'] }));
  mock.method(ebayClient, 'getOffersBySku', async () => ({ offers: [{ offerId: 'o1', status: 'PUBLISHED', listing: { listingId: '123456' } }] }));
  const del = mock.method(ebayClient, 'deleteInventoryItemGroup', async () => {});

  await assert.rejects(() => ebayService.draftVariationListing(freshCredentials(), variationInput()), /already used by live listing 123456/);
  assert.strictEqual(del.mock.calls.length, 0);
});

test('draftVariationListing puts shared aspects on the group and merged aspects on each SKU', async () => {
  let group = null;
  const items = [];
  mock.method(ebayClient, 'getInventoryItemGroup', async () => {
    throw new Error('not found');
  });
  mock.method(ebayClient, 'getInventoryLocations', async () => ({ locations: [{ merchantLocationKey: 'main' }] }));
  mock.method(ebayClient, 'createOrReplaceInventoryItem', async (token, sku, item) => {
    items.push([sku, item]);
  });
  mock.method(ebayClient, 'createOffer', async (token, offer) => ({ offerId: `offer-${offer.sku}` }));
  mock.method(ebayClient, 'createOrReplaceInventoryItemGroup', async (token, key, payload) => {
    group = payload;
  });

  await ebayService.draftVariationListing(freshCredentials(), {
    groupKey: 'G1',
    commonTitle: 'Hanger',
    commonDescription: 'plain',
    commonListingDescription: '<p>html</p>',
    imageUrls: ['https://example.com/a.jpg'],
    variesBy: { aspects: { Type: ['Clothes Drying Rack'], Brand: ['Unbranded'] }, aspectsImageVariesBy: ['Colour'], specifications: [{ name: 'Colour', values: ['Silver', 'Black'] }] },
    variants: [
      { sku: 'G1-1', imageUrls: ['https://example.com/s.jpg'], aspects: { Colour: ['Silver'] }, quantity: 1, price: { value: '9.99', currency: 'GBP' } },
      { sku: 'G1-2', imageUrls: ['https://example.com/b.jpg'], aspects: { Colour: ['Black'] }, quantity: 1, price: { value: '9.99', currency: 'GBP' } },
    ],
    marketplaceId: 'EBAY_GB',
    categoryId: '81241',
    merchantLocationKey: 'main',
    listingPolicies: validListingPolicies(),
  });

  assert.deepStrictEqual(group.aspects, { Type: ['Clothes Drying Rack'], Brand: ['Unbranded'] });
  assert.strictEqual(group.description, '<p>html</p>', 'the group carries the branded HTML — it becomes the live description');
  assert.deepStrictEqual(items[0][1].product.aspects, { Type: ['Clothes Drying Rack'], Brand: ['Unbranded'], Colour: ['Silver'] });
});

// --- the mirror: incremental orders ------------------------------------------

const mirror = require('../../src/modules/ebay/ebay-mirror.repository');

test('a second orders read asks eBay only for orders modified since the last sync and merges them', async () => {
  mock.method(mirror, 'loadSnapshot', async () => null);
  mock.method(mirror, 'upsertOrders', async () => {});
  mock.method(mirror, 'pruneOrdersBefore', async () => {});
  mock.method(mirror, 'saveSnapshot', async () => {});
  mock.method(mirror, 'loadItemSummaries', async () => new Map());
  mock.method(mirror, 'saveItemSummary', async () => {});
  mock.method(ebayTrading, 'getItemSummary', async (token, itemId) => ({ itemId, imageUrl: null, quantity: null, quantityAvailable: null }));

  const calls = [];
  const original = makeOrder({ orderId: 'ORD-1', shippedTime: null });
  const shipped = makeOrder({ orderId: 'ORD-1' }); // same order, now dispatched
  const brandNew = makeOrder({ orderId: 'ORD-2', createdAt: new Date().toISOString(), paidTime: new Date().toISOString() });
  mock.method(ebayTrading, 'getOrders', async (token, opts) => {
    calls.push(opts);
    if (opts.modTimeFrom) return { orders: [shipped, brandNew], totalEntries: 2, totalPages: 1 };
    return { orders: [original], totalEntries: 1, totalPages: 1 };
  });

  const connectionId = 'test-conn-incremental';
  const first = await ebayService.listOrdersDetailed(freshCredentials(), { connectionId, range: '90d', status: 'all', search: '', page: 1, perPage: 25 });
  assert.strictEqual(first.counts.awaiting_dispatch, 1);
  assert.ok(calls[0].createTimeFrom, 'first read is a full 90-day window');

  // Force the copy past its fresh window and read again: the refresh runs
  // behind the (still served) copy, then the merged set is visible.
  const svc = require('../../src/modules/ebay/ebay.service');
  svc.markAccountStale(connectionId);
  await ebayService.listOrdersDetailed(freshCredentials(), { connectionId, range: '90d', status: 'all', search: '', page: 1, perPage: 25 });
  await new Promise((r) => setTimeout(r, 20));
  const second = await ebayService.listOrdersDetailed(freshCredentials(), { connectionId, range: '90d', status: 'all', search: '', page: 1, perPage: 25 });

  const incremental = calls.find((c) => c.modTimeFrom);
  assert.ok(incremental, 'refresh used a modified-since window');
  assert.ok(!incremental.createTimeFrom);
  assert.strictEqual(second.counts.all, 2);
  assert.strictEqual(second.counts.awaiting_dispatch, 0);
  assert.strictEqual(second.counts.dispatched, 2);
});

// --- targeted background sync ---------------------------------------------

test('syncAccount re-reads only the requested kinds and coalesces a burst into one round', async () => {
  mock.method(mirror, 'loadSnapshot', async () => null);
  mock.method(mirror, 'saveSnapshot', async () => {});
  mock.method(mirror, 'upsertOrders', async () => {});
  mock.method(mirror, 'pruneOrdersBefore', async () => {});
  const listingCalls = mock.method(ebayTrading, 'getActiveListings', async () => ({ items: [], totalEntries: 0, totalPages: 1 }));
  mock.method(ebayTrading, 'getUnsoldListings', async () => ({ items: [], totalEntries: 0, totalPages: 1 }));
  const orderCalls = mock.method(ebayTrading, 'getOrders', async () => ({ orders: [], totalEntries: 0, totalPages: 1 }));

  const connectionId = 'test-conn-sync';
  // Three notifications land at once: one sync runs, one more is queued.
  await Promise.all([
    ebayService.syncAccount(freshCredentials(), connectionId, ['orders']),
    ebayService.syncAccount(freshCredentials(), connectionId, ['orders']),
    ebayService.syncAccount(freshCredentials(), connectionId, ['orders']),
  ]);
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(listingCalls.mock.calls.length, 0, 'an orders event never re-reads listings');
  assert.ok(orderCalls.mock.calls.length <= 2, `expected at most 2 order reads, got ${orderCalls.mock.calls.length}`);
});

test('applySale patches one listing from a single GetItem instead of re-reading the lists', async () => {
  const accountEvents = require('../../src/modules/ebay/account-events');
  mock.method(mirror, 'loadSnapshot', async () => null);
  const saved = mock.method(mirror, 'saveSnapshot', async () => {});
  const listReads = mock.method(ebayTrading, 'getActiveListings', async () => ({
    items: [
      { itemId: '1', title: 'a', quantity: 5, quantityAvailable: 5, quantitySold: 0 },
      { itemId: '2', title: 'b', quantity: 1, quantityAvailable: 1, quantitySold: 0 },
    ],
    totalEntries: 2,
    totalPages: 1,
  }));
  const itemReads = mock.method(ebayTrading, 'getItemSummary', async (token, itemId) =>
    itemId === '1'
      ? { itemId, quantity: 5, quantityAvailable: 4, quantitySold: 1, imageUrl: null }
      : { itemId, quantity: 1, quantityAvailable: 0, quantitySold: 1, imageUrl: null }
  );

  const connectionId = 'test-conn-sale';
  await ebayService.listListingsDetailed(freshCredentials(), { connectionId, status: 'active' });
  await ebayService.countActiveListings(freshCredentials(), connectionId);
  const readsBefore = listReads.mock.calls.length;
  const seen = [];
  const unsubscribe = accountEvents.subscribe(connectionId, (event) => seen.push(event.kind));
  try {
    // One unit of a stocked item sold.
    const first = await ebayService.applySale(freshCredentials(), connectionId, '1');
    assert.deepStrictEqual(first, { patched: true, soldOut: false });
    let page = await ebayService.listListingsDetailed(freshCredentials(), { connectionId, status: 'active' });
    assert.deepStrictEqual(
      page.items.map((l) => [l.itemId, l.quantityAvailable, l.quantitySold]),
      [['1', 4, 1], ['2', 1, 0]]
    );

    // The last unit of another item sold: it leaves the active list, the count follows.
    const second = await ebayService.applySale(freshCredentials(), connectionId, '2');
    assert.deepStrictEqual(second, { patched: true, soldOut: true });
    page = await ebayService.listListingsDetailed(freshCredentials(), { connectionId, status: 'active' });
    assert.deepStrictEqual(page.items.map((l) => l.itemId), ['1']);
    const count = await ebayService.countActiveListings(freshCredentials(), connectionId);
    assert.strictEqual(count.totalEntries, 1);

    assert.strictEqual(itemReads.mock.calls.length, 2, 'one GetItem per sale');
    assert.strictEqual(listReads.mock.calls.length, readsBefore, 'the lists were never re-read');
    assert.ok(seen.includes('listings') && seen.includes('activeCount'), 'open pages were told');
    assert.ok(saved.mock.calls.length >= 3, 'the patched copies were persisted');
  } finally {
    unsubscribe();
  }
});

test('applySale for an item not in the loaded copy marks the lists stale rather than guessing', async () => {
  mock.method(mirror, 'loadSnapshot', async () => null);
  mock.method(mirror, 'saveSnapshot', async () => {});
  const listReads = mock.method(ebayTrading, 'getActiveListings', async () => ({ items: [{ itemId: '9', title: 'z', quantity: 1, quantityAvailable: 1 }], totalEntries: 1, totalPages: 1 }));
  mock.method(ebayTrading, 'getItemSummary', async (token, itemId) => ({ itemId, quantity: 3, quantityAvailable: 2, quantitySold: 1 }));

  const connectionId = 'test-conn-sale-unknown';
  await ebayService.listListingsDetailed(freshCredentials(), { connectionId, status: 'active' });
  const before = listReads.mock.calls.length;
  const result = await ebayService.applySale(freshCredentials(), connectionId, '404');
  assert.deepStrictEqual(result, { patched: false, soldOut: false });
  assert.strictEqual(listReads.mock.calls.length, before, 'no re-read at the moment of the sale');
  // The next look at the page re-reads behind the served copy.
  await ebayService.listListingsDetailed(freshCredentials(), { connectionId, status: 'active' });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(listReads.mock.calls.length > before, 'stale copy was re-read on the next look');
});

test('a refreshed copy announces itself so open pages can update', async () => {
  const accountEvents = require('../../src/modules/ebay/account-events');
  mock.method(mirror, 'loadSnapshot', async () => null);
  mock.method(mirror, 'saveSnapshot', async () => {});
  mock.method(ebayTrading, 'getActiveListings', async () => ({ items: [{ itemId: '1', title: 'x' }], totalEntries: 1, totalPages: 1 }));

  const connectionId = 'test-conn-events';
  const seen = [];
  const unsubscribe = accountEvents.subscribe(connectionId, (event) => seen.push(event));
  try {
    await ebayService.listListingsDetailed(freshCredentials(), { connectionId, status: 'active' });
    assert.deepStrictEqual(seen.map((e) => [e.type, e.kind]), [['updated', 'listings']]);
  } finally {
    unsubscribe();
  }
});

test('bestSellingListings ranks by units sold in the last 90 days, then lifetime sold, from the mirror only', async () => {
  const mirror = require('../../src/modules/ebay/ebay-mirror.repository');
  const day = 24 * 60 * 60 * 1000;
  const listings = [
    { itemId: '1', title: 'Slow', viewItemUrl: 'https://www.ebay.co.uk/itm/1', imageUrl: null, price: { amount: 4.99, currency: 'GBP' }, quantitySold: 300 },
    { itemId: '2', title: 'Hot', viewItemUrl: 'https://www.ebay.co.uk/itm/2', imageUrl: null, price: { amount: 9.99, currency: 'GBP' }, quantitySold: 5 },
    { itemId: '3', title: 'Steady', viewItemUrl: 'https://www.ebay.co.uk/itm/3', imageUrl: null, price: { amount: 2.5, currency: 'USD' }, quantitySold: 40 },
  ];
  mock.method(mirror, 'loadSnapshot', async (key, kind) => {
    if (kind === 'listings:active') return { value: { items: listings }, meta: {}, syncedAt: Date.now() };
    if (kind === 'orders') return { value: { count: 2 }, meta: { lastSyncAt: new Date().toISOString() }, syncedAt: Date.now() };
    return null;
  });
  mock.method(mirror, 'loadOrders', async () => [
    { orderId: 'A', createdAt: new Date(Date.now() - day).toISOString(), cancelStatus: 'NotApplicable', lineItems: [{ itemId: '2', quantityPurchased: 3 }] },
    { orderId: 'B', createdAt: new Date(Date.now() - 2 * day).toISOString(), cancelStatus: 'NotApplicable', lineItems: [{ itemId: '2', quantityPurchased: 1 }, { itemId: '3', quantityPurchased: 2 }] },
    { orderId: 'C', createdAt: new Date(Date.now() - 3 * day).toISOString(), cancelStatus: 'CancelClosed', lineItems: [{ itemId: '1', quantityPurchased: 9 }] },
  ]);
  const tradingCalls = mock.method(ebayTrading, 'getActiveListings', async () => {
    throw new Error('should read the mirror, not eBay');
  });
  mock.method(ebayTrading, 'getOrders', async () => {
    throw new Error('should read the mirror, not eBay');
  });

  const { items } = await ebayService.bestSellingListings(freshCredentials(), 'test-conn-best', { count: 2 });

  assert.deepStrictEqual(items.map((i) => [i.name, i.sold, i.price]), [['Hot', 4, '£9.99'], ['Steady', 2, '$2.50']]);
  assert.strictEqual(tradingCalls.mock.calls.length, 0);
});

test('bestSellingListings gives each listing its own mix of the top sellers, stable per listing', async () => {
  const mirror = require('../../src/modules/ebay/ebay-mirror.repository');
  const listings = Array.from({ length: 30 }, (_, i) => ({
    itemId: String(100 + i),
    title: `Item ${i}`,
    viewItemUrl: `https://www.ebay.co.uk/itm/${100 + i}`,
    imageUrl: null,
    price: { amount: 1 + i, currency: 'GBP' },
    quantitySold: 100 - i,
  }));
  mock.method(mirror, 'loadSnapshot', async (key, kind) => (kind === 'listings:active' ? { value: { items: listings }, meta: {}, syncedAt: Date.now() } : null));
  mock.method(mirror, 'loadOrders', async () => []);
  mock.method(ebayTrading, 'getOrders', async () => ({ orders: [], totalEntries: 0, totalPages: 1 }));
  mock.method(mirror, 'upsertOrders', async () => {});
  mock.method(mirror, 'pruneOrdersBefore', async () => {});
  mock.method(mirror, 'saveSnapshot', async () => {});

  const a1 = (await ebayService.bestSellingListings(freshCredentials(), 'test-conn-mix', { count: 6, seed: 'listing-a' })).items.map((i) => i.name);
  const a2 = (await ebayService.bestSellingListings(freshCredentials(), 'test-conn-mix', { count: 6, seed: 'listing-a' })).items.map((i) => i.name);
  const b = (await ebayService.bestSellingListings(freshCredentials(), 'test-conn-mix', { count: 6, seed: 'listing-b' })).items.map((i) => i.name);

  assert.deepStrictEqual(a1, a2);
  assert.notDeepStrictEqual(a1, b);
  // Only top sellers ever appear: the pool is the best 24 of 30.
  for (const name of [...a1, ...b]) assert.ok(Number(name.replace('Item ', '')) < 24, name);
});

test('an ended listing moves from the Active copy to the Inactive one at once', async () => {
  mock.method(mirror, 'loadSnapshot', async () => null);
  mock.method(mirror, 'saveSnapshot', async () => {});
  mock.method(ebayTrading, 'getActiveListings', async () => ({ items: [{ itemId: '1', title: 'a', quantity: 2, quantityAvailable: 2 }, { itemId: '2', title: 'b', quantity: 1, quantityAvailable: 1 }], totalEntries: 2, totalPages: 1 }));
  mock.method(ebayTrading, 'getUnsoldListings', async () => ({ items: [], totalEntries: 0, totalPages: 1 }));
  const endCall = mock.method(ebayTrading, 'endListing', async (token, itemId) => ({ itemId, endTime: 'now', warnings: [] }));

  const connectionId = 'test-conn-end';
  await ebayService.listListingsDetailed(freshCredentials(), { connectionId, status: 'active' });
  await ebayService.listListingsDetailed(freshCredentials(), { connectionId, status: 'inactive' });
  await ebayService.countActiveListings(freshCredentials(), connectionId);

  await ebayService.endLiveListing(freshCredentials(), connectionId, '1');
  assert.strictEqual(endCall.mock.calls.length, 1);
  const active = await ebayService.listListingsDetailed(freshCredentials(), { connectionId, status: 'active' });
  const inactive = await ebayService.listListingsDetailed(freshCredentials(), { connectionId, status: 'inactive' });
  assert.deepStrictEqual(active.items.map((i) => i.itemId), ['2']);
  assert.deepStrictEqual(inactive.items.map((i) => i.itemId), ['1']);
  assert.strictEqual((await ebayService.countActiveListings(freshCredentials(), connectionId)).totalEntries, 1);
});

test('listListingsDetailed search survives a numeric SKU or title from an older mirror copy', async () => {
  mock.method(mirror, 'loadSnapshot', async () => null);
  mock.method(mirror, 'saveSnapshot', async () => {});
  mock.method(ebayTrading, 'getActiveListings', async () => ({
    // A purely numeric custom label parsed as a number, as the mirror held it.
    items: [
      { itemId: '800004132806', sku: 10023, title: 'Braid', quantity: 1, quantityAvailable: 1, quantitySold: 0 },
      { itemId: '2', sku: 'ABC', title: 1234, quantity: 1, quantityAvailable: 1, quantitySold: 0 },
    ],
    totalEntries: 2,
    totalPages: 1,
  }));

  const connectionId = 'test-conn-numeric-sku';
  const byId = await ebayService.listListingsDetailed(freshCredentials(), { connectionId, status: 'active', search: '800004132806' });
  assert.deepStrictEqual(byId.items.map((l) => l.itemId), ['800004132806']);
  const bySku = await ebayService.listListingsDetailed(freshCredentials(), { connectionId, status: 'active', search: '1002' });
  assert.deepStrictEqual(bySku.items.map((l) => l.itemId), ['800004132806']);
  const byTitle = await ebayService.listListingsDetailed(freshCredentials(), { connectionId, status: 'active', search: '1234' });
  assert.deepStrictEqual(byTitle.items.map((l) => l.itemId), ['2']);
});

test('buildInventoryItem lifts product identifiers out of the specifics onto product', () => {
  const { buildInventoryItem, notApplicableText } = require('../../src/modules/ebay/ebay.service');
  const item = buildInventoryItem({
    title: 'T',
    description: 'd',
    imageUrls: [],
    aspects: { EAN: ['5012345678900'], Brand: ['Acme'], MPN: ['X-1'], Colour: ['Red'] },
    condition: 'NEW',
    quantity: 1,
  });
  // Barcodes are product fields, not item specifics; Brand/MPN are both.
  assert.deepStrictEqual(item.product.ean, ['5012345678900']);
  assert.strictEqual(item.product.brand, 'Acme');
  assert.strictEqual(item.product.mpn, 'X-1');
  assert.deepStrictEqual(Object.keys(item.product.aspects).sort(), ['Brand', 'Colour', 'MPN']);

  // Brand without an MPN stays an item specific only: eBay refuses the
  // product pair half-filled ("<BrandMPN> is invalid or missing").
  const brandOnly = buildInventoryItem({ title: 'T', description: 'd', imageUrls: [], aspects: { Brand: ['Unbranded'], Colour: ['Black'] }, condition: 'NEW', quantity: 1 });
  assert.strictEqual(brandOnly.product.brand, undefined);
  assert.strictEqual(brandOnly.product.mpn, undefined);
  assert.deepStrictEqual(brandOnly.product.aspects.Brand, ['Unbranded']);

  // Explicit identifiers win, e.g. the "Does not apply" a retry adds.
  const none = buildInventoryItem({ title: 'T', description: 'd', imageUrls: [], aspects: {}, condition: 'NEW', quantity: 1, identifiers: { ean: 'Does not apply' } });
  assert.deepStrictEqual(none.product.ean, ['Does not apply']);
  assert.strictEqual(notApplicableText('EBAY_DE'), 'Nicht zutreffend');
  assert.strictEqual(notApplicableText('EBAY_GB'), 'Does not apply');
});

test('reviseInventoryListing replaces the item and offer, then republishes the offer', async () => {
  const ebayClient = require('../../src/modules/ebay/api/ebay.client');
  const ebayService = require('../../src/modules/ebay/ebay.service');
  const calls = [];
  const existing = { offerId: 'offer-7', sku: 'S-1', status: 'PUBLISHED', marketplaceId: 'EBAY_GB', format: 'FIXED_PRICE', availableQuantity: 1, categoryId: '1', listingPolicies: { fulfillmentPolicyId: 'f' }, pricingSummary: { price: { value: '9.95', currency: 'GBP' } }, merchantLocationKey: 'm', listing: { listingId: '407' } };
  const m = [
    mock.method(ebayClient, 'getOffer', async () => existing),
    mock.method(ebayClient, 'createOrReplaceInventoryItem', async (t, sku, item) => calls.push(['item', sku, item])),
    mock.method(ebayClient, 'updateOffer', async (t, offerId, offer) => calls.push(['offer', offerId, offer])),
    mock.method(ebayClient, 'publishOffer', async (t, offerId) => {
      calls.push(['publish', offerId]);
      return { listingId: '407' };
    }),
  ];
  try {
    const result = await ebayService.reviseInventoryListing(freshCredentials(), {
      offerId: 'offer-7',
      draft: { sku: 'S-1', title: 'T', description: 'd', imageUrls: ['https://i/1.jpg'], aspects: { Brand: ['B'] }, condition: 'NEW', quantity: 3, price: { value: '12.50', currency: 'GBP' }, categoryId: '55' },
      listingDescription: '<p>html</p>',
      marketplaceId: 'EBAY_GB',
    });
    assert.strictEqual(result.listingId, '407');
    assert.deepStrictEqual(calls.map((c) => c[0]), ['item', 'offer', 'publish']);
    const offer = calls[1][2];
    assert.strictEqual(offer.offerId, undefined);
    assert.strictEqual(offer.status, undefined);
    assert.strictEqual(offer.listing, undefined);
    assert.strictEqual(offer.availableQuantity, 3);
    assert.strictEqual(offer.categoryId, '55');
    assert.strictEqual(offer.listingDescription, '<p>html</p>');
    assert.deepStrictEqual(offer.pricingSummary.price, { value: '12.50', currency: 'GBP' });
    assert.strictEqual(offer.listingPolicies.fulfillmentPolicyId, 'f');
  } finally {
    m.forEach((x) => x.mock.restore());
  }
});

test('getStoreCategoriesCached reports a failed read instead of caching it as "no departments"', async () => {
  const ebayTrading = require('../../src/modules/ebay/api/ebay.trading');
  const ebayService = require('../../src/modules/ebay/ebay.service');
  let calls = 0;
  const m = mock.method(ebayTrading, 'getStoreCategories', async () => {
    calls += 1;
    if (calls === 1) throw new Error('eBay is having a moment');
    return { categories: [{ id: '1', name: 'Tech', children: [] }], hasStore: true };
  });
  try {
    const first = await ebayService.getStoreCategoriesCached(freshCredentials(), 'conn-sc-1');
    assert.deepStrictEqual(first.categories, []);
    assert.strictEqual(first.hasStore, null);
    assert.match(first.unavailable, /Couldn't read this account's Shop departments/);
    // Not cached: the next read goes to eBay again and succeeds.
    const second = await ebayService.getStoreCategoriesCached(freshCredentials(), 'conn-sc-1');
    assert.strictEqual(second.categories[0].name, 'Tech');
    assert.strictEqual(second.hasStore, true);
    assert.strictEqual(second.unavailable, null);
    // A seller without a Shop is a plain no, cached like any other answer.
    m.mock.mockImplementation(async () => ({ categories: [], hasStore: false }));
    const none = await ebayService.getStoreCategoriesCached(freshCredentials(), 'conn-sc-2');
    assert.strictEqual(none.hasStore, false);
    assert.strictEqual(none.unavailable, null);
  } finally {
    m.mock.restore();
  }
});

test('addStoreCategory creates the department then serves the refreshed tree', async () => {
  const ebayTrading = require('../../src/modules/ebay/api/ebay.trading');
  const ebayService = require('../../src/modules/ebay/ebay.service');
  const tree = [{ id: '1', name: 'Tech', children: [] }];
  const get = mock.method(ebayTrading, 'getStoreCategories', async () => ({ categories: tree, hasStore: true }));
  const add = mock.method(ebayTrading, 'addStoreCategory', async (token, input) => {
    assert.strictEqual(input.name, 'Bathroom');
    tree.push({ id: '2', name: 'Bathroom', children: [] });
    return { status: 'Complete', category: { id: '2', name: 'Bathroom', children: [] }, warnings: [] };
  });
  try {
    await ebayService.getStoreCategoriesCached(freshCredentials(), 'conn-sc-3');
    const result = await ebayService.addStoreCategory(freshCredentials(), 'conn-sc-3', { name: 'Bathroom' });
    assert.strictEqual(add.mock.calls.length, 1);
    assert.strictEqual(get.mock.calls.length, 2); // cache was dropped and re-read
    assert.deepStrictEqual(result.categories.map((c) => c.name), ['Tech', 'Bathroom']);
    assert.strictEqual(result.created.name, 'Bathroom');
  } finally {
    get.mock.restore();
    add.mock.restore();
  }
});

test('variationImageFor picks the photo of the option the buyer chose, loosely matching Colour/Color', () => {
  const { variationImageFor } = require('../../src/modules/ebay/ebay.service');
  const summary = {
    imageUrl: 'https://i/main.jpg',
    variationPictures: [{ specificName: 'Colour', byValue: { 'Black Lace': 'https://i/black.jpg', 'White Lace': 'https://i/white.jpg' } }],
  };
  assert.strictEqual(variationImageFor(summary, [{ name: 'Color', value: 'Black Lace' }, { name: 'Size.', value: 'M' }]), 'https://i/black.jpg');
  assert.strictEqual(variationImageFor(summary, [{ name: 'Colour', value: 'white lace' }]), 'https://i/white.jpg');
  // No matching option, or a single-variation listing → the main photo.
  assert.strictEqual(variationImageFor(summary, [{ name: 'Size', value: 'M' }]), 'https://i/main.jpg');
  assert.strictEqual(variationImageFor({ imageUrl: 'https://i/main.jpg', variationPictures: [] }, [{ name: 'Colour', value: 'Red' }]), 'https://i/main.jpg');
});

// --- publishing right after the items are built ---------------------------

test('a publish eBay answers with "Product not found" is tried once more, and then goes live', async () => {
  ebayService.setProductNotFoundDelay(0);
  let calls = 0;
  mock.method(ebayClient, 'publishOfferByInventoryItemGroup', async () => {
    calls += 1;
    if (calls === 1) throw new ebayClient.EbayApiError('Input error. Seller Inventory Service can not publish the data. Product not found. Please try again or contact customer support..', 502, []);
    return { listingId: '800700000001' };
  });

  const result = await ebayService.publishGroup(freshCredentials(), 'Liston-group', 'EBAY_GB');
  assert.strictEqual(calls, 2);
  assert.strictEqual(result.externalProductId, '800700000001');
});

test('any other publish refusal is not retried', async () => {
  ebayService.setProductNotFoundDelay(0);
  const publish = mock.method(ebayClient, 'publishOffer', async () => {
    throw new ebayClient.EbayApiError('A mixture of Self Hosted and EPS pictures are not allowed.', 502, []);
  });
  await assert.rejects(ebayService.publishDraft(freshCredentials(), 'offer-1', 'EBAY_GB'), /mixture/);
  assert.strictEqual(publish.mock.calls.length, 1);
});

test('the supplier filter keeps one supplier state and counts every state within the tab, while the tab counts stay whole', async () => {
  mock.method(ebayTrading, 'getOrders', async () => ({
    orders: [
      makeOrder({ orderId: 'ORD-NEW', shippedTime: null }),
      makeOrder({ orderId: 'ORD-PLACED', shippedTime: null }),
      makeOrder({ orderId: 'ORD-OLD', shippedTime: null }),
      makeOrder({ orderId: 'ORD-SENT' }),
    ],
    totalEntries: 4,
    totalPages: 1,
  }));
  mock.method(ebayTrading, 'getItemSummary', async (token, itemId) => ({ itemId, imageUrl: null, quantity: null, quantityAvailable: null }));
  const states = { 'ORD-PLACED': 'ordered', 'ORD-SENT': 'delivered' };
  const supplierStateOf = (order) => states[order.orderId] || 'pending';
  const opts = { connectionId: 'test-conn-supplier', range: '30d', status: 'awaiting_dispatch', search: '', page: 1, perPage: 25, supplierStateOf };

  const pending = await ebayService.listOrdersDetailed(freshCredentials(), { ...opts, supplier: 'pending' });
  assert.deepStrictEqual(pending.orders.map((o) => o.orderId).sort(), ['ORD-NEW', 'ORD-OLD']);
  assert.deepStrictEqual(pending.supplierCounts, { any: 3, pending: 2, ordered: 1 });
  assert.strictEqual(pending.counts.awaiting_dispatch, 3);
  assert.strictEqual(pending.supplier, 'pending');

  const any = await ebayService.listOrdersDetailed(freshCredentials(), { ...opts, supplier: 'any' });
  assert.strictEqual(any.orders.length, 3);
});

test('dispatched orders not yet delivered are re-read by number every few hours, so a delivery scan moves them to Delivered', async () => {
  const shipped = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const calls = [];
  mock.method(ebayTrading, 'getOrders', async (token, opts) => {
    calls.push(opts);
    if (opts.orderIds) return { orders: [makeOrder({ orderId: 'ORD-OUT', shippedTime: shipped, deliveredAt: new Date().toISOString() })], totalPages: 1 };
    if (opts.modTimeFrom) return { orders: [], totalPages: 1 };
    return { orders: [makeOrder({ orderId: 'ORD-OUT', shippedTime: shipped }), makeOrder({ orderId: 'ORD-WAIT', shippedTime: null })], totalPages: 1 };
  });
  mock.method(ebayTrading, 'getItemSummary', async (token, itemId) => ({ itemId, imageUrl: null, quantity: null, quantityAvailable: null }));
  const opts = { connectionId: 'test-conn-delivery', range: '30d', status: 'all', search: '', page: 1, perPage: 25 };

  mock.method(ebayTrading, 'getActiveListings', async () => ({ items: [], totalEntries: 0, totalPages: 1 }));
  mock.method(ebayTrading, 'getUnsoldListings', async () => ({ items: [], totalEntries: 0, totalPages: 1 }));

  const first = await ebayService.listOrdersDetailed(freshCredentials(), opts);
  assert.strictEqual(first.counts.dispatched, 1);
  // The full read counts as a delivery check, so none is due straight after.
  assert.strictEqual(calls.filter((c) => c.orderIds).length, 0);

  // Hours later (here: at once), the next sync reads the one order out for
  // delivery by its number, and it moves to Delivered.
  ebayService.setDeliveryCheckInterval(0);
  try {
    await ebayService.refreshAccount(freshCredentials(), 'test-conn-delivery');
  } finally {
    ebayService.setDeliveryCheckInterval(6 * 60 * 60 * 1000);
  }
  assert.deepStrictEqual(calls.filter((c) => c.orderIds).map((c) => c.orderIds), [['ORD-OUT']]);
  const after = await ebayService.listOrdersDetailed(freshCredentials(), opts);
  assert.deepStrictEqual([after.counts.dispatched, after.counts.delivered], [0, 1]);

  const later = ebayService.awaitingDelivery([makeOrder({ orderId: 'X', shippedTime: shipped }), makeOrder({ orderId: 'Y', shippedTime: shipped, deliveredAt: shipped }), makeOrder({ orderId: 'Z', shippedTime: null })]);
  assert.deepStrictEqual(later.map((o) => o.orderId), ['X']);
  const tooOld = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(ebayService.awaitingDelivery([makeOrder({ orderId: 'OLD', shippedTime: tooOld })]).length, 0);
});
