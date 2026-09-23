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

test('a draft for an account with only push settings (no default policies) says which policies to choose', async () => {
  mock.method(connectionService, 'getConnectionSummary', async () =>
    ebayConnection({ settings: { ebay: { marketplaceId: 'EBAY_GB', returnPolicyId: 'r1', userId: 'u1', orderPush: { subscriptionId: 's1' } } } })
  );
  const create = mock.method(listingRepository, 'createDraft', async (args) => ({ id: 'listing-9', generated_data: args.generatedData }));

  await listingService.createEbayDraft(CONNECTION_ID, USER_ID, { sku: 'SKU-3', title: 'Lamp' }, { warnings: ['Check the title.'] });

  const saved = create.mock.calls[0].arguments[0].generatedData;
  assert.deepStrictEqual(saved.listingPolicies, { fulfillmentPolicyId: undefined, paymentPolicyId: undefined, returnPolicyId: 'r1' });
  assert.deepStrictEqual(saved.warnings, [
    'Check the title.',
    'This account has no default postage and payment policy in Settings: choose them here before publishing.',
  ]);
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
    generated_data: { marketplaceId: 'EBAY_GB', title: 'Test listing', price: { value: '9.99', currency: 'GBP' }, imageUrls: ['https://i.ebayimg.com/a.jpg'] },
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
  mock.method(listingRepository, 'findOtherWithSku', async () => null);
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
  // The seller's Shop departments: the draft is filed under the one that fits.
  mock.method(ebayService, 'getStoreCategoriesCached', async () => ({
    categories: [{ id: '1', name: 'New In', children: [] }, { id: '2', name: 'Widgets', children: [] }],
    unavailable: null,
  }));
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
  assert.deepStrictEqual(call.generatedData.storeCategoryNames, ['/Widgets'], 'filed under the matching Shop department');
  assert.strictEqual(call.platformOfferId, null);
  // costPrice is no longer part of sourceData — the cost comes from the
  // supplier's own price at draft time, and the derived price plus its full
  // working is persisted in generated_data instead.
  assert.deepStrictEqual(call.sourceData, { competitor: { title: 'Competitor' }, source: { title: 'Source' } });
});

test('generateEbayDraftFromUrls creates a variation draft with no eBay objects yet', async () => {
  mock.method(listingRepository, 'findOtherWithSku', async () => null);
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

// A draft with what publish needs (a title and prices), which a test's
// own fields override.
function pendingDraft(generatedData, overrides = {}) {
  const variants = Array.isArray(generatedData.variants) ? generatedData.variants : null;
  const complete = variants?.length
    ? { commonTitle: 'Test listing', ...generatedData, variants: variants.map((v) => ({ price: { value: '9.99', currency: 'GBP' }, ...v })) }
    : { title: 'Test listing', price: { value: '9.99', currency: 'GBP' }, ...generatedData };
  return {
    id: 'listing-1',
    connection_id: CONNECTION_ID,
    status: 'pending_review',
    platform_offer_id: null,
    platform_group_key: null,
    generated_data: complete,
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

test('publish retries once with "Does not apply" when the category requires an EAN the draft lacks', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({ marketplaceId: 'EBAY_GB', skuBase: 'AE1', title: 'Tracker', imageUrls: ['https://i.ebayimg.com/a.jpg'] })
  );
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't' }, ebayConnection()));
  const draftMock = mock.method(ebayService, 'draftListing', async (credentials, input) => ({ offerId: `offer-${draftMock.mock.calls.length}`, status: 'drafted', identifiers: input.identifiers }));
  const deleteMock = mock.method(ebayService, 'deleteInventoryObjects', async () => {});
  let publishes = 0;
  mock.method(ebayService, 'publishDraft', async () => {
    publishes += 1;
    if (publishes === 1) {
      const err = new Error('A user error has occurred. The EAN field is missing. Please add EAN to the listing and try again.');
      err.details = [{ errorId: 25002, parameters: [{ name: '4', value: 'EAN' }] }];
      throw err;
    }
    return { externalProductId: 'ebay-1', status: 'published' };
  });
  const updateDataMock = mock.method(listingRepository, 'updateGeneratedData', async (id, data) => ({ id, generated_data: data }));
  mock.method(listingRepository, 'setPlatformIds', async () => ({}));
  mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  const result = await listingService.publish('listing-1', USER_ID);

  // First build had no identifier; it was cleared and rebuilt with eBay's text.
  assert.strictEqual(draftMock.mock.calls.length, 2);
  assert.strictEqual(draftMock.mock.calls[0].arguments[1].identifiers.ean, undefined);
  assert.strictEqual(draftMock.mock.calls[1].arguments[1].identifiers.ean, 'Does not apply');
  assert.strictEqual(deleteMock.mock.calls.length, 1);
  assert.strictEqual(updateDataMock.mock.calls[0].arguments[1].identifiers.ean, 'Does not apply');
  assert.strictEqual(result.externalProductId, 'ebay-1');
  assert.match(result.warnings[0], /requires a EAN|requires an EAN/);
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

function liveEditRow(extra = {}) {
  return {
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
      ...extra,
    },
  };
}

