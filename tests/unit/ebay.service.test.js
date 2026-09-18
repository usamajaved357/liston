const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const ebayClient = require('../../src/modules/ebay/ebay.client');
const ebayOauth = require('../../src/modules/ebay/ebay.oauth');
const ebayTrading = require('../../src/modules/ebay/ebay.trading');
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

  mock.method(ebayTrading, 'getOrders', async () => ({
    orders: [awaitingPayment, awaitingDispatch, dispatched, cancelled],
    totalEntries: 4,
    totalPages: 1,
  }));
  mock.method(ebayTrading, 'getItemSummary', async (token, itemId) => ({
    itemId,
    imageUrl: 'https://example.com/pic.jpg',
    quantity: 5,
    quantityAvailable: 3,
  }));

  const result = await ebayService.listOrdersDetailed(freshCredentials(), { connectionId: 'test-conn-1', range: '30d', status: 'all', search: '', page: 1, perPage: 25 });

  assert.deepStrictEqual(result.counts, { all: 4, awaiting_payment: 1, awaiting_dispatch: 1, dispatched: 1, cancelled: 1 });
  assert.strictEqual(result.totalEntries, 4);
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
test('draftVariationListing puts shared aspects on the group and merged aspects on each SKU', async () => {
  let group = null;
  const items = [];
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
