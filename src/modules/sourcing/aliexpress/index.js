const config = require('../../../config');
const scraper = require('../../scraping/aliexpress-listing.scraper');
const dsApi = require('./ds-api');
const { ScrapingError } = require('../../scraping/scraping.errors');
const logger = require('../../../utils/logger');

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

// A Test-status AliExpress app's refresh token dies 48 hours after consent
// (see ds-api.js). When that happens the API can't be used until someone
// re-consents, which is nobody's fault mid-draft: fall back to the browser
// scraper for this read and say plainly what needs doing.
const AUTH_DEAD = /refresh token is invalid|token.*expired|expired and no refresh token|invalid.*access.?token/i;

async function fetchProduct(url, { shipTo, currency } = {}) {
  if (config.aliexpress.source !== 'ds-api') {
    return scraper.scrapeListing(url, 3, { currency, region: shipTo });
  }
  try {
    return await dsApi.fetchProduct(productIdFromUrl(url), url, { shipTo, currency });
  } catch (err) {
    if (!AUTH_DEAD.test(err.message || '')) throw err;
    logger.warn('AliExpress API authorisation has expired; reading the product with the browser instead. Run scripts/aliexpress-auth.js to re-authorise.', {
      error: err.message,
    });
    try {
      return await scraper.scrapeListing(url, 3, { currency, region: shipTo });
    } catch (fallbackErr) {
      throw new ScrapingError(
        "AliExpress access has expired: the app's authorisation needs renewing (an admin runs scripts/aliexpress-auth.js), and the " +
          `browser fallback also failed (${fallbackErr.message}).`,
        { source: 'aliexpress' }
      );
    }
  }
}

/**
 * Just the supplier's parcel ({ weightKg, lengthCm, widthCm, heightCm }),
 * for a draft made before Liston kept it: one API read, or null when the
 * API isn't in use or can't say. Never the browser scraper, which doesn't
 * read the parcel and takes half a minute.
 */
async function fetchPackage(url, { shipTo, currency } = {}) {
  if (config.aliexpress.source !== 'ds-api') return null;
  try {
    return (await dsApi.fetchProduct(productIdFromUrl(url), url, { shipTo, currency })).package || null;
  } catch (err) {
    logger.warn('AliExpress package details not read', { error: err.message });
    return null;
  }
}

/**
 * What AliExpress charges to post one of this option to the buyer's country
 * ({ cost, freeOver, minDays, maxDays, company, … }): one API read, or null
 * when the API isn't in use or has no delivery for it. The caller then
 * falls back to the flat shipping cost in the account's settings.
 */
async function fetchShipping(url, skuId, { shipTo, currency } = {}) {
  if (config.aliexpress.source !== 'ds-api' || !skuId) return null;
  try {
    return await dsApi.fetchShipping(productIdFromUrl(url), skuId, { shipTo, currency });
  } catch (err) {
    logger.warn('AliExpress shipping not read', { error: err.message });
    return null;
  }
}

module.exports = { fetchProduct, fetchPackage, fetchShipping, productIdFromUrl };
