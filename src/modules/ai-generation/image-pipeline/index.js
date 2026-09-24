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
  } else {
    if (!imageScreen.isHeroEligible(chosen[0].screen)) {
      warnings.push(
        'No clean photo of the whole product was found for the main image, so the best available one is used — ' +
          "eBay's picture policy is strictest on the main photo; consider replacing it."
      );
    }
    // Every supplier photo is kept (the seller wants all of them): the ones
    // carrying text, prices or another seller's branding go last, so the
    // main photo and the first few stay clean, and the seller decides.
    if (rejected.length) chosen = [...usable, ...rankRejectedForListing(rejected)];
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
        logger.warn('Hero badges failed. Hero left plain', { error: err.message });
      }
    }
    shots.push({ ...image, buffer });
  }

  const skipped = sourceImageUrls.length - screened.length;
  if (skipped > 0) {
    warnings.push(
      `${skipped} of the supplier's ${sourceImageUrls.length} photos couldn't be used: too small for eBay (under 250px) or they wouldn't download.`
    );
  }
  const enlarged = finished.filter((image) => image.enlargedFrom).length;
  if (enlarged) {
    warnings.push(`${enlarged} small photo${enlarged === 1 ? ' was' : 's were'} enlarged to eBay's 500px minimum, so ${enlarged === 1 ? 'it' : 'they'}'ll look soft.`);
  }
  if (usable.length && rejected.length) {
    warnings.push(
      `The last ${rejected.length} photo${rejected.length === 1 ? '' : 's'} carr${rejected.length === 1 ? 'ies' : 'y'} text, prices or another seller's branding. ` +
        'eBay can show listings with text on their photos lower, so delete them in the editor if you want.'
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
    logger.warn('EPS upload failed for a variant image. Falling back to the source URL', { error: err.message });
    return prepared.sourceUrl;
  }
}

/** The draft's photos (gallery and variations) that aren't on eBay yet. */
function unhostedImages(draft) {
  const all = [...(draft.imageUrls || []), ...(draft.variants || []).flatMap((v) => v.imageUrls || [])];
  return [...new Set(all.filter((url) => url && !eps.isEbayHosted(url)))];
}

/**
 * Puts every photo of a draft on eBay's picture service before it's sent.
 *
 * eBay refuses a listing whose photos mix its own hosting with anyone
 * else's ("A mixture of Self Hosted and EPS pictures are not allowed"), and
 * a draft gets supplier-hosted photos whenever an upload failed while it was
 * built. Each one is uploaded again here; one that still won't go is left
 * out (a variation that loses its only photo takes the main photo) and said
 * so. `ok` is false when no main photo could be hosted at all.
 *
 * @returns { draft, changed, dropped: string[], ok }
 */
async function hostDraftImages(draft, { accessToken, marketplaceId }) {
  const pending = unhostedImages(draft);
  if (!pending.length) return { draft, changed: false, dropped: [], ok: true };

  const hosted = new Map();
  const dropped = [];
  await Promise.all(
    pending.map(async (url) => {
      try {
        hosted.set(url, await eps.hostUrl(accessToken, url, { marketplaceId }));
      } catch (err) {
        logger.warn('Photo could not be put on eBay. Left out of the listing', { sourceUrl: url, error: err.message });
        dropped.push(url);
      }
    })
  );

  const swap = (urls) => [...new Set((urls || []).map((url) => hosted.get(url) || url).filter((url) => !dropped.includes(url)))];
  const imageUrls = swap(draft.imageUrls);
  const next = { ...draft, imageUrls };
  if (Array.isArray(draft.variants)) {
    next.variants = draft.variants.map((variant) => {
      const own = swap(variant.imageUrls);
      return { ...variant, imageUrls: own.length ? own : imageUrls.slice(0, 1) };
    });
  }
  return { draft: next, changed: true, dropped, ok: imageUrls.length > 0 };
}

module.exports = { buildGalleryImages, buildVariantImage, unhostedImages, hostDraftImages };
