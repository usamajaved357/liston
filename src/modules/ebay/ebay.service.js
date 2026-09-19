const ebayClient = require('./ebay.client');
const ebayOauth = require('./ebay.oauth');
const ebayTrading = require('./ebay.trading');
const { createSwrCache } = require('./swr-cache');
const mirror = require('./ebay-mirror.repository');
const logger = require('../../utils/logger');
const ebayNotifications = require('./ebay.notifications');
const accountEvents = require('./account-events');
const governor = require('./request-governor');
const marketplaces = require('./marketplaces');

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

  const refreshed = await ebayOauth.refreshAccessToken(credentials.refreshToken);
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

async function publishDraft(credentials, offerId, marketplaceId) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const result = await ebayClient.publishOffer(accessToken, offerId, marketplaceId);
  return {
    externalProductId: result.listingId,
    status: 'published',
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

async function publishGroup(credentials, groupKey, marketplaceId) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const result = await ebayClient.publishOfferByInventoryItemGroup(accessToken, groupKey, marketplaceId || 'EBAY_GB');
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
// An account subscribed to eBay's push notifications (see
// ebay.notifications.js) is told about every change, so it is polled far
// less: the long windows are only a safety net for a missed notification.
const FRESH = {
  listings: 30 * 60 * 1000,
  orders: 10 * 60 * 1000,
  activeCount: 60 * 60 * 1000,
};
// eBay's push arrives within seconds of a change and triggers the re-read
// itself (see syncAccount), so a subscribed account is not polled at all:
// the daily read is only insurance against a notification eBay dropped.
const FRESH_WITH_PUSH = {
  listings: 24 * 60 * 60 * 1000,
  orders: 24 * 60 * 60 * 1000,
  activeCount: 24 * 60 * 60 * 1000,
};
const freshFor = (kind) => (ctx) => (ctx?.push ? FRESH_WITH_PUSH[kind] : FRESH[kind]);

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
  const totalEntries = await activeCountCache.get(`${connectionId}`, { accessToken, siteId, push, connectionId });
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
  const categories = await ebayTrading.getStoreCategories(accessToken, { siteId });
  return { categories, credentialsChanged, credentials: refreshedCredentials };
}

// The Shop's departments change rarely and the Trading call behind them is
// rationed, so one read an hour per account serves the editor, the AI and
// drafting alike. A rationed refusal is reported, not thrown: no Shop
// categories is a valid state.
const storeCategoryCache = new Map(); // connectionId -> { categories, expiresAt }
const STORE_CATEGORY_TTL_MS = 60 * 60 * 1000;
async function getStoreCategoriesCached(credentials, connectionId) {
  const id = String(connectionId);
  const cached = storeCategoryCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return { categories: cached.categories, unavailable: null };
  try {
    const { categories } = await getStoreCategories(credentials);
    storeCategoryCache.set(id, { categories, expiresAt: Date.now() + STORE_CATEGORY_TTL_MS });
    return { categories, unavailable: null };
  } catch (err) {
    if (err.statusCode === 429 || err.code === 'EBAY_BUDGET') return { categories: [], unavailable: err.message };
    throw err;
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

// Resolves a named range (or explicit custom from/to) to a concrete window.
// Returns null for 'all_time', which has no single window — see
// getEarningsSummary, which walks backwards in chunks instead.
function resolveRangeWindow(range, from, to) {
  const now = new Date();
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
const ORDER_SHAPE = 2;

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
      orders = [...byId.values()].filter((o) => new Date(o.createdAt) >= horizon);
      if (changed.length) await persist(() => mirror.upsertOrders(connectionId, changed));
    } else {
      const result = await fetchAllOrdersInWindow(accessToken, horizon.toISOString(), now.toISOString(), meta?.totalPages, siteId);
      orders = result.orders;
      await persist(() => mirror.upsertOrders(connectionId, orders));
      meta = { ...(meta || {}), totalPages: result.totalPages };
    }
    await persist(() => mirror.pruneOrdersBefore(connectionId, horizon));
    return { value: orders, meta: { ...(meta || {}), lastSyncAt: now.toISOString(), shape: ORDER_SHAPE } };
  }
}

