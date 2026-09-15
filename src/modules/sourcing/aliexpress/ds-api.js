const crypto = require('crypto');
const config = require('../../../config');
const { ScrapingError } = require('../../scraping/scraping.errors');

// AliExpress's official Dropshipping API, as an alternative to driving a real
// browser. Roughly a second instead of thirty, immune to anti-bot measures,
// and it returns per-SKU data (price, stock, option labels, per-option image)
// far more reliably than reading it out of the page.
//
// NOT LIVE-VERIFIED: this needs an approved AliExpress Open Platform app, and
// no key exists in this environment yet. The signing rule, gateway, envelope
// shape and per-SKU price behaviour below are ported from a working
// implementation that was verified live against real products, but treat the
// first real call as the verification step. `config.aliexpress.source`
// defaults to 'scraper', so nothing routes here until it's switched on.

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

function assertConfigured() {
  const { appKey, appSecret, accessToken } = config.aliexpress;
  if (!appKey || !appSecret || !accessToken) {
    throw new ScrapingError(
      'The AliExpress API is selected but not configured — set ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET and ALIEXPRESS_ACCESS_TOKEN.',
      { source: 'aliexpress' }
    );
  }
}

async function call(apiName, bizParams) {
  assertConfigured();
  const { appKey, appSecret, accessToken } = config.aliexpress;

  const params = {
    app_key: appKey,
    timestamp: String(Date.now()),
    sign_method: 'sha256',
    method: apiName,
    access_token: accessToken,
  };
  for (const [key, value] of Object.entries(bizParams)) params[key] = String(value);
  params.sign = sign(params, appSecret);

  const res = await fetch(IOP_GATEWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30 * 1000),
  });

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
  let imageUrl = null;

  for (const property of properties) {
    if (!property || typeof property !== 'object') continue;
    const name = property.sku_property_name;
    const value = property.property_value_definition_name || property.sku_property_value;
    if (name) attributes[String(name)] = value == null ? '' : String(value);
    if (!imageUrl && property.sku_image) imageUrl = String(property.sku_image);
  }

  return { attributes, imageUrl };
}

function normalizeProduct(raw, productId, sourceUrl) {
  raiseIfError(raw);
  const body = unwrapEnvelope(raw);

  const base = body.ae_item_base_info_dto || {};
  const media = body.ae_multimedia_info_dto || {};
  const title = base.subject || base.title || '';

  if (!title) {
    throw new ScrapingError("That AliExpress product couldn't be read — it may have been removed.", {
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

  const variants = [];
  let priceText = null;
  for (const sku of asArray(body.ae_item_sku_info_dtos, 'ae_item_sku_info_d_t_o')) {
    if (!sku || typeof sku !== 'object') continue;
    const amount = sku.offer_sale_price || sku.sku_price || sku.price || '';
    // The product's base currency_code is CNY, but each SKU carries the
    // currency actually requested — so price must come from the SKU.
    const currency = sku.currency_code || '';
    const { attributes, imageUrl } = decodeSkuOptions(sku);

    variants.push({ attributes, imageUrl, priceText: amount ? `${currency} ${amount}`.trim() : null });
    if (!priceText && amount) priceText = `${currency} ${amount}`.trim();
  }

  return {
    sourceUrl,
    title: String(title).trim(),
    description: String(base.detail || base.mobile_detail || '').trim(),
    imageUrls,
    priceText,
    specifics,
    categoryBreadcrumb: [],
    // A product with no options yields an empty array — common and expected,
    // not an error.
    variants,
  };
}

async function fetchProduct(productId, sourceUrl) {
  const raw = await call('aliexpress.ds.product.get', {
    product_id: productId,
    ship_to_country: config.aliexpress.shipToCountry,
    target_currency: config.aliexpress.targetCurrency,
    target_language: 'en',
  });
  return normalizeProduct(raw, productId, sourceUrl);
}

module.exports = { fetchProduct, sign, raiseIfError, unwrapEnvelope, normalizeProduct, decodeSkuOptions };
