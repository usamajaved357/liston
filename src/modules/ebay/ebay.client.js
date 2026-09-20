const { apiBaseUrl } = require('./ebay.oauth');
const logger = require('../../utils/logger');

class EbayApiError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    // The message comes from eBay's own errors[].message — safe and useful
    // to show the seller, rather than being masked as an internal error.
    this.expose = true;
  }
}

const REQUEST_TIMEOUT_MS = 20 * 1000;

// eBay ties a SKU/offer's marketplace visibility to the Content-Language of
// the write calls that created it — confirmed live: creating an inventory
// item + offer with en-US headers made the SKU invisible to EBAY_GB's
// createOffer ("could not be found ... for the marketplace EBAY_GB",
// errorId 25751), while the identical calls with en-GB headers succeeded.
// Same root cause reported by other developers for EBAY_PL/EBAY_DE/EBAY_CA
// (eBay Developer Community). Default to en-US for marketplaces not listed.
const MARKETPLACE_LOCALES = {
  EBAY_US: 'en-US',
  EBAY_GB: 'en-GB',
  EBAY_AU: 'en-AU',
  EBAY_CA: 'en-CA',
  EBAY_IE: 'en-IE',
  EBAY_DE: 'de-DE',
  EBAY_AT: 'de-AT',
  EBAY_CH: 'de-CH',
  EBAY_FR: 'fr-FR',
  EBAY_IT: 'it-IT',
  EBAY_ES: 'es-ES',
  EBAY_NL: 'nl-NL',
  EBAY_BE: 'nl-BE',
  EBAY_PL: 'pl-PL',
};

function localeForMarketplace(marketplaceId) {
  return MARKETPLACE_LOCALES[marketplaceId] || 'en-US';
}

// Options beyond the usual:
//  - headers: extra request headers (Post-Order needs the marketplace id);
//  - authScheme: "Bearer" (REST APIs) or "IAF" (the Post-Order API's name
//    for the same OAuth user token);
//  - signingKey: an eBay signing key ({ jwe, privateKey }) to sign the
//    request with — eBay's digital signatures, which its money-moving calls
//    (Finances API, refunds, cancellations) demand from UK/EU sellers. The
//    signature covers the exact body bytes sent, so it is built here.
async function request(accessToken, method, path, body, marketplaceId, { baseUrl, headers: extraHeaders, authScheme = 'Bearer', signingKey } = {}) {
  const locale = localeForMarketplace(marketplaceId);
  const url = `${baseUrl || apiBaseUrl()}${path}`;
  const payload = body ? JSON.stringify(body) : undefined;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // Both required by eBay's Inventory API on write calls — confirmed live
        // against the real API: omitting Accept-Language (easy to miss, since
        // it's separate from Content-Language) fails every write with
        // errorId 25709 "Invalid value for header Accept-Language." Both must
        // also match the target marketplace's locale (see MARKETPLACE_LOCALES).
        'Content-Language': locale,
        'Accept-Language': locale,
        Accept: 'application/json',
        Authorization: `${authScheme} ${accessToken}`,
        ...(extraHeaders || {}),
        ...(signingKey ? require('./ebay.signature').signatureHeaders({ method, url, body: payload, key: signingKey }) : {}),
      },
      // Without this, a connection that hangs (rather than returning a fast
      // error) under rate-limiting/throttling stalls indefinitely — confirmed
      // live this session (a request sat for 5+ minutes with no response).
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(payload ? { body: payload } : {}),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new EbayApiError('eBay API request timed out. Try again in a moment.', 504);
    }
    throw err;
  }

  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Everything eBay said, in the log: the error id, the long message and
    // the parameters that name the offending field. eBay's short message
    // alone ("The item cannot be listed or modified…") is often too generic
    // to act on.
    logger.warn('eBay API error', {
      method,
      path,
      status: res.status,
      errors: (data.errors || []).map((e) => ({ errorId: e.errorId, message: e.message, longMessage: e.longMessage, parameters: e.parameters })),
    });
    // 403 with eBay's "insufficient permissions" (errorId 1100) means the
    // token lacks the scope this API needs: the seller has to reconnect.
    const scopeMissing = res.status === 403 && (data.errors || []).some((e) => e.errorId === 1100 || /insufficient permissions|scope/i.test(`${e.message} ${e.longMessage}`));
    const err = new EbayApiError(describeErrors(data.errors, res.status), scopeMissing ? 403 : 502, data.errors);
    if (scopeMissing) err.code = 'EBAY_SCOPE_MISSING';
    throw err;
  }
  return data;
}

