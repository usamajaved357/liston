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

test('createEbayDraft snapshots policies and persists the draft WITHOUT touching eBay', async () => {
  mock.method(connectionService, 'getConnectionSummary', async () => ebayConnection());
  // Creating the eBay objects here is what made drafting slow, left orphan
  // SKUs behind and made editing impossible — it now happens at publish.
  const draftListingMock = mock.method(ebayService, 'draftListing', async () => {
    throw new Error('eBay must not be called while drafting');
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

  assert.strictEqual(draftListingMock.mock.calls.length, 0, 'drafting must not call eBay');
  assert.strictEqual(createDraftMock.mock.calls.length, 1);
  const row = createDraftMock.mock.calls[0].arguments[0];
  assert.strictEqual(row.platformOfferId, null);
  assert.strictEqual(row.platformGroupKey, null);
  assert.strictEqual(row.sku, 'SKU-1');
  // The policies in force at draft time are snapshotted, so a later change
  // to the connection's defaults can't silently alter this listing.
  assert.deepStrictEqual(row.generatedData.listingPolicies, {
    fulfillmentPolicyId: 'f1',
    paymentPolicyId: 'p1',
    returnPolicyId: 'r1',
  });
  assert.strictEqual(row.generatedData.marketplaceId, 'EBAY_GB');
  assert.strictEqual(result.id, 'listing-1');
});

test('createEbayDraft refuses to draft when the connection has no policies configured', async () => {
  mock.method(connectionService, 'getConnectionSummary', async () => ebayConnection({ settings: {} }));

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
    generated_data: { marketplaceId: 'EBAY_GB', imageUrls: ['https://i.ebayimg.com/a.jpg'] },
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

test('generateEbayDraftFromUrls records a SKU base, forwards sourceData, and creates a draft', async () => {
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
  mock.method(ebayService, 'ensureValidAccessToken', async () => ({ accessToken: 'token' }));
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
  // Only the BASE is fixed at draft time; the actual SKUs are stamped at
  // publish, so a draft edited over days isn't holding SKUs against eBay's
  // eventually-consistent index.
  assert.strictEqual(call.generatedData.skuBase, 'AE1234567890');
  assert.strictEqual(call.platformOfferId, null);
  // costPrice is no longer part of sourceData — the cost comes from the
  // supplier's own price at draft time, and the derived price plus its full
  // working is persisted in generated_data instead.
  assert.deepStrictEqual(call.sourceData, { competitor: { title: 'Competitor' }, source: { title: 'Source' } });
});

test('generateEbayDraftFromUrls creates a variation draft with no eBay objects yet', async () => {
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
  mock.method(ebayService, 'ensureValidAccessToken', async () => ({ accessToken: 'token' }));
  const draftVariationMock = mock.method(ebayService, 'draftVariationListing', async () => {
    throw new Error('eBay must not be called while drafting');
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
  assert.strictEqual(draftVariationMock.mock.calls.length, 0, 'drafting must not call eBay');
  assert.strictEqual(call.sku, null);
  assert.strictEqual(call.platformGroupKey, null);
  assert.strictEqual(call.generatedData.skuBase, 'AE1234567890');
  assert.strictEqual(call.generatedData.variants.length, 2);
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

// --- publish now BUILDS on eBay, then publishes ---------------------------

function pendingDraft(generatedData, overrides = {}) {
  return {
    id: 'listing-1',
    connection_id: CONNECTION_ID,
    status: 'pending_review',
    platform_offer_id: null,
    platform_group_key: null,
    generated_data: generatedData,
    ...overrides,
  };
}

test('publish creates the eBay offer at publish time and records its id', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      marketplaceId: 'EBAY_GB',
      skuBase: 'AE999',
      title: 'Widget',
      imageUrls: ['https://i.ebayimg.com/a.jpg'],
    })
  );
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't' }, ebayConnection()));
  const draftMock = mock.method(ebayService, 'draftListing', async (credentials, input) => {
    // SKUs are stamped here, not at draft time.
    assert.match(input.sku, /^AE999-[0-9a-f]{6}$/);
    return { offerId: 'offer-9', status: 'drafted' };
  });
  mock.method(ebayService, 'publishDraft', async (credentials, offerId) => {
    assert.strictEqual(offerId, 'offer-9');
    return { externalProductId: 'ebay-123', status: 'published' };
  });
  const setIdsMock = mock.method(listingRepository, 'setPlatformIds', async () => ({}));
  const updateStatusMock = mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  const result = await listingService.publish('listing-1', USER_ID);

  assert.strictEqual(draftMock.mock.calls.length, 1);
  assert.strictEqual(setIdsMock.mock.calls[0].arguments[1].platformOfferId, 'offer-9');
  assert.strictEqual(updateStatusMock.mock.calls[0].arguments[1], 'published');
  assert.strictEqual(result.externalProductId, 'ebay-123');
});

test('publish leaves a failed listing editable and retryable, with eBay reason recorded', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({ marketplaceId: 'EBAY_GB', imageUrls: ['https://i.ebayimg.com/a.jpg'] })
  );
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't' }, ebayConnection()));
  mock.method(ebayService, 'draftListing', async () => {
    throw new Error('Invalid category for this marketplace');
  });
  const updateStatusMock = mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  await assert.rejects(() => listingService.publish('listing-1', USER_ID), /Invalid category/);

  // Publishing 100+ variants is minutes of calls; a failure must not strand
  // the draft in a state the seller can't edit or retry.
  assert.strictEqual(updateStatusMock.mock.calls[0].arguments[1], 'pending_review');
  assert.match(updateStatusMock.mock.calls[0].arguments[2].errorMessage, /Invalid category/);
});

