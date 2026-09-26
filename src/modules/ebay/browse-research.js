const ebayBrowse = require('./api/ebay.browse');

// Product research reads, through eBay's Browse API (public listing data,
// the app's own token, no seller account): a search's live listings, and a
// listing's sold count. eBay gives the app 5,000 of each a day; the research
// module decides how many of them research may spend.
//
// Not available to this app (eBay answers "Access denied"): Marketplace
// Insights (sold listings, the Terapeak data) and the bulk item read.

const SEARCH_LIMIT = 200; // eBay's page size cap: one call, 200 listings
const SEARCH_TTL_MS = 60 * 60 * 1000;
const SOLD_TTL_MS = 12 * 60 * 60 * 1000;
const searches = new Map(); // key -> { at, value }
const soldCounts = new Map(); // `${marketplaceId}:${itemId}` -> { at, value }

const money = (node) => (node && node.value !== undefined ? Number(node.value) : null);

function mapSummary(s) {
  const ship = (s.shippingOptions || [])[0];
  const shipCost = ship ? money(ship.shippingCost) : null;
  return {
    itemId: s.itemId,
    legacyItemId: s.legacyItemId || null,
    title: s.title || '',
    image: s.image?.imageUrl || s.thumbnailImages?.[0]?.imageUrl || null,
    url: s.itemWebUrl || null,
    price: s.price ? { value: money(s.price), currency: s.price.currency } : null,
    shipping: ship ? { cost: shipCost ?? 0, free: shipCost === 0, type: ship.shippingCostType || null } : null,
    // eBay's delivery window for a buyer on this site (not given for some
    // sellers posting from abroad).
    deliveryDates: ship?.minEstimatedDeliveryDate || ship?.maxEstimatedDeliveryDate ? { min: ship.minEstimatedDeliveryDate || ship.maxEstimatedDeliveryDate, max: ship.maxEstimatedDeliveryDate || ship.minEstimatedDeliveryDate } : null,
    seller: s.seller
      ? { username: s.seller.username, feedbackScore: s.seller.feedbackScore ?? null, feedbackPercentage: s.seller.feedbackPercentage ? Number(s.seller.feedbackPercentage) : null, business: s.seller.sellerAccountType === 'BUSINESS' }
      : null,
    location: s.itemLocation ? { country: s.itemLocation.country || null, postalCode: s.itemLocation.postalCode || null } : null,
    condition: s.condition || null,
    category: s.categories?.[0]?.categoryName || null,
    categoryId: s.categories?.[0]?.categoryId || null,
    createdAt: s.itemCreationDate || s.itemOriginDate || null,
    // Several options (sizes, colours) under one listing: its sold count is
    // the sum across them.
    hasVariations: Boolean(s.itemGroupType),
    topRated: Boolean(s.topRatedBuyingExperience),
    sold: null,
  };
}

/**
 * Up to 200 live fixed-price listings for a search, best match first:
 * { total, items } (total: every listing eBay has for it). Kept an hour, so
 * paging through a result or coming back to it spends no call. `calls` is
 * how many eBay calls this spent (0 from the kept copy).
 */
async function search({ q, marketplaceId, condition, minPrice, maxPrice, country }) {
  const filters = ['buyingOptions:{FIXED_PRICE}'];
  if (condition === 'new') filters.push('conditions:{NEW}');
  if (condition === 'used') filters.push('conditions:{USED}');
  if (minPrice || maxPrice) {
    const currency = { EBAY_GB: 'GBP', EBAY_US: 'USD', EBAY_AU: 'AUD', EBAY_CA: 'CAD' }[marketplaceId] || 'EUR';
    filters.push(`price:[${minPrice || ''}..${maxPrice || ''}]`, `priceCurrency:${currency}`);
  }
  const key = JSON.stringify([marketplaceId, q.toLowerCase(), filters]);
  const kept = searches.get(key);
  if (kept && Date.now() - kept.at < SEARCH_TTL_MS) return { ...kept.value, calls: 0 };
  const params = { q, limit: SEARCH_LIMIT, filter: filters.join(','), deliveryCountry: country || undefined };
  let res;
  let calls = 1;
  try {
    res = await ebayBrowse.searchItemSummaries({ ...params, fieldgroups: 'MATCHING_ITEMS,ASPECT_REFINEMENTS' }, marketplaceId);
  } catch (err) {
    // The breakdown is a nice-to-have: a search eBay won't break down is
    // still worth its listings.
    if (err.details?.status !== 400) throw err;
    res = await ebayBrowse.searchItemSummaries(params, marketplaceId);
    calls = 2;
  }
  const value = { total: Number(res.total || 0), items: (res.itemSummaries || []).map(mapSummary), breakdown: breakdownOf(res.refinement) };
  searches.set(key, { at: Date.now(), value });
  return { ...value, calls };
}

