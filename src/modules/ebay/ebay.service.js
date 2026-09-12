const ebayClient = require('./ebay.client');
const ebayOauth = require('./ebay.oauth');

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

module.exports = {
  EbayError,
  ensureValidAccessToken,
  draftListing,
  draftVariationListing,
  publishDraft,
  publishGroup,
  withdrawDraft,
};
