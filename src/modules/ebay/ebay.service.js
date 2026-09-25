const ebayClient = require('./api/ebay.client');
const ebayOauth = require('./api/ebay.oauth');
const ebayTrading = require('./api/ebay.trading');
const ebayFulfillment = require('./api/ebay.fulfillment');
const ebayFinances = require('./api/ebay.finances');
const ebaySignature = require('./api/ebay.signature');
const ebayPostOrder = require('./api/ebay.postorder');
const ebayBrowse = require('./api/ebay.browse');
const browseUsage = require('./browse-usage');
const ebayTaxonomy = require('./api/ebay.taxonomy');
const ebayIdentity = require('./api/ebay.identity');
const { createSwrCache } = require('./swr-cache');
const mirror = require('./ebay-mirror.repository');
const logger = require('../../utils/logger');
const ebayNotifications = require('./ebay.notifications');
const accountEvents = require('./account-events');
const governor = require('./request-governor');
const marketplaces = require('./marketplaces');
const analyticsDays = require('../analytics/analytics-days');
const orderSort = require('../orders/order-sort');
const marketScope = require('./market-scope');
const money = require('../../utils/money');
const connectionRepository = require('../connections/connection.repository');

class EbayError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000; // refresh a bit before actual expiry

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// eBay's Inventory API has a brief, well-documented propagation delay: a SKU
// created via createOrReplaceInventoryItem isn't always immediately visible
// to createOffer for the same SKU (confirmed live this session — a
// freshly-created SKU failed with "could not be found ... for the
// marketplace" on the very next call). Retry a few times with backoff before
// giving up, rather than failing the whole draft over a timing race.
const SKU_PROPAGATION_DELAY_PATTERN = /could not be found|is not available in the system/i;

// A seller-chosen SKU stays the same across publish attempts, so a retry
// after a failure finds the offer the failed attempt already created.
const OFFER_EXISTS_PATTERN = /offer (entity )?already exists|already has an offer/i;

async function createOfferWithRetry(accessToken, offerInput, attempts = 4, delayMs = 2000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await ebayClient.createOffer(accessToken, offerInput);
    } catch (err) {
      if (OFFER_EXISTS_PATTERN.test(err.message)) {
        const existing = await ebayClient.getOffersBySku(accessToken, offerInput.sku, offerInput.marketplaceId);
        const offer = (existing.offers || []).find((o) => o.marketplaceId === offerInput.marketplaceId) || existing.offers?.[0];
        if (offer?.offerId) {
          await ebayClient.updateOffer(accessToken, offer.offerId, offerInput);
          return { offerId: offer.offerId };
        }
      }
      const isPropagationDelay = SKU_PROPAGATION_DELAY_PATTERN.test(err.message);
      if (!isPropagationDelay || attempt === attempts) throw err;
      await sleep(delayMs * attempt);
    }
  }
}

// Returns a valid access token for this connection, refreshing it first if
// it's expired or close to it. When a refresh happens, `credentialsChanged`
// is true and `credentials` holds the updated values — the caller (which
// owns the DB write) must persist them via connectionService, since this
// module has no knowledge of connection storage.
// `credentials.marketplaceId` is attached by the connection service (not
// stored): it picks the Trading site every call below is made against.
async function ensureValidAccessToken(credentials) {
  const siteId = marketplaces.siteIdFor(credentials.marketplaceId);
  const expiresSoon = !credentials.accessTokenExpiresAt || credentials.accessTokenExpiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS;

  if (!expiresSoon) {
    return { accessToken: credentials.accessToken, credentials, credentialsChanged: false, siteId };
  }

  if (!credentials.refreshToken) {
    throw new EbayError('This eBay connection has no refresh token. Reconnect the account', 401);
  }

  const refreshed = await ebayOauth.refreshAccessToken(credentials.refreshToken, ebayOauth.grantedScopes(credentials));
  const updatedCredentials = { ...credentials, ...refreshed };
  return { accessToken: refreshed.accessToken, credentials: updatedCredentials, credentialsChanged: true, siteId };
}

// eBay requires at least one merchant inventory location before an offer can
// be published. We never fabricate a shipping address — if the account has
// none and the caller didn't supply one, this fails loudly rather than
// silently using a wrong origin address.
async function ensureInventoryLocation(accessToken, merchantLocationKey, locationInput) {
  const existing = await ebayClient.getInventoryLocations(accessToken);
  const hasLocation = existing?.locations?.some((loc) => loc.merchantLocationKey === merchantLocationKey);
  if (hasLocation) return;

  if (!locationInput) {
    throw new EbayError(
      'This eBay account has no inventory location set up yet. Provide a warehouse/return address once during onboarding.',
      400
    );
  }

  await ebayClient.createInventoryLocation(accessToken, merchantLocationKey, {
    location: { address: locationInput },
    locationTypes: ['WAREHOUSE'],
    name: locationInput.name || 'Default location',
  });
}

// eBay keeps two descriptions. The inventory item's `product.description`
// is plain text capped at 4,000 characters (the catalogue record); the
// offer's `listingDescription` is the HTML buyers see, capped at 500,000.
// Sending the branded template to both failed at publish: "Invalid value
// for description. The length should be between 1 and 4000 characters."
const INVENTORY_DESCRIPTION_MAX = 4000;
function plainDescription(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, INVENTORY_DESCRIPTION_MAX);
}

// eBay's "product identifier unavailable" text, per site (see the Selling
// Integration Guide, "Product Identifier Text"). Sent as the EAN/UPC/ISBN of
// a product that has none, in a category that requires one.
const NOT_APPLICABLE_TEXT = {
  EBAY_DE: 'Nicht zutreffend',
  EBAY_AT: 'Nicht zutreffend',
  EBAY_CH: 'Nicht zutreffend',
  EBAY_FR: 'Non applicable',
  EBAY_BE: 'Non applicable',
  EBAY_IT: 'Non applicabile',
  EBAY_NL: 'Niet van toepassing',
  EBAY_ES: 'No aplicable',
  EBAY_PL: 'Nie dotyczy',
};

function notApplicableText(marketplaceId) {
  return NOT_APPLICABLE_TEXT[marketplaceId] || 'Does not apply';
}

// Product identifiers live on the inventory item's `product` (ean, upc,
// isbn, mpn, brand), not among the item specifics — an "EAN" aspect is
// ignored by eBay's "The EAN field is missing" check. Sellers and the AI
// naturally put them in specifics, so they are lifted from there: barcodes
// move across (they aren't item specifics), Brand and MPN are sent both ways.
// `identifiers` are explicit values that win over the aspects.
const IDENTIFIER_ASPECTS = { ean: 'ean', upc: 'upc', isbn: 'isbn', gtin: 'ean', mpn: 'mpn', 'manufacturer part number': 'mpn', brand: 'brand' };
const LIST_IDENTIFIERS = new Set(['ean', 'upc', 'isbn']);

function splitProductIdentifiers(aspects, identifiers = {}) {
  const product = {};
  const rest = {};
  for (const [name, values] of Object.entries(aspects || {})) {
    const field = IDENTIFIER_ASPECTS[name.trim().toLowerCase()];
    const list = (Array.isArray(values) ? values : [values]).map((v) => String(v ?? '').trim()).filter(Boolean);
    if (!field || !list.length) {
      rest[name] = values;
      continue;
    }
    if (LIST_IDENTIFIERS.has(field)) product[field] = [...(product[field] || []), ...list];
    else {
      product[field] = product[field] || list[0];
      rest[name] = values;
    }
  }
  for (const [field, value] of Object.entries(identifiers || {})) {
    const list = (Array.isArray(value) ? value : [value]).map((v) => String(v ?? '').trim()).filter(Boolean);
    if (!list.length) continue;
    product[field] = LIST_IDENTIFIERS.has(field) ? list : list[0];
  }
  // eBay reads product.brand and product.mpn as a pair ("BrandMPN"): one
  // without the other is refused in categories that check identifiers
  // ("Input data for tag <BrandMPN> is invalid or missing", seen live with
  // Brand "Unbranded" and no MPN). Alone, each stays an item specific only,
  // which eBay accepts as it always has.
  if (!product.brand || !product.mpn) {
    delete product.brand;
    delete product.mpn;
  }
  return { product, aspects: rest };
}

function buildInventoryItem({ title, description, imageUrls, aspects, condition, quantity, identifiers }) {
  const split = splitProductIdentifiers(aspects, identifiers);
  return {
    availability: {
      shipToLocationAvailability: { quantity },
    },
    condition: condition || 'NEW',
    product: {
      title,
      description: plainDescription(description),
      imageUrls,
      aspects: split.aspects,
      ...split.product,
    },
  };
}

function buildOffer({ sku, marketplaceId, categoryId, secondaryCategoryId, storeCategoryNames, description, listingDescription, price, merchantLocationKey, quantity, listingPolicies }) {
  return {
    sku,
    marketplaceId: marketplaceId || 'EBAY_GB',
    format: 'FIXED_PRICE',
    availableQuantity: quantity,
    categoryId,
    // eBay allows a second item category (fees may apply) and up to two Shop
    // categories, given as "/Department/Sub" paths of the seller's own Shop.
    ...(secondaryCategoryId ? { secondaryCategoryId } : {}),
    ...(storeCategoryNames?.length ? { storeCategoryNames } : {}),
    listingDescription: listingDescription || description,
    pricingSummary: { price },
    merchantLocationKey,
    ...(listingPolicies ? { listingPolicies } : {}),
  };
}

// eBay rejects publishOffer without a fulfillment/payment/return policy
// attached — failing here, at draft time, gives a clearer error than
// discovering it later when the user tries to publish.
function ensureListingPolicies(listingPolicies) {
  const hasAll =
    listingPolicies &&
    listingPolicies.fulfillmentPolicyId &&
    listingPolicies.paymentPolicyId &&
    listingPolicies.returnPolicyId;
  if (!hasAll) {
    throw new EbayError(
      'This eBay connection has no default business policies selected yet. Choose them in Settings before drafting a listing.',
      400
    );
  }
}