// --- editing ---------------------------------------------------------------

test('updateDraft applies text edits and persists them', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({ title: 'Old', description: 'Old desc', imageUrls: ['https://i.ebayimg.com/a.jpg'] })
  );
  const updateMock = mock.method(listingRepository, 'updateGeneratedData', async (id, data) => ({ id, generated_data: data }));

  await listingService.updateDraft('listing-1', USER_ID, { title: 'New title', description: 'New desc' });

  const saved = updateMock.mock.calls[0].arguments[1];
  assert.strictEqual(saved.title, 'New title');
  assert.strictEqual(saved.description, 'New desc');
});

test('updateDraft refuses to edit a published listing', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => pendingDraft({}, { status: 'published' }));
  await assert.rejects(() => listingService.updateDraft('listing-1', USER_ID, { title: 'x' }), /Only a draft can be edited/);
});

test('removeAxisValue drops every combination using that value', () => {
  const draft = {
    variants: [
      { aspects: { Colour: ['Pink'], Model: ['15'] } },
      { aspects: { Colour: ['Pink'], Model: ['16'] } },
      { aspects: { Colour: ['Black'], Model: ['15'] } },
      { aspects: { Colour: ['Black'], Model: ['16'] } },
    ],
    variesBy: {
      specifications: [
        { name: 'Colour', values: ['Pink', 'Black'] },
        { name: 'Model', values: ['15', '16'] },
      ],
    },
  };

  const result = listingService.removeAxisValue(draft, 'Colour', 'Pink');

  // Dropping one colour on a 6x27 product removes 27 variations at once —
  // the only practical way to curate a matrix that size.
  assert.strictEqual(result.variants.length, 2);
  assert.ok(result.variants.every((v) => v.aspects.Colour[0] === 'Black'));
  assert.deepStrictEqual(result.variesBy.specifications[0], { name: 'Colour', values: ['Black'] });
  // The model axis is untouched, since both models still have variations.
  assert.deepStrictEqual(result.variesBy.specifications[1].values, ['15', '16']);
});

test('removeAxisValue drops an axis entirely when nothing is left on it', () => {
  const draft = {
    variants: [{ aspects: { Colour: ['Pink'], Size: ['S'] } }],
    variesBy: { specifications: [{ name: 'Colour', values: ['Pink'] }, { name: 'Size', values: ['S'] }] },
  };
  const result = listingService.removeAxisValue(draft, 'Colour', 'Pink');
  assert.strictEqual(result.variants.length, 0);
  assert.deepStrictEqual(result.variesBy.specifications, []);
});

test('updateDraft refuses an edit that would leave a variation listing with nothing to sell', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      imageUrls: ['https://i.ebayimg.com/a.jpg'],
      variants: [{ aspects: { Colour: ['Pink'] }, imageUrls: ['https://i.ebayimg.com/p.jpg'] }],
      variesBy: { specifications: [{ name: 'Colour', values: ['Pink'] }] },
    })
  );

  await assert.rejects(
    () => listingService.updateDraft('listing-1', USER_ID, { removeAxisValues: [{ axis: 'Colour', value: 'Pink' }] }),
    /at least one variation/
  );
});