function getOrdersLast90Cached(connectionId, accessToken, siteId, push = false) {
  return ordersCache.get(connectionId, { accessToken, siteId, connectionId, push });
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
  let all = await listingsCache.get(listingsKey(connectionId, status), { accessToken, status, siteId, push, connectionId });
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

async function bestSellingListings(credentials, connectionId, { exclude, count = 12, push = false, seed = null } = {}) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const id = String(connectionId);
  const [items, orders] = await Promise.all([
    listingsCache.get(listingsKey(id, 'active'), { accessToken, status: 'active', siteId, push, connectionId: id }),
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
    if (cached && now - cached.fetchedAt < ITEM_SUMMARY_CACHE_TTL_MS) out.set(itemId, cached.summary);
    else missing.push(itemId);
  }
  if (missing.length) {
    const persisted = await mirror.loadItemSummaries(missing).catch(() => new Map());
    for (const itemId of [...missing]) {
      const row = persisted.get(itemId);
      if (row && now - row.fetchedAt < ITEM_SUMMARY_CACHE_TTL_MS) {
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
  return 'dispatched';
}

const ORDER_STATUS_FILTERS = ['awaiting_payment', 'awaiting_dispatch', 'dispatched', 'cancelled'];

/**
 * The Orders page's data source: fetches every order in the range, tags each
 * with a derived status, filters by status/search text, sorts newest first,
 * and paginates in-memory (eBay's own pagination doesn't support these
 * filters) — then enriches only the returned page's line items with a
 * picture + live quantity from GetItem, so we're not fetching images for
 * orders the page never shows.
 */
async function listOrdersDetailed(credentials, { connectionId, range, status, search, page = 1, perPage = 25, push = false }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);
  const [start, end] = resolveRangeWindow(range);
  const rawOrders = ordersWithin(await getOrdersLast90Cached(connectionId, accessToken, siteId, push), start, end);

  const tagged = rawOrders.map((order) => ({ ...order, derivedStatus: classifyOrderStatus(order) }));

  const counts = { all: tagged.length };
  for (const key of ORDER_STATUS_FILTERS) {
    counts[key] = tagged.filter((o) => o.derivedStatus === key).length;
  }

  let filtered = status && status !== 'all' ? tagged.filter((o) => o.derivedStatus === status) : tagged;

  if (search && search.trim()) {
    const needle = search.trim().toLowerCase();
    filtered = filtered.filter(
      (o) =>
        o.orderId.toLowerCase().includes(needle) ||
        o.lineItems.some((li) => (li.title || '').toLowerCase().includes(needle))
    );
  }

  filtered.sort((a, b) => new Date(b.paidTime || b.createdAt) - new Date(a.paidTime || a.createdAt));

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
        imageUrl: summary?.imageUrl || null,
        quantityAvailable: summary?.quantityAvailable ?? null,
        viewItemUrl: summary?.viewItemUrl || null,
      };
    }),
  }));

  return {
    orders: enrichedOrders,
    counts,
    totalEntries,
    totalPages,
    page,
    perPage,
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
async function getEarningsSummary(credentials, { connectionId, range, from, to, push = false }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged, siteId } = await ensureValidAccessToken(credentials);

  const effectiveRange = range === 'all_time' ? '90d' : range;
  const [start, end] = resolveRangeWindow(effectiveRange, from, to);
  const orders = connectionId
    ? ordersWithin(await getOrdersLast90Cached(connectionId, accessToken, siteId, push), start, end)
    : (await fetchAllOrdersInWindow(accessToken, start.toISOString(), end.toISOString(), 1, siteId)).orders;

  let amount = 0;
  let currency = null;
  for (const order of orders) {
    if (order.total) {
      amount += order.total.amount;
      currency = currency || order.total.currency;
    }
  }

  return {
    earnings: { amount: Math.round(amount * 100) / 100, currency },
    orderCount: orders.length,
    truncated: range === 'all_time',
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

// Whether an account gets eBay's push notifications (set by
// scripts/enable-ebay-notifications.js).
function pushEnabled(connection) {
  return Boolean(connection?.settings?.ebay?.notificationsEnabledAt);
}

module.exports = {
  pushEnabled,
  EbayError,
  ensureValidAccessToken,
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
  getStoreCategories,
  getStoreCategoriesCached,
  createMerchantLocation,
  deleteInventoryObjects,
  findLiveListingForSku,
  reviseLiveListing,
  conditionIdFor,
  listListingsDetailed,
  invalidateListings,
  removeListingFromMirror,
  endLiveListing,
  refreshAccount,
  markAccountStale,
  syncAccount,
  applySale,
  enableNotifications,
  listOrdersDetailed,
  getEarningsSummary,
  resolveRangeWindow,
};
