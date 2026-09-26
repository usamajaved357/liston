const { apiBaseUrl } = require('./ebay.oauth');
const { getApplicationToken } = require('./ebay.app-token');

// eBay's Marketplace Insights API: the sales history of items sold on eBay
// in the last 90 days (what eBay's own product research shows). A limited
// release: eBay grants its scope to an app on application. Until it has,
// eBay refuses the scope (invalid_scope) or the call (403), and this client
// answers null, "not granted", rather than an error; it asks again after an
// hour so the day eBay grants it, it starts working without a restart.

const SCOPE = 'https://api.ebay.com/oauth/api_scope/buy.marketplace.insights';
const REQUEST_TIMEOUT_MS = 20 * 1000;
const RECHECK_MS = 60 * 60 * 1000;

class EbayInsightsError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.expose = true;
  }
}

let refusedAt = 0;
const refusedRecently = () => refusedAt && Date.now() - refusedAt < RECHECK_MS;

async function tokenOrNull() {
  if (refusedRecently()) return null;
  try {
    return await getApplicationToken(SCOPE);
  } catch (err) {
    if (err.ebayError === 'invalid_scope') {
      refusedAt = Date.now();
      return null;
    }
    throw err;
  }
}

/**
 * item_sales/search: { itemSales, total, … } for a search, or null when
 * eBay hasn't granted the app this API. `filter` is eBay's filter string
 * (price, conditions…); at most 200 a call.
 */
async function searchItemSales({ q, filter, categoryIds, limit = 200, offset }, marketplaceId) {
  const token = await tokenOrNull();
  if (!token) return null;
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (filter) params.set('filter', filter);
  if (categoryIds) params.set('category_ids', categoryIds);
  if (offset) params.set('offset', String(offset));
  let res;
  try {
    res = await fetch(`${apiBaseUrl()}/buy/marketplace_insights/v1_beta/item_sales/search?${params}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': marketplaceId, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new EbayInsightsError('eBay took too long to respond. Try again in a moment.', 504);
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) {
    refusedAt = Date.now();
    return null;
  }
  if (!res.ok) {
    const error = data.errors?.[0];
    throw new EbayInsightsError(error?.message || `eBay sales history request failed (${res.status})`, 502, { status: res.status, errorId: error?.errorId });
  }
  return data;
}

/** Test hook: forget a refusal. */
function forget() {
  refusedAt = 0;
}

module.exports = { searchItemSales, forget, SCOPE, EbayInsightsError };