test('publish on a live edit of a Liston-published listing revises it through the Inventory API', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => liveEditRow());
  // Liston's own record of publishing it: an Inventory offer.
  mock.method(listingRepository, 'findPublishedByItemId', async () => ({ id: 'own-1', platform_offer_id: 'offer-7', sku: 'Liston-1-AB12', generated_data: { title: 'Old', storeCategoryNames: ['/Tech'] } }));
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 'token' }, ebayConnection()));
  mock.method(ebayService, 'getStoreProfile', async () => ({ storeName: 'Store' }));
  mock.method(ebayService, 'listActiveListings', async () => ({ items: [] }));
  const trading = mock.method(ebayService, 'reviseLiveListing', async () => {
    throw new Error('should not be used');
  });
  const inventory = mock.method(ebayService, 'reviseInventoryListing', async (credentials, input) => {
    assert.strictEqual(input.offerId, 'offer-7');
    assert.strictEqual(input.draft.sku, 'Liston-1-AB12');
    assert.strictEqual(input.draft.title, 'New title');
    assert.match(input.listingDescription, /New copy/);
    assert.deepStrictEqual(input.storeCategoryNames, ['/Tech']);
    return { listingId: '407000000001', warnings: [] };
  });
  const updateData = mock.method(listingRepository, 'updateGeneratedData', async () => ({}));
  const del = mock.method(listingRepository, 'deleteById', async () => {});

  const result = await listingService.publish('edit-1', USER_ID);

  assert.strictEqual(trading.mock.calls.length, 0);
  assert.strictEqual(inventory.mock.calls.length, 1);
  // The published record follows the edit.
  assert.strictEqual(updateData.mock.calls[0].arguments[0], 'own-1');
  assert.strictEqual(updateData.mock.calls[0].arguments[1].title, 'New title');
  assert.strictEqual(del.mock.calls[0].arguments[0], 'edit-1');
  assert.strictEqual(result.deleted, true);
});

test('publish on a live edit falls back to the Inventory API when eBay says the listing is inventory-managed', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => liveEditRow({ sku: 'Liston-9-ZZ99' }));
  mock.method(listingRepository, 'findPublishedByItemId', async () => null);
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 'token' }, ebayConnection()));
  mock.method(ebayService, 'getStoreProfile', async () => ({ storeName: 'Store' }));
  mock.method(ebayService, 'listActiveListings', async () => ({ items: [] }));
  mock.method(ebayService, 'reviseLiveListing', async () => {
    throw new Error('Inventory-based listing management is not currently supported by this tool. Please refer to the tool used to create this listing.');
  });
  const inventory = mock.method(ebayService, 'reviseInventoryListing', async (credentials, input) => {
    assert.strictEqual(input.sku, 'Liston-9-ZZ99');
    return { listingId: '407000000001', warnings: [] };
  });
  mock.method(listingRepository, 'deleteById', async () => {});

  await listingService.publish('edit-1', USER_ID);
  assert.strictEqual(inventory.mock.calls.length, 1);
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
  mock.method(listingRepository, 'findPublishedByItemId', async () => null);
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

const ebayTaxonomy = require('../../src/modules/ebay/api/ebay.taxonomy');
const textGenerator = require('../../src/modules/ai-generation/text-generator.service');

test('publish uses the seller’s own SKU as-is, and numbers variations from it', async () => {
  mock.method(listingRepository, 'findOtherWithSku', async () => null);
  mock.method(ebayService, 'listListingsDetailed', async () => ({ items: [] }));
  mock.method(ebayService, 'findLiveListingForSku', async () => ({ listingId: null }));
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
  mock.method(ebayTaxonomy, 'getEditorAspectSchema', async () => null);
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

test('publish sends eBay-ready specifics: no axis in the shared set, identifiers marked Does Not Apply', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      marketplaceId: 'EBAY_GB',
      commonTitle: 'Widget',
      commonDescription: 'd',
      imageUrls: ['https://i.ebayimg.com/a.jpg'],
      categoryId: '11',
      // The seller (or a refit) put Colour in item specifics too — eBay
      // rejects the group when a variation attribute is repeated there.
      variesBy: { aspects: { Brand: ['Acme'], Colour: ['Red'] }, aspectsImageVariesBy: [], specifications: [{ name: 'Colour', values: ['Red', 'Blue'] }] },
      variants: [
        { aspects: { Colour: ['Red'] }, imageUrls: ['https://i.ebayimg.com/r.jpg'], price: { value: '9', currency: 'GBP' }, quantity: 1 },
        { aspects: { Colour: ['Blue'] }, imageUrls: ['https://i.ebayimg.com/b.jpg'], price: { value: '9', currency: 'GBP' }, quantity: 1 },
      ],
    })
  );
  mock.method(ebayTaxonomy, 'getVariationsSupported', async () => true);
  mock.method(ebayTaxonomy, 'getEditorAspectSchema', async () => [
    { name: 'Colour', required: true, variation: true },
    { name: 'Brand', required: true, variation: false },
    { name: 'Manufacturer Part Number', required: true, variation: false },
  ]);
  mock.method(listingService, 'renderDraftDescription', async () => '<p>x</p>');
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't' }, ebayConnection()));
  let sent;
  mock.method(ebayService, 'draftVariationListing', async (credentials, input) => {
    sent = input;
    return { groupKey: input.groupKey };
  });
  mock.method(ebayService, 'publishGroup', async () => ({ externalProductId: 'ebay-1' }));
  mock.method(listingRepository, 'setPlatformIds', async () => ({}));
  const statusMock = mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  await listingService.publish('listing-1', USER_ID);
  assert.deepStrictEqual(sent.variesBy.aspects, { Brand: ['Acme'], 'Manufacturer Part Number': ['Does Not Apply'] });
  assert.deepStrictEqual(sent.variants.map((v) => v.aspects), [{ Colour: ['Red'] }, { Colour: ['Blue'] }]);
  assert.strictEqual(statusMock.mock.calls[0].arguments[1], 'published');
});