async function getBusinessPolicies(credentials, marketplaceId = 'EBAY_GB') {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);

  const [fulfillment, payment, returnPolicy] = await Promise.all([
    ebayClient.getFulfillmentPolicies(accessToken, marketplaceId),
    ebayClient.getPaymentPolicies(accessToken, marketplaceId),
    ebayClient.getReturnPolicies(accessToken, marketplaceId),
  ]);

  return {
    fulfillmentPolicies: fulfillment?.fulfillmentPolicies || [],
    paymentPolicies: payment?.paymentPolicies || [],
    returnPolicies: returnPolicy?.returnPolicies || [],
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

async function getMerchantLocations(credentials) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const result = await ebayClient.getInventoryLocations(accessToken);
  return {
    locations: result?.locations || [],
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

/**
 * Drafts a single (non-variation) listing: creates the inventory item and an
 * unpublished offer. Nothing is live on eBay yet — see publishDraft.
 */
async function draftListing(credentials, input) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);

  ensureListingPolicies(input.listingPolicies);
  await ensureInventoryLocation(accessToken, input.merchantLocationKey, input.locationInput);
  await refuseLiveSku(accessToken, input.sku, input.marketplaceId);
  await ebayClient.createOrReplaceInventoryItem(accessToken, input.sku, buildInventoryItem(input), input.marketplaceId);
  const offer = await createOfferWithRetry(accessToken, buildOffer(input));

  return {
    offerId: offer.offerId,
    sku: input.sku,
    status: 'drafted',
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

/**
 * Drafts a multi-variation listing: one inventory item per variant SKU, all
 * grouped, offers created per SKU. Publish separately via publishGroup.
 */
// Deliberately modest: high enough to make a 160-variant listing practical,
// low enough that eBay never sees a burst worth throttling. Offers are also
// retried individually (createOfferWithRetry) for eBay's eventually-consistent
// SKU index, which concurrency doesn't change.
const VARIANT_CONCURRENCY = 4;

// Results keep input order, and the first failure rejects — a half-built
// variation group is not something to paper over.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// A seller-chosen SKU keeps the same group key across publish attempts, so
// a retry finds the group a failed attempt left behind — with the shared
// item specifics as they were THEN. eBay validates each SKU it re-creates
// against that stale group before the group itself can be updated, which
// is how a draft kept failing with "Part Type is missing" after Part Type
// had been added (seen live). Dropping the unpublished group first lets the
// attempt rebuild it from the current draft. A group that is live is left
// alone and named, since deleting it would take the listing down.
// The live listing a SKU (or the first variation SKU built from it) belongs
// to, if any — the check behind Liston's unique custom labels.
async function findLiveListingForSku(credentials, sku, marketplaceId) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  let listingId = null;
  for (const candidate of [sku, `${sku}-1`]) {
    const offers = await ebayClient.getOffersBySku(accessToken, candidate, marketplaceId).catch(() => ({ offers: [] }));
    const live = (offers.offers || []).find((o) => o.status === 'PUBLISHED' && o.listing?.listingId);
    if (live) {
      listingId = String(live.listing.listingId);
      break;
    }
  }
  return { listingId, credentialsChanged, credentials: refreshedCredentials };
}

// A SKU is one product on the account. Re-creating an inventory item under
// a SKU that is already live would REVISE that listing into this product
// (a seller-typed custom label reused across two drafts, seen live), so a
// SKU with a published offer is refused outright.
async function refuseLiveSku(accessToken, sku, marketplaceId) {
  const offers = await ebayClient.getOffersBySku(accessToken, sku, marketplaceId).catch(() => ({ offers: [] }));
  const live = (offers.offers || []).find((o) => o.status === 'PUBLISHED' && o.listing?.listingId);
  if (live) {
    throw new EbayError(
      `The custom label "${sku}" is already used by live listing ${live.listing.listingId}. Give this draft a different SKU, or end that listing first.`,
      400
    );
  }
}

async function clearStaleGroup(accessToken, groupKey, variants, marketplaceId) {
  const existing = await ebayClient.getInventoryItemGroup(accessToken, groupKey).catch(() => null);
  if (!existing) return;
  const firstSku = existing.variantSKUs?.[0] || variants[0]?.sku;
  if (firstSku) await refuseLiveSku(accessToken, firstSku, marketplaceId);
  await ebayClient.deleteInventoryItemGroup(accessToken, groupKey);
}

async function draftVariationListing(credentials, { groupKey, commonTitle, commonDescription, commonListingDescription, imageUrls, variesBy, variants, marketplaceId, categoryId, secondaryCategoryId, storeCategoryNames, merchantLocationKey, locationInput, listingPolicies, identifiers }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);

  ensureListingPolicies(listingPolicies);
  await ensureInventoryLocation(accessToken, merchantLocationKey, locationInput);
  await clearStaleGroup(accessToken, groupKey, variants, marketplaceId);

  // Each variant costs two sequential eBay calls (inventory item, then
  // offer), so a real multi-axis matrix — a phone case is 6 colours x 27
  // models — turns into hundreds of round trips and minutes of waiting.
  // Running a few at a time cuts that sharply while staying well short of
  // anything eBay would treat as abuse; the per-variant order (item before
  // its own offer) is preserved, which is the only ordering that matters.
  async function draftOneVariant(variant) {
    await ebayClient.createOrReplaceInventoryItem(
      accessToken,
      variant.sku,
      buildInventoryItem({
        title: commonTitle,
        description: commonDescription,
        imageUrls: variant.imageUrls || imageUrls,
        aspects: { ...variesBy.aspects, ...variant.aspects },
        condition: variant.condition,
        quantity: variant.quantity,
        identifiers,
      }),
      marketplaceId
    );
    const offer = await createOfferWithRetry(
      accessToken,
      buildOffer({
        sku: variant.sku,
        marketplaceId,
        categoryId,
        secondaryCategoryId,
        storeCategoryNames,
        description: commonDescription,
        listingDescription: commonListingDescription,
        price: variant.price,
        merchantLocationKey,
        quantity: variant.quantity,
        listingPolicies,
      })
    );
    return { sku: variant.sku, offerId: offer.offerId };
  }

  const offers = await mapWithConcurrency(variants, VARIANT_CONCURRENCY, draftOneVariant);

  await ebayClient.createOrReplaceInventoryItemGroup(
    accessToken,
    groupKey,
    {
      title: commonTitle,
      // For a multi-variation listing eBay builds the LIVE description from
      // the group's description (HTML, 500k limit) — not from the offers'
      // listingDescription. Sending plain text here published a listing
      // without the branded template. Confirmed live.
      description: commonListingDescription || commonDescription,
      imageUrls,
      // The listing's own item specifics come from the GROUP, not the SKUs
      // — eBay reads shared aspects (Type, Brand, Material…) here and only
      // the varying ones (Colour, Size) from each SKU. Without this, publish
      // failed with "The item specific Type is missing" even though every
      // SKU carried it. Confirmed live.
      aspects: variesBy.aspects || {},
      variantSKUs: variants.map((v) => v.sku),
      variesBy: { aspectsImageVariesBy: variesBy.aspectsImageVariesBy, specifications: variesBy.specifications },
    },
    marketplaceId
  );

  return {
    groupKey,
    offers,
    status: 'drafted',
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

// Right after its items are built, eBay sometimes answers a publish with
// "Seller Inventory Service can not publish the data. Product not found."
// — its inventory hasn't caught up with the items yet — and the same
// publish goes through a few seconds later. One more try, after a pause.
let productNotFoundDelayMs = 4000;
const isProductNotFound = (err) => /product not found/i.test(err?.message || '');

async function publishWhenReady(publishCall) {
  try {
    return await publishCall();
  } catch (err) {
    if (!isProductNotFound(err)) throw err;
    logger.warn('eBay had not caught up with the new items. Publishing again', { error: err.message });
    if (productNotFoundDelayMs) await new Promise((resolve) => setTimeout(resolve, productNotFoundDelayMs));
    return publishCall();
  }
}

function setProductNotFoundDelay(ms) {
  productNotFoundDelayMs = ms;
}

async function publishDraft(credentials, offerId, marketplaceId) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const result = await publishWhenReady(() => ebayClient.publishOffer(accessToken, offerId, marketplaceId));
  return {
    externalProductId: result.listingId,
    status: 'published',
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

async function publishGroup(credentials, groupKey, marketplaceId) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const result = await publishWhenReady(() => ebayClient.publishOfferByInventoryItemGroup(accessToken, groupKey, marketplaceId || 'EBAY_GB'));
  return {
    externalProductId: result.listingId,
    status: 'published',
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

async function withdrawDraft(credentials, offerId) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  await ebayClient.withdrawOffer(accessToken, offerId);
  return { status: 'withdrawn', credentialsChanged, credentials: refreshedCredentials };
}

// Active + ended listings read from the seller's real eBay catalog (Trading
// API) — this sees everything on the account, not just what Liston created.
// How long a copy is served without asking eBay again (`fresh`), and how
// long it keeps being served while a refresh runs behind it (`stale`). With
// the mirror on disk, a copy is always worth showing; only an account that
// has never been read makes anyone wait.
//
// An account whose eBay push is actually arriving (see pushEnabled) is told
// about changes, so it is polled far less: the long windows are only a
// safety net for a missed notification. Push is per kind: new orders and
// listing changes come from eBay's Notification API (ebay-push.js); Trading's
// older Platform Notifications (ebay.notifications.js) count for listings
// too, when they arrive.
const FRESH = {
  listings: 30 * 60 * 1000,
  orders: 10 * 60 * 1000,
  activeCount: 60 * 60 * 1000,
};
// eBay's push arrives within seconds of a change and brings it in itself
// (a new order is read on its own, see applyNewOrder), so these reads are
// only insurance against a notification eBay dropped — and against what
// push doesn't cover (an order's later changes: dispatch, cancellation).
const FRESH_WITH_PUSH = {
  listings: 24 * 60 * 60 * 1000,
  orders: 6 * 60 * 60 * 1000,
  activeCount: 24 * 60 * 60 * 1000,
};
// `push`: true (a push-triggered read: everything counts as pushed), or
// { listings, orders } from pushEnabled(connection).
const pushCovers = (push, kind) => (push === true ? true : Boolean(push && push[kind === 'activeCount' ? 'listings' : kind]));
const freshFor = (kind) => (ctx) => (pushCovers(ctx?.push, kind) ? FRESH_WITH_PUSH[kind] : FRESH[kind]);

// Tags a cache read for the governor: a read someone is waiting on is
// 'user'; a refresh behind a served copy is whatever the caller said (a
// push-triggered sync) or plain 'background'.
function governed(ctx, connectionId, waiting, fn) {
  return governor.withContext({ connectionId: String(connectionId), priority: waiting ? 'user' : ctx?.priority || 'background' }, fn);
}
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

// The one number the Overview needs per account. Mirrored, so a page of
// stat tiles costs no eBay calls unless a copy is over an hour old.
const activeCountCache = createSwrCache({
  freshMs: freshFor('activeCount'),
  staleMs: STALE_MS,
  fetcher: async (ctx, meta, current, { waiting } = {}) =>
    governed(ctx, ctx.connectionId, waiting, async () => {
      const result = await ebayTrading.getActiveListings(ctx.accessToken, { pageNumber: 1, entriesPerPage: 1, siteId: ctx.siteId });
      return { value: result.totalEntries || 0, meta: null };
    }),
  load: (key) => mirror.loadSnapshot(key, 'active_count').then((row) => row && { ...row, value: row.value.count }),
  store: (key, value) => mirror.saveSnapshot(key, 'active_count', { count: value }),
  onUpdate: (key) => accountEvents.emitUpdated(key, 'activeCount'),
});

async function countActiveListings(credentials, connectionId, { push = false } = {}) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  // Shared with another site: eBay's count covers both, so it's counted
  // from this site's listings instead.
  const scope = await scopeOf(connectionId);
  const totalEntries = scope?.claimed?.length
    ? (await cachedListings(connectionId, 'active', { accessToken, siteId, push })).length
    : await activeCountCache.get(`${connectionId}`, { accessToken, siteId, push, connectionId });
  return { totalEntries, credentialsChanged, credentials: refreshedCredentials };
}

async function listActiveListings(credentials, opts) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const result = await ebayTrading.getActiveListings(accessToken, { ...opts, siteId });
  return { ...result, credentialsChanged, credentials: refreshedCredentials };
}

// The store's name, logo and feedback figures change rarely and cost two
// rationed Trading calls, so they're mirrored for a day. Without this the
// Settings page (and every description render) depended on a live call
// that eBay's allowance could refuse, which is how one store's palette
// suggestions ended up as the generic presets.
const PROFILE_FRESH_MS = 24 * 60 * 60 * 1000;
const storeProfileCache = createSwrCache({
  freshMs: PROFILE_FRESH_MS,
  staleMs: STALE_MS,
  fetcher: async (ctx, meta, current, { waiting } = {}) =>
    governed(ctx, ctx.connectionId, waiting, async () => ({ value: await ebayTrading.getStoreProfile(ctx.accessToken, { siteId: ctx.siteId }), meta: null })),
  load: (key) => mirror.loadSnapshot(key, 'store_profile'),
  store: (key, value) => mirror.saveSnapshot(key, 'store_profile', value),
});

async function getStoreProfile(credentials, connectionId, { refresh = false } = {}) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  if (!connectionId) {
    const profile = await ebayTrading.getStoreProfile(accessToken, { siteId });
    return { ...profile, credentialsChanged, credentials: refreshedCredentials };
  }
  const key = String(connectionId);
  if (refresh) storeProfileCache.invalidate(key);
  const profile = await storeProfileCache.get(key, { accessToken, siteId, connectionId: key, priority: 'user' });
  return { ...profile, credentialsChanged, credentials: refreshedCredentials };
}

// The best of the seller's own feedback, for the description template:
// positive, with something actually said, longest and most recent first.
const MIN_REVIEW_LENGTH = 25;
const feedbackCache = createSwrCache({
  freshMs: PROFILE_FRESH_MS,
  staleMs: STALE_MS,
  fetcher: async (ctx, meta, current, { waiting } = {}) =>
    governed(ctx, ctx.connectionId, waiting, async () => {
      // Up to 200 most recent feedbacks in one call (eBay's page max);
      // positive ones with something said, longest first. eBay feedback has
      // no star per comment: "Positive" is the five-star equivalent.
      const all = await ebayTrading.getSellerFeedback(ctx.accessToken, { siteId: ctx.siteId, entriesPerPage: 200 });
      const seen = new Set();
      const best = all
        .filter((f) => f.type === 'Positive' && f.text.length >= MIN_REVIEW_LENGTH && !/^(a+|great|good|thanks?|ok)[.!]*$/i.test(f.text))
        .filter((f) => {
          const key = f.text.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => b.text.length - a.text.length || new Date(b.date) - new Date(a.date))
        .slice(0, 60)
        .map((f) => ({
          stars: 5,
          text: f.text.slice(0, 400),
          buyer: f.buyer,
          date: f.date ? new Date(f.date).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '',
          itemTitle: f.itemTitle,
        }));
      return { value: best, meta: { total: all.length } };
    }),
  load: (key) => mirror.loadSnapshot(key, 'feedback').then((row) => row && { ...row, value: row.value.reviews }),
  store: (key, value, meta) => mirror.saveSnapshot(key, 'feedback', { reviews: value }, meta),
});

async function getBestReviews(credentials, connectionId, { refresh = false } = {}) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const key = String(connectionId);
  if (refresh) feedbackCache.invalidate(key);
  const reviews = await feedbackCache.get(key, { accessToken, siteId, connectionId: key, priority: 'user' });
  return { reviews, credentialsChanged, credentials: refreshedCredentials };
}

async function listUnsoldListings(credentials, opts) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const result = await ebayTrading.getUnsoldListings(accessToken, { ...opts, siteId });
  return { ...result, credentialsChanged, credentials: refreshedCredentials };
}

// Best-effort removal of the Inventory API objects behind a listing Liston
// published (offer, then the item or group). Anything already gone is fine.
async function deleteInventoryObjects(credentials, { offerId, groupKey, skus = [] }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const quiet = (p) => p.catch(() => {});
  if (offerId) await quiet(ebayClient.deleteOffer(accessToken, offerId));
  if (groupKey) await quiet(ebayClient.deleteInventoryItemGroup(accessToken, groupKey));
  for (const sku of skus) await quiet(ebayClient.deleteInventoryItem(accessToken, sku));
  return { credentialsChanged, credentials: refreshedCredentials };
}

// Which eBay site this seller is on (from their registration), plus the
// address eBay holds for them. Used once to set a connection's marketplace
// and to offer a ready-made shipping location.
// The seller's Shop categories, for filing a listing under their own
// departments. Sellers without an eBay Shop simply have none.
async function getStoreCategories(credentials) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const { categories, hasStore } = await ebayTrading.getStoreCategories(accessToken, { siteId });
  return { categories, hasStore, credentialsChanged, credentials: refreshedCredentials };
}

// Creates a Shop department and returns the refreshed tree.
async function addStoreCategory(credentials, connectionId, { name, parentId }) {
  const { accessToken, siteId } = await ensureValidAccessToken(credentials);
  const result = await ebayTrading.addStoreCategory(accessToken, { name, parentId }, { siteId });
  storeCategoryCache.delete(String(connectionId));
  const fresh = await getStoreCategoriesCached(credentials, connectionId);
  return { ...fresh, created: result.category, status: result.status, warnings: result.warnings };
}

// The Shop's departments change rarely and the Trading call behind them is
// rationed, so one read an hour per account serves the editor, the AI and
// drafting alike. A rationed refusal is reported, not thrown: no Shop
// categories is a valid state.
const storeCategoryCache = new Map(); // connectionId -> { categories, expiresAt }
const STORE_CATEGORY_TTL_MS = 60 * 60 * 1000;
async function getStoreCategoriesCached(credentials, connectionId, { refresh = false } = {}) {
  const id = String(connectionId);
  const cached = storeCategoryCache.get(id);
  if (!refresh && cached && cached.expiresAt > Date.now()) return { categories: cached.categories, hasStore: cached.hasStore, unavailable: null };
  try {
    const { categories, hasStore } = await getStoreCategories(credentials);
    storeCategoryCache.set(id, { categories, hasStore, expiresAt: Date.now() + STORE_CATEGORY_TTL_MS });
    return { categories, hasStore, unavailable: null };
  } catch (err) {
    // A failed read is reported as such — never cached, never shown as
    // "no departments".
    const reason = err.statusCode === 429 || err.code === 'EBAY_BUDGET' ? err.message : `Couldn't read this account's Shop departments from eBay (${err.message}). Try again.`;
    return { categories: [], hasStore: null, unavailable: reason };
  }
}

