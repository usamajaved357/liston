// Self-contained: see the identical rationale/constraint at the top of
// ./ebay.js — this function is serialized and re-executed inside a page
// context by both the Playwright scraper and the browser extension, so it
// must have no outer-scope references. Unlike eBay, AliExpress has no
// cross-origin iframe involved anywhere in this extraction, so this ports
// with full parity (description included).
async function extractAliexpressFields() {
  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const FIELD_TIMEOUT_MS = 4000;

  // AliExpress renders its product data client-side well after the initial
  // page load — give it a moment to hydrate (up to 15s) before reading
  // anything, polling for the second (real, visible) h1 to show up.
  const hydrationStart = Date.now();
  while (document.querySelectorAll('h1').length < 2 && Date.now() - hydrationStart < 15000) {
    await wait(200);
  }

  const title =
    [...document.querySelectorAll('h1')].find((el) => el.offsetParent !== null)?.textContent?.trim() || null;

  if (!title) {
    return { title: null, priceText: null, description: null, imageUrls: [], specifics: {}, variantGroups: [] };
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

  const priceText = await pollFor(
    () => document.querySelector('[class*="price-default--current"]')?.textContent,
    FIELD_TIMEOUT_MS
  );

  const description = await pollFor(
    () => document.querySelector('[class*="ai-overview"], [class*="description"]')?.textContent,
    FIELD_TIMEOUT_MS
  );

  // The main gallery: every image nested under the wrapper that holds the
  // zoomable main product photo (identified by its stable "magnifier--image"
  // class fragment), rather than a fixed DOM-depth walk.
  const imageUrls = (() => {
    const mainImg = document.querySelector('[class*="magnifier--image"]');
    if (!mainImg) return [];
    let el = mainImg;
    for (let i = 0; i < 8 && el; i++) {
      const imgs = el.querySelectorAll('img');
      if (imgs.length >= 2) return [...new Set([...imgs].map((img) => img.src).filter(Boolean))];
      el = el.parentElement;
    }
    return mainImg.src ? [mainImg.src] : [];
  })();

  const specifics = (() => {
    const result = {};
    const lines = document.querySelectorAll('[class*="specification--line"]');
    for (const line of lines) {
      for (const prop of line.querySelectorAll('[class*="specification--prop"]')) {
        const label = prop.querySelector('[class*="specification--title"]')?.textContent?.trim();
        const value = prop.querySelector('[class*="specification--desc"]')?.textContent?.trim();
        if (label && value) result[label] = value;
      }
    }
    return result;
  })();

  // Variant groups: swatches are grouped by the numeric prefix of their
  // `data-sku-col` attribute (e.g. "14-496" -> row "14"), which reliably
  // separates independent variant axes (colour vs. model vs. size)
  // regardless of how they're nested in the DOM.
  const variantGroups = (() => {
    const titleEls = document.querySelectorAll('[class*="sku-item--title"]');
    const labels = [...titleEls].map((el) => el.textContent.trim().split(':')[0].trim());
    const rows = {};
    const rowOrder = [];
    for (const swatch of document.querySelectorAll('[data-sku-col]')) {
      const rowId = swatch.getAttribute('data-sku-col').split('-')[0];
      if (!rows[rowId]) {
        rows[rowId] = [];
        rowOrder.push(rowId);
      }
      const img = swatch.querySelector('img');
      const label = swatch.getAttribute('title') || (img?.alt && !/^\d+$/.test(img.alt) ? img.alt : null);
      rows[rowId].push({ label: label || `Option ${rows[rowId].length + 1}`, imageUrl: img?.src || null });
    }
    return rowOrder.map((rowId, i) => ({ name: labels[i] || null, options: rows[rowId] }));
  })();

  return { title, priceText, description, imageUrls, specifics, variantGroups };
}

if (typeof module !== 'undefined') {
  module.exports = { extractAliexpressFields };
}