// Size list mirrors EBAY_GB "Men's Trousers" (57989) read live, where eBay
// refused "XXL" at publish (25129) although its schema called Size free text.
const TROUSERS_SCHEMA = [
  { name: 'Colour', required: true, variation: true, selectionOnly: false, allowedValues: ['Black', 'Grey', 'Navy'], hasMoreValues: false },
  { name: 'Size', required: true, variation: true, selectionOnly: false, allowedValues: ['S', 'M', 'L', 'XL', '2XL', '3XL'], hasMoreValues: false },
  { name: 'Brand', required: true, variation: false },
];

function trousersDraft(sizes, extra = {}) {
  const variants = sizes.map((size) => ({
    aspects: { Colour: ['Grey'], Size: [size] },
    imageUrls: ['https://i.ebayimg.com/g.jpg'],
    price: { value: '19', currency: 'GBP' },
    quantity: 1,
  }));
  return pendingDraft({
    marketplaceId: 'EBAY_GB',
    categoryId: '57989',
    commonTitle: 'Mens Joggers',
    commonDescription: 'd',
    imageUrls: ['https://i.ebayimg.com/a.jpg'],
    variesBy: {
      aspects: { Brand: ['Unbranded'] },
      aspectsImageVariesBy: [],
      specifications: [
        { name: 'Colour', values: ['Grey'] },
        { name: 'Size', values: sizes },
      ],
    },
    variants,
    ...extra,
  });
}

test('publish sends variation options under eBay spelling ("XXL" -> "2XL") and says so', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => trousersDraft(['XL', 'XXL', 'xxxl']));
  mock.method(ebayTaxonomy, 'getVariationsSupported', async () => true);
  mock.method(ebayTaxonomy, 'getEditorAspectSchema', async () => TROUSERS_SCHEMA);
  mock.method(listingService, 'renderDraftDescription', async () => '<p>x</p>');
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't' }, ebayConnection()));
  let sent;
  mock.method(ebayService, 'draftVariationListing', async (credentials, input) => {
    sent = input;
    return { groupKey: input.groupKey };
  });
  mock.method(ebayService, 'publishGroup', async () => ({ externalProductId: 'ebay-1' }));
  mock.method(listingRepository, 'setPlatformIds', async () => ({}));
  mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  const result = await listingService.publish('listing-1', USER_ID);
  assert.deepStrictEqual(sent.variesBy.specifications, [
    { name: 'Colour', values: ['Grey'] },
    { name: 'Size', values: ['XL', '2XL', '3XL'] },
  ]);
  assert.deepStrictEqual(sent.variants.map((v) => v.aspects.Size[0]), ['XL', '2XL', '3XL']);
  assert.ok(result.warnings.some((w) => /Size options were sent under eBay's spelling.*XXL → 2XL, xxxl → 3XL/.test(w)), result.warnings.join('\n'));
});

test('publish refuses an option eBay lists nothing for, on a fixed-list axis, before building anything', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => trousersDraft(['M', 'Petite']));
  mock.method(ebayTaxonomy, 'getVariationsSupported', async () => true);
  mock.method(ebayTaxonomy, 'getEditorAspectSchema', async () => TROUSERS_SCHEMA.map((a) => (a.name === 'Size' ? { ...a, selectionOnly: true } : a)));
  const draftMock = mock.method(ebayService, 'draftVariationListing', async () => ({}));
  mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  await assert.rejects(
    () => listingService.publish('listing-1', USER_ID),
    /eBay only accepts its own Size values in this category and "Petite" isn't one of them. eBay's Size values for this category are: S, M, L, XL, 2XL, 3XL. Rename the "Petite" option under Variations/
  );
  assert.strictEqual(draftMock.mock.calls.length, 0);
});

