const imageTransformer = require('../image-transformer.service');
const imageOps = require('./image.ops');
const eps = require('./eps');
const slotPlan = require('./slot-plan');
const imageScreen = require('./image-screen.service');
const logger = require('../../../utils/logger');

// The listing image pipeline, in one place.
//
//   source photo → AI treatment (selective) → 1600² square JPEG → eBay EPS
//
// Two deliberate decisions about the AI step, both about consistency:
//
//  * GALLERY images get a generated scene. That's where a supplier snapshot
//    becomes something that looks professionally shot, and where the payoff
//    is largest.
//  * PER-VARIANT images do NOT. A generated scene is different every time, so
//    compositing each colour separately makes them look like photos of
//    different products rather than one product in five colours. Those get
//    background removal onto white instead, which is the same treatment every
//    time — the colours stay comparable, which is the entire point of showing
//    them side by side.
//
// Cost falls out of the same decision: a handful of paid calls per draft
// instead of one per variant.

// Sourcing priority, per slot: a real photo of the actual product beats a
// generated one for buyer trust and return rates, so AI only ever *treats* a
// real photo — it never invents a product shot from nothing.
async function treatGalleryImage(url, scenePrompt) {
  const [treated] = await imageTransformer.transformImages([url], scenePrompt);
  return treated || url;
}

/**
 * Prepares the shared gallery images for a listing.
 * Returns { imageUrls, warnings } — URLs are eBay-hosted and permanent.
 */
async function buildGalleryImages({
  sourceImageUrls,
  scenePrompt,
  scenePrompts,
  accessToken,
  marketplaceId,
  categoryId,
}) {
  const plan = slotPlan.planForCategory(categoryId);
  // One brief per intended gallery slot. A single prompt still works (older
  // callers, and the model's main shot) — it just yields a one-shot gallery.
  const briefs = (scenePrompts?.length ? scenePrompts : [scenePrompt]).filter(Boolean);

  if (!sourceImageUrls.length) {
    return { imageUrls: [], warnings: ['This product had no source images to work from.'] };
  }

  // Screen BEFORE spending anything. Supplier galleries mix real photography
  // with junk — a live AliExpress listing served a 48×48 tracking thumbnail
  // among its product shots — and compositing is a paid, ~17s call, so it
  // should never be spent on an image that was never going to be listed.
  // Screening first also means the treatment lands on the best images
  // available rather than whichever happened to come first.
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
  // galleries are sales decks — infographic slides with text callouts and
  // arrows sit alongside the real photography, and eBay demotes listings
  // whose images carry text. This looks at what each image actually shows,
  // drops the marketing graphics, and puts the best product shot first
  // (it becomes the search thumbnail).
  const reviewed = await imageScreen.screenImages(screened.map((image) => image.prepared));
  const { usable: ranked, rejected } = imageScreen.rankScreened(reviewed);

  const usable = ranked.slice(0, plan.recommendedImages);

  // Supplier galleries rarely leave enough clean photography behind: a real
  // iPhone-case listing had 10 of its 13 photos rejected as marketing
  // graphics, leaving a single usable shot. A one-image listing looks
  // abandoned next to a competitor's eight.
  //
  // So the gallery is BUILT rather than merely filtered. Each photography
  // brief becomes a distinct generated scene from the best clean photo
  // available — genuinely our own imagery, and the only honest way to match a
  // competitor's gallery without touching their copyrighted photos.
  const shots = [];
  for (const [index, brief] of briefs.entries()) {
    // Prefer a different real photo per brief while they last — real
    // photography of the actual product beats a generated variation of the
    // same shot. Past that, reuse the best photo with a new scene, which is
    // where the extra gallery slots come from.
    const reusingBase = index >= usable.length;
    const base = usable[Math.min(index, usable.length - 1)];
    if (!base) break;

    try {
      const treatedUrl = await treatGalleryImage(base.sourceUrl, brief);
      if (treatedUrl === base.sourceUrl) {
        // Nothing was generated (no key, or the provider failed). Keep the
        // untouched original only if it isn't already in the gallery.
        if (!reusingBase) shots.push(base);
        continue;
      }
      const prepared = await imageOps.prepare(treatedUrl);
      if (prepared) shots.push(prepared);
      else if (!reusingBase) shots.push(base);
    } catch (err) {
      logger.warn('Image treatment failed — keeping the original photo', {
        url: base.sourceUrl,
        error: err.message,
      });
      if (!reusingBase) shots.push(base);
    }
  }

  // Any clean photo not already represented still belongs in the gallery.
  const usedSources = new Set(shots.map((image) => image.sourceUrl));
  for (const image of usable) {
    if (shots.length >= plan.recommendedImages) break;
    if (!usedSources.has(image.sourceUrl)) shots.push(image);
  }

  const finished = shots.slice(0, plan.recommendedImages);

  const warnings = [];
  const skipped = sourceImageUrls.length - screened.length;
  if (skipped > 0) {
    warnings.push(`${skipped} of the supplier's ${sourceImageUrls.length} photos were too small to use.`);
  }
  if (rejected.length) {
    warnings.push(
      `${rejected.length} of the supplier's photos were marketing graphics (text overlays or photo collages) — ` +
        `eBay doesn't allow those on listing images, so they were left out.`
    );
  }

  // Aggregated rather than repeated per image — four copies of the same
  // sentence is noise, one sentence with a count is information.
  const soft = finished.filter((image) => image.sourceMeta && Math.max(image.sourceMeta.width, image.sourceMeta.height) < imageOps.TARGET_SIZE).length;
  if (soft) {
    warnings.push(
      `${soft} of ${finished.length} photos are below ${imageOps.TARGET_SIZE}px in the original, so they'll look ` +
        `soft when buyers zoom in.`
    );
  }

  const imageUrls = await eps.uploadAll(accessToken, finished, { marketplaceId });
  return { imageUrls, warnings };
}

/**
 * Prepares one variant's own image.
 *
 * Returns null when the variant has no photo of its own — deliberately, so
 * the caller can report the gap. Quietly substituting the shared gallery
 * photo would show every colour as the same picture, which is exactly the
 * pattern that drives "not as described" returns.
 */
async function buildVariantImage({ sourceImageUrl, accessToken, marketplaceId }) {
  if (!sourceImageUrl) return null;

  let treated = sourceImageUrl;
  try {
    // Background removal, not scene generation — see the note at the top.
    treated = await imageTransformer.removeBackground(sourceImageUrl);
  } catch (err) {
    logger.warn('Variant background removal failed — keeping the original photo', {
      url: sourceImageUrl,
      error: err.message,
    });
  }

  const prepared = await imageOps.prepare(treated);
  if (!prepared) return null;

  try {
    return await eps.upload(accessToken, prepared.buffer, { marketplaceId });
  } catch (err) {
    logger.warn('EPS upload failed for a variant image — falling back to the source URL', { error: err.message });
    return prepared.sourceUrl;
  }
}

module.exports = { buildGalleryImages, buildVariantImage };