async function detectMarketplace(credentials) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);

  // GetUser is the direct answer, but eBay rations it tightly per app. When
  // it's refused, fall back to signals that aren't rationed: where the
  // seller's business policies live, then which eBay site their listings
  // link to.
  let profile = null;
  try {
    profile = await ebayTrading.getUserProfile(accessToken);
  } catch {
    profile = null;
  }
  let market = profile ? marketplaces.fromSite(profile.site) || marketplaces.fromSite(profile.storeSite) || marketplaces.fromCountry(profile.registrationAddress.country) : null;

  if (!market) {
    const counts = await Promise.all(
      marketplaces.MARKETPLACES.map(async (m) => {
        const res = await ebayClient.getFulfillmentPolicies(accessToken, m.id).catch(() => null);
        return { m, n: res?.fulfillmentPolicies?.length || 0 };
      })
    );
    const best = counts.sort((a, b) => b.n - a.n)[0];
    if (best && best.n > 0) market = best.m;
  }
  if (!market) {
    const listings = await ebayTrading.getActiveListings(accessToken, { pageNumber: 1, entriesPerPage: 1 }).catch(() => null);
    const host = listings?.items?.[0]?.viewItemUrl ? new URL(listings.items[0].viewItemUrl).host : null;
    market = marketplaces.MARKETPLACES.find((m) => m.itemHost === host) || null;
  }
  market = market || marketplaces.byId(marketplaces.DEFAULT_ID);
  return { marketplaceId: market.id, profile, credentialsChanged, credentials: refreshedCredentials };
}

/**
 * Which eBay seller a token belongs to: { userId, username }, the same
 * account whatever site it's connected for. Identity API first (not
 * rationed), GetUser when that fails.
 */
async function identifySeller(credentials) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  let seller = await ebayIdentity.getUser(accessToken).catch(() => null);
  if (!seller?.userId && !seller?.username) {
    const profile = await ebayTrading.getUserProfile(accessToken).catch(() => null);
    seller = { userId: null, username: profile?.username || null };
  }
  return { ...seller, credentialsChanged, credentials: refreshedCredentials };
}

// Creates an Inventory API location (what an offer's merchantLocationKey
// points at). Seller Hub addresses are not inventory locations, which is why
// accounts that never used the Inventory API show none.
async function createMerchantLocation(credentials, { merchantLocationKey, name, address }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const body = {
    location: {
      address: {
        addressLine1: address.addressLine1,
        ...(address.addressLine2 ? { addressLine2: address.addressLine2 } : {}),
        city: address.city,
        ...(address.stateOrProvince ? { stateOrProvince: address.stateOrProvince } : {}),
        postalCode: address.postalCode,
        country: address.country,
      },
    },
    locationTypes: ['WAREHOUSE'],
    merchantLocationStatus: 'ENABLED',
    name,
    ...(address.phone ? { phone: address.phone } : {}),
  };
  await ebayClient.createInventoryLocation(accessToken, merchantLocationKey, body);
  return { merchantLocationKey, credentialsChanged, credentials: refreshedCredentials };
}

async function getLiveItem(credentials, itemId) {
  const { accessToken, siteId } = await ensureValidAccessToken(credentials);
  return ebayTrading.getItem(accessToken, itemId, { siteId });
}

async function reviseLiveListing(credentials, itemId, payload) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const result = await ebayTrading.reviseListing(accessToken, itemId, payload, { siteId });
  return { ...result, credentialsChanged, credentials: refreshedCredentials };
}

// Where a listing another tool made through the Inventory API lives, from
// its SKUs: a variation's group (the inventory item names it in groupIds),
// or a single listing's SKU. Null when eBay has no inventory item for them.
async function inventoryRefForSkus(credentials, { skus, isVariation }) {
  const { accessToken } = await ensureValidAccessToken(credentials);
  const first = (skus || []).find(Boolean);
  if (!first) return null;
  const item = await ebayClient.getInventoryItem(accessToken, first).catch(() => null);
  if (!item) return null;
  if (!isVariation) return { sku: first };
  const groupKey = (item.groupIds || [])[0];
  return groupKey ? { groupKey } : null;
}

// Puts an ended listing back on eBay (a new item number) with the edit's
// fields; the ended one leaves the Inactive mirror.
async function relistLiveListing(credentials, connectionId, itemId, payload) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const result = await ebayTrading.relistListing(accessToken, itemId, payload, { siteId });
  removeListingFromMirror(connectionId, itemId);
  return { ...result, credentialsChanged, credentials: refreshedCredentials };
}

// A listing Liston published through the Inventory API can't be revised
// through the Trading API — eBay answers "Inventory-based listing
// management is not currently supported by this tool". Such a listing is
// revised the way it was made: the inventory item(s), the offer(s) and (for
// variations) the group are replaced, then the offer/group is published
// again, which pushes the changes to the live item.
// eBay's refusal to put up a listing identical to one this seller already
// has live ("…an item you already have on eBay: <title> (<item id>)…").
// Returns the live item's number, or null when it isn't that refusal.
function duplicateListingOf(err) {
  const texts = [err?.message, ...((err?.details || []).map((e) => e.LongMessage || e.ShortMessage))].filter(Boolean).join(' ');
  if (!/identical items from the same seller|already have on eBay/i.test(texts)) return null;
  const m = texts.match(/\((\d{9,15})\)/);
  return m ? m[1] : '';
}

// eBay's refusal to revise a listing that has already ended ("You are not
// allowed to revise ended listings", error 291).
function isEndedListingError(err) {
  const codes = (err?.details || []).map((e) => String(e.ErrorCode ?? ''));
  return codes.includes('291') || /revise ended|listing (has )?ended|auction (has )?ended/i.test(err?.message || '');
}

function isInventoryManagedError(err) {
  return /Inventory-based listing management/i.test(err?.message || '');
}

const OFFER_READ_ONLY = new Set(['offerId', 'status', 'listing', 'listingStartDate']);
function editableOffer(existing) {
  const copy = {};
  for (const [key, value] of Object.entries(existing || {})) {
    if (!OFFER_READ_ONLY.has(key)) copy[key] = value;
  }
  return copy;
}

async function publishedOfferFor(accessToken, sku, marketplaceId) {
  const res = await ebayClient.getOffersBySku(accessToken, sku, marketplaceId).catch(() => ({ offers: [] }));
  const offers = res.offers || [];
  return offers.find((o) => o.status === 'PUBLISHED') || offers[0] || null;
}

async function reviseInventoryListing(credentials, { groupKey, offerId, draft, listingDescription, marketplaceId, storeCategoryNames }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const mp = marketplaceId || draft.marketplaceId || 'EBAY_GB';
  const isVariation = Array.isArray(draft.variants) && draft.variants.length > 0;
  const warnings = [];

  const offerBody = (existing, { price, quantity }) => ({
    ...editableOffer(existing),
    availableQuantity: quantity,
    ...(draft.categoryId ? { categoryId: String(draft.categoryId) } : {}),
    ...(draft.secondaryCategoryId ? { secondaryCategoryId: String(draft.secondaryCategoryId) } : {}),
    ...(storeCategoryNames ? { storeCategoryNames } : {}),
    ...(draft.listingPolicies ? { listingPolicies: { ...(existing.listingPolicies || {}), ...draft.listingPolicies } } : {}),
    listingDescription,
    pricingSummary: { ...(existing.pricingSummary || {}), price },
  });

  if (!isVariation) {
    const sku = draft.sku;
    const existing = (offerId && (await ebayClient.getOffer(accessToken, offerId).catch(() => null))) || (await publishedOfferFor(accessToken, sku, mp));
    if (!existing) throw new EbayError(`Couldn't find the eBay offer behind SKU ${sku} to revise.`, 502);
    await ebayClient.createOrReplaceInventoryItem(
      accessToken,
      existing.sku,
      buildInventoryItem({ title: draft.title, description: draft.description, imageUrls: draft.imageUrls, aspects: draft.aspects, condition: draft.condition, quantity: draft.quantity, identifiers: draft.identifiers }),
      mp
    );
    await ebayClient.updateOffer(accessToken, existing.offerId, offerBody(existing, { price: draft.price, quantity: draft.quantity }));
    const published = await ebayClient.publishOffer(accessToken, existing.offerId, mp);
    return { listingId: published.listingId, warnings, credentialsChanged, credentials: refreshedCredentials };
  }

  const group = await ebayClient.getInventoryItemGroup(accessToken, groupKey);
  const existingSkus = group.variantSKUs || [];
  // Variations added in the editor have no SKU yet; they're numbered on
  // from the group like a fresh publish would.
  let next = existingSkus.length;
  const variants = draft.variants.map((v) => ({ ...v, sku: v.sku || `${groupKey}-${(next += 1)}` }));
  const template = (await Promise.all(existingSkus.slice(0, 1).map((sku) => publishedOfferFor(accessToken, sku, mp))))[0];

  for (const variant of variants) {
    await ebayClient.createOrReplaceInventoryItem(
      accessToken,
      variant.sku,
      buildInventoryItem({
        title: draft.commonTitle,
        description: draft.commonDescription,
        imageUrls: variant.imageUrls || draft.imageUrls,
        aspects: { ...(draft.variesBy?.aspects || {}), ...variant.aspects },
        condition: variant.condition,
        quantity: variant.quantity,
        identifiers: draft.identifiers,
      }),
      mp
    );
    const existing = await publishedOfferFor(accessToken, variant.sku, mp);
    if (existing) {
      await ebayClient.updateOffer(accessToken, existing.offerId, offerBody(existing, { price: variant.price, quantity: variant.quantity }));
    } else if (template) {
      await createOfferWithRetry(accessToken, { ...offerBody(template, { price: variant.price, quantity: variant.quantity }), sku: variant.sku, marketplaceId: mp });
    } else {
      throw new EbayError(`Couldn't find an existing offer in group ${groupKey} to base the new variation on.`, 502);
    }
  }

  // Variations removed in the editor come off the live listing.
  const keep = new Set(variants.map((v) => v.sku));
  for (const sku of existingSkus.filter((s) => !keep.has(s))) {
    const gone = await publishedOfferFor(accessToken, sku, mp);
    if (gone?.offerId) await ebayClient.withdrawOffer(accessToken, gone.offerId).catch((err) => warnings.push(`Couldn't remove variation ${sku}: ${err.message}`));
  }

  await ebayClient.createOrReplaceInventoryItemGroup(
    accessToken,
    groupKey,
    {
      title: draft.commonTitle,
      description: listingDescription || draft.commonDescription,
      imageUrls: draft.imageUrls,
      aspects: draft.variesBy?.aspects || {},
      variantSKUs: variants.map((v) => v.sku),
      variesBy: { aspectsImageVariesBy: draft.variesBy?.aspectsImageVariesBy, specifications: draft.variesBy?.specifications },
    },
    mp
  );
  const published = await ebayClient.publishOfferByInventoryItemGroup(accessToken, groupKey, mp);
  return { listingId: published.listingId, warnings, credentialsChanged, credentials: refreshedCredentials };
}

function conditionIdFor(condition) {
  return ebayTrading.CONDITION_IDS[condition] || undefined;
}

async function listOrders(credentials, opts) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const result = await ebayTrading.getOrders(accessToken, { ...opts, siteId });
  return { ...result, credentialsChanged, credentials: refreshedCredentials };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_DAYS = 90; // eBay's own cap on CreateTimeFrom/CreateTimeTo span per GetOrders call
const MAX_ORDER_PAGE_SIZE = 200; // eBay's max EntriesPerPage for GetOrders

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfUtcMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1);
}

// The start of a day in the seller's time zone, as an instant.
function localMidnight(day, timeZone) {
  return new Date(`${day}T00:00:00${analyticsDays.offsetAt(day, timeZone)}`);
}

// Resolves a named range (or explicit custom from/to) to a concrete window.
// Returns null for 'all_time', which has no single window — see
// getEarningsSummary, which walks backwards in chunks instead. With the
// seller's `timeZone`, Today and the months start at their midnight (an
// order at 00:30 in London is today's, not yesterday's in UTC).
function resolveRangeWindow(range, from, to, timeZone = null) {
  const now = new Date();
  if (timeZone && ['today', 'this_month', 'last_month'].includes(range)) {
    const today = analyticsDays.today(timeZone, now);
    if (range === 'today') return [localMidnight(today, timeZone), now];
    const thisMonth = `${today.slice(0, 7)}-01`;
    if (range === 'this_month') return [localMidnight(thisMonth, timeZone), now];
    const lastMonth = `${analyticsDays.addDays(thisMonth, -1).slice(0, 7)}-01`;
    return [localMidnight(lastMonth, timeZone), new Date(localMidnight(thisMonth, timeZone).getTime() - 1)];
  }
  switch (range) {
    case 'today':
      return [startOfUtcDay(now), now];
    case '7d':
      return [new Date(now.getTime() - 7 * DAY_MS), now];
    case '30d':
      return [new Date(now.getTime() - 30 * DAY_MS), now];
    case '90d':
      return [new Date(now.getTime() - 90 * DAY_MS), now];
    case 'this_month':
      return [startOfUtcMonth(now), now];
    case 'last_month': {
      const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      return [startOfUtcMonth(lastMonth), endOfUtcMonth(lastMonth)];
    }
    case 'custom': {
      if (!from || !to) {
        throw new EbayError('A custom range needs both a from and to date', 400);
      }
      const start = new Date(from);
      const end = new Date(to);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
        throw new EbayError('Invalid custom date range', 400);
      }
      if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
        throw new EbayError('Custom ranges can span at most 90 days', 400);
      }
      return [start, end];
    }
    default:
      return [new Date(now.getTime() - 7 * DAY_MS), now];
  }
}