test("publish turns eBay's 25129 refusal of an option value into the axis, the value and eBay's list", async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => trousersDraft(['M', 'Petite']));
  mock.method(ebayTaxonomy, 'getVariationsSupported', async () => true);
  mock.method(ebayTaxonomy, 'getEditorAspectSchema', async () => TROUSERS_SCHEMA);
  mock.method(listingService, 'renderDraftDescription', async () => '<p>x</p>');
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't' }, ebayConnection()));
  mock.method(ebayService, 'draftVariationListing', async (credentials, input) => ({ groupKey: input.groupKey }));
  mock.method(ebayService, 'publishGroup', async () => {
    const err = new Error(
      'The product aspects for this category no longer support custom values for Size. Your listing was not published. (Enter a valid value for Size.; Petite is not a valid value for Size. Select a value from the available options.)'
    );
    err.statusCode = 400;
    err.details = [
      {
        errorId: 25129,
        message: 'The product aspects for this category no longer support custom values for Size.',
        parameters: [
          { name: '0', value: 'Enter a valid value for Size.' },
          { name: '1', value: 'Petite is not a valid value for Size. Select a value from the available options.' },
          { name: '3', value: 'Size' },
          { name: '4', value: 'Petite' },
        ],
      },
    ];
    throw err;
  });
  const statusMock = mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  await assert.rejects(
    () => listingService.publish('listing-1', USER_ID),
    /eBay only accepts its own Size values in this category and "Petite" isn't one of them. eBay's Size values for this category are: S, M, L, XL, 2XL, 3XL./
  );
  assert.strictEqual(statusMock.mock.calls[0].arguments[1], 'pending_review');
  assert.match(statusMock.mock.calls[0].arguments[2].errorMessage, /Rename the "Petite" option under Variations/);
});

test('publish names what the draft still lacks (title, prices, policies, blank option names) before touching eBay', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      marketplaceId: 'EBAY_GB',
      commonTitle: ' ',
      imageUrls: ['https://i.ebayimg.com/a.jpg'],
      listingPolicies: { fulfillmentPolicyId: 'f', paymentPolicyId: '', returnPolicyId: '' },
      variesBy: { specifications: [{ name: 'Style', values: ['Logo 1', ''] }] },
      variants: [
        { aspects: { Style: ['Logo 1'] }, imageUrls: ['https://i.ebayimg.com/1.jpg'] },
        { aspects: { Style: [''] }, price: { value: '', currency: 'GBP' }, imageUrls: ['https://i.ebayimg.com/2.jpg'] },
      ],
    })
  );
  const draftMock = mock.method(ebayService, 'draftListing', async () => ({}));
  const statusMock = mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  await assert.rejects(
    () => listingService.publish('listing-1', USER_ID),
    (err) =>
      err.statusCode === 400 &&
      err.message ===
        'Before publishing: Add a title. Enter a price for variation 2 in the variations table. Choose a payment and returns policy. ' +
          '"Style" has an option with no name. Rename or remove it in the variations table.'
  );
  assert.strictEqual(draftMock.mock.calls.length, 0, 'nothing was built on eBay');
  assert.strictEqual(statusMock.mock.calls.length, 0, 'the draft was not touched');
});

test('publish names a required specific that is still empty instead of letting eBay reject the build', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      marketplaceId: 'EBAY_GB',
      title: 'Widget',
      description: 'd',
      imageUrls: ['https://i.ebayimg.com/a.jpg'],
      categoryId: '11',
      aspects: { Material: ['Steel'] },
      price: { value: '9', currency: 'GBP' },
      quantity: 1,
    })
  );
  mock.method(ebayTaxonomy, 'getEditorAspectSchema', async () => [
    { name: 'Brand', required: true },
    { name: 'Type', required: true },
    { name: 'Material', required: false },
  ]);
  const draftMock = mock.method(ebayService, 'draftListing', async () => ({}));
  const statusMock = mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  await assert.rejects(() => listingService.publish('listing-1', USER_ID), /eBay requires Brand, Type for this category/);
  assert.strictEqual(draftMock.mock.calls.length, 0, 'nothing was built on eBay');
  assert.strictEqual(statusMock.mock.calls.length, 0, 'the draft was not touched');
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