test('updateDraft reports an image gap rather than silently saving a broken gallery', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({ imageUrls: ['https://i.ebayimg.com/a.jpg'] })
  );
  mock.method(listingRepository, 'updateGeneratedData', async (id, data) => ({ id, generated_data: data }));

  const { imageCheck } = await listingService.updateDraft('listing-1', USER_ID, { imageUrls: [] });

  assert.strictEqual(imageCheck.ok, false);
  assert.match(imageCheck.errors.join(' '), /no images/i);
});

test('removeDraft refuses to delete a published listing', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => pendingDraft({}, { status: 'published' }));
  await assert.rejects(() => listingService.removeDraft('listing-1', USER_ID), /Only a draft can be edited/);
});

// --- seller-uploaded images ------------------------------------------------

const sharp = require('sharp');
const eps = require('../../src/modules/ai-generation/image-pipeline/eps');

async function dataUrl(width, height) {
  const buf = await sharp({ create: { width, height, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

test('uploadDraftImage hosts the seller photo on eBay and appends it to the gallery, bytes untouched', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => ({
    id: 'listing-1',
    status: 'pending_review',
    connection_id: CONNECTION_ID,
    generated_data: { imageUrls: ['https://i.ebayimg.com/a.jpg'], marketplaceId: 'EBAY_GB' },
  }));
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 'token' }, ebayConnection()));
  mock.method(ebayService, 'ensureValidAccessToken', async () => ({ accessToken: 'token' }));
  let uploadedBytes = null;
  mock.method(eps, 'upload', async (token, buffer) => {
    uploadedBytes = buffer;
    return 'https://i.ebayimg.com/new.jpg';
  });
  const save = mock.method(listingRepository, 'updateGeneratedData', async (id, data) => ({ id, generated_data: data }));

  const { listing, imageUrl } = await listingService.uploadDraftImage('listing-1', USER_ID, { dataUrl: await dataUrl(900, 700) });

  assert.strictEqual(imageUrl, 'https://i.ebayimg.com/new.jpg');
  assert.deepStrictEqual(listing.generated_data.imageUrls, ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/new.jpg']);
  const meta = await sharp(uploadedBytes).metadata();
  assert.deepStrictEqual([meta.width, meta.height], [900, 700], 'uploaded as-is, not padded');
  assert.strictEqual(save.mock.callCount(), 1);
});

test('uploadDraftImage can replace an image everywhere it appears, or set a variation photo', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => ({
    id: 'listing-1',
    status: 'pending_review',
    connection_id: CONNECTION_ID,
    generated_data: {
      imageUrls: ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg'],
      variants: [{ imageUrls: ['https://i.ebayimg.com/a.jpg'] }, { imageUrls: ['https://i.ebayimg.com/b.jpg'] }],
      marketplaceId: 'EBAY_GB',
    },
  }));
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 'token' }, ebayConnection()));
  mock.method(ebayService, 'ensureValidAccessToken', async () => ({ accessToken: 'token' }));
  mock.method(eps, 'upload', async () => 'https://i.ebayimg.com/new.jpg');
  mock.method(listingRepository, 'updateGeneratedData', async (id, data) => ({ id, generated_data: data }));

  const replaced = await listingService.uploadDraftImage('listing-1', USER_ID, { dataUrl: await dataUrl(800, 800), replaces: 'https://i.ebayimg.com/a.jpg' });
  assert.deepStrictEqual(replaced.listing.generated_data.imageUrls, ['https://i.ebayimg.com/new.jpg', 'https://i.ebayimg.com/b.jpg']);
  assert.deepStrictEqual(replaced.listing.generated_data.variants[0].imageUrls, ['https://i.ebayimg.com/new.jpg']);

  const variant = await listingService.uploadDraftImage('listing-1', USER_ID, { dataUrl: await dataUrl(800, 800), variantIndex: 1 });
  assert.deepStrictEqual(variant.listing.generated_data.variants[1].imageUrls, ['https://i.ebayimg.com/new.jpg']);
  assert.strictEqual(variant.listing.generated_data.imageUrls.length, 2, 'a variant upload does not touch the gallery');
});

