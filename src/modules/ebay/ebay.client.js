const { apiBaseUrl } = require('./ebay.oauth');

class EbayApiError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

const REQUEST_TIMEOUT_MS = 20 * 1000;

async function request(accessToken, method, path, body) {
  let res;
  try {
    res = await fetch(`${apiBaseUrl()}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // Both required by eBay's Inventory API on write calls — confirmed live
        // against the real API: omitting Accept-Language (easy to miss, since
        // it's separate from Content-Language) fails every write with
        // errorId 25709 "Invalid value for header Accept-Language."
        'Content-Language': 'en-US',
        'Accept-Language': 'en-US',
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      // Without this, a connection that hangs (rather than returning a fast
      // error) under rate-limiting/throttling stalls indefinitely — confirmed
      // live this session (a request sat for 5+ minutes with no response).
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new EbayApiError('eBay API request timed out — try again in a moment.', 504);
    }
    throw err;
  }

  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.errors?.[0]?.message || `eBay API request failed (${res.status})`;
    throw new EbayApiError(message, 502, data.errors);
  }
  return data;
}

// SKU is the seller's own identifier — inventory items are created/replaced
// idempotently by SKU, independent of any offer or listing.
function createOrReplaceInventoryItem(accessToken, sku, inventoryItem) {
  return request(accessToken, 'PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, inventoryItem);
}

function createOrReplaceInventoryItemGroup(accessToken, groupKey, inventoryItemGroup) {
  return request(
    accessToken,
    'PUT',
    `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
    inventoryItemGroup
  );
}

// Returns { offerId } — this is the "draft": it exists in the seller's
// account but nothing is live until publishOffer is called.
function createOffer(accessToken, offer) {
  return request(accessToken, 'POST', '/sell/inventory/v1/offer', offer);
}

function updateOffer(accessToken, offerId, offer) {
  return request(accessToken, 'PUT', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, offer);
}

// Returns { listingId } — the offer is now a live eBay listing.
function publishOffer(accessToken, offerId) {
  return request(accessToken, 'POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`);
}

function publishOfferByInventoryItemGroup(accessToken, inventoryItemGroupKey, marketplaceId) {
  return request(accessToken, 'POST', '/sell/inventory/v1/offer/publish_by_inventory_item_group', {
    inventoryItemGroupKey,
    marketplaceId,
  });
}

function withdrawOffer(accessToken, offerId) {
  return request(accessToken, 'POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`);
}

function getInventoryLocations(accessToken) {
  return request(accessToken, 'GET', '/sell/inventory/v1/location?limit=50');
}

// An offer can't be published without at least one merchant inventory
// location on the account — this creates one if the seller has none yet.
function createInventoryLocation(accessToken, merchantLocationKey, location) {
  return request(
    accessToken,
    'POST',
    `/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey)}`,
    location
  );
}

// Seller-configured business policies (shipping/handling, payment, returns) —
// an offer can't be published without one of each attached.
function getFulfillmentPolicies(accessToken, marketplaceId) {
  return request(accessToken, 'GET', `/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`);
}

function getPaymentPolicies(accessToken, marketplaceId) {
  return request(accessToken, 'GET', `/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`);
}

function getReturnPolicies(accessToken, marketplaceId) {
  return request(accessToken, 'GET', `/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`);
}

module.exports = {
  EbayApiError,
  createOrReplaceInventoryItem,
  createOrReplaceInventoryItemGroup,
  createOffer,
  updateOffer,
  publishOffer,
  publishOfferByInventoryItemGroup,
  withdrawOffer,
  getInventoryLocations,
  createInventoryLocation,
  getFulfillmentPolicies,
  getPaymentPolicies,
  getReturnPolicies,
};
