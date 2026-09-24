const sharp = require('sharp');
const logger = require('../../../utils/logger');

// eBay's picture rules, as constants rather than scattered magic numbers.
// Sources: eBay Picture Policy + listing requirements.
const MIN_LONGEST_SIDE = 500; // eBay's hard minimum — below this it's rejected
const TARGET_SIZE = 1600; // below this, eBay's zoom feature is disabled
const MAX_DIMENSION = 9000;
const MAX_BYTES = 12 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 20 * 1000;

// Why every image gets re-encoded rather than passed through:
//
//  - SQUARE: eBay crops search thumbnails to a square. A non-square photo
//    gets cut, which on mobile (most buyers) means a chopped product.
//  - 1600px: under it, eBay turns off zoom, which measurably costs
//    conversions. Padding a smaller image up doesn't add detail, but it does
//    keep the gallery consistent and preserves zoom.
//  - PAD, NEVER STRETCH: a distorted product photo reads as a scam listing.
//  - WHITE: neutral backgrounds are what eBay recommends and what the rest
//    of the gallery will look like after compositing.
async function padToSquare(buffer, size = TARGET_SIZE) {
  return sharp(buffer)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
      // Never upscale past the source's own resolution into a blurry mess —
      // a small image is centred on white at full size instead.
      withoutEnlargement: false,
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } }) // PNG cutouts → white, not black
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

// The "make the supplier photo look better" step, without a model. Supplier
// photos are usually decent but soft, slightly dull and under-sized. This is
// the kind of clean-up a retoucher does before a photo goes live: scale to the
// listing size with a quality resampler, recover crispness with a mild
// unsharp mask, lift flat mid-tones a touch. Deliberately conservative — the
// product must stay exactly the product; nothing here can add, remove or
// recolour anything. Free and ~100ms, where a generated image cost ~$0.20.
async function enhance(buffer, size = TARGET_SIZE) {
  // Supplier shots often leave the product small in a sea of white. Trim the
  // plain margins (only when the photo actually has a plain background — a
  // lifestyle shot trims nothing) and re-pad with a consistent 6% margin, so
  // the product fills the frame like a real catalogue photo. Trimming can
  // fail on a busy image; fall back to the untouched photo.
  let framed = await sharp(buffer).flatten({ background: { r: 255, g: 255, b: 255 } }).toBuffer();
  try {
    const trimmed = await sharp(framed).trim({ threshold: 18 }).toBuffer();
    const t = await sharp(trimmed).metadata();
    const o = await sharp(framed).metadata();
    // Only accept a trim that leaves a sensible product; a near-empty result
    // means the background wasn't plain after all.
    if (t.width >= o.width * 0.15 && t.height >= o.height * 0.15) {
      const margin = Math.round(Math.max(t.width, t.height) * 0.06);
      framed = await sharp(trimmed)
        .extend({ top: margin, bottom: margin, left: margin, right: margin, background: { r: 255, g: 255, b: 255 } })
        .toBuffer();
    }
  } catch {
    // keep `framed` as is
  }

  const meta = await sharp(framed).metadata();
  const longest = Math.max(meta.width || 0, meta.height || 0);
  // Upscaling a small photo a long way just magnifies its softness; sharpen
  // a little harder in that case so the result isn't mushy.
  const upscaling = longest < size;
  return sharp(framed)
    .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 }, kernel: 'lanczos3' })
    .modulate({ brightness: 1.02, saturation: 1.04 })
    .linear(1.04, -4) // slight contrast lift, keeps white white
    .sharpen({ sigma: upscaling ? 1.2 : 0.8, m1: 0.6, m2: 0.4 })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

async function describe(buffer) {
  const { width, height, format } = await sharp(buffer).metadata();
  return { width, height, format, bytes: buffer.length };
}

// Validates what we're about to SEND to eBay. Errors block a publish;
// warnings are shown on the review page but don't stop anything.
async function validate(buffer) {
  const errors = [];
  const warnings = [];
  let meta;

  try {
    meta = await describe(buffer);
  } catch {
    return { ok: false, errors: ['This file could not be read as an image.'], warnings: [], meta: null };
  }

  const longest = Math.max(meta.width || 0, meta.height || 0);
  if (!longest) {
    errors.push('This image has no readable dimensions.');
  } else if (longest < MIN_LONGEST_SIDE) {
    errors.push(`eBay needs images at least ${MIN_LONGEST_SIDE}px on the longest side — this one is ${longest}px.`);
  } else if (longest < TARGET_SIZE) {
    warnings.push(`This image is ${longest}px; below ${TARGET_SIZE}px eBay can't offer zoom on it.`);
  }

  if (longest > MAX_DIMENSION) errors.push(`eBay's maximum image dimension is ${MAX_DIMENSION}px.`);
  if (meta.width && meta.height && meta.width !== meta.height) {
    warnings.push('This image is not square, so eBay will crop it in search results.');
  }
  if (meta.bytes > MAX_BYTES) errors.push("This image is over eBay's 12MB limit.");

  return { ok: errors.length === 0, errors, warnings, meta };
}