test('uploadDraftImage rejects a photo below eBay’s 500px minimum before touching eBay', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => ({
    id: 'listing-1',
    status: 'pending_review',
    connection_id: CONNECTION_ID,
    generated_data: { imageUrls: [], marketplaceId: 'EBAY_GB' },
  }));
  const upload = mock.method(eps, 'upload', async () => 'https://i.ebayimg.com/new.jpg');

  const small = await dataUrl(300, 300);
  await assert.rejects(() => listingService.uploadDraftImage('listing-1', USER_ID, { dataUrl: small }), /500px/);
  assert.strictEqual(upload.mock.callCount(), 0);
});

test('fetchDraftImage only serves images that belong to the draft', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => ({
    id: 'listing-1',
    generated_data: { imageUrls: ['https://i.ebayimg.com/a.jpg'] },
  }));
  await assert.rejects(() => listingService.fetchDraftImage('listing-1', USER_ID, 'https://evil.example/x.jpg'), /isn't part of this listing/);
});

// ---- editing a live listing ----

function liveItem(overrides = {}) {
  return {
    itemId: '407000000001',
    sku: 'SKU-1',
    title: 'Live title',
    description: '<p>Hello <strong>there</strong></p><ul><li>One</li></ul>',
    imageUrls: ['https://i.ebayimg.com/1.jpg', 'https://i.ebayimg.com/2.jpg'],
    price: { amount: 9.99, currency: 'GBP' },
    quantity: 10,
    quantitySold: 3,
    condition: 'NEW',
    conditionId: 1000,
    categoryId: '123',
    categoryPath: ['A', 'B'],
    specifics: { Brand: ['Unbranded'], Type: ['Thing'] },
    currency: 'GBP',
    viewItemUrl: 'https://www.ebay.co.uk/itm/407000000001',
    listingType: 'FixedPriceItem',
    variationSpecificsSet: {},
    variations: [],
    variationPictures: [],
    ...overrides,
  };
}

test('startLiveEdit loads a single live listing into the draft shape with available stock and text description', async () => {
  mock.method(listingRepository, 'findLiveEdit', async () => null);
  mock.method(listingRepository, 'findPublishedByItemId', async () => null);
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 'token' }, ebayConnection()));
  mock.method(ebayService, 'getLiveItem', async () => liveItem());
  const create = mock.method(listingRepository, 'createLiveEdit', async (args) => ({ id: 'edit-1', edit_of_item_id: args.itemId, generated_data: args.generatedData, status: 'pending_review' }));

  const row = await listingService.startLiveEdit(CONNECTION_ID, USER_ID, '407000000001');

  const draft = create.mock.calls[0].arguments[0].generatedData;
  assert.strictEqual(row.edit_of_item_id, '407000000001');
  assert.strictEqual(draft.title, 'Live title');
  assert.strictEqual(draft.quantity, 7);
  assert.strictEqual(draft.price.value, '9.99');
  assert.deepStrictEqual(draft.aspects, { Brand: ['Unbranded'], Type: ['Thing'] });
  assert.match(draft.description, /Hello \*\*there\*\*/);
  assert.match(draft.description, /• One/);
});

test('startLiveEdit maps a variation listing with per-value pictures and prefers the Liston draft description', async () => {
  mock.method(listingRepository, 'findLiveEdit', async () => null);
  mock.method(listingRepository, 'findPublishedByItemId', async () => ({ generated_data: { commonDescription: 'Original **draft** copy', variants: [{}] } }));
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 'token' }, ebayConnection()));
  mock.method(ebayService, 'getLiveItem', async () =>
    liveItem({
      variationSpecificsSet: { Colour: ['Black', 'White'] },
      variations: [
        { sku: 'S-B', price: { amount: 5, currency: 'GBP' }, quantity: 4, quantitySold: 1, specifics: { Colour: ['Black'] } },
        { sku: 'S-W', price: { amount: 6, currency: 'GBP' }, quantity: 2, quantitySold: 0, specifics: { Colour: ['White'] } },
      ],
      variationPictures: [{ specificName: 'Colour', byValue: { Black: ['https://i.ebayimg.com/b.jpg'] } }],
    })
  );
  const create = mock.method(listingRepository, 'createLiveEdit', async (args) => ({ id: 'edit-2', generated_data: args.generatedData }));

  await listingService.startLiveEdit(CONNECTION_ID, USER_ID, '407000000001');

  const draft = create.mock.calls[0].arguments[0].generatedData;
  assert.strictEqual(draft.commonDescription, 'Original **draft** copy');
  assert.deepStrictEqual(draft.variesBy.specifications, [{ name: 'Colour', values: ['Black', 'White'] }]);
  assert.deepStrictEqual(draft.variesBy.aspectsImageVariesBy, ['Colour']);
  assert.deepStrictEqual(draft.variants[0].imageUrls, ['https://i.ebayimg.com/b.jpg']);
  assert.deepStrictEqual(draft.variants[1].imageUrls, ['https://i.ebayimg.com/1.jpg']); // falls back to the gallery
  assert.strictEqual(draft.variants[0].quantity, 3);
});

