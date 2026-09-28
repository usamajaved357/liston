const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../../../utils/logger');
const appState = require('../../../db/app-state.repository');
const config = require('../../../config');
const { ScrapingError } = require('../../scraping/scraping.errors');

// AliExpress's official Dropshipping API, as an alternative to driving a real
// browser. Roughly a second instead of thirty, immune to anti-bot measures,
// and it returns per-SKU data (price, stock, option labels, per-option image)
// far more reliably than reading it out of the page.
//
// LIVE-VERIFIED 2026-09-15 against a real product: 1.64s, 10 variants with
// per-SKU GBP prices and per-option photos, 16 specifics — on the same URL
// the browser scraper had just failed on three times. `config.aliexpress.source`
// defaults to 'scraper'; set ALIEXPRESS_SOURCE=ds-api to route here.

const IOP_GATEWAY = 'https://api-sg.aliexpress.com/sync';

// IOP signature: sort params by key, concatenate key1value1key2value2…,
// HMAC-SHA256 with the app secret, hex, uppercased. `sign` itself is excluded.
function sign(params, appSecret) {
  const ordered = Object.keys(params)
    .filter((key) => key !== 'sign')
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('');
  return crypto.createHmac('sha256', appSecret).update(ordered, 'utf8').digest('hex').toUpperCase();
}

// Tokens can come from .env or from the file the consent script writes —
// checking only .env sent a freshly authorised app straight to "not
// configured". Confirmed live.
async function assertConfigured() {
  const { appKey, appSecret } = config.aliexpress;
  const state = await loadTokenState();
  if (!appKey || !appSecret || !(state.accessToken || state.refreshToken)) {
    throw new ScrapingError(
      'The AliExpress API is selected but not configured — set ALIEXPRESS_APP_KEY and ALIEXPRESS_APP_SECRET, then run `node scripts/aliexpress-auth.js` to authorise.',
      { source: 'aliexpress' }
    );
  }
}

// --- token lifecycle ---------------------------------------------------------
// AliExpress access tokens are short-lived; a static one in .env would stop
// working within hours. The refresh token is the durable credential and it
// rolls on every refresh, so the current pair has to be kept somewhere that
// survives a restart AND a redeploy. A local file did the first but not the
// second (Railway wipes the filesystem each release), so it lives in the
// app_state table now, with an in-memory copy for the hot path. The file
// is still read once as a migration path from earlier installs.
//
// Expiry comes from the epoch-ms `expire_time` / `refresh_token_valid_time`
// fields, not the misleading `expires_in` label.
const TOKEN_FILE = path.join(process.cwd(), '.cache', 'aliexpress-token.json');
const TOKEN_KEY = 'aliexpress.token';
const REFRESH_SKEW_MS = 5 * 60 * 1000;
let tokenState = null;
let refreshing = null;

function stateFromEnvOrFile() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return {
      accessToken: config.aliexpress.accessToken,
      refreshToken: config.aliexpress.refreshToken,
      accessExpiresMs: config.aliexpress.accessTokenExpiresMs,
    };
  }
}

async function loadTokenState() {
  if (tokenState) return tokenState;
  try {
    const stored = await appState.get(TOKEN_KEY);
    if (stored?.refreshToken) {
      tokenState = stored;
      return tokenState;
    }
  } catch (err) {
    // No DB (a script run before migrations, or the unit tests) — fall
    // through to the file/env copy.
    logger.warn('Could not read the AliExpress token from the database', { error: err.message });
  }
  tokenState = stateFromEnvOrFile();
  return tokenState;
}

async function saveTokenState(state) {
  tokenState = state;
  try {
    await appState.set(TOKEN_KEY, state);
  } catch (err) {
    logger.warn('Could not persist the AliExpress token to the database. Keeping the file copy', { error: err.message });
  }
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // best effort only
  }
}

