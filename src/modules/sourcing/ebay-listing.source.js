const browse = require('../ebay/api/ebay.browse');
const { ScrapingError } = require('../scraping/scraping.errors');

const DEFAULT_MARKETPLACE = 'EBAY_GB';

// eBay signals "this id is a multi-variation parent, ask the group endpoint
// instead" with this specific error rather than an empty result — so the
// single/group dispatch is driven by eBay's own answer, not by guessing from
// the URL or from a field that may or may not be present.
const ITEM_IS_A_GROUP = 11006;

// A buyer-facing eBay URL carries the LEGACY item id: ebay.co.uk/itm/1234...,
// sometimes with a slug segment first (/itm/some-title/1234...). Take the last
// numeric run so both shapes work.
function legacyItemIdFromUrl(url) {
  const matches = String(url || '').match(/\/itm\/(?:[^/?#]+\/)?(\d{6,})/);
  if (!matches) {
    throw new ScrapingError(
      "That doesn't look like an eBay listing URL — it should contain /itm/ followed by the item number.",
      { source: 'ebay' }
    );
  }
  return matches[1];
}

function imagesOf(item) {
  const urls = [];
  if (item.image?.imageUrl) urls.push(item.image.imageUrl);
  for (const extra of item.additionalImages || []) {
    if (extra.imageUrl && !urls.includes(extra.imageUrl)) urls.push(extra.imageUrl);
  }
  return urls;
}

function specificsOf(item) {
  const specifics = {};
  for (const aspect of item.localizedAspects || []) {
    if (aspect.name && aspect.value && !(aspect.name in specifics)) {
      specifics[aspect.name] = aspect.value;
    }
  }
  return specifics;
}

// Browse returns the seller's description as the raw HTML blob they wrote
// (tables, inline styles, the lot). The AI only ever reads it as reference
// prose, so flatten it to text rather than feeding it markup.
function plainText(html) {
  return String(html || '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function priceTextOf(item) {
  if (!item.price?.value) return null;
  return `${item.price.currency || ''} ${item.price.value}`.trim();
}

const money = (node) => (node && node.value !== undefined && node.value !== null && node.value !== '' ? Number(node.value) : null);

// How many eBay says this listing (or one variation of it) has sold, and has
// left: null when eBay didn't say.
function soldOf(item) {
  const counts = (item.estimatedAvailabilities || []).map((a) => a.estimatedSoldQuantity).filter((n) => n !== undefined && n !== null);
  return counts.length ? counts.reduce((sum, n) => sum + (Number(n) || 0), 0) : null;
}
function availableOf(item) {
  const counts = (item.estimatedAvailabilities || []).map((a) => a.estimatedAvailableQuantity).filter((n) => n !== undefined && n !== null);
  return counts.length ? counts.reduce((sum, n) => sum + (Number(n) || 0), 0) : null;
}

// The first postage option a buyer on the site sees: what it costs and
// eBay's delivery estimate.
function postageOf(item) {
  const ship = (item.shippingOptions || [])[0];
  if (!ship) return null;
  return {
    cost: money(ship.shippingCost) ?? 0,
    service: ship.type || ship.shippingServiceCode || null,
    minDate: ship.minEstimatedDeliveryDate || ship.maxEstimatedDeliveryDate || null,
    maxDate: ship.maxEstimatedDeliveryDate || ship.minEstimatedDeliveryDate || null,
  };
}

// Who sells it, as buyers see it. The seller's legal details eBay also
// sends (name, address, email) are left behind.
function sellerOf(item) {
  const s = item.seller;
  if (!s) return null;
  return {
    username: s.username || null,
    feedbackScore: s.feedbackScore ?? null,
    feedbackPercentage: s.feedbackPercentage ? Number(s.feedbackPercentage) : null,
    business: s.sellerAccountType === 'BUSINESS',
  };
}

// categoryPath is pipe-delimited, broadest first:
// "Clothes, Shoes & Accessories|Men|Men's Clothing|Shirts & Tops|T-Shirts"
function breadcrumbOf(item) {
  return (item.categoryPath || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
}

// An aspect that holds the same value on every variation is a property of the
// product (Material, Brand); one that differs is a variation axis (Colour,
// Size). Diffing the group's items is the only way to tell them apart —
// eBay's group payload doesn't label the axes itself.
function varyingAspectNames(items) {
  const values = new Map();
  for (const item of items) {
    for (const aspect of item.localizedAspects || []) {
      if (!aspect.name || !aspect.value) continue;
      if (!values.has(aspect.name)) values.set(aspect.name, new Set());
      values.get(aspect.name).add(aspect.value);
    }
  }
  return [...values.entries()].filter(([, set]) => set.size > 1).map(([name]) => name);
}

function normalizeSingle(item, url) {
  return {
    sourceUrl: url,
    title: (item.title || '').trim(),
    description: plainText(item.description || item.shortDescription),
    // Competitor photos are REFERENCE ONLY and deliberately never land in an
    // `imageUrls` field: the image pipeline reads `imageUrls`, so there is no
    // code path by which a competitor's photo can reach a publish payload.
    // Listing someone else's photos is an eBay policy violation and a
    // copyright problem — this makes it structurally impossible rather than
    // a rule someone has to remember.
    referenceImages: imagesOf(item),
    priceText: priceTextOf(item),
    specifics: specificsOf(item),
    categoryBreadcrumb: breadcrumbOf(item),
    // eBay's real numeric leaf category id. Previously the AI had to guess
    // this from a breadcrumb; Browse returns it authoritatively.
    categoryId: item.categoryId || null,
    // What sells and how fast (product hunting): eBay's sold count, what's
    // left, the postage a buyer pays, who sells it and since when.
    legacyItemId: item.legacyItemId || null,
    url: item.itemWebUrl ? item.itemWebUrl.split('?')[0] : null,
    sold: soldOf(item),
    available: availableOf(item),
    postage: postageOf(item),
    seller: sellerOf(item),
    createdAt: item.itemCreationDate || item.itemOriginDate || null,
    location: item.itemLocation?.country ? { country: item.itemLocation.country } : null,
    variants: [],
  };
}

function normalizeGroup(group, url) {
  const items = group.items || [];
  if (!items.length) {
    throw new ScrapingError("That eBay listing's variations couldn't be read. Try a different listing.", {
      source: 'ebay',
    });
  }

  const [first] = items;
  const axes = varyingAspectNames(items);
  const base = normalizeSingle(first, url);

  const sold = items.map(soldOf).filter((n) => n !== null);
  const available = items.map(availableOf).filter((n) => n !== null);
  const created = items.map((item) => item.itemCreationDate).filter(Boolean).sort();
  return {
    ...base,
    sold: sold.length ? sold.reduce((sum, n) => sum + n, 0) : null,
    available: available.length ? available.reduce((sum, n) => sum + n, 0) : null,
    createdAt: created[0] || base.createdAt,
    title: (group.title || first.title || '').trim(),
    description: plainText(group.commonDescriptions?.[0]?.description) || base.description,
    // Aspects that vary belong to the variants, not to the parent product.
    specifics: Object.fromEntries(Object.entries(base.specifics).filter(([name]) => !axes.includes(name))),
    variants: items.map((item) => ({
      attributes: Object.fromEntries(
        (item.localizedAspects || [])
          .filter((aspect) => axes.includes(aspect.name))
          .map((aspect) => [aspect.name, aspect.value])
      ),
      imageUrl: item.image?.imageUrl || null,
      priceText: priceTextOf(item),
      sold: soldOf(item),
      available: availableOf(item),
      postageCost: postageOf(item)?.cost ?? null,
    })),
  };
}

// Replaces the old Playwright scraper entirely. Same output contract (plus
// `referenceImages` in place of `imageUrls`, and real competitor variants),
// but it's an official read-only API call: ~0.5s instead of ~7s, and nothing
// to be blocked by — reading public listings needs no seller's consent.
async function fetchListing(url, marketplaceId = DEFAULT_MARKETPLACE) {
  const legacyItemId = legacyItemIdFromUrl(url);

  let item;
  try {
    item = await browse.getItemByLegacyId(legacyItemId, marketplaceId);
  } catch (err) {
    if (err.details?.errorId === ITEM_IS_A_GROUP) {
      const group = await browse.getItemsByItemGroup(legacyItemId, marketplaceId);
      return normalizeGroup(group, url);
    }
    if (err.details?.status === 404) {
      throw new ScrapingError(
        "That eBay listing couldn't be found — it may have ended or been removed.",
        { source: 'ebay' }
      );
    }
    throw err;
  }

  if (!item.title) {
    throw new ScrapingError("This doesn't look like a live eBay listing. It may have ended or been removed.", {
      source: 'ebay',
    });
  }

  return normalizeSingle(item, url);
}

module.exports = {
  fetchListing,
  legacyItemIdFromUrl,
  normalizeSingle,
  normalizeGroup,
  varyingAspectNames,
};