test('startLiveEdit resumes an unfinished edit instead of creating a second copy', async () => {
  mock.method(listingRepository, 'findLiveEdit', async () => ({ id: 'edit-existing' }));
  const create = mock.method(listingRepository, 'createLiveEdit', async () => ({ id: 'edit-new' }));
  const row = await listingService.startLiveEdit(CONNECTION_ID, USER_ID, '407000000001');
  assert.strictEqual(row.id, 'edit-existing');
  assert.strictEqual(create.mock.calls.length, 0);
});

test('publish on a live edit revises the item in place and removes the working copy', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => ({
    id: 'edit-1',
    connection_id: CONNECTION_ID,
    status: 'pending_review',
    edit_of_item_id: '407000000001',
    external_product_id: '407000000001',
    generated_data: {
      title: 'New title',
      description: 'New copy',
      imageUrls: ['https://i.ebayimg.com/1.jpg'],
      aspects: { Brand: ['Unbranded'] },
      condition: 'NEW',
      quantity: 5,
      price: { value: '12.50', currency: 'GBP' },
      categoryId: '123',
    },
  }));
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 'token' }, ebayConnection()));
  mock.method(ebayService, 'getStoreProfile', async () => ({ storeName: 'Store' }));
  mock.method(ebayService, 'listActiveListings', async () => ({ items: [] }));
  const revise = mock.method(ebayService, 'reviseLiveListing', async (credentials, itemId, payload) => {
    assert.strictEqual(itemId, '407000000001');
    assert.strictEqual(payload.title, 'New title');
    assert.deepStrictEqual(payload.price, { amount: 12.5, currency: 'GBP' });
    assert.strictEqual(payload.quantity, 5);
    assert.strictEqual(payload.conditionId, 1000);
    assert.match(payload.descriptionHtml, /New copy/);
    return { itemId };
  });
  const del = mock.method(listingRepository, 'deleteById', async () => {});
  const updateStatus = mock.method(listingRepository, 'updateStatus', async () => {});

  const result = await listingService.publish('edit-1', USER_ID);

  assert.strictEqual(revise.mock.calls.length, 1);
  assert.strictEqual(del.mock.calls[0].arguments[0], 'edit-1');
  assert.strictEqual(updateStatus.mock.calls.length, 0);
  assert.strictEqual(result.external_product_id, '407000000001');
  assert.strictEqual(result.deleted, true);
});

test('removeInactiveListing clears Liston records, deletes eBay inventory objects it created and hides the item', async () => {
  mock.method(listingRepository, 'findAllByItemId', async () => [
    { platform_offer_id: 'offer-9', platform_group_key: null, sku: 'SKU-9', generated_data: {} },
  ]);
  const delObjects = mock.method(ebayService, 'deleteInventoryObjects', async () => ({}));
  const settings = mock.method(connectionService, 'updateConnectionSettings', async (id, userId, patch) => patch);
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 'token' }, ebayConnection({ settings: { hiddenItemIds: ['1'] } })));
  const delRows = mock.method(listingRepository, 'deleteByItemId', async () => {});
  mock.method(ebayService, 'invalidateListings', () => {});

  await listingService.removeInactiveListing(CONNECTION_ID, USER_ID, '407000000009');

  assert.deepStrictEqual(delObjects.mock.calls[0].arguments[1], { offerId: 'offer-9' });
  assert.deepStrictEqual(delObjects.mock.calls[1].arguments[1], { skus: ['SKU-9'] });
  assert.deepStrictEqual(settings.mock.calls[0].arguments[2], { hiddenItemIds: ['1', '407000000009'] });
  assert.deepStrictEqual(delRows.mock.calls[0].arguments, [CONNECTION_ID, '407000000009']);
});