test('publish refuses a variation attribute eBay does not allow in the category, naming the allowed ones', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      marketplaceId: 'EBAY_GB',
      categoryId: '11844',
      categoryPath: ["Men's Shavers"],
      imageUrls: ['https://i.ebayimg.com/a.jpg'],
      variesBy: { aspects: {}, aspectsImageVariesBy: [], specifications: [{ name: 'Unit Quantity', values: ['1', '2'] }] },
      variants: [
        { aspects: { 'Unit Quantity': ['1'] }, imageUrls: ['https://i.ebayimg.com/1.jpg'], price: { value: '9', currency: 'GBP' }, quantity: 1 },
        { aspects: { 'Unit Quantity': ['2'] }, imageUrls: ['https://i.ebayimg.com/2.jpg'], price: { value: '9', currency: 'GBP' }, quantity: 1 },
      ],
    })
  );
  mock.method(ebayTaxonomy, 'getVariationsSupported', async () => true);
  mock.method(ebayTaxonomy, 'getEditorAspectSchema', async () => [
    { name: 'Colour', variation: true },
    { name: 'Unit Quantity', variation: false },
  ]);
  const draftMock = mock.method(ebayService, 'draftVariationListing', async () => ({}));
  mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  await assert.rejects(() => listingService.publish('listing-1', USER_ID), /doesn't allow "Unit Quantity" as a variation attribute.*Colour/);
  assert.strictEqual(draftMock.mock.calls.length, 0);
});

test('updateDraft refuses to rename an axis to a name eBay does not allow as a variation', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      categoryId: '11844',
      imageUrls: [],
      variesBy: { aspects: {}, aspectsImageVariesBy: [], specifications: [{ name: 'Unit Quantity', values: ['1'] }] },
      variants: [{ aspects: { 'Unit Quantity': ['1'] }, imageUrls: [], price: { value: '9', currency: 'GBP' }, quantity: 1 }],
    })
  );
  mock.method(ebayTaxonomy, 'getEditorAspectSchema', async () => [{ name: 'Colour', variation: true }, { name: 'Pack Size', variation: false }]);
  await assert.rejects(() => listingService.updateDraft('listing-1', USER_ID, { renameAxes: [{ from: 'Unit Quantity', to: 'Pack Size' }] }), /fixed item specific here.*Colour/);
});

test('updateDraft lets an axis take a name of the seller’s own that eBay does not list', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      categoryId: '11844',
      imageUrls: [],
      variesBy: { aspects: {}, aspectsImageVariesBy: [], specifications: [{ name: 'Unit Quantity', values: ['1'] }] },
      variants: [{ aspects: { 'Unit Quantity': ['1'] }, imageUrls: [], price: { value: '9', currency: 'GBP' }, quantity: 1 }],
    })
  );
  mock.method(ebayTaxonomy, 'getEditorAspectSchema', async () => [{ name: 'Colour', variation: true }, { name: 'Pack Size', variation: false }]);
  const updateMock = mock.method(listingRepository, 'updateGeneratedData', async (id, data) => ({ id, generated_data: data }));
  await listingService.updateDraft('listing-1', USER_ID, { renameAxes: [{ from: 'Unit Quantity', to: 'Breaking Strain' }] });
  assert.deepStrictEqual(updateMock.mock.calls[0].arguments[1].variesBy.specifications, [{ name: 'Breaking Strain', values: ['1'] }]);
});

// --- ending a live listing ----------------------------------------------------

test('endLiveListing ends the item on eBay and drops any working copy opened to edit it', async () => {
  const end = mock.method(ebayService, 'endLiveListing', async (credentials, connectionId, itemId) => ({ itemId, endTime: '2026-09-19T01:00:00.000Z', warnings: [] }));
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 'token' }, ebayConnection()));
  mock.method(listingRepository, 'findLiveEdit', async () => ({ id: 'copy-1' }));
  const del = mock.method(listingRepository, 'deleteById', async () => {});

  const result = await listingService.endLiveListing(CONNECTION_ID, USER_ID, '407000000009');

  assert.deepStrictEqual(end.mock.calls[0].arguments.slice(1), [CONNECTION_ID, '407000000009']);
  assert.deepStrictEqual(del.mock.calls[0].arguments, ['copy-1']);
  assert.deepStrictEqual(result, { itemId: '407000000009', endTime: '2026-09-19T01:00:00.000Z', warnings: [] });
});

test('dedupeVariationGroup drops repeated combinations and repeated specification values, case-insensitively', () => {
  const draft = {
    variesBy: {
      aspects: {},
      aspectsImageVariesBy: ['Colour'],
      specifications: [
        { name: 'Colour', values: ['Camo Brown', 'camo brown', 'Camo Green'] },
        { name: 'Size', values: ['25lb', '35lb'] },
      ],
    },
    variants: [
      { aspects: { Colour: ['Camo Brown'], Size: ['25lb'] }, price: { value: '9', currency: 'GBP' }, quantity: 1 },
      { aspects: { Colour: ['camo brown'], Size: ['25lb'] }, price: { value: '9', currency: 'GBP' }, quantity: 1 },
      { aspects: { Colour: ['Camo Green'], Size: ['35lb'] }, price: { value: '9', currency: 'GBP' }, quantity: 1 },
    ],
  };

  const { draft: tidy, warnings } = listingService.dedupeVariationGroup(draft);

  assert.strictEqual(tidy.variants.length, 2);
  assert.deepStrictEqual(tidy.variesBy.specifications, [
    { name: 'Colour', values: ['Camo Brown', 'Camo Green'] },
    // 25lb is only used by the kept Camo Brown row, 35lb by Camo Green.
    { name: 'Size', values: ['25lb', '35lb'] },
  ]);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /1 duplicate variation was left out/);
  assert.match(warnings[0], /Colour: camo brown, Size: 25lb/);
  // The stored draft is untouched.
  assert.strictEqual(draft.variants.length, 3);
});