async function signedPost(apiName, bizParams, { accessToken } = {}) {
  const { appKey, appSecret } = config.aliexpress;
  const params = { app_key: appKey, timestamp: String(Date.now()), sign_method: 'sha256', method: apiName };
  if (accessToken) params.access_token = accessToken;
  for (const [key, value] of Object.entries(bizParams)) params[key] = String(value);
  params.sign = sign(params, appSecret);

  const res = await fetch(IOP_GATEWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30 * 1000),
  });
  if (!res.ok) throw new ScrapingError(`AliExpress API request failed (${res.status})`, { source: 'aliexpress' });
  return res.json();
}

async function refreshAccessToken(state) {
  if (!state.refreshToken) {
    throw new ScrapingError('The AliExpress access token has expired and no refresh token is set.', { source: 'aliexpress' });
  }
  const raw = await signedPost('/auth/token/security/refresh', { refresh_token: state.refreshToken });
  raiseIfError(raw);
  const data = unwrapEnvelope(raw);
  if (!data.access_token) {
    throw new ScrapingError(
      'AliExpress access has expired — re-authorise the app: run `node scripts/aliexpress-auth.js`, open the link, approve, then run it again with the code.',
      { source: 'aliexpress' }
    );
  }
  const next = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || state.refreshToken,
    accessExpiresMs: Number(data.expire_time) || Date.now() + 60 * 60 * 1000,
    refreshExpiresMs: Number(data.refresh_token_valid_time) || state.refreshExpiresMs || null,
  };
  await saveTokenState(next);
  logger.info('Refreshed the AliExpress access token');
  return next;
}

// A Test-status app gets short tokens: access 24h, refresh 48h from the
// CONSENT (confirmed live — the refresh expiry does not move when the token
// is refreshed). So the timer keeps the access token fresh, but a Test app
// still needs a new consent every two days; "Apply Online" in the AliExpress
// console turns the app formal, whose tokens last months.
const KEEP_ALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000;
function startTokenKeepAlive() {
  if (config.aliexpress.source !== 'ds-api') return null;
  const tick = async () => {
    try {
      const state = await loadTokenState();
      if (!state.refreshToken) return;
      await refreshAccessToken(state);
    } catch (err) {
      logger.warn('AliExpress token keep-alive failed', { error: err.message });
    }
  };
  tick();
  const timer = setInterval(tick, KEEP_ALIVE_INTERVAL_MS);
  timer.unref();
  return timer;
}

// One-time consent. The seller opens this URL, approves the app under their
// AliExpress account, and is sent to the app's registered callback with a
// `code` — exchangeCode turns that into the durable refresh token.
function authorizeUrl() {
  const { appKey, callbackUrl } = config.aliexpress;
  if (!appKey || !callbackUrl) throw new Error('Set ALIEXPRESS_APP_KEY and ALIEXPRESS_CALLBACK first');
  const params = new URLSearchParams({ response_type: 'code', force_auth: 'true', redirect_uri: callbackUrl, client_id: appKey });
  return `https://api-sg.aliexpress.com/oauth/authorize?${params}`;
}