// --- category, SKU and splitting -------------------------------------------

const ebayTaxonomy = require('../../src/modules/ebay/ebay.taxonomy');
const textGenerator = require('../../src/modules/ai-generation/text-generator.service');

test('publish uses the seller’s own SKU as-is, and numbers variations from it', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      marketplaceId: 'EBAY_GB',
      sku: 'Liston-777',
      commonTitle: 'Widget',
      commonDescription: 'd',
      imageUrls: ['https://i.ebayimg.com/a.jpg'],
      categoryId: '11',
      variesBy: { aspects: {}, aspectsImageVariesBy: [], specifications: [{ name: 'Colour', values: ['Red', 'Blue'] }] },
      variants: [
        { aspects: { Colour: ['Red'] }, imageUrls: ['https://i.ebayimg.com/r.jpg'], price: { value: '9', currency: 'GBP' }, quantity: 1 },
        { aspects: { Colour: ['Blue'] }, imageUrls: ['https://i.ebayimg.com/b.jpg'], price: { value: '9', currency: 'GBP' }, quantity: 1 },
      ],
    })
  );
  mock.method(ebayTaxonomy, 'getVariationsSupported', async () => true);
  mock.method(listingService, 'renderDraftDescription', async () => '<p>x</p>');
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't' }, ebayConnection()));
  const draftMock = mock.method(ebayService, 'draftVariationListing', async (credentials, input) => {
    assert.strictEqual(input.groupKey, 'Liston-777');
    assert.deepStrictEqual(input.variants.map((v) => v.sku), ['Liston-777-1', 'Liston-777-2']);
    return { groupKey: input.groupKey };
  });
  mock.method(ebayService, 'publishGroup', async () => ({ externalProductId: 'ebay-1' }));
  mock.method(listingRepository, 'setPlatformIds', async () => ({}));
  mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  await listingService.publish('listing-1', USER_ID);
  assert.strictEqual(draftMock.mock.calls.length, 1);
});

test('publish refuses a variation draft whose category does not allow variations, before touching eBay', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      marketplaceId: 'EBAY_GB',
      categoryId: '9886',
      categoryPath: ['Vehicle Parts & Accessories', 'Other Car Parts & Accessories'],
      imageUrls: ['https://i.ebayimg.com/a.jpg'],
      variesBy: { aspects: {}, aspectsImageVariesBy: [], specifications: [{ name: 'Colour', values: ['Red', 'Blue'] }] },
      variants: [
        { aspects: { Colour: ['Red'] }, imageUrls: ['https://i.ebayimg.com/r.jpg'], price: { value: '9', currency: 'GBP' }, quantity: 1 },
        { aspects: { Colour: ['Blue'] }, imageUrls: ['https://i.ebayimg.com/b.jpg'], price: { value: '9', currency: 'GBP' }, quantity: 1 },
      ],
    })
  );
  mock.method(ebayTaxonomy, 'getVariationsSupported', async () => false);
  const draftMock = mock.method(ebayService, 'draftVariationListing', async () => ({}));
  mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  await assert.rejects(() => listingService.publish('listing-1', USER_ID), /doesn't allow multi-variation listings in "Other Car Parts & Accessories"/);
  assert.strictEqual(draftMock.mock.calls.length, 0);
});