// "Unbranded", "Generic" and the like: listings without a brand to protect.
const NO_BRAND = /^(unbranded|generic|unbranded\/generic|no[ -]?brand|non-branded|does not apply|not applicable|not specified|unspecified|n\/a|none|unknown|ohne marke|markenlos|sans marque|sin marca|senza marca)$/i;

/**
 * How eBay splits every listing for the search (not just the 200 read):
 * { brands: [{ name, count, unbranded }], categories: [{ id, name, count }],
 * categoryId } — the dominant category. Null when eBay sent none.
 */
function breakdownOf(refinement) {
  if (!refinement) return null;
  const brandAspect = (refinement.aspectDistributions || []).find((a) => /^(brand|marke|marque|marca)$/i.test(a.localizedAspectName || ''));
  const brands = (brandAspect?.aspectValueDistributions || [])
    .map((v) => ({ name: v.localizedAspectValue, count: Number(v.matchCount) || 0, unbranded: NO_BRAND.test(String(v.localizedAspectValue || '').trim()) }))
    .filter((b) => b.name)
    .sort((a, b) => b.count - a.count);
  const categories = (refinement.categoryDistributions || [])
    .map((c) => ({ id: String(c.categoryId), name: c.categoryName, count: Number(c.matchCount) || 0 }))
    .sort((a, b) => b.count - a.count);
  return { brands, categories, categoryId: refinement.dominantCategoryId ? String(refinement.dominantCategoryId) : categories[0]?.id || null };
}

/** A sold count already read (and still kept), without a call; else null. */
function keptSold(itemId, marketplaceId) {
  const kept = soldCounts.get(`${marketplaceId}:${itemId}`);
  return kept && Date.now() - kept.at < SOLD_TTL_MS ? kept.value : null;
}

/**
 * How many a listing has sold, per eBay (estimatedSoldQuantity): one call —
 * for a listing with variations, the variation group, summed. Kept 12
 * hours. Resolves to { sold, calls }.
 */
async function soldCount({ itemId, legacyItemId, hasVariations }, marketplaceId) {
  const key = `${marketplaceId}:${itemId}`;
  const kept = soldCounts.get(key);
  if (kept && Date.now() - kept.at < SOLD_TTL_MS) return { sold: kept.value, calls: 0 };
  const soldOf = (item) => (item?.estimatedAvailabilities || []).reduce((sum, a) => sum + (Number(a.estimatedSoldQuantity) || 0), 0);
  let sold;
  if (hasVariations && legacyItemId) {
    const group = await ebayBrowse.getItemsByItemGroup(legacyItemId, marketplaceId);
    sold = (group.items || []).reduce((sum, item) => sum + soldOf(item), 0);
  } else {
    sold = soldOf(await ebayBrowse.getItem(itemId, marketplaceId));
  }
  soldCounts.set(key, { at: Date.now(), value: sold });
  return { sold, calls: 1 };
}

/** Test hook. */
function forget() {
  searches.clear();
  soldCounts.clear();
}

module.exports = { search, soldCount, keptSold, mapSummary, breakdownOf, forget, SEARCH_LIMIT };