// One readable line from eBay's errors: the first error's message, its
// parameters when they name the field concerned, and the other errors'
// messages when there are several.
function describeErrors(errors, status) {
  if (!errors?.length) return `eBay API request failed (${status})`;
  const [first, ...rest] = errors;
  const parts = [first.message || first.longMessage || 'eBay rejected the request'];
  const details = readableParameters(first.parameters);
  if (details.length) parts.push(`(${details.join('; ')})`);
  for (const error of rest) if (error.message && error.message !== first.message) parts.push(error.message);
  return parts.join(' ');
}

// eBay's error parameters mix the sentence a seller should read with its
// own template pieces (the same sentence with "{URL0}" unresolved, the rule
// code, the bare URL, the message id in a <font> tag). Keep the sentences,
// with markup stripped, and drop the scaffolding.
function readableParameters(parameters) {
  const seen = new Set();
  const out = [];
  for (const p of parameters || []) {
    if (!p || p.value === undefined || p.value === null) continue;
    const text = String(p.value)
      .replace(/<font[^>]*>\s*\{[^}]*\}\s*<\/font>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || text.includes('{') || /^https?:\/\//i.test(text) || !/\s/.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // A named parameter ("text1: SKU-1") is worth its label; eBay's
    // numbered ones ("0", "1"…) are not.
    out.push(p.name && !/^\d+$/.test(p.name) ? `${p.name}: ${text}` : text);
  }
  return out;
}

// SKU is the seller's own identifier — inventory items are created/replaced
// idempotently by SKU, independent of any offer or listing. `marketplaceId`
// isn't part of the request body (eBay's schema has no such field here) —
// it only controls the Content-Language/Accept-Language headers, which is
// what actually determines which marketplace can later see this SKU.
function createOrReplaceInventoryItem(accessToken, sku, inventoryItem, marketplaceId) {
  return request(
    accessToken,
    'PUT',
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    inventoryItem,
    marketplaceId
  );
}

function createOrReplaceInventoryItemGroup(accessToken, groupKey, inventoryItemGroup, marketplaceId) {
  return request(
    accessToken,
    'PUT',
    `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
    inventoryItemGroup,
    marketplaceId
  );
}

// Returns { offerId } — this is the "draft": it exists in the seller's
// account but nothing is live until publishOffer is called. `offer.marketplaceId`
// is always present in the body already — reused here to pick the matching locale.
function createOffer(accessToken, offer) {
  return request(accessToken, 'POST', '/sell/inventory/v1/offer', offer, offer.marketplaceId);
}

// The unpublished/published offers already on a SKU (eBay allows one per
// marketplace). Used to recover from "offer already exists" on a retry.
function getInventoryItemGroup(accessToken, groupKey) {
  return request(accessToken, 'GET', `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`);
}

function getOffersBySku(accessToken, sku, marketplaceId) {
  return request(accessToken, 'GET', `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`, undefined, marketplaceId);
}

function getOffer(accessToken, offerId) {
  return request(accessToken, 'GET', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
}

function updateOffer(accessToken, offerId, offer) {
  return request(accessToken, 'PUT', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, offer, offer.marketplaceId);
}

// Returns { listingId } — the offer is now a live eBay listing.
function publishOffer(accessToken, offerId, marketplaceId) {
  return request(
    accessToken,
    'POST',
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
    undefined,
    marketplaceId
  );
}

function publishOfferByInventoryItemGroup(accessToken, inventoryItemGroupKey, marketplaceId) {
  return request(
    accessToken,
    'POST',
    '/sell/inventory/v1/offer/publish_by_inventory_item_group',
    { inventoryItemGroupKey, marketplaceId },
    marketplaceId
  );
}

function withdrawOffer(accessToken, offerId) {
  return request(accessToken, 'POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`);
}

function deleteOffer(accessToken, offerId) {
  return request(accessToken, 'DELETE', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
}

function deleteInventoryItem(accessToken, sku) {
  return request(accessToken, 'DELETE', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
}

function deleteInventoryItemGroup(accessToken, groupKey) {
  return request(accessToken, 'DELETE', `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`);
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
  request,
  createOrReplaceInventoryItem,
  createOrReplaceInventoryItemGroup,
  getInventoryItemGroup,
  createOffer,
  getOffersBySku,
  getOffer,
  updateOffer,
  publishOffer,
  publishOfferByInventoryItemGroup,
  withdrawOffer,
  deleteOffer,
  deleteInventoryItem,
  deleteInventoryItemGroup,
  getInventoryLocations,
  createInventoryLocation,
  getFulfillmentPolicies,
  getPaymentPolicies,
  getReturnPolicies,
};