test('splitVariant lifts one variation into a single-item draft with the shared and own specifics', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft(
      {
        marketplaceId: 'EBAY_GB',
        sku: 'Liston-777',
        commonTitle: 'Coin Dispenser Holder Organiser with Spring',
        commonDescription: 'shared desc',
        imageUrls: ['https://i.ebayimg.com/main.jpg'],
        categoryId: '9886',
        categoryPath: ['Vehicle Parts & Accessories', 'Other Car Parts & Accessories'],
        listingPolicies: { fulfillmentPolicyId: 'f1', paymentPolicyId: 'p1', returnPolicyId: 'r1' },
        merchantLocationKey: 'main',
        variesBy: { aspects: { Type: ['Coin Holder'] }, aspectsImageVariesBy: ['Colour'], specifications: [{ name: 'Colour', values: ['Black', 'Silver'] }] },
        variants: [
          { aspects: { Colour: ['Black'] }, imageUrls: ['https://i.ebayimg.com/black.jpg'], price: { value: '12.99', currency: 'GBP' }, quantity: 3 },
          { aspects: { Colour: ['Silver'] }, imageUrls: ['https://i.ebayimg.com/silver.jpg'], price: { value: '13.99', currency: 'GBP' }, quantity: 1 },
        ],
      },
      { source_data: { source: { title: 's' } } }
    )
  );
  const createMock = mock.method(listingRepository, 'createDraft', async (row) => ({ id: 'new-1', ...row }));

  const created = await listingService.splitVariant('listing-1', USER_ID, 1);

  const data = createMock.mock.calls[0].arguments[0].generatedData;
  assert.strictEqual(created.id, 'new-1');
  assert.strictEqual(data.title, 'Coin Dispenser Holder Organiser with Spring Silver');
  assert.deepStrictEqual(data.aspects, { Type: ['Coin Holder'], Colour: ['Silver'] });
  assert.deepStrictEqual(data.imageUrls, ['https://i.ebayimg.com/silver.jpg', 'https://i.ebayimg.com/main.jpg']);
  assert.deepStrictEqual(data.price, { value: '13.99', currency: 'GBP' });
  assert.strictEqual(data.quantity, 1);
  assert.strictEqual(data.sku, 'Liston-777-2');
  assert.strictEqual(data.variants, undefined);
  assert.strictEqual(data.splitFromListingId, 'listing-1');
});

test('splitVariant refuses an index that is not on the draft', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => pendingDraft({ variants: [] }));
  await assert.rejects(() => listingService.splitVariant('listing-1', USER_ID, 4), /no longer on the draft/);
});

test('updateDraft with a new category refits title, description and specifics, keeping origin', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft(
      {
        marketplaceId: 'EBAY_GB',
        title: 'Old title',
        description: 'Old desc',
        aspects: { Type: ['Coin Holder'], 'Country/Region of Manufacture': ['United Kingdom'] },
        categoryId: '9886',
        categoryPath: ['Vehicle Parts & Accessories', 'Other Car Parts & Accessories'],
        imageUrls: ['https://i.ebayimg.com/a.jpg'],
      },
      { error_message: 'Last publish failed: category does not support variations', source_data: { source: { title: 'src' } } }
    )
  );
  mock.method(ebayTaxonomy, 'getCategoryPath', async () => [{ id: '131090', name: 'Vehicle Parts & Accessories' }, { id: '63691', name: 'Cup Holders' }]);
  mock.method(ebayTaxonomy, 'getCategoryChildren', async () => []);
  mock.method(ebayTaxonomy, 'getAspectSchema', async () => null);
  const refitMock = mock.method(textGenerator, 'refitContentForCategory', async ({ categoryPath }) => {
    assert.deepStrictEqual(categoryPath, ['Vehicle Parts & Accessories', 'Cup Holders']);
    return { title: 'New title for cup holders', description: 'New desc', aspects: { Type: ['Cup Holder'] }, warnings: [] };
  });
  const updateMock = mock.method(listingRepository, 'updateGeneratedData', async (id, data) => ({ id, generated_data: data, error_message: 'stale' }));
  const statusMock = mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, generated_data: updateMock.mock.calls[0].arguments[1], ...extra }));

  const { listing } = await listingService.updateDraft('listing-1', USER_ID, { categoryId: '63691' });

  assert.strictEqual(refitMock.mock.calls.length, 1);
  const saved = updateMock.mock.calls[0].arguments[1];
  assert.strictEqual(saved.categoryId, '63691');
  assert.deepStrictEqual(saved.categoryPath, ['Vehicle Parts & Accessories', 'Cup Holders']);
  assert.strictEqual(saved.title, 'New title for cup holders');
  assert.deepStrictEqual(saved.aspects, { Type: ['Cup Holder'], 'Country/Region of Manufacture': ['United Kingdom'] });
  assert.match(saved.warnings[0], /^Category changed to/);
  // The recorded publish failure was about the old category.
  assert.strictEqual(statusMock.mock.calls[0].arguments[2].errorMessage, null);
  assert.strictEqual(listing.errorMessage, null);
});

test('updateDraft refuses a category that is not a final (leaf) category', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => pendingDraft({ categoryId: '1', title: 't', description: 'd', imageUrls: [] }));
  mock.method(ebayTaxonomy, 'getCategoryPath', async () => [{ id: '10', name: 'Vehicle Parts' }]);
  mock.method(ebayTaxonomy, 'getCategoryChildren', async () => [{ id: '11', name: 'Cup Holders', leaf: true, childCount: 0 }]);
  await assert.rejects(() => listingService.updateDraft('listing-1', USER_ID, { categoryId: '10' }), /final category/);
});