async function exchangeCode(code) {
  const raw = await signedPost('/auth/token/security/create', { code });
  raiseIfError(raw);
  const data = unwrapEnvelope(raw);
  if (!data.access_token || !data.refresh_token) {
    throw new Error(`AliExpress returned no tokens for that code: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  const next = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresMs: Number(data.expire_time) || Date.now() + 60 * 60 * 1000,
    refreshExpiresMs: Number(data.refresh_token_valid_time) || null,
  };
  await saveTokenState(next);
  return next;
}

async function getValidAccessToken() {
  const state = await loadTokenState();
  const fresh = state.accessToken && state.accessExpiresMs && Date.now() < state.accessExpiresMs - REFRESH_SKEW_MS;
  if (fresh) return state.accessToken;

  // Concurrent callers share one refresh rather than racing.
  if (!refreshing) {
    refreshing = refreshAccessToken(state)
      .catch(async (err) => {
        // The copy in memory may simply be stale: someone re-authorised
        // (scripts/aliexpress-auth.js) since this process loaded it. Re-read
        // the database once before giving up, so a renewal never needs a
        // restart to take effect.
        tokenState = null;
        const latest = await loadTokenState();
        if (latest.refreshToken && latest.refreshToken !== state.refreshToken) {
          logger.info('AliExpress token was renewed elsewhere; using the new one');
          const stillFresh = latest.accessToken && latest.accessExpiresMs && Date.now() < latest.accessExpiresMs - REFRESH_SKEW_MS;
          return stillFresh ? latest : refreshAccessToken(latest);
        }
        throw err;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return (await refreshing).accessToken;
}

/**
 * One POST to the gateway. A dropped connection (DNS, reset, refused) is
 * tried once more; if it drops again, or AliExpress doesn't answer in 30
 * seconds, the seller is told so in words instead of an internal error.
 */
async function postGateway(body, { fetchImpl = fetch, retryDelayMs = 700 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchImpl(IOP_GATEWAY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(30 * 1000),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new ScrapingError("AliExpress didn't answer in time. Try again in a moment.", { source: 'aliexpress', statusCode: 504 });
      }
      if (attempt >= 2) {
        throw new ScrapingError("Couldn't reach AliExpress just now: the connection dropped. Try again in a moment.", { source: 'aliexpress' });
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

async function call(apiName, bizParams) {
  await assertConfigured();
  const accessToken = await getValidAccessToken();
  const { appKey, appSecret } = config.aliexpress;

  const params = {
    app_key: appKey,
    timestamp: String(Date.now()),
    sign_method: 'sha256',
    method: apiName,
    access_token: accessToken,
  };
  for (const [key, value] of Object.entries(bizParams)) params[key] = String(value);
  params.sign = sign(params, appSecret);

  const res = await postGateway(new URLSearchParams(params).toString());

  if (!res.ok) {
    throw new ScrapingError(`AliExpress API request failed (${res.status})`, { source: 'aliexpress' });
  }
  return res.json();
}

// Two failure shapes occur: a business error under `error_response`, and a
// gateway error (bad signature, bad app key) as bare top-level fields with no
// envelope at all. A failed product fetch still returns the envelope with a
// non-200 rsp_code, so without that check a caller silently gets blank fields.
function raiseIfError(result) {
  if (!result || typeof result !== 'object') return;

  const businessError = result.error_response;
  if (businessError) {
    throw new ScrapingError(
      `AliExpress rejected the request: ${businessError.sub_msg || businessError.msg || 'unknown error'}`,
      { source: 'aliexpress' }
    );
  }

  const envelopeKeys = Object.keys(result).filter((key) => key.endsWith('_response'));
  if (!envelopeKeys.length && result.code && String(result.code) !== '0') {
    throw new ScrapingError(`AliExpress rejected the request: ${result.message || result.code}`, {
      source: 'aliexpress',
    });
  }

  for (const key of envelopeKeys) {
    const value = result[key];
    if (value && typeof value === 'object' && 'rsp_code' in value && !['200', '0'].includes(String(value.rsp_code))) {
      throw new ScrapingError(`AliExpress couldn't return that product: ${value.rsp_msg || value.rsp_code}`, {
        source: 'aliexpress',
      });
    }
  }
}

// The payload is wrapped in a key named after the method (dots become
// underscores) and often nests a further `result`/`data` inside — the
// documented flat shape isn't what the live API returns.
function unwrapEnvelope(result) {
  let body = result;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!body || typeof body !== 'object') break;
    const next = [...Object.keys(body).filter((k) => k.endsWith('_response')), 'result', 'data'].find(
      (key) => body[key] && typeof body[key] === 'object'
    );
    if (!next) break;
    body = body[next];
  }
  return body && typeof body === 'object' ? body : {};
}

function asArray(value, innerKey) {
  const inner = value && typeof value === 'object' && innerKey in value ? value[innerKey] : value;
  if (!inner) return [];
  return Array.isArray(inner) ? inner : [inner];
}

