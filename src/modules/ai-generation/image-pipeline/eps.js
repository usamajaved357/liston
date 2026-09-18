const crypto = require('crypto');
const governor = require('../../ebay/request-governor');
const { query } = require('../../../db/client');
const config = require('../../../config');
const { XMLParser } = require('fast-xml-parser');
const logger = require('../../../utils/logger');

// eBay Picture Services: upload an image to eBay and get back a permanent
// eBay-hosted URL. This is the step that makes generated images actually
// usable, and it solves three separate problems at once:
//
//  1. Generated images exist only as bytes in memory — nothing serves them.
//     A draft reviewed today and published next week needs a durable URL.
//  2. AliExpress's CDN enforces a Referer ACL, so alicdn URLs can 403 for
//     anyone but AliExpress itself.
//  3. We process images (square, 1600px, composited) into buffers that exist
//     nowhere on the public internet — eBay can only fetch a URL, so they
//     have to be hosted somewhere. EPS is free and eBay-served.
//
// Mechanism: the legacy Trading API's UploadSiteHostedPictures call, which is
// multipart (XML payload + raw bytes) rather than the plain XML post the rest
// of ebay.trading.js uses — hence a separate module. Auth is the seller's own
// OAuth token via X-EBAY-API-IAF-TOKEN, the same header ebay.trading.js uses.

const TRADING_API_URL = 'https://api.ebay.com/ws/api.dll';
const COMPATIBILITY_LEVEL = '1193';
const UPLOAD_TIMEOUT_MS = 60 * 1000;

const parser = new XMLParser({ ignoreAttributes: false });

// eBay's numeric site ids, which the Trading API uses instead of the
// marketplace ids the REST APIs take.
const SITE_IDS = {
  EBAY_US: '0',
  EBAY_GB: '3',
  EBAY_AU: '15',
  EBAY_DE: '77',
  EBAY_FR: '71',
  EBAY_IT: '101',
  EBAY_ES: '186',
  EBAY_CA: '2',
  EBAY_IE: '205',
  EBAY_NL: '146',
};

function siteIdFor(marketplaceId) {
  return SITE_IDS[marketplaceId] || '0';
}

// Identical bytes always produce the same eBay URL, so re-publishing a draft
// (or two variants sharing a photo) doesn't re-upload. In memory first,
// then the ebay_image_uploads table, so a restart or a second instance
// doesn't repeat uploads either — each one is a Trading call.
const uploadCache = new Map();

// Tests upload the same fixture bytes with different expectations; the
// durable cache would carry one test's answer into the next.
const PERSIST = config.env !== 'test';

async function findUploaded(hash) {
  if (uploadCache.has(hash)) return uploadCache.get(hash);
  if (!PERSIST) return null;
  try {
    const { rows } = await query('SELECT url FROM ebay_image_uploads WHERE content_hash = $1', [hash]);
    if (rows[0]) uploadCache.set(hash, rows[0].url);
    return rows[0]?.url || null;
  } catch {
    return null;
  }
}

function rememberUploaded(hash, url) {
  uploadCache.set(hash, url);
  if (!PERSIST) return;
  query(
    `INSERT INTO ebay_image_uploads (content_hash, url) VALUES ($1, $2) ON CONFLICT (content_hash) DO UPDATE SET url = EXCLUDED.url`,
    [hash, url]
  ).catch(() => {});
}

function hashOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildMultipartBody(buffer, boundary, pictureName) {
  const xmlPayload =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
    `<WarningLevel>High</WarningLevel>` +
    `<PictureName>${pictureName}</PictureName>` +
    `</UploadSiteHostedPicturesRequest>`;

  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="XML Payload"\r\n` +
      `Content-Type: text/xml; charset=utf-8\r\n\r\n` +
      `${xmlPayload}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="image.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  return Buffer.concat([head, buffer, tail]);
}

/**
 * Uploads one prepared image buffer and returns its permanent eBay URL.
 * Throws on failure — the caller decides whether to fall back.
 */
async function upload(accessToken, buffer, { marketplaceId = 'EBAY_GB', pictureName = 'Liston listing image' } = {}) {
  const hash = hashOf(buffer);
  const cached = await findUploaded(hash);
  if (cached) return cached;

  const boundary = `----ListonEPS${crypto.randomBytes(12).toString('hex')}`;

  const res = await governor.run('UploadSiteHostedPictures', () => fetch(TRADING_API_URL, {
    method: 'POST',
    headers: {
      'X-EBAY-API-SITEID': siteIdFor(marketplaceId),
      'X-EBAY-API-COMPATIBILITY-LEVEL': COMPATIBILITY_LEVEL,
      'X-EBAY-API-CALL-NAME': 'UploadSiteHostedPictures',
      'X-EBAY-API-IAF-TOKEN': accessToken,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: buildMultipartBody(buffer, boundary, pictureName),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  }));

  const text = await res.text();
  const parsed = parser.parse(text);
  const body = parsed.UploadSiteHostedPicturesResponse;

  if (!body) throw new Error("eBay returned an unexpected response to the picture upload");
  if (body.Ack === 'Failure') {
    const errors = Array.isArray(body.Errors) ? body.Errors : [body.Errors].filter(Boolean);
    throw new Error(errors[0]?.LongMessage || errors[0]?.ShortMessage || 'eBay rejected the picture upload');
  }

  const fullUrl = body.SiteHostedPictureDetails?.FullURL;
  if (!fullUrl) throw new Error('eBay accepted the picture but returned no URL');

  rememberUploaded(hash, fullUrl);
  return fullUrl;
}

/**
 * Uploads many prepared images, preserving order.
 *
 * An image that fails to upload falls back to its own source URL rather than
 * disappearing: a publicly-reachable original is still better than a gap in
 * the gallery, and the publish gate reports what didn't make it.
 */
async function uploadAll(accessToken, prepared, { marketplaceId } = {}) {
  return Promise.all(
    prepared.map(async (image) => {
      try {
        return await upload(accessToken, image.buffer, { marketplaceId });
      } catch (err) {
        logger.warn('EPS upload failed. Falling back to the source image URL', {
          sourceUrl: image.sourceUrl,
          error: err.message,
        });
        return image.sourceUrl;
      }
    })
  );
}

function resetUploadCache() {
  uploadCache.clear();
}

module.exports = { upload, uploadAll, siteIdFor, buildMultipartBody, resetUploadCache };