test('dedupeVariationGroup merges two specifications with the same name', () => {
  const draft = {
    variesBy: { aspects: {}, specifications: [{ name: 'Colour', values: ['Black'] }, { name: 'colour', values: ['Red'] }] },
    variants: [
      { aspects: { Colour: ['Black'] }, price: { value: '9', currency: 'GBP' }, quantity: 1 },
      { aspects: { Colour: ['Red'] }, price: { value: '9', currency: 'GBP' }, quantity: 1 },
    ],
  };
  const { draft: tidy, warnings } = listingService.dedupeVariationGroup(draft);
  assert.deepStrictEqual(tidy.variesBy.specifications, [{ name: 'Colour', values: ['Black', 'Red'] }]);
  assert.deepStrictEqual(warnings, []);
});

test('updateDraft refuses to rename an axis onto another axis of the listing', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      imageUrls: [],
      categoryId: null,
      variesBy: {
        aspects: {},
        aspectsImageVariesBy: [],
        specifications: [
          { name: 'Colour', values: ['Black', 'Red'] },
          { name: 'Size', values: ['S', 'M'] },
        ],
      },
      variants: [
        { aspects: { Colour: ['Black'], Size: ['S'] }, imageUrls: [], price: { value: '9', currency: 'GBP' }, quantity: 1 },
        { aspects: { Colour: ['Black'], Size: ['M'] }, imageUrls: [], price: { value: '9', currency: 'GBP' }, quantity: 1 },
      ],
    })
  );
  await assert.rejects(
    () => listingService.updateDraft('listing-1', USER_ID, { renameAxes: [{ from: 'Size', to: 'colour' }] }),
    /already a variation attribute/
  );
});

// --- unique custom labels ------------------------------------------------------

test('uniqueSku draws a fresh tag until Liston has no other record with the label', async () => {
  const seen = [];
  mock.method(listingRepository, 'findOtherWithSku', async (connectionId, sku) => {
    seen.push(sku);
    return seen.length === 1 ? { id: 'other', status: 'pending_review' } : null;
  });
  const sku = await listingService.uniqueSku(CONNECTION_ID, 'Liston-1005006');
  assert.match(sku, /^Liston-1005006-[A-HJ-NP-Z2-9]{4}$/);
  assert.strictEqual(seen.length, 2);
  assert.notStrictEqual(seen[0], seen[1]);
});

test('skuInUse names a live listing found through eBay offers', async () => {
  mock.method(listingRepository, 'findOtherWithSku', async () => null);
  mock.method(ebayService, 'listListingsDetailed', async () => ({ items: [] }));
  mock.method(ebayService, 'findLiveListingForSku', async () => ({ listingId: '800684782461' }));
  const where = await listingService.skuInUse(CONNECTION_ID, 'Liston-X', { credentials: { accessToken: 't' }, marketplaceId: 'EBAY_GB' });
  assert.strictEqual(where, 'live listing 800684782461');
});

test('publish swaps a label another live listing owns for a fresh one, on the draft too, and says so', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({ marketplaceId: 'EBAY_GB', skuBase: 'AE999', sku: 'Liston-DSAEZEESEP19', title: 'Headlight', imageUrls: ['https://i.ebayimg.com/a.jpg'] })
  );
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't' }, ebayConnection()));
  mock.method(listingRepository, 'findOtherWithSku', async () => null);
  mock.method(ebayService, 'listListingsDetailed', async () => ({ items: [] }));
  mock.method(ebayService, 'findLiveListingForSku', async (credentials, sku) => ({ listingId: sku === 'Liston-DSAEZEESEP19' ? '800684782461' : null }));
  const saved = mock.method(listingRepository, 'updateGeneratedData', async (id, data) => ({ id, generated_data: data }));
  let usedSku = null;
  mock.method(ebayService, 'draftListing', async (credentials, input) => {
    usedSku = input.sku;
    return { offerId: 'offer-1', status: 'drafted' };
  });
  mock.method(ebayService, 'publishDraft', async () => ({ externalProductId: 'ebay-1', status: 'published' }));
  mock.method(listingRepository, 'setPlatformIds', async () => ({}));
  mock.method(listingRepository, 'updateStatus', async (id, status, extra) => ({ id, status, ...extra }));

  const result = await listingService.publish('listing-1', USER_ID);

  assert.match(usedSku, /^Liston-DSAEZEESEP19-[A-HJ-NP-Z2-9]{4}$/);
  assert.strictEqual(saved.mock.calls[0].arguments[1].sku, usedSku, 'the draft keeps the label it was published under');
  assert.match(result.warnings[0], /SKU changed from Liston-DSAEZEESEP19 to Liston-DSAEZEESEP19-[A-HJ-NP-Z2-9]{4}: .*live listing 800684782461/);
});

