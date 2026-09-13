const { withPage } = require('./browser');
const { ScrapingError } = require('./scraping.errors');
const { extractEbayFields } = require('./dom-extractors/ebay');

// Pure function so it's unit-testable without launching a real browser —
// takes already-extracted raw field values and returns the normalized shape.
function normalize({ title, priceText, description, imageUrls, specifics, categoryBreadcrumb, categoryId }) {
  if (!title) {
    throw new ScrapingError("This doesn't look like a live eBay listing — it may have ended or been removed.", {
      source: 'ebay',
    });
  }

  return {
    sourceUrl: null, // filled in by the caller, which has the original url
    title: title.trim(),
    description: (description || '').replace(/^\(window\.\$ebay.*?pageName:'videsc'\}/, '').trim(),
    imageUrls: imageUrls || [],
    priceText: priceText || null,
    specifics: specifics || {},
    categoryBreadcrumb: categoryBreadcrumb || [],
    // eBay's real numeric leaf category ID — never let the AI guess this,
    // eBay category IDs aren't inferable from a title/breadcrumb and a wrong
    // one gets the offer rejected (or worse, silently mis-categorized).
    categoryId: categoryId || null,
    variants: [],
  };
}

// Field extraction: title/price/images/specifics/breadcrumb/categoryId live
// in dom-extractors/ebay.js, shared verbatim with the browser extension (see
// Part 4 of the session plan) — one source of truth for eBay's DOM
// structure. Description is the one field that stays Playwright-only: it
// lives in a cross-origin iframe (itm.ebaydesc.com) that only Playwright's
// own multi-frame access can read (a same-origin restriction, not something
// a shared plain-DOM function or the extension can work around).
async function extractFromPage(page) {
  const fields = await page.evaluate(extractEbayFields);
  if (!fields.title) return { ...fields, description: null };

  const description = await page
    .locator('#desc_ifr')
    .scrollIntoViewIfNeeded({ timeout: 4000 })
    .then(() => page.waitForTimeout(2500))
    .then(() => page.frameLocator('#desc_ifr').locator('body').first().textContent({ timeout: 4000 }))
    .catch(() => null);

  return { ...fields, description };
}

// eBay's bot detection is probabilistic even with the stealth plugin — the
// same URL can succeed on one attempt and get served a soft "Error Page"
// challenge on the next (confirmed live this session, same listing, back to
// back). A fresh browser launch (a new stealth-patched context/fingerprint
// each time, via withPage) on retry has a real chance of getting through
// rather than being a no-op.
async function scrapeListing(url, attempts = 3) {
  let raw = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    raw = await withPage(url, extractFromPage, { source: 'ebay' });
    if (raw.title) break;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
  return { ...normalize(raw), sourceUrl: url };
}

module.exports = { scrapeListing, normalize };