// Fetches every order in a <=90-day window (paging through all of them) as
// full mapped objects — used by the Orders page, which needs to classify,
// search and paginate itself since eBay's OrderStatus filter doesn't cover
// the payment/dispatch distinctions the UI shows.
// `expectedPages` is the page count from the previous fetch of the same
// window: with it, every page is requested at once (a guess that's too high
// just returns an empty page), so a refresh costs one round trip.
async function fetchAllOrdersInWindow(accessToken, createTimeFrom, createTimeTo, expectedPages = 1, siteId = 0) {
  const opts = { createTimeFrom, createTimeTo, entriesPerPage: MAX_ORDER_PAGE_SIZE, siteId };
  const firstBatch = await Promise.all(
    Array.from({ length: Math.max(1, expectedPages) }, (_, i) => ebayTrading.getOrders(accessToken, { ...opts, pageNumber: i + 1 }))
  );
  const totalPages = firstBatch[0].totalPages;
  const orders = firstBatch.flatMap((r) => r.orders);
  if (totalPages <= firstBatch.length) return { orders, totalPages };
  // More pages than expected: fetch the remainder together.
  const rest = await Promise.all(
    Array.from({ length: totalPages - firstBatch.length }, (_, i) => ebayTrading.getOrders(accessToken, { ...opts, pageNumber: firstBatch.length + i + 1 }))
  );
  return { orders: orders.concat(...rest.map((r) => r.orders)), totalPages };
}

// Every number on the account dashboard and the Orders page comes from the
// same thing: the connection's orders for the last 90 days (eBay won't serve
// anything older). So that set is fetched once per connection and every
// range, status tab, search and earnings figure is derived from it in
// memory. See swr-cache.js for how it stays warm.
//
// Incremental after the first read: eBay is asked only for orders MODIFIED
// since the last sync (a few minutes' worth, usually one page or none),
// which are merged into the mirrored set. A full 90-day read happens only
// when there is no usable sync point.
const MAX_MOD_WINDOW_DAYS = 30; // eBay's cap on a ModTimeFrom/ModTimeTo span
const SYNC_OVERLAP_MS = 5 * 60 * 1000; // re-read a little before the last sync: eBay's clocks and ours differ

// The mirror is a copy: if writing it fails, the page still gets its data
// from eBay; the failure is logged, not surfaced.
async function persist(write) {
  try {
    await write();
  } catch (err) {
    logger.warn('Could not write to the eBay mirror', { error: err.message });
  }
}

// Bump when mapOrder gains a field, so every mirrored order is re-read once.
const ORDER_SHAPE = 7; // 7: Global Shipping Programme hub, Ref # and seller-side total; 6: each line's eBay site; 5: delivered time; 4: buyer email and sales record number; 3: delivery window and service

// A delivery is a carrier scan, which doesn't always move an order's
// modified time, so the incremental read can miss it. Every few hours the
// dispatched orders not yet delivered are read again by number (50 to a
// call: usually one call), for up to 30 days after dispatch.
let DELIVERY_CHECK_MS = 6 * 60 * 60 * 1000;
function setDeliveryCheckInterval(ms) {
  DELIVERY_CHECK_MS = ms;
}
const DELIVERY_WATCH_DAYS = 30;
const ORDER_ID_BATCH = 50;

/** Dispatched orders still waiting for a delivery scan, worth reading again. */
function awaitingDelivery(orders, now = new Date()) {
  const since = now.getTime() - DELIVERY_WATCH_DAYS * DAY_MS;
  return orders.filter((o) => o.shippedTime && !o.deliveredAt && classifyOrderStatus(o) === 'dispatched' && new Date(o.shippedTime).getTime() >= since);
}

async function fetchOrdersById(accessToken, orderIds, siteId) {
  const batches = [];
  for (let i = 0; i < orderIds.length; i += ORDER_ID_BATCH) batches.push(orderIds.slice(i, i + ORDER_ID_BATCH));
  const results = await Promise.all(batches.map((ids) => ebayTrading.getOrders(accessToken, { orderIds: ids, entriesPerPage: ORDER_ID_BATCH, siteId })));
  return results.flatMap((r) => r.orders);
}

function ordersHorizon(now = new Date()) {
  return new Date(now.getTime() - MAX_WINDOW_DAYS * DAY_MS);
}

async function fetchOrdersModifiedSince(accessToken, modTimeFrom, modTimeTo, siteId) {
  const opts = { modTimeFrom, modTimeTo, entriesPerPage: MAX_ORDER_PAGE_SIZE, siteId };
  const first = await ebayTrading.getOrders(accessToken, { ...opts, pageNumber: 1 });
  if (first.totalPages <= 1) return first.orders;
  const rest = await Promise.all(
    Array.from({ length: first.totalPages - 1 }, (_, i) => ebayTrading.getOrders(accessToken, { ...opts, pageNumber: i + 2 }))
  );
  return first.orders.concat(...rest.map((r) => r.orders));
}

const ordersCache = createSwrCache({
  freshMs: freshFor('orders'),
  staleMs: STALE_MS,
  fetcher: async (ctx, meta, current, { waiting } = {}) =>
    governed(ctx, ctx.connectionId, waiting, () => fetchOrdersIncrementally(ctx, meta, current)),
  load: async (key) => {
    const state = await mirror.loadSnapshot(key, 'orders');
    if (!state) return null;
    const orders = await mirror.loadOrders(key, ordersHorizon());
    // A copy read with an older field set is served but treated as stale,
    // so the full re-read (see fetchOrdersIncrementally) runs behind it.
    // Older than any fresh window (24h at most) but within the stale one,
    // so the copy is still served while the re-read runs.
    const syncedAt = state.meta?.shape === ORDER_SHAPE ? state.syncedAt : Math.min(state.syncedAt, Date.now() - FRESH_WITH_PUSH.orders - 1000);
    return { value: orders, meta: state.meta, syncedAt };
  },
  // Order rows are written by the fetcher itself; this keeps the sync point.
  store: (key, value, meta) => mirror.saveSnapshot(key, 'orders', { count: value.length }, meta),
  onUpdate: (key) => accountEvents.emitUpdated(key, 'orders'),
});

async function fetchOrdersIncrementally({ accessToken, siteId, connectionId }, meta, current) {
  {
    const now = new Date();
    const horizon = ordersHorizon(now);
    const lastSyncAt = meta?.lastSyncAt ? new Date(meta.lastSyncAt) : null;
    // Orders read before a field was added (the shipping address, say) only
    // gain it on a full re-read; an incremental read brings back just what
    // changed. The shape version forces one full pass per change.
    const sameShape = meta?.shape === ORDER_SHAPE;
    const canIncrement = sameShape && Array.isArray(current) && lastSyncAt && now - lastSyncAt < MAX_MOD_WINDOW_DAYS * DAY_MS - DAY_MS;

    let orders;
    if (canIncrement) {
      const from = new Date(lastSyncAt.getTime() - SYNC_OVERLAP_MS);
      const changed = await fetchOrdersModifiedSince(accessToken, from.toISOString(), now.toISOString(), siteId);
      const byId = new Map(current.map((o) => [o.orderId, o]));
      for (const order of changed) byId.set(order.orderId, order);
      const deliveryDue = !meta?.deliveryCheckAt || now - new Date(meta.deliveryCheckAt) >= DELIVERY_CHECK_MS;
      if (deliveryDue) {
        const changedIds = new Set(changed.map((o) => o.orderId));
        const watch = awaitingDelivery([...byId.values()], now).filter((o) => !changedIds.has(o.orderId)).map((o) => o.orderId);
        const reread = watch.length ? await fetchOrdersById(accessToken, watch, siteId) : [];
        for (const order of reread) byId.set(order.orderId, order);
        changed.push(...reread);
        meta = { ...(meta || {}), deliveryCheckAt: now.toISOString() };
      }
      orders = [...byId.values()].filter((o) => new Date(o.createdAt) >= horizon);
      if (changed.length) await persist(() => mirror.upsertOrders(connectionId, changed));
    } else {
      const result = await fetchAllOrdersInWindow(accessToken, horizon.toISOString(), now.toISOString(), meta?.totalPages, siteId);
      orders = result.orders;
      await persist(() => mirror.upsertOrders(connectionId, orders));
      // A full read is as current as a delivery check.
      meta = { ...(meta || {}), totalPages: result.totalPages, deliveryCheckAt: now.toISOString() };
    }
    await persist(() => mirror.pruneOrdersBefore(connectionId, horizon));
    return { value: orders, meta: { ...(meta || {}), lastSyncAt: now.toISOString(), shape: ORDER_SHAPE } };
  }
}

// One eBay account connected on several sites: eBay hands every connection
// the account's listings and orders from all of them, so each keeps its own
// site's (market-scope.js). The copies hold everything; the split is made
// as they're read, so connecting or removing a site needs no re-read.
const SCOPE_TTL_MS = 5 * 60 * 1000;
const scopes = new Map(); // connectionId -> { at, scope: Promise }
function scopeOf(connectionId) {
  const id = String(connectionId);
  const known = scopes.get(id);
  if (known && Date.now() - known.at < SCOPE_TTL_MS) return known.scope;
  const scope = connectionRepository.findMarketScope(id).catch(() => null);
  scopes.set(id, { at: Date.now(), scope });
  return scope;
}

/**
 * Which eBay sites this account's listings and orders are on, from the
 * copies eBay sent (all sites, whatever the connection's own): [{
 * marketplaceId, listings, orders }], busiest first. Reads only the copies.
 */
async function accountSites(credentials, connectionId) {
  const { accessToken, siteId } = await ensureValidAccessToken(credentials);
  const id = String(connectionId);
  const ctx = { accessToken, siteId, connectionId: id };
  const [items, orders] = await Promise.all([
    listingsCache.get(listingsKey(id, 'active'), { ...ctx, status: 'active' }).catch(() => []),
    ordersCache.get(id, ctx).catch(() => []),
  ]);
  const sites = new Map();
  const bump = (market, key) => {
    if (!market) return;
    const site = sites.get(market) || { marketplaceId: market, listings: 0, orders: 0 };
    site[key] += 1;
    sites.set(market, site);
  };
  for (const item of items || []) bump(marketScope.marketOfListing(item), 'listings');
  for (const order of orders || []) bump(marketScope.marketOfOrder(order), 'orders');
  return [...sites.values()].sort((a, b) => b.listings + b.orders - (a.listings + a.orders));
}

/** After a connection is added, removed or tagged with its site or seller. */
function forgetMarketScopes() {
  scopes.clear();
}

async function getOrdersLast90Cached(connectionId, accessToken, siteId, push = false) {
  const [orders, scope] = await Promise.all([ordersCache.get(connectionId, { accessToken, siteId, connectionId, push }), scopeOf(connectionId)]);
  return marketScope.ordersIn(scope, orders);
}

const itemSummaryCache = new Map(); // itemId -> { fetchedAt, summary }
const ITEM_SUMMARY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a listing's photo and URL hardly ever change

// The listings tab works the same way: the whole active (or unsold) set is
// pulled once, so paging, page size and search never go back to eBay.
const MAX_LISTING_PAGE_SIZE = 200;
async function fetchAllListings(accessToken, status, expectedPages = 1, siteId = 0) {
  const call = status === 'inactive' ? ebayTrading.getUnsoldListings : ebayTrading.getActiveListings;
  const opts = { entriesPerPage: MAX_LISTING_PAGE_SIZE, siteId };
  const firstBatch = await Promise.all(
    Array.from({ length: Math.max(1, expectedPages) }, (_, i) => call(accessToken, { ...opts, pageNumber: i + 1 }))
  );
  const totalPages = firstBatch[0].totalPages;
  const items = firstBatch.flatMap((r) => r.items);
  if (totalPages <= firstBatch.length) return { items, totalPages };
  const rest = await Promise.all(
    Array.from({ length: totalPages - firstBatch.length }, (_, i) => call(accessToken, { ...opts, pageNumber: firstBatch.length + i + 1 }))
  );
  return { items: items.concat(...rest.map((r) => r.items)), totalPages };
}

const listingsCache = createSwrCache({
  freshMs: freshFor('listings'),
  staleMs: STALE_MS,
  fetcher: async (ctx, meta, current, { waiting } = {}) =>
    governed(ctx, ctx.connectionId, waiting, async () => {
      const { items, totalPages } = await fetchAllListings(ctx.accessToken, ctx.status, meta?.totalPages, ctx.siteId);
      return { value: items, meta: { totalPages } };
    }),
  load: (key) => mirror.loadSnapshot(...splitListingsKey(key)).then((row) => row && { ...row, value: row.value.items }),
  store: (key, value, meta) => mirror.saveSnapshot(...splitListingsKey(key), { items: value }, meta),
  onUpdate: (key) => accountEvents.emitUpdated(splitListingsKey(key)[0], 'listings'),
});

// Cache keys double as snapshot ids: "<connectionId>:listings:active" is
// snapshot kind "listings:active" of that connection.
const listingsKey = (connectionId, status) => `${connectionId}:listings:${status}`;

// The cached listings of one tab, this connection's site only.
async function cachedListings(connectionId, status, ctx) {
  const id = String(connectionId);
  const [items, scope] = await Promise.all([listingsCache.get(listingsKey(id, status), { ...ctx, status, connectionId: id }), scopeOf(id)]);
  return marketScope.listingsIn(scope, items);
}
function splitListingsKey(key) {
  const at = key.indexOf(':');
  return [key.slice(0, at), key.slice(at + 1)];
}

/**
 * Listings for the Listings tab: the cached full set, searched and paged in
 * memory. `perPage` of 0 means everything on one page.
 */