test('regenerateSku gives a draft a new label built from its current one and persists it', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () => pendingDraft({ marketplaceId: 'EBAY_GB', sku: 'Liston-1005006-ABCD', imageUrls: [] }));
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't' }, ebayConnection()));
  mock.method(listingRepository, 'findOtherWithSku', async () => null);
  mock.method(ebayService, 'listListingsDetailed', async () => ({ items: [] }));
  mock.method(ebayService, 'findLiveListingForSku', async () => ({ listingId: null }));
  const saved = mock.method(listingRepository, 'updateGeneratedData', async (id, data) => ({ id, generated_data: data }));

  const { sku } = await listingService.regenerateSku('listing-1', USER_ID);
  assert.match(sku, /^Liston-1005006-[A-HJ-NP-Z2-9]{4}$/);
  assert.notStrictEqual(sku, 'Liston-1005006-ABCD');
  assert.strictEqual(saved.mock.calls[0].arguments[1].sku, sku);
});

test('a Hazardous Materials block from eBay is explained with the words that likely triggered it', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({
      marketplaceId: 'EBAY_GB',
      skuBase: 'AE1',
      title: 'Carp Hooklink Braid',
      description: 'Lead-free sinking braid that pairs with lead clips.',
      aspects: { Type: ['Braided Line'] },
      imageUrls: ['https://i.ebayimg.com/a.jpg'],
    })
  );
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't' }, ebayConnection()));
  mock.method(ebayService, 'draftListing', async () => ({ offerId: 'offer-1', status: 'drafted' }));
  mock.method(ebayService, 'publishDraft', async () => {
    const err = new Error('Cannot revise listing. The item cannot be listed or modified.');
    err.details = [{ errorId: 25019, parameters: [{ name: '2', value: 'PI_HAZ_Hazardous_GeneralMessage' }] }];
    throw err;
  });
  mock.method(ebayService, 'deleteInventoryObjects', async () => ({}));
  mock.method(listingRepository, 'findOtherWithSku', async () => null);
  mock.method(listingRepository, 'updateGeneratedData', async (id, data) => ({ id, generated_data: data }));
  const status = mock.method(listingRepository, 'updateStatus', async (id, s, extra) => ({ id, status: s, ...extra }));

  await assert.rejects(() => listingService.publish('listing-1', USER_ID), (err) => {
    assert.match(err.message, /Hazardous Materials policy/);
    assert.match(err.message, /"lead" in the description/);
    assert.strictEqual(err.statusCode, 400);
    return true;
  });
  assert.match(status.mock.calls[0].arguments[2].errorMessage, /"lead" in the description/);
});

test('a policy block clears what the attempt created on eBay and renews the SKU', async () => {
  mock.method(listingRepository, 'findByIdForUser', async () =>
    pendingDraft({ marketplaceId: 'EBAY_GB', skuBase: 'AE1', sku: 'Liston-1-ABCD', title: 'Rig', description: 'Clean text.', aspects: {}, imageUrls: ['https://i.ebayimg.com/a.jpg'] })
  );
  mock.method(connectionService, 'withDecryptedCredentials', async (id, userId, action) => action({ accessToken: 't' }, ebayConnection()));
  mock.method(listingRepository, 'findOtherWithSku', async () => null);
  mock.method(ebayService, 'listListingsDetailed', async () => ({ items: [] }));
  mock.method(ebayService, 'findLiveListingForSku', async () => ({ listingId: null }));
  mock.method(ebayService, 'draftListing', async () => ({ offerId: 'offer-1', status: 'drafted' }));
  mock.method(ebayService, 'publishDraft', async () => {
    const err = new Error('Cannot revise listing. The item cannot be listed or modified.');
    err.details = [{ errorId: 25019, parameters: [{ name: '2', value: 'PI_HAZ_Hazardous_GeneralMessage' }] }];
    throw err;
  });
  const cleared = mock.method(ebayService, 'deleteInventoryObjects', async () => ({}));
  const saved = mock.method(listingRepository, 'updateGeneratedData', async (id, data) => ({ id, generated_data: data }));
  mock.method(listingRepository, 'updateStatus', async (id, s, extra) => ({ id, status: s, ...extra }));

  await assert.rejects(() => listingService.publish('listing-1', USER_ID), /has been cleared and the draft has a fresh SKU/);
  assert.strictEqual(cleared.mock.calls.length, 1);
  assert.deepStrictEqual(cleared.mock.calls[0].arguments[1].skus, ['Liston-1-ABCD']);
  const newSku = saved.mock.calls.at(-1).arguments[1].sku;
  assert.match(newSku, /^Liston-1-[A-HJ-NP-Z2-9]{4}$/);
  assert.notStrictEqual(newSku, 'Liston-1-ABCD');
});

// --- rewording eBay's filter words ------------------------------------------

