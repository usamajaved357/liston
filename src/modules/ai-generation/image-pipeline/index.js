const imageOps = require('./image.ops');
const eps = require('./eps');
const slotPlan = require('./slot-plan');
const heroBadges = require('./hero-badges');
const config = require('../../../config');
const logger = require('../../../utils/logger');

// The listing image pipeline, in one place.
//
//   supplier photo (the ones the seller kept, in their order) → size check
//     → badges on the hero only → EPS
//
// No generative model and no retouching. Both were tried: generation cost
// ~$0.20 an image and drifted from the product; sharpening/re-framing/badges
// didn't make the seller happier with the result. The supplier's file is
// published exactly as it is — the seller replaces or adds their own photos
// from the draft editor when they want something different. There is no AI
// photo check any more: the seller picks and orders the photos before
// drafting (step two of a new draft), and every photo they kept is used —
// a vision call per draft only to reorder them cost ~40% of drafting's AI
// spend.
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

  // Size check before anything is uploaded: supplier galleries can carry
  // junk — a live AliExpress listing served a 48×48 tracking thumbnail among
  // its product shots.
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

  const chosen = screened.map((image) => image.prepared);
  const warnings = [];

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

/** Every photo URL on a draft: gallery and variations. */
function draftImages(draft) {
  return [...new Set([...(draft.imageUrls || []), ...(draft.variants || []).flatMap((v) => v.imageUrls || [])].filter(Boolean))];
}

/**
 * The draft with its photos swapped by `hosted` (old URL → new) and the
 * `dropped` ones left out; a variation that loses its only photo takes the
 * main photo.
 */
function swapDraftImages(draft, hosted, dropped = []) {
  const swap = (urls) => [...new Set((urls || []).map((url) => hosted.get(url) || url).filter((url) => !dropped.includes(url)))];
  const imageUrls = swap(draft.imageUrls);
  const next = { ...draft, imageUrls };
  if (Array.isArray(draft.variants)) {
    next.variants = draft.variants.map((variant) => {
      const own = swap(variant.imageUrls);
      return { ...variant, imageUrls: own.length ? own : imageUrls.slice(0, 1) };
    });
  }
  return next;
}

/**
 * Puts every photo of a draft on eBay's picture service, under this seller
 * account, before it's sent.
 *
 * eBay refuses a listing whose photos mix its own hosting with anyone
 * else's ("A mixture of Self Hosted and EPS pictures are not allowed"): a
 * supplier-hosted photo (an upload that failed while the draft was built),
 * or an eBay photo uploaded under ANOTHER seller account (the picture cache
 * used to share uploads between accounts). Each is uploaded again here;
 * `force` does it for every photo. One that still won't go is left out (a
 * variation that loses its only photo takes the main photo) and said so.
 * `ok` is false when no main photo could be hosted at all.
 *
 * @returns { draft, changed, dropped: string[], hosted: Map, ok }
 */
async function hostDraftImages(draft, { accessToken, marketplaceId, account, force = false }) {
  const pending = force
    ? draftImages(draft)
    : [...new Set([...unhostedImages(draft), ...(await eps.foreignUrls(draftImages(draft).filter(eps.isEbayHosted), account))])];
  if (!pending.length) return { draft, changed: false, dropped: [], hosted: new Map(), ok: true };

  const hosted = new Map();
  const dropped = [];
  await Promise.all(
    pending.map(async (url) => {
      try {
        hosted.set(url, await eps.hostUrl(accessToken, url, { marketplaceId, account, force: true }));
      } catch (err) {
        logger.warn('Photo could not be put on eBay. Left out of the listing', { sourceUrl: url, error: err.message });
        dropped.push(url);
      }
    })
  );

  const next = swapDraftImages(draft, hosted, dropped);
  return { draft: next, changed: true, dropped, hosted, ok: next.imageUrls.length > 0 };
}

module.exports = { buildGalleryImages, buildVariantImage, unhostedImages, hostDraftImages, swapDraftImages, draftImages };
