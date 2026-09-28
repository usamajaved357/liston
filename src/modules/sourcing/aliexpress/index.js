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

/**
 * AliExpress products that may be the same thing as an eBay listing: by its
 * photo (image search) and by the words of its title (text search), each
 * tried whatever the other does, best matches first:
 * { image: [candidate], text: [candidate], errors: [message] }. Needs the
 * AliExpress API (ALIEXPRESS_SOURCE=ds-api); the browser scraper can't search.
 */
async function findSuppliers({ imageUrl, words, shipTo, currency, fetchImpl = fetch, resolveImpl = resolveElsewhere }) {
  if (config.aliexpress.source !== 'ds-api') {
    throw new ScrapingError('Finding a supplier by itself needs the AliExpress API (ALIEXPRESS_SOURCE=ds-api).', { source: 'aliexpress' });
  }
  const errors = [];
  // The photo, several ways at once (eBay's image host sits on a CDN, and the edge a network's DNS
  // hands out doesn't always answer): as asked, as eBay's smaller copy, over IPv4, and from the
  // addresses independent DNS resolvers give; the first to arrive, within PHOTO_WAIT_MS.
  const small = String(imageUrl).replace(/\/s-l\d+\./, '/s-l225.');
  const photo = () =>
    Promise.any([
      download(fetchImpl, imageUrl),
      download(fetchImpl, small),
      httpsDownload(imageUrl, { family: 4 }),
      downloadViaOtherDns(imageUrl, resolveImpl),
    ]).catch((err) => {
      throw new Error(`the eBay photo couldn't be read (${err.errors?.[0]?.message || err.message})`);
    });
  const byImage = (async () => (imageUrl ? dsApi.searchByImage(await photo(), { shipTo, currency, count: 20 }) : []))().catch((err) => {
    errors.push(`Image search: ${err.message}`);
    return [];
  });
  const byText = (words ? dsApi.searchByText(words, { shipTo, currency, pageSize: 20 }) : Promise.resolve([])).catch((err) => {
    errors.push(`Text search: ${err.message}`);
    return [];
  });
  const [image, text] = await Promise.all([byImage, byText]);
  if (errors.length) logger.warn('AliExpress supplier search partly failed', { errors });
  return { image, text, errors };
}

const PHOTO_WAIT_MS = 6000;
async function download(fetchImpl, url) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(PHOTO_WAIT_MS) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
function httpsDownload(url, options = {}) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ...options, timeout: PHOTO_WAIT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`status ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

// Public resolvers that don't all hand out the same CDN edge (Quad9 answers eBay's image host
// with Akamai where the others give Fastly), asked in parallel; every IPv4 address they give.
const OTHER_DNS = ['9.9.9.9', '1.1.1.1', '8.8.8.8'];
async function resolveElsewhere(host) {
  const { Resolver } = require('dns').promises;
  const found = await Promise.all(
    OTHER_DNS.map((server) => {
      const resolver = new Resolver({ timeout: 2000, tries: 1 });
      resolver.setServers([server]);
      return resolver.resolve4(host).catch(() => []);
    })
  );
  return [...new Set(found.flat())];
}

// The photo from each address other resolvers give (the TLS name stays eBay's), first to arrive.
async function downloadViaOtherDns(url, resolveImpl) {
  const addresses = await resolveImpl(new URL(url).hostname);
  if (!addresses.length) throw new Error('no other address for the photo host');
  return Promise.any(
    addresses.map((address) =>
      httpsDownload(url, {
        lookup: (host, opts, cb) => (opts && opts.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4)),
      })
    )
  );
}

module.exports = { fetchProduct, fetchPackage, fetchShipping, productIdFromUrl, findSuppliers, downloadViaOtherDns };