// A SKU's variation attributes, e.g. { "Body Color": "Cold white" }, plus its
// own photo. property_value_definition_name is the buyer-facing label
// AliExpress actually shows; sku_property_value is the raw fallback.
function decodeSkuOptions(sku) {
  const properties = asArray(sku.ae_sku_property_dtos, 'ae_sku_property_d_t_o');
  const attributes = {};
  const rawValues = {};
  let imageUrl = null;

  for (const property of properties) {
    if (!property || typeof property !== 'object') continue;
    const name = property.sku_property_name;
    const value = property.property_value_definition_name || property.sku_property_value;
    if (name) {
      attributes[String(name)] = value == null ? '' : String(value);
      const raw = property.sku_property_value;
      if (raw != null && String(raw) !== String(value ?? '')) rawValues[String(name)] = String(raw);
    }
    if (!imageUrl && property.sku_image) imageUrl = String(property.sku_image);
  }

  return { attributes, imageUrl, rawValues };
}

// Two SKUs shown under the same label ("Camo Brown" for both a 25lb and a
// 35lb spool, one property id each) would be one variation to eBay, which
// rejects the group. Where the raw property value tells them apart, the
// label is replaced by it; a collision that can't be resolved is left for
// the drafting step to drop.
function separateColliding(entries) {
  const key = (attributes) =>
    Object.entries(attributes)
      .map(([n, v]) => `${n.toLowerCase()}=${v.trim().replace(/\s+/g, ' ').toLowerCase()}`)
      .sort()
      .join('|');
  const counts = new Map();
  for (const entry of entries) counts.set(key(entry.attributes), (counts.get(key(entry.attributes)) || 0) + 1);
  return entries.map((entry) => {
    if ((counts.get(key(entry.attributes)) || 0) < 2) return entry;
    const attributes = { ...entry.attributes };
    for (const [name, raw] of Object.entries(entry.rawValues || {})) attributes[name] = raw;
    return { ...entry, attributes };
  });
}

// The parcel the supplier ships: package_info_dto's gross weight (kg, a
// string like "0.050") and box size (whole cm). eBay needs the weight when
// the seller's postage policy works postage out from it. Null without a
// usable weight; the size only when all three sides are given.
function packageOf(info) {
  const weightKg = Number(info?.gross_weight);
  if (!(weightKg > 0)) return null;
  const sides = [info.package_length, info.package_width, info.package_height].map(Number);
  const sized = sides.every((n) => n > 0);
  return {
    weightKg: Math.round(weightKg * 1000) / 1000,
    lengthCm: sized ? sides[0] : null,
    widthCm: sized ? sides[1] : null,
    heightCm: sized ? sides[2] : null,
  };
}

// How the product and its store do on AliExpress: orders ("1000+"), the
// rating and how many reviewed it, whether it's still on sale, the store
// and its ratings, and the delivery days AliExpress quotes.
function supplierOf(body) {
  const base = body.ae_item_base_info_dto || {};
  const store = body.ae_store_info || {};
  const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    orders: base.sales_count ? String(base.sales_count) : null,
    rating: num(base.avg_evaluation_rating),
    reviews: num(base.evaluation_count),
    onSale: base.product_status_type ? base.product_status_type === 'onSelling' : null,
    store: store.store_name
      ? {
          name: String(store.store_name),
          country: store.store_country_code || null,
          described: num(store.item_as_described_rating),
          communication: num(store.communication_rating),
          shipping: num(store.shipping_speed_rating),
        }
      : null,
    deliveryDays: num(body.logistics_info_dto?.delivery_time),
  };
}

