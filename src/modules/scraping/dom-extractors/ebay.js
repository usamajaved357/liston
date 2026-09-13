// Self-contained: this function is serialized and re-executed inside a page
// context by BOTH the Playwright scraper (`page.evaluate`) and the browser
// extension (`chrome.scripting.executeScript`) — one source of truth for
// eBay's DOM structure instead of two copies that can silently drift apart.
// It must have NO references to anything outside its own body (no closures,
// no imports) since both callers re-invoke it fresh in the target page.
//
// NOTE: deliberately does NOT extract the item description — eBay serves it
// from a cross-origin iframe (itm.ebaydesc.com), which Playwright can read
// via its own multi-frame access (see ebay-listing.scraper.js) but a plain
// in-page function cannot (same-origin browser restriction, not a bug here).
// The Node scraper adds description as a separate Playwright-only step; the
// browser extension simply doesn't have it.
async function extractEbayFields() {
  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function pollFor(fn, timeoutMs, intervalMs = 200) {
    const start = Date.now();
    let value = fn();
    while (!value && Date.now() - start < timeoutMs) {
      await wait(intervalMs);
      value = fn();
    }
    return value;
  }

  const FIELD_TIMEOUT_MS = 4000;

  const title = (await pollFor(() => document.querySelector('h1')?.textContent, FIELD_TIMEOUT_MS)) || null;

  if (!title) {
    return {
      title: null,
      priceText: null,
      imageUrls: [],
      specifics: {},
      categoryBreadcrumb: [],
      categoryId: null,
    };
  }

  const priceText = document.querySelector('[data-testid="x-price-section"]')?.textContent || null;

  const imageUrls = (() => {
    const imgs = document.querySelectorAll('[data-testid="ux-image-carousel-container"] img');
    const seen = new Set();
    const urls = [];
    for (const img of imgs) {
      if (!img.src) continue;
      // eBay serves the same image at several sizes (s-l300, s-l1600, ...)
      // under a shared id in the path — dedupe by that id, keep the largest.
      const id = img.src.replace(/\/s-l\d+(\.\w+)?$/, '');
      if (seen.has(id)) continue;
      seen.add(id);
      urls.push(img.src.replace(/\/s-l\d+(\.\w+)?$/, '/s-l1600$1'));
    }
    return urls;
  })();

  const specifics = (() => {
    const result = {};
    const lists = document.querySelectorAll('dl[data-testid="ux-layout-section-evo__item"]');
    for (const dl of lists) {
      const labels = dl.querySelectorAll('dt.ux-labels-values__labels');
      const values = dl.querySelectorAll('dd.ux-labels-values__values');
      labels.forEach((dt, i) => {
        const label = dt.textContent?.trim();
        const value = values[i]?.textContent?.trim();
        if (label && value) result[label] = value;
      });
    }
    return result;
  })();

  const categoryBreadcrumb = [...document.querySelectorAll('[data-testid="x-breadcrumb"] .seo-breadcrumb-text')]
    .map((el) => el.textContent.trim())
    .filter(Boolean);

  // The description iframe's src carries eBay's real numeric category id as
  // a query param (?category=20349) — reading the element's own `src`
  // attribute from the parent document is fine (only its *contentDocument*
  // is cross-origin-restricted).
  const categoryId = document.querySelector('#desc_ifr')?.getAttribute('src')?.match(/[?&]category=(\d+)/)?.[1] || null;

  return { title, priceText, imageUrls, specifics, categoryBreadcrumb, categoryId };
}

if (typeof module !== 'undefined') {
  module.exports = { extractEbayFields };
}
