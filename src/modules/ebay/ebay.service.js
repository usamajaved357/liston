const ebayClient = require('./ebay.client');
const ebayOauth = require('./ebay.oauth');
const ebayTrading = require('./ebay.trading');

class EbayError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000; // refresh a bit before actual expiry

// Returns a valid access token for this connection, refreshing it first if
// it's expired or close to it. When a refresh happens, `credentialsChanged`
// is true and `credentials` holds the updated values — the caller (which
// owns the DB write) must persist them via connectionService, since this
// module has no knowledge of connection storage.
async function ensureValidAccessToken(credentials) {
  const expiresSoon = !credentials.accessTokenExpiresAt || credentials.accessTokenExpiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS;

  if (!expiresSoon) {
    return { accessToken: credentials.accessToken, credentials, credentialsChanged: false };
  }

  if (!credentials.refreshToken) {
    throw new EbayError('This eBay connection has no refresh token — reconnect the account', 401);
  }

  const refreshed = await ebayOauth.refreshAccessToken(credentials.refreshToken);
  const updatedCredentials = { ...credentials, ...refreshed };
  return { accessToken: refreshed.accessToken, credentials: updatedCredentials, credentialsChanged: true };
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

function buildInventoryItem({ title, description, imageUrls, aspects, condition, quantity }) {
  return {
    availability: {
      shipToLocationAvailability: { quantity },
    },
    condition: condition || 'NEW',
    product: {
      title,
      description,
      imageUrls,
      aspects,
    },
  };
}

function buildOffer({ sku, marketplaceId, categoryId, description, price, merchantLocationKey, quantity }) {
  return {
    sku,
    marketplaceId: marketplaceId || 'EBAY_US',
    format: 'FIXED_PRICE',
    availableQuantity: quantity,
    categoryId,
    listingDescription: description,
    pricingSummary: { price },
    merchantLocationKey,
  };
}

/**
 * Drafts a single (non-variation) listing: creates the inventory item and an
 * unpublished offer. Nothing is live on eBay yet — see publishDraft.
 */
async function draftListing(credentials, input) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);

  await ensureInventoryLocation(accessToken, input.merchantLocationKey, input.locationInput);
  await ebayClient.createOrReplaceInventoryItem(accessToken, input.sku, buildInventoryItem(input));
  const offer = await ebayClient.createOffer(accessToken, buildOffer(input));

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
async function draftVariationListing(credentials, { groupKey, commonTitle, commonDescription, imageUrls, variesBy, variants, marketplaceId, categoryId, merchantLocationKey, locationInput }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);

  await ensureInventoryLocation(accessToken, merchantLocationKey, locationInput);

  const offers = [];
  for (const variant of variants) {
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
      })
    );
    const offer = await ebayClient.createOffer(
      accessToken,
      buildOffer({
        sku: variant.sku,
        marketplaceId,
        categoryId,
        description: commonDescription,
        price: variant.price,
        merchantLocationKey,
        quantity: variant.quantity,
      })
    );
    offers.push({ sku: variant.sku, offerId: offer.offerId });
  }

  await ebayClient.createOrReplaceInventoryItemGroup(accessToken, groupKey, {
    title: commonTitle,
    description: commonDescription,
    imageUrls,
    variantSKUs: variants.map((v) => v.sku),
    variesBy: { aspectsImageVariesBy: variesBy.aspectsImageVariesBy, specifications: variesBy.specifications },
  });

  return {
    groupKey,
    offers,
    status: 'drafted',
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

async function publishDraft(credentials, offerId) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const result = await ebayClient.publishOffer(accessToken, offerId);
  return {
    externalProductId: result.listingId,
    status: 'published',
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

async function publishGroup(credentials, groupKey, marketplaceId) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const result = await ebayClient.publishOfferByInventoryItemGroup(accessToken, groupKey, marketplaceId || 'EBAY_US');
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
async function listActiveListings(credentials, opts) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const result = await ebayTrading.getActiveListings(accessToken, opts);
  return { ...result, credentialsChanged, credentials: refreshedCredentials };
}

async function listUnsoldListings(credentials, opts) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const result = await ebayTrading.getUnsoldListings(accessToken, opts);
  return { ...result, credentialsChanged, credentials: refreshedCredentials };
}

async function listOrders(credentials, opts) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const result = await ebayTrading.getOrders(accessToken, opts);
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

// Sums every order's total within one <=90-day window, paging through all
// results rather than just the first page — a single page undercounts
// earnings whenever a window has more orders than one page holds.
async function sumOrdersInWindow(accessToken, createTimeFrom, createTimeTo) {
  let pageNumber = 1;
  let amount = 0;
  let count = 0;
  let currency = null;

  for (;;) {
    const { orders, totalPages } = await ebayTrading.getOrders(accessToken, {
      createTimeFrom,
      createTimeTo,
      pageNumber,
      entriesPerPage: MAX_ORDER_PAGE_SIZE,
    });
    for (const order of orders) {
      if (order.total) {
        amount += order.total.amount;
        currency = currency || order.total.currency;
      }
    }
    count += orders.length;
    if (orders.length === 0 || pageNumber >= totalPages) break;
    pageNumber += 1;
  }

  return { amount, count, currency };
}

// eBay's GetOrders hard-rejects any CreateTimeFrom older than 90 days —
// there is no pagination or chunking trick around it, confirmed against the
// live API ("Orders older than 90 days cannot be retrieved"). So 'all_time'
// is, honestly, "as far back as eBay lets us look": the last 90 days. The
// `truncated` flag lets the frontend say so instead of implying a true
// lifetime total.
async function getEarningsSummary(credentials, { range, from, to }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);

  const effectiveRange = range === 'all_time' ? '90d' : range;
  const [start, end] = resolveRangeWindow(effectiveRange, from, to);
  const sum = await sumOrdersInWindow(accessToken, start.toISOString(), end.toISOString());

  return {
    earnings: { amount: Math.round(sum.amount * 100) / 100, currency: sum.currency },
    orderCount: sum.count,
    truncated: range === 'all_time',
    credentialsChanged,
    credentials: refreshedCredentials,
  };
}

module.exports = {
  EbayError,
  ensureValidAccessToken,
  draftListing,
  draftVariationListing,
  publishDraft,
  publishGroup,
  withdrawDraft,
  listActiveListings,
  listUnsoldListings,
  listOrders,
  getEarningsSummary,
  resolveRangeWindow,
};