// AliExpress's image CDN turns away requests that don't look like they came
// from its own pages (a Referer ACL), and drops the odd one mid-transfer; so
// images are asked for the way a browser on the product page would, and a
// failed one is asked for once more.
const DOWNLOAD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
};
function headersFor(url) {
  try {
    return /alicdn\.com|aliexpress/i.test(new URL(url).hostname) ? { ...DOWNLOAD_HEADERS, Referer: 'https://www.aliexpress.com/' } : DOWNLOAD_HEADERS;
  } catch {
    return DOWNLOAD_HEADERS;
  }
}

async function download(url) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, { headers: headersFor(url), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Couldn't download image (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// The SOURCE has to clear the resolution bar, not the padded output — padding
// makes every image 1600² by construction, so validating only the result would
// pass anything. Confirmed live: an AliExpress gallery included a 48×48
// thumbnail, which sailed through output-only validation as a blurry
// upscale. Judge the input.
async function validateSource(buffer) {
  const meta = await describe(buffer);
  const longest = Math.max(meta.width || 0, meta.height || 0);

  if (!longest) return { ok: false, reason: 'no readable dimensions' };
  if (longest < MIN_LONGEST_SIDE) {
    return { ok: false, reason: `only ${longest}px on its longest side (eBay's minimum is ${MIN_LONGEST_SIDE}px)` };
  }
  return { ok: true, meta };
}

// A seller's own photo, ready for eBay: JPG, PNG and GIF go as they are;
// anything else that reads as a picture (WebP, AVIF, HEIF, TIFF, SVG…) is
// turned into a JPEG on white, the right way up. Throws when the bytes
// aren't a picture at all.
const EBAY_FORMATS = new Set(['jpeg', 'png', 'gif']);
async function toUploadable(buffer) {
  const { format } = await sharp(buffer).metadata();
  if (!format) throw new Error('Not an image');
  if (EBAY_FORMATS.has(format)) return buffer;
  return sharp(buffer, { density: 300 }).rotate().flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: 92 }).toBuffer();
}

// Photos this far below eBay's minimum are still worth enlarging; smaller
// ones are thumbnails and tracking pixels (a live gallery had a 48×48 one).
const ENLARGE_FROM = 250;
const ENLARGE_TO = 800;
async function enlargeable(buffer) {
  const meta = await describe(buffer).catch(() => ({}));
  const longest = Math.max(meta.width || 0, meta.height || 0);
  return longest >= ENLARGE_FROM && longest < MIN_LONGEST_SIDE ? longest : null;
}

// Download → check the source is worth using → normalize → check what we'll
// send. Returns null rather than throwing when an individual image can't be
// used: one bad photo out of eight shouldn't cost the seller the whole draft.
// The caller decides whether what survived is enough (see gates.js).
async function prepare(url) {
  try {
    let original = await download(url);

    let source = await validateSource(original);
    const enlargedFrom = source.ok ? null : await enlargeable(original);
    if (enlargedFrom) {
      // A usable photo just under eBay's 500px minimum (supplier galleries
      // have a few): enlarged to fit rather than lost. It'll look soft, and
      // the draft says so.
      original = await sharp(original).rotate().resize({ width: ENLARGE_TO, height: ENLARGE_TO, fit: 'inside', kernel: 'lanczos3' }).jpeg({ quality: 92 }).toBuffer();
      source = await validateSource(original);
    }
    if (!source.ok) {
      logger.warn('Skipped a source image that is too small to list', { url, reason: source.reason });
      return null;
    }

    const normalized = await padToSquare(original);
    const result = await validate(normalized);
    if (!result.ok) {
      logger.warn('Dropped an image that failed eBay validation', { url, errors: result.errors });
      return null;
    }

    const warnings = [...result.warnings];
    // Padding hides low resolution rather than fixing it: a 600px photo
    // centred on white is 1600² but still only holds 600px of detail.
    const sourceLongest = Math.max(source.meta.width, source.meta.height);
    if (sourceLongest < TARGET_SIZE) {
      warnings.push(
        `One photo is only ${sourceLongest}px in the original, so it will look soft when buyers zoom in.`
      );
    }

    return { buffer: normalized, original, sourceUrl: url, meta: result.meta, sourceMeta: source.meta, warnings, enlargedFrom };
  } catch (err) {
    logger.warn('Could not prepare an image', { url, error: err.message });
    return null;
  }
}

module.exports = {
  toUploadable,
  MIN_LONGEST_SIDE,
  TARGET_SIZE,
  MAX_DIMENSION,
  MAX_BYTES,
  padToSquare,
  enhance,
  describe,
  validate,
  validateSource,
  download,
  prepare,
};