test('fixPolicyWords applies the AI rewording, then swaps whatever it left behind, and saves', async () => {
  const revisionService = require('../../src/modules/listings/listing-revision.service');
  let stored = pendingDraft({
    commonTitle: 'Fluorocarbon Hooklink Braid 20m',
    commonDescription: 'Fluorocarbon coated braid. Pairs with lead clips.',
    imageUrls: [],
    variesBy: { aspects: { Material: ['Fluorocarbon'] }, aspectsImageVariesBy: [], specifications: [{ name: 'Colour', values: ['Camo Brown', 'Lead Grey'] }] },
    variants: [
      { aspects: { Colour: ['Camo Brown'] }, imageUrls: [], price: { value: '9', currency: 'GBP' }, quantity: 1 },
      { aspects: { Colour: ['Lead Grey'] }, imageUrls: [], price: { value: '9', currency: 'GBP' }, quantity: 1 },
    ],
  });
  mock.method(listingRepository, 'findByIdForUser', async () => stored);
  mock.method(listingRepository, 'updateGeneratedData', async (id, data) => {
    stored = { ...stored, generated_data: data };
    return stored;
  });
  // The model fixes the title and description but forgets the specific and the option.
  mock.method(revisionService, 'reviseText', async ({ instruction }) => {
    assert.match(instruction, /"fluorocarbon", "lead"/);
    return { changes: { commonTitle: 'Low-Vis Hooklink Braid 20m', commonDescription: 'Clear low-visibility coated braid. Pairs with weight clips.' }, summary: 'Reworded.' };
  });

  const result = await listingService.fixPolicyWords('listing-1', USER_ID);

  assert.strictEqual(result.changed, true);
  assert.deepStrictEqual(result.remaining, []);
  const data = stored.generated_data;
  assert.strictEqual(data.commonTitle, 'Low-Vis Hooklink Braid 20m');
  assert.deepStrictEqual(data.variesBy.aspects.Material, ['Low-visibility']);
  assert.deepStrictEqual(data.variesBy.specifications[0].values, ['Camo Brown', 'Weight Grey']);
  assert.deepStrictEqual(data.variants[1].aspects.Colour, ['Weight Grey']);
});

test('fixPolicyWords still clears the words when the AI editor is unavailable', async () => {
  const revisionService = require('../../src/modules/listings/listing-revision.service');
  let stored = pendingDraft({ title: 'Lead-free Braid', description: 'Uses lead clips.', aspects: {}, imageUrls: [] });
  mock.method(listingRepository, 'findByIdForUser', async () => stored);
  mock.method(listingRepository, 'updateGeneratedData', async (id, data) => {
    stored = { ...stored, generated_data: data };
    return stored;
  });
  mock.method(revisionService, 'reviseText', async () => {
    throw new Error('no key');
  });

  const result = await listingService.fixPolicyWords('listing-1', USER_ID);
  assert.deepStrictEqual(result.remaining, []);
  assert.strictEqual(stored.generated_data.title, 'Eco-friendly Braid');
  assert.strictEqual(stored.generated_data.description, 'Uses weight clips.');
});

test('a live edit records what buyers would notice changed, with readable before and after', () => {
  const draft = { title: 'Lamp', imageUrls: ['a.jpg', 'b.jpg'], price: { value: '9.99', currency: 'GBP' }, quantity: 3, aspects: { Brand: ['X'] }, description: 'Bright.' };
  const before = listingService.editSnapshot(draft);
  assert.strictEqual(listingService.editDifferences(before, listingService.editSnapshot({ ...draft })), null, 'nothing changed');
  const after = listingService.editSnapshot({ ...draft, title: 'LED Desk Lamp', imageUrls: ['b.jpg', 'a.jpg'], aspects: { Brand: ['X'], Colour: ['Black'] } });
  assert.deepStrictEqual(listingService.editDifferences(before, after), {
    fields: ['title', 'main_photo', 'specifics'],
    before: { title: 'Lamp', mainPhoto: 'a.jpg', photos: 2, price: 9.99, quantity: 3, specifics: 1 },
    after: { title: 'LED Desk Lamp', mainPhoto: 'b.jpg', photos: 2, price: 9.99, quantity: 3, specifics: 2 },
  });
  const reordered = listingService.editSnapshot({ ...draft, imageUrls: ['a.jpg', 'c.jpg'] });
  assert.deepStrictEqual(listingService.editDifferences(before, reordered).fields, ['photos'], 'same main photo, different set');
  const variation = { commonTitle: 'Tee', imageUrls: ['a'], variesBy: { aspects: {} }, variants: [{ price: { value: '5' }, quantity: 2 }, { price: { value: '4' }, quantity: 1 }] };
  assert.deepStrictEqual([listingService.editSnapshot(variation).price, listingService.editSnapshot(variation).quantity], [4, 3]);
  assert.strictEqual(listingService.editDifferences(null, after), null, 'an edit started before snapshots were kept');
});
