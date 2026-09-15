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

  // EVERY selectable property is a real purchasable axis, not just the first.
  //
  // An earlier version kept only the first group and folded the rest into
  // `specifics` as text, on the mistaken belief that eBay's Inventory API
  // supports one varying aspect per group. It doesn't — `variesBy.specifications`
  // is a list, and eBay handles multi-axis variations fine. The cost of that
  // mistake was concrete: a fitted iPhone case drafted as 6 colours with a
  // "fits 26 models" aspect, so a buyer had no way to say which phone they
  // owned. Dropping an axis doesn't simplify a listing, it breaks it.
  const groups = (variantGroups || []).filter((group) => group?.options?.length);
  const variants = buildVariantMatrix(groups);

  return {
    sourceUrl: null,
    title: title.trim(),
    description: (description || '').trim(),
    imageUrls: (imageUrls || []).map(upscaleImage),
    priceText: priceText || null,
    specifics: { ...(specifics || {}) },
    categoryBreadcrumb: [],
    variants,
    // The axes, in the supplier's own order, so the caller can describe the
    // variation structure to eBay without re-deriving it from the variants.
    variantAxes: groups.map((group, index) => ({
      name: group.name || `Option ${index + 1}`,
      values: group.options.map((option, i) => option.label || `Option ${i + 1}`),
      // Only some axes carry a distinct photo per option (colour usually
      // does, size never does). This is what decides eBay's
      // `aspectsImageVariesBy`, and it also keeps image work proportional to
      // the number of distinct photos rather than the size of the matrix.
      hasImages: group.options.some((option) => Boolean(option.imageUrl)),
    })),
  };
}

// eBay caps variations per listing at 250. Well before that, every extra
// variant is another inventory-item API call at draft time, so a 6x27 matrix
// would be both slow and mostly unsellable stock — capped, and the caller
// reports the trim rather than silently losing options.
const MAX_VARIANTS = 120;

// The cartesian product of every axis: Colour x Model x Size. Combinations
// are unique by construction, which also satisfies eBay's requirement that
// no two variations share the same aspect values.
function buildVariantMatrix(groups) {
  if (!groups.length) return [];

  let combos = [{ attributes: {}, imageUrl: null }];

  for (const [index, group] of groups.entries()) {
    const axisName = group.name || `Option ${index + 1}`;
    const next = [];
    for (const combo of combos) {
      for (const [optionIndex, option] of group.options.entries()) {
        next.push({
          attributes: { ...combo.attributes, [axisName]: option.label || `Option ${optionIndex + 1}` },
          // The first axis that supplies a photo for this combination wins;
          // a later axis without photos can't blank one already found.
          imageUrl: combo.imageUrl || upscaleImage(option.imageUrl) || null,
        });
      }
    }
    combos = next;
  }

  // Trim to WHOLE rows of the first axis. A flat slice cuts mid-row, which
  // on a real product left one colour offering only 12 of 27 phone models —
  // a buyer picks that colour and can't find their phone, which looks broken
  // rather than merely limited. Better to offer four complete colours than
  // four and a half.
  if (combos.length > MAX_VARIANTS) {
    const rowSize = groups.slice(1).reduce((total, group) => total * group.options.length, 1);
    const wholeRows = Math.max(1, Math.floor(MAX_VARIANTS / rowSize));
    combos = combos.slice(0, Math.min(combos.length, wholeRows * rowSize));
  }

  return combos.map((combo) => ({ ...combo, priceText: null }));
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

module.exports = { scrapeListing, normalize, buildVariantMatrix, MAX_VARIANTS };