function normalizeProduct(raw, productId, sourceUrl) {
  raiseIfError(raw);
  const body = unwrapEnvelope(raw);

  const base = body.ae_item_base_info_dto || {};
  const media = body.ae_multimedia_info_dto || {};
  const title = base.subject || base.title || '';

  if (!title) {
    throw new ScrapingError("That AliExpress product couldn't be read. It may have been removed.", {
      source: 'aliexpress',
    });
  }

  const imageField = media.image_urls || '';
  const imageUrls = Array.isArray(imageField)
    ? imageField.map(String)
    : String(imageField)
        .replace(/,/g, ';')
        .split(';')
        .map((url) => url.trim())
        .filter(Boolean);

  const specifics = {};
  for (const property of asArray(body.ae_item_properties, 'ae_item_property')) {
    if (!property || typeof property !== 'object') continue;
    const name = property.attr_name || property.name;
    const value = property.attr_value || property.value;
    if (name) specifics[String(name)] = value == null ? '' : String(value);
  }

  const decoded = [];
  let priceText = null;
  for (const sku of asArray(body.ae_item_sku_info_dtos, 'ae_item_sku_info_d_t_o')) {
    if (!sku || typeof sku !== 'object') continue;
    const amount = sku.offer_sale_price || sku.sku_price || sku.price || '';
    // The product's base currency_code is CNY, but each SKU carries the
    // currency actually requested — so price must come from the SKU.
    const currency = sku.currency_code || '';
    const { attributes, imageUrl, rawValues } = decodeSkuOptions(sku);

    decoded.push({
      attributes,
      rawValues,
      imageUrl,
      priceText: amount ? `${currency} ${amount}`.trim() : null,
      // Which SKU this is (the shipping read asks per SKU) and how many
      // the supplier has left of it.
      skuId: sku.sku_id ? String(sku.sku_id) : null,
      stock: sku.sku_available_stock === undefined || sku.sku_available_stock === null || sku.sku_available_stock === '' ? null : Number(sku.sku_available_stock),
    });
    if (!priceText && amount) priceText = `${currency} ${amount}`.trim();
  }
  const variants = separateColliding(decoded).map(({ rawValues, ...variant }) => variant);

  // The product page's gallery is the main photos PLUS each option's own
  // photo — the API keeps those on the SKUs. A glasses listing showed 8 on
  // the page and the API's image_urls carried 6; the other two were the
  // colour photos. Merged (deduplicated, main photos first) so the draft
  // has every picture the buyer would have seen on AliExpress.
  const skuImages = variants.map((variant) => variant.imageUrl).filter(Boolean);
  const allImages = [...new Set([...imageUrls, ...skuImages])];

  return {
    sourceUrl,
    title: String(title).trim(),
    description: String(base.detail || base.mobile_detail || '').trim(),
    imageUrls: allImages,
    priceText,
    specifics,
    categoryBreadcrumb: [],
    package: packageOf(body.package_info_dto),
    supplier: supplierOf(body),
    // A product with no options yields an empty array — common and expected,
    // not an error.
    variants,
    variantAxes: deriveVariantAxes(variants),
  };
}

// The variation structure the picker and the eBay group need — same shape
// the scraper returns. The API gives only flat SKUs, so the axes are derived
// from them: one axis per attribute name, values in first-seen order. Without
// this the variation picker showed "one variation" for a ten-SKU product and
// drafted all of them unasked. Confirmed live.
function deriveVariantAxes(variants) {
  const axes = new Map();
  for (const variant of variants) {
    for (const [name, value] of Object.entries(variant.attributes)) {
      if (!axes.has(name)) axes.set(name, { name, values: [], hasImages: false });
      const axis = axes.get(name);
      if (!axis.values.includes(value)) axis.values.push(value);
    }
  }
  // Only the axis whose values actually carry distinct photos is flagged
  // (colour usually does, size never does) — that decides eBay's
  // `aspectsImageVariesBy`.
  for (const axis of axes.values()) {
    const imagesByValue = new Map();
    for (const variant of variants) {
      const value = variant.attributes[axis.name];
      if (variant.imageUrl && value != null) {
        if (!imagesByValue.has(value)) imagesByValue.set(value, new Set());
        imagesByValue.get(value).add(variant.imageUrl);
      }
    }
    // A photo per SKU is attached to every attribute of that SKU, so every
    // axis looks image-bearing at first glance. The photo belongs to THIS
    // axis only if each of its values maps to exactly one photo (every
    // "Black" SKU shares the black photo) and the values differ from each
    // other. On a glasses listing, "Eye Prescription" failed the first test
    // — +100 had a black and an orange photo — so it's the colour's axis.
    const consistent = [...imagesByValue.values()].every((set) => set.size === 1);
    const distinct = new Set([...imagesByValue.values()].map((set) => [...set][0]));
    axis.hasImages = imagesByValue.size > 0 && consistent && (distinct.size > 1 || axes.size === 1);
  }
  return [...axes.values()];
}

