const insights = require('./api/ebay.marketplace-insights');

// What sold for a search in the last 90 days, from eBay's Marketplace
// Insights API: each listing with its last sold price, how many sold and
// when. { available: false } while eBay hasn't granted the app the API.
// Kept an hour in memory, like a Browse search; nothing is stored.

const TTL_MS = 60 * 60 * 1000;
const LIMIT = 200;
const kept = new Map(); // key -> { at, value }

const legacyIdOf = (itemId) => (/^v1\|(\d+)\|/.exec(String(itemId || '')) || [])[1] || null;
const money = (m) => (m && m.value !== undefined && m.value !== null ? Number(m.value) : null);

function mapSale(s) {
  const shipping = (s.shippingOptions || [])[0]?.shippingCost;
  return {
    itemId: s.itemId || null,
    legacyItemId: s.legacyItemId ? String(s.legacyItemId) : legacyIdOf(s.itemId),
    title: s.title || null,
    image: s.image?.imageUrl || null,
    url: s.itemWebUrl || null,
    price: money(s.lastSoldPrice),
    shipping: money(shipping),
    currency: s.lastSoldPrice?.currency || null,
    sold: s.totalSoldQuantity !== undefined ? Number(s.totalSoldQuantity) : null,
    lastSoldAt: s.lastSoldDate || null,
    condition: s.condition || null,
    seller: s.seller?.username || null,
    country: s.itemLocation?.country || null,
  };
}

async function soldListings({ q, marketplaceId, condition, minPrice, maxPrice }) {
  const filters = [];
  if (condition === 'new') filters.push('conditions:{NEW}');
  if (condition === 'used') filters.push('conditions:{USED}');
  if (minPrice || maxPrice) {
    const currency = { EBAY_GB: 'GBP', EBAY_US: 'USD', EBAY_AU: 'AUD', EBAY_CA: 'CAD' }[marketplaceId] || 'EUR';
    filters.push(`price:[${minPrice || ''}..${maxPrice || ''}]`, `priceCurrency:${currency}`);
  }
  const key = JSON.stringify([marketplaceId, q.toLowerCase(), filters]);
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const res = await insights.searchItemSales({ q, filter: filters.join(',') || undefined, limit: LIMIT }, marketplaceId);
  if (!res) return { available: false };
  const value = { available: true, total: Number(res.total || 0), items: (res.itemSales || []).map(mapSale) };
  kept.set(key, { at: Date.now(), value });
  return value;
}

/** Test hook. */
function forget() {
  kept.clear();
  insights.forget();
}

module.exports = { soldListings, mapSale, forget };
