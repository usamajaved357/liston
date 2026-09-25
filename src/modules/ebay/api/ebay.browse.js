const { apiBaseUrl } = require('./ebay.oauth');
const { getApplicationToken } = require('./ebay.app-token');
const browseUsage = require('../browse-usage');

class EbayBrowseError extends Error {
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

// Browse is a READ-ONLY public-data API authed with an application token, so
// unlike ebay.client.js's Inventory calls there's no seller, no consent and no
// Content-Language marketplace coupling — only X-EBAY-C-MARKETPLACE-ID, which
// selects which site's catalogue (and currency) we read.
// `callName` is how the admin's usage page lists it; every call is counted
// against the app's daily Browse allowance (browse-usage.js).
async function request(callName, path, params, marketplaceId) {
  const accessToken = await getApplicationToken();
  const query = new URLSearchParams(params).toString();
  const url = `${apiBaseUrl()}${path}${query ? `?${query}` : ''}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new EbayBrowseError('eBay took too long to respond. Try again in a moment.', 504);
    }
    throw err;
  }

  browseUsage.record(callName, { rateLimited: res.status === 429 });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = data.errors?.[0];
    throw new EbayBrowseError(error?.message || `eBay Browse request failed (${res.status})`, 502, {
      status: res.status,
      errorId: error?.errorId,
      longMessage: error?.longMessage,
    });
  }
  return data;
}

// The numeric id in an /itm/ URL is the LEGACY item id (the one buyers see),
// not the Browse "v1|...|..." RESTful id — hence the dedicated endpoint.
function getItemByLegacyId(legacyItemId, marketplaceId) {
  return request('getItemByLegacyId', '/buy/browse/v1/item/get_item_by_legacy_id', { legacy_item_id: legacyItemId }, marketplaceId);
}

// Every variation of a multi-variation listing, each with its own price,
// image and aspects. For a seller-defined variation listing eBay accepts the
// parent's legacy item id as the group id (verified live: 133 variants back
// for a Fruit of the Loom t-shirt listing).
function getItemsByItemGroup(itemGroupId, marketplaceId) {
  return request('getItemsByItemGroup', '/buy/browse/v1/item/get_items_by_item_group', { item_group_id: itemGroupId }, marketplaceId);
}

// fieldgroups "MATCHING_ITEMS,ASPECT_REFINEMENTS" adds, in the same call,
// how the results split by category and by item specific (Brand included).
function searchItemSummaries({ q, limit = 25, offset, filter, categoryIds, sort, fieldgroups }, marketplaceId) {
  return request(
    'search',
    '/buy/browse/v1/item_summary/search',
    {
      q,
      limit,
      ...(offset ? { offset } : {}),
      ...(filter ? { filter } : {}),
      ...(categoryIds ? { category_ids: categoryIds } : {}),
      ...(sort ? { sort } : {}),
      ...(fieldgroups ? { fieldgroups } : {}),
    },
    marketplaceId
  );
}

// One listing (or one variation of one) by its RESTful id, "v1|123|0". Its
// estimatedAvailabilities carry eBay's count of how many have sold.
// (The bulk version, getItems, is a restricted API this app can't use.)
function getItem(itemId, marketplaceId) {
  return request('getItem', `/buy/browse/v1/item/${encodeURIComponent(itemId)}`, {}, marketplaceId);
}

module.exports = {
  EbayBrowseError,
  getItemByLegacyId,
  getItemsByItemGroup,
  searchItemSummaries,
  getItem,
};