async function fetchProduct(productId, sourceUrl, { shipTo, currency } = {}) {
  const raw = await call('aliexpress.ds.product.get', {
    product_id: productId,
    ship_to_country: shipTo || config.aliexpress.shipToCountry,
    target_currency: currency || config.aliexpress.targetCurrency,
    target_language: 'en',
  });
  return normalizeProduct(raw, productId, sourceUrl);
}

// "£8.00", "US $10.00", "8.00" -> 8; null when there's no number.
function amountIn(text) {
  const match = String(text || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

// One way AliExpress can post it, from aliexpress.ds.freight.query.
// `shipping_fee_cent` holds the amount in whole units ("1.99" with a format
// of "£1.99"), whatever its name says. Confirmed live.
function deliveryOption(option) {
  const free = option.free_shipping === true || option.free_shipping === 'true';
  const fee = free ? 0 : amountIn(option.shipping_fee_cent) ?? amountIn(option.shipping_fee_format);
  return {
    code: option.code || null,
    company: option.company || null,
    cost: fee,
    currency: option.shipping_fee_currency || null,
    // Orders at or over this price go free ("Choice" products).
    freeOver: amountIn(option.free_shipping_threshold),
    minDays: option.min_delivery_days === undefined ? null : Number(option.min_delivery_days),
    maxDays: option.max_delivery_days === undefined ? null : Number(option.max_delivery_days),
    tracking: option.tracking === true || option.tracking === 'true',
    shipFrom: option.ship_from_country || null,
  };
}

/**
 * What it costs to send one of this SKU to the buyer's country, the way a
 * seller would pick: the cheapest tracked option (else the cheapest), with
 * the free-postage threshold and delivery days. Null when AliExpress has no
 * delivery for it ("DELIVERY_INFO_EMPTY").
 */
async function fetchShipping(productId, skuId, { shipTo, currency } = {}) {
  const raw = await call('aliexpress.ds.freight.query', {
    queryDeliveryReq: JSON.stringify({
      quantity: 1,
      shipToCountry: shipTo || config.aliexpress.shipToCountry,
      productId: String(productId),
      selectedSkuId: String(skuId),
      language: 'en_US',
      locale: 'en_US',
      currency: currency || config.aliexpress.targetCurrency,
    }),
  });
  raiseIfError(raw);
  const result = unwrapEnvelope(raw);
  if (result.success === false || result.success === 'false') return null;
  const options = asArray(result.delivery_options, 'delivery_option_d_t_o').filter((o) => o && typeof o === 'object').map(deliveryOption).filter((o) => o.cost !== null);
  if (!options.length) return null;
  const byCost = (a, b) => a.cost - b.cost || (a.maxDays ?? 99) - (b.maxDays ?? 99);
  const tracked = options.filter((o) => o.tracking).sort(byCost);
  const chosen = tracked[0] || [...options].sort(byCost)[0];
  return { ...chosen, options: options.length };
}

// ---- finding a supplier ----------------------------------------------------------------

const PRODUCT_URL = (id) => `https://www.aliexpress.com/item/${id}.html`;
// Search results give photos on ae-pic-*.aliexpress-media.com, which doesn't answer from every network;
// AliExpress's main image host serves the same /kf/ file.
const photoUrl = (url) => (url ? String(url).replace(/^https?:\/\/ae-pic-[a-z0-9]+\.aliexpress-media\.com\/kf\//i, 'https://ae01.alicdn.com/kf/') : null);
const numberIn = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  return String(v ?? '').trim() && Number.isFinite(n) ? n : null;
};

/**
 * AliExpress products for some words (aliexpress.ds.text.search, best match
 * first): [{ productId, title, imageUrl, price, rating (stars), orders, url,
 * via: 'text' }]. LIVE-VERIFIED 2026-09-29: products under
 * data.products.selection_search_product, the rating as `score` ("4.3").
 */
async function searchByText(keyWord, { shipTo, currency, pageSize = 10 } = {}) {
  const country = shipTo || config.aliexpress.shipToCountry;
  const raw = await call('aliexpress.ds.text.search', {
    keyWord: String(keyWord).slice(0, 120),
    local: `en_${country}`,
    countryCode: country,
    currency: currency || config.aliexpress.targetCurrency,
    pageSize,
    pageIndex: 1,
  });
  raiseIfError(raw);
  const data = raw?.aliexpress_ds_text_search_response?.data || unwrapEnvelope(raw);
  return asArray(data.products, 'selection_search_product')
    .filter((p) => p && p.itemId)
    .map((p) => ({
      productId: String(p.itemId),
      title: String(p.title || ''),
      imageUrl: photoUrl(p.itemMainPic),
      price: numberIn(p.targetSalePrice),
      rating: numberIn(p.score),
      orders: p.orders ? String(p.orders) : null,
      url: PRODUCT_URL(p.itemId),
      via: 'text',
    }));
}

/**
 * AliExpress products that look like a photo (aliexpress.ds.image.search,
 * the image uploaded as a file: file parameters are sent as multipart and
 * left out of the signature): [{ productId, title, imageUrl, price,
 * positive (feedback %), orders, url, via: 'image' }]. LIVE-VERIFIED
 * 2026-09-29: products under data.products.traffic_image_product_d_t_o.
 */
async function searchByImage(imageBytes, { shipTo, currency, count = 10, fetchImpl = fetch } = {}) {
  await assertConfigured();
  const accessToken = await getValidAccessToken();
  const { appKey, appSecret } = config.aliexpress;
  const params = {
    app_key: appKey,
    timestamp: String(Date.now()),
    sign_method: 'sha256',
    method: 'aliexpress.ds.image.search',
    access_token: accessToken,
    shpt_to: shipTo || config.aliexpress.shipToCountry,
    target_currency: currency || config.aliexpress.targetCurrency,
    target_language: 'EN',
    product_cnt: String(count),
  };
  params.sign = sign(params, appSecret);
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) form.append(key, value);
  form.append('image_file_bytes', new Blob([imageBytes], { type: 'image/jpeg' }), 'image.jpg');
  let res;
  try {
    res = await fetchImpl(IOP_GATEWAY, { method: 'POST', body: form, signal: AbortSignal.timeout(30 * 1000) });
  } catch (err) {
    throw new ScrapingError("Couldn't reach AliExpress's image search just now. Try again in a moment.", { source: 'aliexpress' });
  }
  if (!res.ok) throw new ScrapingError(`AliExpress image search failed (${res.status})`, { source: 'aliexpress' });
  const raw = await res.json();
  raiseIfError(raw);
  const data = raw?.aliexpress_ds_image_search_response?.data || unwrapEnvelope(raw);
  return asArray(data.products, 'traffic_image_product_d_t_o')
    .filter((p) => p && p.product_id)
    .map((p) => ({
      productId: String(p.product_id),
      title: String(p.product_title || ''),
      imageUrl: photoUrl(p.product_main_image_url),
      price: numberIn(p.target_sale_price),
      positive: numberIn(p.evaluate_rate),
      orders: p.lastest_volume !== undefined ? String(p.lastest_volume) : null,
      url: PRODUCT_URL(p.product_id),
      via: 'image',
    }));
}

module.exports = { photoUrl, searchByText, searchByImage, fetchProduct, fetchShipping, deliveryOption, supplierOf, postGateway, sign, raiseIfError, unwrapEnvelope, normalizeProduct, packageOf, decodeSkuOptions, deriveVariantAxes, getValidAccessToken, authorizeUrl, exchangeCode, startTokenKeepAlive };
