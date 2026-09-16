const imageOps = require('./image.ops');
const eps = require('./eps');
const slotPlan = require('./slot-plan');
const imageScreen = require('./image-screen.service');
const heroBadges = require('./hero-badges');
const config = require('../../../config');
const logger = require('../../../utils/logger');

// The listing image pipeline, in one place.
//
//   supplier photo → screen (drop text slides / collages) → enhance
//     (trim margins, 1600², sharpen, lift) → badges on the hero only → EPS
//
// No generative model and no retouching. Both were tried: generation cost
// ~$0.20 an image and drifted from the product; sharpening/re-framing/badges
// didn't make the seller happier with the result. The supplier's file is
// published exactly as it is — the seller replaces or adds their own photos
// from the draft editor when they want something different. Screening stays,
// but only to keep other sellers' branding and foreign-language slides out.
//
// Badges on the main image (UK flag / FREE SHIPPING / border) are still
// available, all off by default — see config.imageGeneration.

async function finalBuffer(prepared) {
  // The original bytes, not the white-padded normalisation — eBay accepts
  // any shape ≥500px, and the seller asked for the photos untouched.
  return prepared.original || prepared.buffer;
}

/**
 * Prepares the shared gallery images for a listing.
 *
 * @returns { imageUrls: string[], warnings: string[] } — hosted (EPS) URLs in
 *          gallery order, hero first.
 */
async function buildGalleryImages({ sourceImageUrls, accessToken, marketplaceId, categoryId }) {
  const plan = slotPlan.planForCategory(categoryId);

  if (!sourceImageUrls.length) {
    return { imageUrls: [], warnings: ['This product had no source images to work from.'] };
  }

  // Screen BEFORE spending anything. Supplier galleries mix real photography
  // with junk — a live AliExpress listing served a 48×48 tracking thumbnail
  // among its product shots.
  const screened = (
    await Promise.all(
      sourceImageUrls.map(async (url) => {
        const prepared = await imageOps.prepare(url);
        return prepared ? { url, prepared } : null;
      })
    )
  ).filter(Boolean);

  if (!screened.length) {
    return { imageUrls: [], warnings: ["None of this product's photos met eBay's minimum image size."] };
  }

  // Resolution isn't the only way a supplier photo is unusable. Supplier
  // galleries are sales decks — infographic slides with text callouts sit
  // alongside the real photography, and eBay demotes listings whose images
  // carry text. This looks at what each image actually shows, drops the
  // marketing graphics, and puts the best product shot first (it becomes the
  // search thumbnail).
  const reviewed = await imageScreen.screenImages(screened.map((image) => image.prepared));
  const { usable, rejected } = imageScreen.rankScreened(reviewed);

  const warnings = [];
  let chosen = usable;
  if (!chosen.length) {
    // Every photo carries supplier branding or foreign text (a GPS-tag
    // listing shipped seven such slides). A listing with no images is worse
    // than one with them — the seller's call, flagged loudly.
    chosen = rankRejectedForListing(rejected);
    warnings.push(
      'Every supplier photo carries supplier branding or non-English text. They are used as-is because nothing ' +
        'cleaner exists — replace them with your own photos before publishing.'
    );
  } else if (!imageScreen.isHeroEligible(chosen[0].screen)) {
    warnings.push(
      'No clean photo of the whole product was found for the main image, so the best available one is used — ' +
        "eBay's picture policy is strictest on the main photo; consider replacing it."
    );
  }

  const finished = chosen.slice(0, plan.recommendedImages);
  const settings = config.imageGeneration;

  const shots = [];
  for (const [index, image] of finished.entries()) {
    let buffer = await finalBuffer(image);
    if (index === 0 && heroBadges.activeBadges(settings).length) {
      try {
        buffer = await heroBadges.brandHero(buffer, settings);
      } catch (err) {
        logger.warn('Hero badges failed — hero left plain', { error: err.message });
      }
    }
    shots.push({ ...image, buffer });
  }

  const skipped = sourceImageUrls.length - screened.length;
  if (skipped > 0) warnings.push(`${skipped} of the supplier's ${sourceImageUrls.length} photos were too small to use.`);
  if (usable.length && rejected.length) {
    warnings.push(
      `${rejected.length} of the supplier's photos carried supplier branding, prices or non-English text and were left out.`
    );
  }
  const soft = finished.filter(
    (image) => image.sourceMeta && Math.max(image.sourceMeta.width, image.sourceMeta.height) < imageOps.TARGET_SIZE
  ).length;
  if (soft) {
    warnings.push(
      `${soft} of ${finished.length} photos are below ${imageOps.TARGET_SIZE}px in the original, so they'll look soft when buyers zoom in.`
    );
  }
  const badges = heroBadges.activeBadges(settings);
  if (badges.length) {
    warnings.push(
      `The main image carries a ${badges.join(', ')}. eBay's picture policy discourages badges, text and borders and ` +
        `can reduce visibility for them — switch them off in the image settings if you'd rather not.`
    );
  }

  const imageUrls = await eps.uploadAll(accessToken, shots, { marketplaceId });
  return { imageUrls, warnings };
}

// Among rejected slides, the ones that at least photograph the whole product
// come first; collages last.
function rankRejectedForListing(rejected) {
  const score = (image) => {
    const screen = image.screen || {};
    if (screen.isCollage) return 3;
    if (screen.kind === 'product_photo' && screen.showsWholeProduct) return 0;
    if (screen.kind === 'product_photo') return 1;
    return 2;
  };
  return [...rejected].sort((a, b) => score(a) - score(b));
}

/**
 * Prepares one variant's own image: its supplier photo, as-is.
 *
 * Returns null when the variant has no photo of its own — deliberately, so
 * the caller can report the gap. Quietly substituting the shared gallery
 * photo would show every colour as the same picture, which is exactly the
 * pattern that drives "not as described" returns.
 */
async function buildVariantImage({ sourceImageUrl, accessToken, marketplaceId }) {
  if (!sourceImageUrl) return null;

  const prepared = await imageOps.prepare(sourceImageUrl);
  if (!prepared) return null;
  const buffer = await finalBuffer(prepared);

  try {
    return await eps.upload(accessToken, buffer, { marketplaceId });
  } catch (err) {
    logger.warn('EPS upload failed for a variant image — falling back to the source URL', { error: err.message });
    return prepared.sourceUrl;
  }
}

module.exports = { buildGalleryImages, buildVariantImage };
