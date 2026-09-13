const { withPage } = require('./browser');
const { ScrapingError } = require('./scraping.errors');
const { extractAliexpressFields } = require('./dom-extractors/aliexpress');

// Upgrades AliExpress's resized thumbnail URLs (e.g. "...jpg_220x220q75.jpg_.avif")
// to the original file where possible.
function upscaleImage(src) {
  if (!src) return src;
  return src.replace(/_\d+x\d+q\d+\.jpg_\.avif$/, '');
}

// Pure function so it's unit-testable without launching a real browser.
function normalize({ title, priceText, description, imageUrls, specifics, variantGroups }) {
  if (!title) {
    throw new ScrapingError("This doesn't look like a live AliExpress product page — it may have been removed.", {
      source: 'aliexpress',
    });
  }

  // AliExpress often exposes several selectable properties (colour, size,
  // compatible model...). We treat only the FIRST as a real purchasable
  // variation axis (matches how most simple products use it) and fold any
  // others into `specifics` as informational text — eBay's inventory API
  // only cleanly supports one varying aspect per listing group in this flow.
  const [primaryGroup, ...otherGroups] = variantGroups || [];
  const mergedSpecifics = { ...(specifics || {}) };
  for (const group of otherGroups) {
    if (group.name && group.options.length) {
      mergedSpecifics[group.name] = group.options.map((o) => o.label).join(', ');
    }
  }

  const variants = (primaryGroup?.options || []).map((option, index) => ({
    attributes: { [primaryGroup.name || 'Option']: option.label || `Option ${index + 1}` },
    imageUrl: upscaleImage(option.imageUrl) || null,
    priceText: null, // AliExpress per-variant pricing isn't used — see plan decision on flat sellPrice
  }));

  return {
    sourceUrl: null,
    title: title.trim(),
    description: (description || '').trim(),
    imageUrls: (imageUrls || []).map(upscaleImage),
    priceText: priceText || null,
    specifics: mergedSpecifics,
    categoryBreadcrumb: [],
    variants,
  };
}

// Field extraction lives in dom-extractors/aliexpress.js, shared verbatim
// with the browser extension (see Part 4 of the session plan) — one source
// of truth for AliExpress's DOM structure instead of two copies that can
// silently drift apart. Selectors verified live against a real AliExpress
// product page this session (AliExpress's build-hashed class names WILL
// drift over time; this is expected to need occasional upkeep).
async function extractFromPage(page) {
  return page.evaluate(extractAliexpressFields);
}

// Same rationale as the eBay scraper: bot detection can be probabilistic
// even with the stealth plugin, and a fresh browser launch on retry (a new
// fingerprint each time via withPage) has a real chance of getting through.
async function scrapeListing(url, attempts = 3) {
  let raw = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    raw = await withPage(url, extractFromPage, { source: 'aliexpress' });
    if (raw.title) break;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
  return { ...normalize(raw), sourceUrl: url };
}

module.exports = { scrapeListing, normalize };
