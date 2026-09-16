const { apiBaseUrl } = require('./ebay.oauth');
const { getApplicationToken } = require('./ebay.app-token');

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
async function request(path, params, marketplaceId) {
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
      throw new EbayBrowseError('eBay took too long to respond — try again in a moment.', 504);
    }
    throw err;
  }

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
  return request('/buy/browse/v1/item/get_item_by_legacy_id', { legacy_item_id: legacyItemId }, marketplaceId);
}

// Every variation of a multi-variation listing, each with its own price,
// image and aspects. For a seller-defined variation listing eBay accepts the
// parent's legacy item id as the group id (verified live: 133 variants back
// for a Fruit of the Loom t-shirt listing).
function getItemsByItemGroup(itemGroupId, marketplaceId) {
  return request('/buy/browse/v1/item/get_items_by_item_group', { item_group_id: itemGroupId }, marketplaceId);
}

function searchItemSummaries({ q, limit = 25, filter }, marketplaceId) {
  return request(
    '/buy/browse/v1/item_summary/search',
    { q, limit, ...(filter ? { filter } : {}) },
    marketplaceId
  );
}

module.exports = {
  EbayBrowseError,
  getItemByLegacyId,
  getItemsByItemGroup,
  searchItemSummaries,
};
