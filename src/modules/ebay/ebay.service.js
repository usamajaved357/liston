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

async function createOfferWithRetry(accessToken, offerInput, attempts = 4, delayMs = 2000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await ebayClient.createOffer(accessToken, offerInput);
    } catch (err) {
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

function buildInventoryItem({ title, description, imageUrls, aspects, condition, quantity }) {
  return {
    availability: {
      shipToLocationAvailability: { quantity },
    },
    condition: condition || 'NEW',
    product: {
      title,
      description: plainDescription(description),
      imageUrls,
      aspects,
    },
  };
}

function buildOffer({ sku, marketplaceId, categoryId, description, listingDescription, price, merchantLocationKey, quantity, listingPolicies }) {
  return {
    sku,
    marketplaceId: marketplaceId || 'EBAY_GB',
    format: 'FIXED_PRICE',
    availableQuantity: quantity,
    categoryId,
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

async function draftVariationListing(credentials, { groupKey, commonTitle, commonDescription, commonListingDescription, imageUrls, variesBy, variants, marketplaceId, categoryId, merchantLocationKey, locationInput, listingPolicies }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);

  ensureListingPolicies(listingPolicies);
  await ensureInventoryLocation(accessToken, merchantLocationKey, locationInput);

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
      }),
      marketplaceId
    );
    const offer = await createOfferWithRetry(
      accessToken,
      buildOffer({
        sku: variant.sku,
        marketplaceId,
        categoryId,
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
async function listActiveListings(credentials, opts) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const result = await ebayTrading.getActiveListings(accessToken, opts);
  return { ...result, credentialsChanged, credentials: refreshedCredentials };
}

async function getStoreProfile(credentials) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const profile = await ebayTrading.getStoreProfile(accessToken);
  return { ...profile, credentialsChanged, credentials: refreshedCredentials };
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

// Fetches every order in a <=90-day window (paging through all of them) as
// full mapped objects — used by the Orders page, which needs to classify,
// search and paginate itself since eBay's OrderStatus filter doesn't cover
// the payment/dispatch distinctions the UI shows.
async function fetchAllOrdersInWindow(accessToken, createTimeFrom, createTimeTo) {
  let pageNumber = 1;
  const all = [];
  for (;;) {
    const { orders, totalPages } = await ebayTrading.getOrders(accessToken, {
      createTimeFrom,
      createTimeTo,
      pageNumber,
      entriesPerPage: MAX_ORDER_PAGE_SIZE,
    });
    all.push(...orders);
    if (orders.length === 0 || pageNumber >= totalPages) break;
    pageNumber += 1;
  }
  return all;
}

// Switching status tab, page, or search on the Orders page all re-derive
// from the same underlying order set for a given (connection, range) — with
// no cache, each of those was a full eBay refetch (2+ GetOrders calls plus
// up to `perPage` GetItem calls), which is what made the UI feel like it
// hung. These are process-local, short-lived caches — fine for a
// single-instance deployment; would need a shared store (Redis) once this
// runs on more than one process.
const ordersWindowCache = new Map(); // `${connectionId}:${range}` -> { fetchedAt, orders }
const ORDERS_CACHE_TTL_MS = 60 * 1000;

const itemSummaryCache = new Map(); // itemId -> { fetchedAt, summary }
const ITEM_SUMMARY_CACHE_TTL_MS = 10 * 60 * 1000;

async function getOrdersWindowCached(connectionId, accessToken, range, start, end) {
  const key = `${connectionId}:${range}`;
  const cached = ordersWindowCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ORDERS_CACHE_TTL_MS) {
    return cached.orders;
  }
  const orders = await fetchAllOrdersInWindow(accessToken, start.toISOString(), end.toISOString());
  ordersWindowCache.set(key, { fetchedAt: Date.now(), orders });
  return orders;
}

async function getItemSummaryCached(accessToken, itemId) {
  const cached = itemSummaryCache.get(itemId);
  if (cached && Date.now() - cached.fetchedAt < ITEM_SUMMARY_CACHE_TTL_MS) {
    return cached.summary;
  }
  const summary = await ebayTrading.getItemSummary(accessToken, itemId).catch(() => null);
  if (summary) itemSummaryCache.set(itemId, { fetchedAt: Date.now(), summary });
  return summary;
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
async function listOrdersDetailed(credentials, { connectionId, range, status, search, page = 1, perPage = 25 }) {
  const { accessToken, credentials: refreshedCredentials, credentialsChanged } = await ensureValidAccessToken(credentials);
  const [start, end] = resolveRangeWindow(range);
  const rawOrders = await getOrdersWindowCached(connectionId, accessToken, range, start, end);

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
  const summaries = await Promise.all(uniqueItemIds.map((itemId) => getItemSummaryCached(accessToken, itemId)));
  const summaryByItemId = new Map(summaries.filter(Boolean).map((s) => [s.itemId, s]));

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
  createOfferWithRetry,
  buildInventoryItem,
  buildOffer,
  draftListing,
  draftVariationListing,
  getBusinessPolicies,
  getMerchantLocations,
  publishDraft,
  publishGroup,
  withdrawDraft,
  listActiveListings,
  getStoreProfile,
  listUnsoldListings,
  listOrders,
  listOrdersDetailed,
  getEarningsSummary,
  resolveRangeWindow,
};