async function listListingsDetailed(credentials, { connectionId, status = 'active', search, page = 1, perPage = 25, hiddenItemIds = [], push = false }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  let all = await cachedListings(connectionId, status, { accessToken, siteId, push });
  if (hiddenItemIds.length) {
    const hidden = new Set(hiddenItemIds.map(String));
    all = all.filter((item) => !hidden.has(item.itemId));
  }

  let filtered = all;
  if (search && search.trim()) {
    const needle = search.trim().toLowerCase();
    filtered = all.filter(
      (item) => String(item.title || '').toLowerCase().includes(needle) || String(item.sku || '').toLowerCase().includes(needle) || String(item.itemId).includes(needle)
    );
  }

  const totalEntries = filtered.length;
  const size = perPage > 0 ? perPage : Math.max(1, totalEntries);
  const totalPages = Math.max(1, Math.ceil(totalEntries / size));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const items = filtered.slice((safePage - 1) * size, safePage * size);

  return {
    items,
    totalEntries,
    totalPages,
    page: safePage,
    perPage: size,
    allCount: all.length,
    syncedAt: listingsCache.syncedAt(listingsKey(connectionId, status)),
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

// Each listing's latest sale in the mirrored orders (eBay keeps 90 days):
// itemId -> ISO time. Cancelled orders aren't sales. Reads the mirror only.
async function lastSalesByItem(credentials, { connectionId, push = false }) {
  const { accessToken, siteId } = await ensureValidAccessToken(credentials);
  const orders = await getOrdersLast90Cached(String(connectionId), accessToken, siteId, push).catch(() => []);
  const last = new Map();
  for (const order of orders || []) {
    if (order.cancelStatus && !['NotApplicable', 'None', 'CancelFailed'].includes(order.cancelStatus)) continue;
    if (!order.createdAt) continue;
    for (const line of order.lineItems || []) {
      const id = line.itemId ? String(line.itemId) : null;
      if (id && !(last.get(id) >= order.createdAt)) last.set(id, order.createdAt);
    }
  }
  return last;
}

// The account's best sellers, for the "More from our store" row in every
// description: ranked by units sold in the last 90 days (from the mirrored
// orders), then by the listing's lifetime sold count, then by recency. Reads
// only the mirror, so rendering a description never spends an eBay call.
//
// Every listing gets its own mix: the row is drawn from a pool of the top
// sellers, shuffled with the listing as the seed, so two listings show
// different best sellers while one listing always renders the same row.
function seededShuffle(list, seed) {
  let h = 2166136261;
  for (const ch of String(seed || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// What listing analytics needs from this account: a valid token for the
// traffic report, whether the token carries eBay's analytics scope, and the
// cached live listings and 90 days of orders (sales are counted from these,
// so they cost no traffic calls). Both come from the local copies, read
// from eBay only when stale, exactly as the Listings and Orders tabs do.
async function analyticsInputs(credentials, connectionId, { push = false } = {}) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const id = String(connectionId);
  const [items, orders] = await Promise.all([
    cachedListings(id, 'active', { accessToken, siteId, push }).catch(() => []),
    getOrdersLast90Cached(id, accessToken, siteId, push).catch(() => []),
  ]);
  return {
    accessToken,
    marketplaceId: credentials.marketplaceId || marketplaces.DEFAULT_ID,
    hasAnalyticsScope: ebayOauth.grantedScopes(credentials).some((scope) => /sell\.analytics/.test(scope)),
    items: items || [],
    orders: orders || [],
    listingsSyncedAt: listingsCache.syncedAt(listingsKey(id, 'active')),
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

async function bestSellingListings(credentials, connectionId, { exclude, count = 12, push = false, seed = null } = {}) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const id = String(connectionId);
  const [items, orders] = await Promise.all([
    cachedListings(id, 'active', { accessToken, siteId, push }),
    getOrdersLast90Cached(id, accessToken, siteId, push).catch(() => []),
  ]);

  const soldRecently = new Map();
  for (const order of orders || []) {
    if (order.cancelStatus && order.cancelStatus !== 'NotApplicable') continue;
    for (const line of order.lineItems || []) {
      if (!line.itemId) continue;
      soldRecently.set(line.itemId, (soldRecently.get(line.itemId) || 0) + (Number(line.quantityPurchased) || 1));
    }
  }

  const ranked = (items || [])
    .filter((item) => item.viewItemUrl && item.itemId !== String(exclude || ''))
    .map((item) => ({ item, recent: soldRecently.get(item.itemId) || 0, lifetime: Number(item.quantitySold) || 0 }))
    .sort((a, b) => b.recent - a.recent || b.lifetime - a.lifetime || String(b.item.itemId).localeCompare(String(a.item.itemId)));
  // The pool is three rows' worth of the best sellers (at least 24); each
  // listing shows `count` of them in its own order.
  const pool = ranked.slice(0, Math.max(count * 3, 24));
  const chosen = (seed ? seededShuffle(pool, seed) : pool).slice(0, count);
  const rows = chosen.map(({ item, recent, lifetime }) => ({
      url: item.viewItemUrl,
      imageUrl: item.imageUrl,
      name: item.title,
      price: item.price ? formatMoneyFor(item.price) : null,
      sold: recent || lifetime || 0,
    }));

  return { items: rows, credentialsChanged, credentials: refreshedCredentials };
}

const CURRENCY_SYMBOLS = { GBP: '£', USD: '$', EUR: '€', AUD: 'A$', CAD: 'C$' };
function formatMoneyFor(price) {
  const symbol = CURRENCY_SYMBOLS[price.currency] || `${price.currency || ''} `;
  return `${symbol}${Number(price.amount).toFixed(2)}`;
}

// Something we did changed the live set (a publish, a revision, an ended
// item removed). The copy keeps being shown, and refreshes behind the next
// look, so nobody waits on eBay for a change they already know about.
function invalidateListings(connectionId) {
  listingsCache.markStale(listingsKey(connectionId, 'active'));
  listingsCache.markStale(listingsKey(connectionId, 'inactive'));
  activeCountCache.markStale(String(connectionId));
}

// An ended item the seller removed for good: gone from the copy at once.
// The seller ended a listing: it leaves the Active copy and joins the
// Inactive one straight away (eBay's own lists follow within minutes; the
// stale marks make the next look confirm).
function moveListingToInactive(connectionId, itemId) {
  const id = String(connectionId);
  let ended = null;
  listingsCache.patch(listingsKey(id, 'active'), (items) => {
    ended = items.find((item) => item.itemId === String(itemId)) || null;
    return items.filter((item) => item.itemId !== String(itemId));
  });
  if (ended) {
    listingsCache.patch(listingsKey(id, 'inactive'), (items) => [{ ...ended, endTime: new Date().toISOString() }, ...items.filter((item) => item.itemId !== String(itemId))]);
    activeCountCache.patch(id, (count) => Math.max(0, count - 1));
  }
  listingsCache.markStale(listingsKey(id, 'active'));
  listingsCache.markStale(listingsKey(id, 'inactive'));
  activeCountCache.markStale(id);
}

async function endLiveListing(credentials, connectionId, itemId) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const result = await ebayTrading.endListing(accessToken, itemId, { siteId });
  moveListingToInactive(connectionId, itemId);
  return { ...result, credentialsChanged, credentials: refreshedCredentials };
}

function removeListingFromMirror(connectionId, itemId) {
  listingsCache.patch(listingsKey(connectionId, 'inactive'), (items) => items.filter((item) => item.itemId !== String(itemId)));
}

// eBay told us (or the seller asked): bring everything for this account up
// to date now. `wait` makes the caller sit through it; otherwise the copies
// are marked stale and refresh behind the next look.
const REFRESH_MIN_INTERVAL_MS = 60 * 1000;
const lastManualRefresh = new Map();

async function refreshAccount(credentials, connectionId, { wait = true } = {}) {
  const now = Date.now();
  if (now - (lastManualRefresh.get(connectionId) || 0) < REFRESH_MIN_INTERVAL_MS) {
    throw new EbayError('This account was refreshed less than a minute ago. Give eBay a moment.', 429);
  }
  lastManualRefresh.set(connectionId, now);

  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const keys = [listingsKey(connectionId, 'active'), listingsKey(connectionId, 'inactive')];
  for (const key of keys) listingsCache.invalidate(key);
  ordersCache.invalidate(String(connectionId));
  activeCountCache.invalidate(String(connectionId));

  const ctx = { accessToken, siteId, connectionId: String(connectionId), priority: 'user' };
  const work = Promise.all([
    listingsCache.get(listingsKey(connectionId, 'active'), { ...ctx, status: 'active' }),
    listingsCache.get(listingsKey(connectionId, 'inactive'), { ...ctx, status: 'inactive' }),
    ordersCache.get(String(connectionId), ctx),
    activeCountCache.get(String(connectionId), ctx),
  ]);
  if (wait) await work;
  else work.catch(() => {});
  return { credentialsChanged, credentials: refreshedCredentials };
}

// Subscribes the account to eBay's push notifications and returns the
// eBay username they'll arrive under. One GetUser per account, once.
async function enableNotifications(credentials, applicationUrl) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  await ebayTrading.setNotificationPreferences(accessToken, ebayNotifications.subscriptionXml(applicationUrl), { siteId });
  const profile = await ebayTrading.getUserProfile(accessToken);
  return { username: profile.username, credentialsChanged, credentials: refreshedCredentials };
}

// --- one order, in full ----------------------------------------------------

// Whether this connection's token can use the Fulfillment API. Tokens issued
// before the order scopes were added can't, until the seller reconnects.
function canManageOrders(credentials) {
  return ebayOauth.hasScope(credentials, ebayOauth.SCOPE_FULFILLMENT);
}

function scopeMissingError() {
  const err = new EbayError('Order actions need eBay permissions this connection was linked without. Reconnect the account from Connections (one click) to enable them.', 403);
  err.code = 'EBAY_SCOPE_MISSING';
  return err;
}


// The photo for the variation a buyer chose (Colour: Black Lace → that
// swatch's picture), falling back to the listing's main photo. Names and
// values are compared loosely: the order's "Color" and the listing's
// "Colour" are the same axis.
function variationImageFor(summary, variation) {
  if (!summary) return null;
  const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const chosen = (variation || []).map((v) => ({ name: norm(v.name), value: norm(v.value) }));
  for (const set of summary.variationPictures || []) {
    const axis = norm(set.specificName);
    const match = chosen.find((c) => c.name === axis || c.name.replace('colour', 'color') === axis.replace('colour', 'color'));
    if (!match) continue;
    const entry = Object.entries(set.byValue || {}).find(([value]) => norm(value) === match.value);
    if (entry) return entry[1];
  }
  return summary.imageUrl || null;
}

// The order as eBay's Fulfillment API returns it, with each line's photo
// and listing link. Without the scope, the Trading copy the order list
// already holds is returned instead (no line-item ids → no actions), so the
// page still renders and can say why the actions are off.
async function getOrderDetail(credentials, { connectionId, orderId }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const marketplaceId = credentials.marketplaceId || 'EBAY_GB';
  let order;
  let source;
  if (canManageOrders(credentials)) {
    const [raw, shipments] = await Promise.all([
      ebayFulfillment.getOrder(accessToken, orderId, marketplaceId),
      ebayFulfillment.getShippingFulfillments(accessToken, orderId, marketplaceId).catch(() => ({ fulfillments: [] })),
    ]);
    order = ebayFulfillment.mapOrder(raw, shipments?.fulfillments || []);
    source = 'fulfillment';
  } else {
    const all = await getOrdersLast90Cached(connectionId, accessToken, siteId, false).catch(() => []);
    const legacy = all.find((o) => o.orderId === orderId);
    if (!legacy) throw new EbayError('Order not found in the last 90 days of this account.', 404);
    order = legacyOrderDetail(legacy);
    source = 'trading';
  }
  // When the buyer received it: the Fulfillment API doesn't say, the
  // account's order copy (GetOrders) does. (The Trading shape carries it.)
  if (!order.deliveredAt) {
    const mirrored = (await getOrdersLast90Cached(connectionId, accessToken, siteId, false).catch(() => [])).find((o) => o.orderId === orderId);
    order.deliveredAt = mirrored?.deliveredAt || null;
  }
  const itemIds = [...new Set(order.lineItems.map((li) => li.itemId).filter(Boolean))];
  // The rest of what Seller Hub's order page shows, each best-effort: the
  // fees eBay took and where the funds are (Finances API), the buyer's
  // feedback score and whether they've bought before (the order list the
  // account already holds). None of it should keep the order from showing.
  // Why the fee breakdown may be missing, so the page can say the right
  // thing: 'scope' (token predates the finances permission → reconnect),
  // 'pending' (eBay hasn't posted the sale to Finances yet), 'error'.
  let earningsUnavailable = null;
  const hasFinancesScope = ebayOauth.hasScope(credentials, ebayOauth.SCOPE_FINANCES);
  if (!hasFinancesScope) earningsUnavailable = 'scope';
  const signed = hasFinancesScope
    ? await ensureSigningKey({ ...refreshedCredentials, marketplaceId }, accessToken).catch((err) => {
        logger.warn('Could not get an eBay signing key for the order earnings', { orderId, error: err.message });
        earningsUnavailable = 'error';
        return null;
      })
    : null;
  const [summaries, earnings, buyerInfo] = await Promise.all([
    getItemSummariesCached(accessToken, itemIds, siteId),
    signed
      ? ebayFinances
          .getOrderTransactions(accessToken, orderId, marketplaceId, signed.key)
          .then((res) => {
            const mapped = ebayFinances.mapOrderEarnings(res);
            if (!mapped) earningsUnavailable = 'pending';
            return mapped;
          })
          .catch((err) => {
            logger.warn('Could not load the order earnings from eBay', { orderId, error: err.message });
            earningsUnavailable = 'error';
            return null;
          })
      : Promise.resolve(null),
    buyerDetails(connectionId, accessToken, siteId, order.buyer?.username),
  ]);
  order.lineItems = order.lineItems.map((li) => {
    const summary = li.itemId ? summaries.get(li.itemId) : null;
    return {
      ...li,
      imageUrl: variationImageFor(summary, li.variation),
      viewItemUrl: summary?.viewItemUrl || null,
      quantityAvailable: summary?.quantityAvailable ?? null,
      itemSpecifics: summary?.specifics || {},
    };
  });
  order.buyer = { ...order.buyer, ...buyerInfo };
  order.earnings = earnings;
  order.earningsUnavailable = earnings ? null : earningsUnavailable;
  return {
    order,
    source,
    actionsEnabled: source === 'fulfillment',
    credentialsChanged: credentialsChanged || Boolean(signed?.credentialsChanged),
    credentials: signed?.credentials || refreshedCredentials,
  };
}

// The connection's eBay signing key (see ebay.signature), made on first
// use and kept with the tokens. Returns { key, credentials,
// credentialsChanged } so the caller persists a new key the usual way.
async function ensureSigningKey(credentials, accessToken) {
  const current = credentials.signingKey;
  if (current?.jwe && current?.privateKey && !ebaySignature.isExpired(current)) {
    return { key: current, credentials, credentialsChanged: false };
  }
  const key = await ebaySignature.createSigningKey(accessToken, credentials.marketplaceId || 'EBAY_GB');
  logger.info('Created an eBay signing key for the connection', { keyId: key.id, expiresAt: key.expiresAt });
  return { key, credentials: { ...credentials, signingKey: key }, credentialsChanged: true };
}

// Refunds the buyer, in full or in part. eBay takes the money from the
// seller's balance and answers with the refund's id and state.
async function refundOrder(credentials, { connectionId, orderId, amount, reason, comment }) {
  if (!canManageOrders(credentials)) throw scopeMissingError();
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const marketplaceId = credentials.marketplaceId || 'EBAY_GB';
  const signed = await ensureSigningKey({ ...refreshedCredentials, marketplaceId }, accessToken);
  const result = await ebayFulfillment.issueRefund(
    accessToken,
    orderId,
    {
      reasonForRefund: reason,
      comment,
      ...(amount ? { orderLevelRefundAmount: { value: String(amount.value), currency: amount.currency } } : {}),
    },
    marketplaceId,
    signed.key
  );
  ordersCache.markStale(String(connectionId));
  return {
    refundId: result?.refundId || null,
    refundStatus: result?.refundStatus || null,
    credentialsChanged: credentialsChanged || signed.credentialsChanged,
    credentials: signed.credentials,
  };
}

// Cancels an order: approves the buyer's open request when there is one,
// otherwise opens a seller cancellation for the given reason. eBay refunds
// the buyer either way.
async function cancelOrder(credentials, { connectionId, orderId, legacyOrderId, reason, pendingCancelId, buyerPaid, buyerPaidDate, refundAmount }) {
  if (!canManageOrders(credentials)) throw scopeMissingError();
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const marketplaceId = credentials.marketplaceId || 'EBAY_GB';
  const signed = await ensureSigningKey({ ...refreshedCredentials, marketplaceId }, accessToken);
  let cancelId = pendingCancelId || null;
  if (cancelId) {
    await ebayPostOrder.approveCancellation(accessToken, cancelId, marketplaceId, signed.key);
  } else {
    const result = await ebayPostOrder.createCancellation(
      accessToken,
      { legacyOrderId: legacyOrderId || orderId, cancelReason: reason, buyerPaid, buyerPaidDate, refundAmount },
      marketplaceId,
      signed.key
    );
    cancelId = result?.cancelId || null;
  }
  ordersCache.markStale(String(connectionId));
  return { cancelId, approved: Boolean(pendingCancelId), credentialsChanged: credentialsChanged || signed.credentialsChanged, credentials: signed.credentials };
}

// --- post-sale cases: returns, item-not-received, payment disputes ---------

function amountOf(node) {
  if (!node || node.value === undefined) return null;
  return { value: Number(node.value), currency: node.currency };
}

function mapReturn(r) {
  const info = r.creationInfo || {};
  return {
    id: String(r.returnId),
    state: r.state || null, // e.g. RETURN_REQUESTED, RETURN_REQUESTED_TIMEOUT, ITEM_SHIPPED, ITEM_DELIVERED, CLOSED
    status: r.status || null,
    type: info.type || r.currentType || null,
    reason: info.reason || null,
    buyerComment: info.comments?.content || null,
    itemId: info.item?.itemId ? String(info.item.itemId) : null,
    quantity: info.item?.returnQuantity ?? null,
    openedAt: r.creationInfo?.creationDate?.value || null,
    respondBy: r.sellerResponseDue?.respondByDate?.value || r.sellerResponseDue?.respondByDate || null,
    refundAmount: amountOf(r.actualRefundAmount || r.sellerTotalRefund?.actualRefundAmount || r.buyerTotalRefund?.estimatedRefundAmount),
    tracking: r.shipmentTracking?.trackingNumber || null,
    carrier: r.shipmentTracking?.carrierUsed || null,
    closed: /CLOSED|REFUNDED|ESCALATED_CLOSED/i.test(String(r.state || '')),
  };
}

function mapInquiry(i) {
  return {
    id: String(i.inquiryId),
    state: i.state || null, // e.g. OPEN, WAITING_FOR_SELLER_RESPONSE, CLOSED
    status: i.status || null,
    itemId: i.itemId ? String(i.itemId) : null,
    openedAt: i.creationDate?.value || i.creationDate || null,
    respondBy: i.sellerResponseDue?.respondByDate?.value || i.respondByDate?.value || null,
    claimAmount: amountOf(i.claimAmount),
    closed: /CLOSED/i.test(String(i.state || '')),
  };
}

function mapDispute(d) {
  return {
    id: String(d.paymentDisputeId),
    status: d.paymentDisputeStatus || null, // OPEN, ACTION_NEEDED, CLOSED …
    reason: d.reason || null,
    amount: amountOf(d.amount),
    openedAt: d.openDate || null,
    respondBy: d.respondByDate || null,
    closed: /CLOSED/i.test(String(d.paymentDisputeStatus || '')),
  };
}

// Every open case on an order, best-effort: none of them may keep the
// order page from showing, so a failed read is an empty list plus a note.
async function getOrderCases(credentials, { orderId, legacyOrderId }) {
  if (!canManageOrders(credentials)) return { returns: [], inquiries: [], disputes: [], unavailable: 'scope' };
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const marketplaceId = credentials.marketplaceId || 'EBAY_GB';
  const id = legacyOrderId || orderId;
  const quiet = (label, p) =>
    p.catch((err) => {
      // eBay answers 404 when an order simply has none (no dispute, say).
      logger[/\(404\)/.test(err.message) ? 'debug' : 'warn'](`Could not read the order's ${label}`, { orderId, error: err.message });
      return null;
    });
  const [returns, inquiries, disputes] = await Promise.all([
    quiet('returns', ebayPostOrder.searchReturns(accessToken, { orderId: id }, marketplaceId)),
    quiet('inquiries', ebayPostOrder.searchInquiries(accessToken, { orderId: id }, marketplaceId)),
    quiet('payment disputes', ebayFulfillment.getPaymentDisputeSummaries(accessToken, { orderId }, marketplaceId)),
  ]);
  return {
    returns: (returns?.members || []).map(mapReturn),
    inquiries: (inquiries?.members || []).map(mapInquiry),
    disputes: (disputes?.paymentDisputeSummaries || []).map(mapDispute),
    unavailable: returns === null && inquiries === null && disputes === null ? 'error' : null,
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

// Declines a buyer's cancellation request (no refund, order stands).
async function declineCancellation(credentials, { connectionId, cancelId }) {
  if (!canManageOrders(credentials)) throw scopeMissingError();
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  await ebayPostOrder.rejectCancellation(accessToken, cancelId, credentials.marketplaceId || 'EBAY_GB');
  ordersCache.markStale(String(connectionId));
  return { credentialsChanged, credentials: refreshedCredentials };
}

// One seller action on a return: accept / decline the request, mark the
// item received, refund (full or partial), or message the buyer. Money
// moves on decide+refund, so those are signed.
async function respondToReturn(credentials, { returnId, action, comment, declineReason, amount }) {
  if (!canManageOrders(credentials)) throw scopeMissingError();
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const marketplaceId = credentials.marketplaceId || 'EBAY_GB';
  let creds = refreshedCredentials;
  let changed = credentialsChanged;
  const signedKey = async () => {
    const signed = await ensureSigningKey({ ...creds, marketplaceId }, accessToken);
    creds = signed.credentials;
    changed = changed || signed.credentialsChanged;
    return signed.key;
  };
  switch (action) {
    case 'accept':
      await ebayPostOrder.decideReturn(accessToken, returnId, { decision: 'ACCEPT', comment }, marketplaceId, await signedKey());
      break;
    case 'decline':
      await ebayPostOrder.decideReturn(accessToken, returnId, { decision: 'DECLINE', comment, declineReason }, marketplaceId, await signedKey());
      break;
    case 'received':
      await ebayPostOrder.markReturnReceived(accessToken, returnId, { comment }, marketplaceId);
      break;
    case 'refund':
      await ebayPostOrder.issueReturnRefund(accessToken, returnId, { amount, comment }, marketplaceId, await signedKey());
      break;
    case 'message':
      await ebayPostOrder.sendReturnMessage(accessToken, returnId, comment, marketplaceId);
      break;
    default:
      throw new EbayError('Unknown return action', 400);
  }
  return { credentialsChanged: changed, credentials: creds };
}

// One seller action on an item-not-received inquiry.
async function respondToInquiry(credentials, { inquiryId, action, carrier, trackingNumber, shippedDate, message }) {
  if (!canManageOrders(credentials)) throw scopeMissingError();
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const marketplaceId = credentials.marketplaceId || 'EBAY_GB';
  switch (action) {
    case 'shipment':
      await ebayPostOrder.provideInquiryShipmentInfo(accessToken, inquiryId, { carrier, trackingNumber, shippedDate, message }, marketplaceId);
      return { credentialsChanged, credentials: refreshedCredentials };
    case 'refund': {
      const signed = await ensureSigningKey({ ...refreshedCredentials, marketplaceId }, accessToken);
      await ebayPostOrder.issueInquiryRefund(accessToken, inquiryId, { comment: message }, marketplaceId, signed.key);
      return { credentialsChanged: credentialsChanged || signed.credentialsChanged, credentials: signed.credentials };
    }
    case 'message':
      await ebayPostOrder.sendInquiryMessage(accessToken, inquiryId, message, marketplaceId);
      return { credentialsChanged, credentials: refreshedCredentials };
    default:
      throw new EbayError('Unknown inquiry action', 400);
  }
}

// Accept or contest a payment dispute. Contesting uses whatever evidence is
// already on the dispute (eBay adds the seller's tracking itself; anything
// more is uploaded on eBay's page).
async function respondToDispute(credentials, { disputeId, action, returnAddress }) {
  if (!canManageOrders(credentials)) throw scopeMissingError();
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const marketplaceId = credentials.marketplaceId || 'EBAY_GB';
  if (action === 'accept') {
    await ebayFulfillment.acceptPaymentDispute(accessToken, disputeId, { returnAddress }, marketplaceId);
  } else if (action === 'contest') {
    const dispute = await ebayFulfillment.getPaymentDispute(accessToken, disputeId, marketplaceId);
    await ebayFulfillment.contestPaymentDispute(accessToken, disputeId, { revision: dispute?.revision ?? 0, returnAddress }, marketplaceId);
  } else {
    throw new EbayError('Unknown dispute action', 400);
  }
  return { credentialsChanged, credentials: refreshedCredentials };
}

// A buyer's public feedback score is one rationed Trading call, so it is
// kept for a day per buyer; "repeat buyer" counts their orders in the
// account's last-90-day list, which is already held.
const buyerFeedbackCache = new Map(); // username -> { fetchedAt, feedback }
const BUYER_FEEDBACK_TTL_MS = 24 * 60 * 60 * 1000;

async function buyerDetails(connectionId, accessToken, siteId, username) {
  if (!username) return {};
  const [feedback, orders] = await Promise.all([
    (async () => {
      const hit = buyerFeedbackCache.get(username);
      if (hit && Date.now() - hit.fetchedAt < BUYER_FEEDBACK_TTL_MS) return hit.feedback;
      const feedback = await ebayTrading.getMemberFeedback(accessToken, username, siteId).catch(() => null);
      if (feedback) buyerFeedbackCache.set(username, { fetchedAt: Date.now(), feedback });
      return feedback;
    })(),
    getOrdersLast90Cached(connectionId, accessToken, siteId, false).catch(() => []),
  ]);
  const previousOrders = (orders || []).filter((o) => o.buyerUserId === username).length;
  return {
    feedbackScore: feedback?.feedbackScore ?? null,
    feedbackPercent: feedback?.feedbackPercent ?? null,
    repeatBuyer: previousOrders > 1,
  };
}

// A Trading-shaped order (the list's mirror) in the detail shape, minus
// what Trading doesn't carry.
function legacyOrderDetail(o) {
  const status = classifyOrderStatus(o);
  // Trading money is { amount, currency }; the detail shape is { value, currency }.
  const amt = (m) => (m && m.amount !== undefined ? { value: Number(m.amount), currency: m.currency } : null);
  return {
    orderId: o.orderId,
    legacyOrderId: o.orderId,
    salesRecordReference: o.salesRecordNumber || null,
    createdAt: o.createdAt,
    lastModified: null,
    paymentStatus: o.checkoutStatus === 'Complete' ? 'PAID' : 'PENDING',
    fulfillmentStatus: o.shippedTime ? 'FULFILLED' : 'NOT_STARTED',
    cancelState: status === 'cancelled' ? 'CANCELED' : 'NONE_REQUESTED',
    cancelRequests: [],
    buyer: { username: o.buyerUserId || null },
    buyerCheckoutNotes: null,
    shipTo: o.shippingAddress ? { ...o.shippingAddress, email: o.shippingProgramme ? '' : o.buyerEmail || '' } : null,
    shipToReferenceId: o.shippingAddress?.referenceId || null,
    shippingProgramme: o.shippingProgramme || null,
    finalDestination: o.finalDestination || null,
    shippingService: o.gspService || (o.lineItems || []).map((li) => li.shippingService).find(Boolean) || null,
    shippingCarrier: null,
    estimatedDelivery: {
      min: (o.lineItems || []).map((li) => li.estimatedDeliveryMin).filter(Boolean).sort()[0] || null,
      max: (o.lineItems || []).map((li) => li.estimatedDeliveryMax).filter(Boolean).sort().slice(-1)[0] || null,
    },
    pricing: { subtotal: amt(o.subtotal), total: amt(o.total), delivery: amt(o.total && o.subtotal ? { amount: o.total.amount - o.subtotal.amount, currency: o.total.currency } : null), tax: null, discount: null, deliveryDiscount: null, adjustment: null },
    payments: o.paidTime ? [{ method: null, status: 'PAID', amount: amt(o.total), date: o.paidTime, referenceId: null }] : [],
    refunds: [],
    totalDueSeller: null,
    totalMarketplaceFee: null,
    lineItems: (o.lineItems || []).map((li, index) => ({
      lineItemId: null,
      itemId: li.itemId,
      legacyVariationId: null,
      sku: null,
      title: li.title,
      quantity: li.quantityPurchased,
      unitPrice: amt(li.price),
      total: li.price ? { value: Math.round(Number(li.price.amount) * li.quantityPurchased * 100) / 100, currency: li.price.currency } : null,
      deliveryCost: null,
      variation: li.variation || [],
      fulfillmentStatus: o.shippedTime ? 'FULFILLED' : 'NOT_STARTED',
      shipByDate: li.handleByTime || o.dispatchByTime || null,
      minEstimatedDelivery: li.estimatedDeliveryMin || null,
      maxEstimatedDelivery: li.estimatedDeliveryMax || null,
      promotions: [],
      refunds: [],
      ebayCollectedTax: null,
      index,
    })),
    fulfillments: o.shippedTime
      ? [{ fulfillmentId: null, carrier: o.lineItems?.[0]?.trackingCarrier || null, trackingNumber: o.lineItems?.[0]?.trackingNumber || null, shippedDate: o.shippedTime, lineItems: [] }]
      : [],
  };
}

// Marks line items dispatched on eBay, with tracking. Returns the new
// fulfillment id. The order list's copy is marked stale so it re-reads.
async function dispatchOrder(credentials, { connectionId, orderId, lineItems, carrier, trackingNumber, shippedDate }) {
  if (!canManageOrders(credentials)) throw scopeMissingError();
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const marketplaceId = credentials.marketplaceId || 'EBAY_GB';
  const result = await ebayFulfillment.createShippingFulfillment(
    accessToken,
    orderId,
    { lineItems, shippingCarrierCode: carrier, trackingNumber, shippedDate },
    marketplaceId
  );
  ordersCache.markStale(String(connectionId));
  return { fulfillmentId: result?.fulfillmentId || null, credentialsChanged, credentials: refreshedCredentials };
}

// Marks an account's copies stale without reading anything.
function markAccountStale(connectionId) {
  invalidateListings(connectionId);
  ordersCache.markStale(String(connectionId));
}

// Re-reads just the parts of an account that changed, right now, in the
// background — what a push notification (or one of our own publishes)
// triggers. Calls for the same account are coalesced: while one re-read is
// running, further requests queue at most one more, so a burst of
// notifications (a sale marks the order AND revises the listing's quantity)
// costs one round of calls, not one per event.
const pendingSync = new Map(); // connectionId -> { running: Promise, again: Set<kind> }

async function syncAccount(credentials, connectionId, kinds = ['listings', 'orders']) {
  const id = String(connectionId);
  const state = pendingSync.get(id);
  if (state?.running) {
    for (const kind of kinds) state.again.add(kind);
    return state.running;
  }
  const entry = { running: null, again: new Set() };
  pendingSync.set(id, entry);
  entry.running = (async () => {
    try {
      const { accessToken, siteId } = await ensureValidAccessToken(credentials);
      const ctx = { accessToken, siteId, connectionId: id, push: true, priority: 'push' };
      const jobs = [];
      if (kinds.includes('listings')) {
        for (const status of ['active', 'inactive']) {
          const key = listingsKey(id, status);
          listingsCache.markStale(key);
          jobs.push(listingsCache.get(key, { ...ctx, status }));
        }
        activeCountCache.markStale(id);
        jobs.push(activeCountCache.get(id, ctx));
      }
      if (kinds.includes('orders')) {
        ordersCache.markStale(id);
        jobs.push(ordersCache.get(id, ctx));
      }
      // markStale rather than invalidate: the copy keeps being served and
      // the re-read runs behind it; a read the governor holds back (budget
      // nearly spent) is simply retried by the next look at the page.
      await Promise.all(jobs.map((job) => job.catch((err) => (err.code === 'EBAY_BUDGET' ? null : Promise.reject(err)))));
    } finally {
      const again = [...entry.again];
      pendingSync.delete(id);
      if (again.length) syncAccount(credentials, connectionId, again).catch(() => {});
    }
  })();
  return entry.running;
}

// A sale changes one listing's quantity; on a big account a full re-read
// of the lists to learn that costs 15–20 calls. So a sale is reflected
// with one GetItem for that item, patched into the mirrored copy and
// announced to open pages. A listing that just sold out leaves the active
// list; the count follows. Falls back to a stale mark (re-read on the next
// look, no call now) when there is no loaded copy to patch.
// Listings a pushed order just sold from, per account: eBay follows a sale
// with a LISTING "UPDATED" push for the new quantity, which applyNewOrder
// has already applied — so that one needs no read.
const recentSales = new Map(); // connectionId -> Map(listingId -> ms)
const SALE_UPDATE_WINDOW_MS = 5 * 60 * 1000;
// More changed listings than this in one batch: one read of the whole
// active list (1 call per 200 listings) beats a GetItem each.
const LISTING_READS_BEFORE_FULL = 8;

/**
 * Listing changes eBay pushed (LISTING: CREATED | UPDATED | ENDED), gathered
 * per account (ebay-push.js). Ended listings leave the active list with no
 * call; an update right after a pushed sale was already applied; the rest
 * are read one by one (Trading GetItem, trimmed), or — for a burst — the
 * whole active list once. Open pages are told ("listings" event). Resolves
 * to { summary, credentialsChanged, credentials }.
 */
async function applyListingChanges(credentials, connectionId, changes) {
  const id = String(connectionId);
  const { accessToken, siteId, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const ctx = { accessToken, siteId, connectionId: id, push: { listings: true, orders: false }, priority: 'push' };
  const key = listingsKey(id, 'active');
  const now = Date.now();
  const soldAt = recentSales.get(id) || new Map();
  const ended = new Set(changes.filter((c) => c.reason === 'ENDED').map((c) => String(c.listingId)));
  const toRead = [];
  let skippedSales = 0;
  for (const c of changes) {
    const listingId = String(c.listingId);
    if (ended.has(listingId)) continue;
    if (c.reason === 'UPDATED' && now - (soldAt.get(listingId) || 0) < SALE_UPDATE_WINDOW_MS) {
      skippedSales += 1;
      continue;
    }
    toRead.push(listingId);
  }

  let reads = 0;
  let fullRead = false;
  if (toRead.length > LISTING_READS_BEFORE_FULL) {
    listingsCache.markStale(key);
    await listingsCache.get(key, { ...ctx, status: 'active' });
    fullRead = true;
  } else {
    const fetched = new Map();
    for (const listingId of toRead) {
      const result = await governor
        .withContext({ connectionId: id, priority: 'push' }, () => ebayTrading.getListingItem(accessToken, listingId, { siteId }))
        .catch((err) => (err.code === 'EBAY_BUDGET' ? null : Promise.reject(err)));
      reads += 1;
      if (!result) continue; // held back by the Trading budget: the next routine read catches it
      if (result.active) fetched.set(listingId, result.item);
      else ended.add(listingId);
    }
    if (fetched.size || ended.size) {
      await listingsCache.patchStored(key, (items) => {
        const next = [];
        for (const item of items) {
          const itemId = String(item.itemId);
          if (ended.has(itemId)) continue;
          next.push(fetched.has(itemId) ? { ...item, ...fetched.get(itemId) } : item);
          fetched.delete(itemId);
        }
        return [...fetched.values(), ...next]; // new listings first, as eBay lists them
      });
    }
  }
  if (ended.size) listingsCache.markStale(listingsKey(id, 'inactive')); // the Unsold tab gains them on its next look
  const active = listingsCache.peek(key);
  if (Array.isArray(active)) await activeCountCache.patchStored(id, () => active.length);
  return {
    summary: { changes: changes.length, ended: ended.size, fromSales: skippedSales, reads, fullRead },
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

/**
 * A new order eBay pushed (ORDER_CONFIRMATION): read it on its own from the
 * Fulfillment API (1 call, its own allowance — no Trading call), add it to
 * the order list, and take the units off the listings it came from, from
 * the quantities in the notification (no call). Open pages are told
 * ("orders", "listings" events). The next routine Trading read of the
 * account replaces the order with Trading's own copy.
 */
async function applyNewOrder(credentials, connectionId, { orderId, lineItems = [] }) {
  const id = String(connectionId);
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const raw = await ebayFulfillment.getOrder(accessToken, orderId, credentials.marketplaceId || 'EBAY_GB');
  const order = ebayFulfillment.toListOrder(raw);
  await persist(() => mirror.upsertOrders(id, [order]));
  const inList = await ordersCache.patchStored(id, (orders) => [order, ...orders.filter((o) => o.orderId !== order.orderId)]);
  // No stored copy yet (the account's orders were never read): the order is
  // in the mirror, which the first read includes; tell open pages anyway.
  if (!inList) accountEvents.emitUpdated(id, 'orders');

  const sold = new Map();
  const soldAt = recentSales.get(id) || new Map();
  recentSales.set(id, soldAt);
  for (const li of lineItems.length ? lineItems : order.lineItems.map((l) => ({ listingId: l.itemId, quantity: l.quantityPurchased }))) {
    if (!li.listingId) continue;
    sold.set(String(li.listingId), (sold.get(String(li.listingId)) || 0) + (Number(li.quantity) || 1));
    soldAt.set(String(li.listingId), Date.now());
  }
  if (sold.size) {
    await listingsCache.patchStored(listingsKey(id, 'active'), (items) =>
      items.flatMap((item) => {
        const units = sold.get(String(item.itemId));
        if (!units) return [item];
        const available = item.quantityAvailable == null ? null : Math.max(0, item.quantityAvailable - units);
        if (available === 0) return []; // sold out: ended on eBay
        return [{ ...item, quantityAvailable: available, quantitySold: (item.quantitySold || 0) + units }];
      })
    );
  }
  return { order, credentialsChanged, credentials: refreshedCredentials };
}

async function applySale(credentials, connectionId, itemId) {
  const id = String(connectionId);
  const key = listingsKey(id, 'active');
  const { accessToken, siteId } = await ensureValidAccessToken(credentials);
  const summary = await governor.withContext({ connectionId: id, priority: 'push' }, () =>
    ebayTrading.getItemSummary(accessToken, String(itemId), { siteId })
  );
  const soldOut = summary.quantityAvailable === 0;
  let found = false;
  const patched = listingsCache.patch(key, (items) => {
    const next = [];
    for (const item of items) {
      if (String(item.itemId) !== String(itemId)) {
        next.push(item);
        continue;
      }
      found = true;
      if (soldOut) continue;
      next.push({
        ...item,
        quantity: summary.quantity ?? item.quantity,
        quantityAvailable: summary.quantityAvailable ?? item.quantityAvailable,
        quantitySold: summary.quantitySold ?? item.quantitySold,
      });
    }
    return next;
  });
  if (!patched || !found) {
    // Nothing loaded, or an item we have not seen yet (listed since the
    // last read): the next look at the page re-reads.
    listingsCache.markStale(key);
    activeCountCache.markStale(id);
    return { patched: false, soldOut };
  }
  if (soldOut && !activeCountCache.patch(id, (count) => Math.max(0, count - 1))) activeCountCache.markStale(id);
  return { patched: true, soldOut };
}

function ordersWithin(orders, start, end) {
  const s = start.getTime();
  const e = end.getTime();
  return orders.filter((o) => {
    const t = new Date(o.createdAt).getTime();
    return t >= s && t <= e;
  });
}

// Memory first, then the mirror table, then eBay — and an eBay read is
// written back so it is never repeated for that item on any server.
async function getItemSummariesCached(accessToken, itemIds, siteId) {
  const now = Date.now();
  const out = new Map();
  const missing = [];
  for (const itemId of itemIds) {
    const cached = itemSummaryCache.get(itemId);
    // Copies made before variation photos were read are refetched once.
    if (cached && now - cached.fetchedAt < ITEM_SUMMARY_CACHE_TTL_MS && cached.summary?.variationPictures && cached.summary?.specifics) out.set(itemId, cached.summary);
    else missing.push(itemId);
  }
  if (missing.length) {
    const persisted = await mirror.loadItemSummaries(missing).catch(() => new Map());
    for (const itemId of [...missing]) {
      const row = persisted.get(itemId);
      if (row && now - row.fetchedAt < ITEM_SUMMARY_CACHE_TTL_MS && row.summary?.variationPictures && row.summary?.specifics) {
        itemSummaryCache.set(itemId, row);
        out.set(itemId, row.summary);
        missing.splice(missing.indexOf(itemId), 1);
      }
    }
  }
  await Promise.all(
    missing.map(async (itemId) => {
      const summary = await ebayTrading.getItemSummary(accessToken, itemId, { siteId }).catch(() => null);
      if (!summary) return;
      itemSummaryCache.set(itemId, { fetchedAt: now, summary });
      out.set(itemId, summary);
      mirror.saveItemSummary(itemId, summary).catch(() => {});
    })
  );
  return out;
}

// Classifies an order the way eBay's Seller Hub visually groups them —
// Trading API has no single field for this, so it's derived from payment
// and shipping state actually present on the order.
function classifyOrderStatus(order) {
  if (order.cancelStatus && order.cancelStatus !== 'NotApplicable') return 'cancelled';
  if (order.status === 'Cancelled') return 'cancelled';
  if (order.checkoutStatus !== 'Complete') return 'awaiting_payment';
  if (!order.shippedTime) return 'awaiting_dispatch';
  if (order.deliveredAt) return 'delivered';
  return 'dispatched';
}

const ORDER_STATUS_FILTERS = ['awaiting_payment', 'awaiting_dispatch', 'dispatched', 'delivered', 'cancelled'];

/**
 * The Orders page's data source: fetches every order in the range, tags each
 * with a derived status, filters by status/search text, sorts it
 * (orders/order-sort.js: newest first, or the nearest dispatch deadline on
 * Awaiting dispatch) and paginates in-memory (eBay's own pagination doesn't support these
 * filters) — then enriches only the returned page's line items with a
 * picture + live quantity from GetItem, so we're not fetching images for
 * orders the page never shows.
 */
// `archivedOrderIds` are the orders the team put away: left out unless
// `archived` asks for exactly those. `supplierStateOf(order)` says where the
// supplier order stands (orders/order-supplier.js); `supplier` keeps one
// state. The tab counts don't depend on it; `supplierCounts` count each
// state within the chosen tab.
async function listOrdersDetailed(credentials, { connectionId, range, status, search, sort, page = 1, perPage = 25, push = false, archivedOrderIds = [], archived = false, supplier = 'any', supplierStateOf = null }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const [start, end] = resolveRangeWindow(range);
  const rawOrders = ordersWithin(await getOrdersLast90Cached(connectionId, accessToken, siteId, push), start, end);

  const archivedSet = new Set(archivedOrderIds);
  const tagged = rawOrders
    .filter((order) => archivedSet.has(order.orderId) === Boolean(archived))
    .map((order) => ({ ...order, derivedStatus: classifyOrderStatus(order), archived: archivedSet.has(order.orderId) }));

  const counts = { all: tagged.length };
  for (const key of ORDER_STATUS_FILTERS) {
    counts[key] = tagged.filter((o) => o.derivedStatus === key).length;
  }

  let filtered = status && status !== 'all' ? tagged.filter((o) => o.derivedStatus === status) : tagged;

  // What needs doing among the paid orders waiting to ship: past their
  // dispatch-by date, and not yet ordered from the supplier.
  const awaiting = tagged.filter((o) => o.derivedStatus === 'awaiting_dispatch');
  const nowMs = Date.now();
  const attention = {
    overdue: awaiting.filter((o) => o.dispatchByTime && new Date(o.dispatchByTime).getTime() < nowMs).length,
    notOrdered: supplierStateOf ? awaiting.filter((o) => supplierStateOf(o) === 'pending').length : null,
  };

  let supplierCounts = null;
  if (supplierStateOf) {
    const states = new Map(filtered.map((o) => [o.orderId, supplierStateOf(o)]));
    supplierCounts = { any: filtered.length };
    for (const state of states.values()) supplierCounts[state] = (supplierCounts[state] || 0) + 1;
    if (supplier && supplier !== 'any') filtered = filtered.filter((o) => states.get(o.orderId) === supplier);
  }

  if (search && search.trim()) {
    const needle = search.trim().toLowerCase();
    filtered = filtered.filter(
      (o) =>
        o.orderId.toLowerCase().includes(needle) ||
        o.lineItems.some((li) => (li.title || '').toLowerCase().includes(needle))
    );
  }

  const sortKey = orderSort.sortFor(sort, status);
  filtered = orderSort.sortOrders(filtered, sortKey, status);

  const totalEntries = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalEntries / perPage));
  const pageOrders = filtered.slice((page - 1) * perPage, page * perPage);

  const uniqueItemIds = [...new Set(pageOrders.flatMap((o) => o.lineItems.map((li) => li.itemId).filter(Boolean)))];
  const summaryByItemId = await getItemSummariesCached(accessToken, uniqueItemIds, siteId);

  const enrichedOrders = pageOrders.map((order) => ({
    ...order,
    lineItems: order.lineItems.map((li) => {
      const summary = li.itemId ? summaryByItemId.get(li.itemId) : null;
      return {
        ...li,
        imageUrl: variationImageFor(summary, li.variation),
        quantityAvailable: summary?.quantityAvailable ?? null,
        viewItemUrl: summary?.viewItemUrl || null,
      };
    }),
  }));

  return {
    orders: enrichedOrders,
    counts,
    attention,
    supplierCounts,
    supplier: supplierStateOf ? supplier || 'any' : 'any',
    totalEntries,
    totalPages,
    page,
    perPage,
    sort: sortKey,
    syncedAt: ordersCache.syncedAt(String(connectionId)),
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

// eBay's GetOrders hard-rejects any CreateTimeFrom older than 90 days —
// there is no pagination or chunking trick around it, confirmed against the
// live API ("Orders older than 90 days cannot be retrieved"). So 'all_time'
// is, honestly, "as far back as eBay lets us look": the last 90 days. The
// `truncated` flag lets the frontend say so instead of implying a true
// lifetime total.
// `timeZone`: whose day "today" and the months are (the owner's dashboard
// passes the viewer's); the account's site's otherwise.
/** The account's own orders placed in a range (its site only), from the mirror. */
async function ordersInRange(credentials, { connectionId, range, from, to, timeZone = null, push = false }) {
  const { accessToken, siteId } = await ensureValidAccessToken(credentials);
  const [start, end] = resolveRangeWindow(range === 'all_time' ? '90d' : range, from, to, timeZone || analyticsDays.timeZoneFor(credentials.marketplaceId || 'EBAY_GB'));
  return ordersWithin(await getOrdersLast90Cached(String(connectionId), accessToken, siteId, push), start, end);
}

// Each order's money as eBay's Finances API has it (fees, ad fees, what
// reached the seller, refunds), kept in ebay_order_finances for the
// Overview. Read in bulk: every transaction in a date window, 1,000 to a
// call. The first read covers eBay's 90 days; after that the window since
// the last read (with a few days' overlap for fees and refunds eBay books
// late), at most every FINANCES_FRESH_MS. An order whose sale fell before
// the window but got a refund or an ad fee inside it is read on its own.
const FINANCES_FRESH_MS = 30 * 60 * 1000;
const FINANCES_OVERLAP_MS = 3 * DAY_MS;
const FINANCES_MAX_PAGES = 20;
const FINANCES_LATE_ORDERS = 50;
const financesRunning = new Map();

function syncOrderFinances(credentials, connectionId, { force = false } = {}) {
  const id = String(connectionId);
  if (financesRunning.has(id)) return financesRunning.get(id);
  const run = syncOrderFinancesNow(credentials, id, { force }).finally(() => financesRunning.delete(id));
  financesRunning.set(id, run);
  return run;
}

async function syncOrderFinancesNow(credentials, id, { force }) {
  if (!ebayOauth.hasScope(credentials, ebayOauth.SCOPE_FINANCES)) return { skipped: 'scope', credentialsChanged: false, credentials };
  const state = await mirror.loadSnapshot(id, 'finances').catch(() => null);
  const now = new Date();
  if (!force && state && now - state.syncedAt < FINANCES_FRESH_MS) return { skipped: 'fresh', credentialsChanged: false, credentials };

  const { accessToken, credentials: refreshed, credentialsChanged } = await ensureValidAccessToken(credentials);
  const marketplaceId = credentials.marketplaceId || marketplaces.DEFAULT_ID;
  const signed = await ensureSigningKey({ ...refreshed, marketplaceId }, accessToken);
  const lastSyncAt = state?.meta?.lastSyncAt ? new Date(state.meta.lastSyncAt) : null;
  const from = lastSyncAt ? new Date(lastSyncAt.getTime() - FINANCES_OVERLAP_MS) : ordersHorizon(now);

  // The first page says how many there are; the rest are read together
  // (each takes eBay a few seconds).
  const window = { from: from.toISOString(), to: now.toISOString() };
  const first = await ebayFinances.getTransactions(accessToken, { ...window, offset: 0 }, marketplaceId, signed.key);
  const pageSize = (first?.transactions || []).length;
  const pages = pageSize ? Math.min(FINANCES_MAX_PAGES, Math.ceil(Number(first?.total || 0) / pageSize)) : 1;
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) =>
      ebayFinances.getTransactions(accessToken, { ...window, offset: (i + 1) * pageSize }, marketplaceId, signed.key)
    )
  );
  const transactions = [first, ...rest].flatMap((res) => res?.transactions || []);
  const rows = ebayFinances.orderFinancesFrom(transactions);
  // After the first read: a refund or a late ad fee on an order sold before
  // the window brings that order's whole history, so its row stays complete.
  // (On the first read those orders are older than the 90 days shown.)
  if (lastSyncAt) {
    const found = new Set(rows.map((r) => r.orderId));
    const late = [...new Set(transactions.map(ebayFinances.orderIdOf).filter((orderId) => orderId && !found.has(orderId)))].slice(0, FINANCES_LATE_ORDERS);
    const histories = await mapWithConcurrency(late, 4, (orderId) =>
      ebayFinances.getOrderTransactions(accessToken, orderId, marketplaceId, signed.key).catch(() => null)
    );
    for (const res of histories) rows.push(...ebayFinances.orderFinancesFrom(res?.transactions || []));
  }
  await mirror.upsertOrderFinances(id, rows);
  await mirror.saveSnapshot(id, 'finances', { count: rows.length }, { lastSyncAt: now.toISOString() });
  const changed = credentialsChanged || signed.credentialsChanged;
  return { orders: rows.length, credentialsChanged: changed, credentials: signed.credentialsChanged ? signed.credentials : refreshed };
}

async function getEarningsSummary(credentials, { connectionId, range, from, to, timeZone = null, push = false }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);

  const effectiveRange = range === 'all_time' ? '90d' : range;
  const [start, end] = resolveRangeWindow(effectiveRange, from, to, timeZone || analyticsDays.timeZoneFor(credentials.marketplaceId || 'EBAY_GB'));
  const orders = connectionId
    ? ordersWithin(await getOrdersLast90Cached(connectionId, accessToken, siteId, push), start, end)
    : (await fetchAllOrdersInWindow(accessToken, start.toISOString(), end.toISOString(), 1, siteId)).orders;

  // In the account's own currency; sales in another (a site of the account
  // not linked separately) are totalled beside it, never added in.
  // A day with no orders is still £0.00, not a bare 0.00.
  const { main, others } = money.splitByCurrency(
    orders.map((order) => order.total),
    marketplaces.currencyFor(credentials.marketplaceId || 'EBAY_GB')
  );

  return {
    earnings: main,
    otherEarnings: others,
    orderCount: orders.length,
    truncated: range === 'all_time',
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

// Whether an account gets eBay's push notifications (set by
// scripts/enable-ebay-notifications.js).
// Whether eBay's push is actually arriving for an account, per kind — not
// merely subscribed: a subscription eBay stays silent on (as Trading's
// Platform Notifications did for sales) must not stop Liston checking. A
// push counts for two days after the last one received.
const PUSH_TRUST_MS = 48 * 60 * 60 * 1000;
function pushEnabled(connection, now = Date.now()) {
  const ebay = connection?.settings?.ebay || {};
  const recent = (at) => Boolean(at) && now - new Date(at).getTime() < PUSH_TRUST_MS;
  const listings =
    (Boolean(ebay.listingPush?.subscriptionId) && recent(ebay.listingPush?.lastReceivedAt)) || (Boolean(ebay.notificationsEnabledAt) && recent(ebay.lastPushAt));
  const orders = Boolean(ebay.orderPush?.subscriptionId) && recent(ebay.orderPush?.lastReceivedAt);
  return { listings, orders };
}

// Similar listings on a site (public data, 1 Browse call), for a listing's
// health check: the cheapest by price in the same category.
function searchSimilarListings({ q, categoryId, filter, limit = 20 }, marketplaceId) {
  return browseUsage.as('health', () => ebayBrowse.searchItemSummaries({ q, limit, filter, categoryIds: categoryId || undefined, sort: 'price' }, marketplaceId));
}

// A category's item specifics with required/recommended flags (cached by
// the taxonomy client for a day); null when eBay couldn't be asked.
function categoryAspectSchema(marketplaceId, categoryId) {
  return ebayTaxonomy.getEditorAspectSchema(marketplaceId, categoryId);
}

module.exports = {
  searchSimilarListings,
  categoryAspectSchema,
  pushEnabled,
  getOrderCases,
  declineCancellation,
  respondToReturn,
  respondToInquiry,
  respondToDispute,
  variationImageFor,
  canManageOrders,
  getOrderDetail,
  refundOrder,
  cancelOrder,
  ensureSigningKey,
  dispatchOrder,
  EbayError,
  ensureValidAccessToken,
  analyticsInputs,
  createOfferWithRetry,
  buildInventoryItem,
  splitProductIdentifiers,
  notApplicableText,
  buildOffer,
  draftListing,
  draftVariationListing,
  getBusinessPolicies,
  getMerchantLocations,
  publishDraft,
  publishGroup,
  setProductNotFoundDelay,
  withdrawDraft,
  listActiveListings,
  countActiveListings,
  getStoreProfile,
  getBestReviews,
  listUnsoldListings,
  bestSellingListings,
  listOrders,
  getLiveItem,
  detectMarketplace,
  identifySeller,
  getStoreCategories,
  getStoreCategoriesCached,
  addStoreCategory,
  createMerchantLocation,
  deleteInventoryObjects,
  findLiveListingForSku,
  reviseLiveListing,
  reviseInventoryListing,
  isInventoryManagedError,
  conditionIdFor,
  listListingsDetailed,
  relistLiveListing,
  inventoryRefForSkus,
  duplicateListingOf,
  isEndedListingError,
  lastSalesByItem,
  invalidateListings,
  removeListingFromMirror,
  endLiveListing,
  refreshAccount,
  markAccountStale,
  syncAccount,
  applySale,
  applyNewOrder,
  applyListingChanges,
  enableNotifications,
  listOrdersDetailed,
  awaitingDelivery,
  forgetMarketScopes,
  accountSites,
  ordersInRange,
  syncOrderFinances,
  classifyOrderStatus,
  setDeliveryCheckInterval,
  getEarningsSummary,
  resolveRangeWindow,
};
