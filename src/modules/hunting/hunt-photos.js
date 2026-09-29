const sharp = require('sharp');

// Whether an eBay listing uses one of a supplier's own photos, without any AI:
// many dropshippers list with the supplier's pictures, so the same photo on
// both is the same product, for free. A difference hash of each photo (its
// light-to-dark pattern on a 16×16 grid, after trimming plain borders) barely
// moves when a photo is resized, recompressed or given a thin frame, and
// changes almost entirely between two different photos. Two or more of the
// listing's photos among the supplier's is the same product; anything short
// of that (another angle, a lifestyle shot, a big banner) isn't decided here:
// it's left to the AI's comparison (ai-generation/product-match).

const GRID = 16;
// Of 256 bits, how many may differ for two photos to be the same picture
// (calibrated on live listings: a seller's copy with a watermark or a new
// crop differs by 19-30, other photos, of the same product or not, by 42 or more).
const SAME_PHOTO_BITS = 32;
// Photos of the listing that must each be one of the supplier's: one alone could be a stock
// picture of what the product does (a projector's pattern on a ceiling) that other sellers use too.
const SHARED_NEEDED = 2;

/** The photo's difference hash (256 0/1 values), or null when it isn't an image. */
async function fingerprint(bytes) {
  if (!bytes || !bytes.length) return null;
  try {
    let image = sharp(bytes).rotate().flatten({ background: '#ffffff' });
    // A plain border (white padding, a frame) is cut off first, so a padded copy hashes the same.
    const trimmed = await image
      .clone()
      .trim({ threshold: 12 })
      .toBuffer()
      .catch(() => null);
    if (trimmed) image = sharp(trimmed);
    const data = await image
      .resize(GRID + 1, GRID, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();
    const bits = new Uint8Array(GRID * GRID);
    for (let y = 0; y < GRID; y += 1) {
      for (let x = 0; x < GRID; x += 1) bits[y * GRID + x] = data[y * (GRID + 1) + x] > data[y * (GRID + 1) + x + 1] ? 1 : 0;
    }
    return bits;
  } catch {
    return null;
  }
}

const distance = (a, b) => a.reduce((n, bit, i) => n + (bit !== b[i] ? 1 : 0), 0);

/**
 * How the listing's photos compare with the supplier's (fingerprints): the
 * closest pair in differing bits (null when none could be read), how many of
 * the listing's photos are one of the supplier's, and whether that's enough
 * to call it the same product without the AI (samePhotos).
 */
function compare(listingPrints, supplierPrints) {
  const theirs = supplierPrints.filter(Boolean);
  let bits = null;
  let shared = 0;
  for (const a of listingPrints.filter(Boolean)) {
    const nearest = theirs.reduce((n, b) => Math.min(n, distance(a, b)), Infinity);
    if (nearest === Infinity) continue;
    if (bits === null || nearest < bits) bits = nearest;
    if (nearest <= SAME_PHOTO_BITS) shared += 1;
  }
  return { bits, shared, samePhotos: shared >= SHARED_NEEDED };
}

module.exports = { fingerprint, distance, compare, SAME_PHOTO_BITS, SHARED_NEEDED };