test('updateDraft renames an option and an axis everywhere they appear', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      commonTitle: 't',
      commonDescription: 'd',
      imageUrls: ['https://i.ebayimg.com/a.jpg'],
      variesBy: { aspects: {}, aspectsImageVariesBy: ['Color'], specifications: [{ name: 'Color', values: ['Blk', 'Red'] }] },
      variants: [
        { aspects: { Color: ['Blk'] }, imageUrls: ['https://i.ebayimg.com/b.jpg'], price: { value: '9', currency: 'GBP' }, quantity: 1 },
        { aspects: { Color: ['Red'] }, imageUrls: ['https://i.ebayimg.com/r.jpg'], price: { value: '9', currency: 'GBP' }, quantity: 1 },
      ],
    })
  );
  const updateMock = mock.method(listingRepository, 'updateGeneratedData', async (id, data) => ({ id, generated_data: data }));

  await listingService.updateDraft('listing-1', USER_ID, {
    renameAxisValues: [{ axis: 'Color', from: 'Blk', to: 'Black' }],
    renameAxes: [{ from: 'Color', to: 'Colour' }],
  });

  const saved = updateMock.mock.calls[0].arguments[1];
  assert.deepStrictEqual(saved.variants.map((v) => v.aspects), [{ Colour: ['Black'] }, { Colour: ['Red'] }]);
  assert.deepStrictEqual(saved.variesBy.specifications, [{ name: 'Colour', values: ['Black', 'Red'] }]);
  assert.deepStrictEqual(saved.variesBy.aspectsImageVariesBy, ['Colour']);
});

test('updateDraft refuses to rename an option onto one that already exists', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      imageUrls: [],
      variesBy: { aspects: {}, aspectsImageVariesBy: [], specifications: [{ name: 'Colour', values: ['Black', 'Red'] }] },
      variants: [
        { aspects: { Colour: ['Black'] }, imageUrls: [], price: { value: '9', currency: 'GBP' }, quantity: 1 },
        { aspects: { Colour: ['Red'] }, imageUrls: [], price: { value: '9', currency: 'GBP' }, quantity: 1 },
      ],
    })
  );
  await assert.rejects(
    () => listingService.updateDraft('listing-1', USER_ID, { renameAxisValues: [{ axis: 'Colour', from: 'Red', to: 'Black' }] }),
    /already an option/
  );
});

test('updateDraft adds an option by copying the variations of an existing one', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      commonTitle: 't',
      commonDescription: 'd',
      imageUrls: ['https://i.ebayimg.com/a.jpg'],
      variesBy: { aspects: {}, aspectsImageVariesBy: [], specifications: [{ name: 'Unit Quantity', values: ['1', '2'] }] },
      variants: [
        { aspects: { 'Unit Quantity': ['1'] }, imageUrls: ['https://i.ebayimg.com/1.jpg'], price: { value: '6.99', currency: 'GBP' }, quantity: 3 },
        { aspects: { 'Unit Quantity': ['2'] }, imageUrls: ['https://i.ebayimg.com/2.jpg'], price: { value: '9.99', currency: 'GBP' }, quantity: 3 },
      ],
    })
  );
  const updateMock = mock.method(listingRepository, 'updateGeneratedData', async (id, data) => ({ id, generated_data: data }));

  await listingService.updateDraft('listing-1', USER_ID, { addAxisValues: [{ axis: 'Unit Quantity', value: '5', copyFrom: '2' }] });

  const saved = updateMock.mock.calls[0].arguments[1];
  assert.strictEqual(saved.variants.length, 3);
  assert.deepStrictEqual(saved.variants[2].aspects, { 'Unit Quantity': ['5'] });
  assert.strictEqual(saved.variants[2].price.value, '9.99');
  assert.deepStrictEqual(saved.variants[2].imageUrls, ['https://i.ebayimg.com/2.jpg']);
  assert.deepStrictEqual(saved.variesBy.specifications[0].values, ['1', '2', '5']);

  await assert.rejects(
    () => listingService.updateDraft('listing-1', USER_ID, { addAxisValues: [{ axis: 'Unit Quantity', value: '2' }] }),
    /already an option/
  );
});
