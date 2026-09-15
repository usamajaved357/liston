const config = require('../../../config');
const scraper = require('../../scraping/aliexpress-listing.scraper');
const dsApi = require('./ds-api');
const { ScrapingError } = require('../../scraping/scraping.errors');

// One way in, two ways underneath. Today everything goes through the browser
// scraper — it works and needs no registration. Once an AliExpress Open
// Platform app is approved, ALIEXPRESS_SOURCE=ds-api switches the whole app
// to the official API with no other code change; both implementations return
// the identical normalized shape.
//
// Contrast with eBay, which has no scraper at all any more: its Browse API is
// open to any developer keyset, so there was never a reason to keep one.

function productIdFromUrl(url) {
  const ref = String(url || '').trim();
  const matched = ref.match(/\/item\/(?:[^/?#]*?)(\d{6,})\.html/) || ref.match(/\/item\/(\d{6,})/);
  if (matched) return matched[1];

  // A bare numeric id is also accepted, which keeps this usable from scripts.
  if (/^\d{6,}$/.test(ref)) return ref;

  throw new ScrapingError(
    "That doesn't look like an AliExpress product URL — it should contain /item/ followed by the product number.",
    { source: 'aliexpress' }
  );
}

async function fetchProduct(url) {
  if (config.aliexpress.source === 'ds-api') {
    return dsApi.fetchProduct(productIdFromUrl(url), url);
  }
  return scraper.scrapeListing(url);
}

module.exports = { fetchProduct, productIdFromUrl };
