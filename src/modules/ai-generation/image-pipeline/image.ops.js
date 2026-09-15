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

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Couldn't download image (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
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

// Download → check the source is worth using → normalize → check what we'll
// send. Returns null rather than throwing when an individual image can't be
// used: one bad photo out of eight shouldn't cost the seller the whole draft.
// The caller decides whether what survived is enough (see gates.js).
async function prepare(url) {
  try {
    const original = await download(url);

    const source = await validateSource(original);
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

    return { buffer: normalized, sourceUrl: url, meta: result.meta, sourceMeta: source.meta, warnings };
  } catch (err) {
    logger.warn('Could not prepare an image', { url, error: err.message });
    return null;
  }
}

module.exports = {
  MIN_LONGEST_SIDE,
  TARGET_SIZE,
  MAX_DIMENSION,
  MAX_BYTES,
  padToSquare,
  describe,
  validate,
  validateSource,
  download,
  prepare,
};
