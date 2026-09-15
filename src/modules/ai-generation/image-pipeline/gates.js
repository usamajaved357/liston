const slotPlan = require('./slot-plan');

// Checks that run before a draft is allowed to go live.
//
// The point of a gate is that it fails LOUDLY and is fixable, rather than
// letting a half-built listing reach buyers. The two hard rules here are the
// ones that would otherwise produce a listing that technically publishes but
// performs badly:
//
//   * too few images to look like a real listing
//   * a variation listing where some variants have no photo of their own
//
// Neither is auto-fixable without lying (filling a missing variant hero with
// the shared photo would show every colour as the same picture), so they're
// reported for the seller to resolve.

/**
 * @returns { ok, errors, warnings } — errors block publishing, warnings don't.
 */
function checkDraftImages(draftInput, { categoryId } = {}) {
  const plan = slotPlan.planForCategory(categoryId || draftInput.categoryId);
  const errors = [];
  const warnings = [];

  const galleryImages = draftInput.imageUrls || [];
  if (!galleryImages.length) {
    errors.push('This listing has no images. eBay requires at least one.');
  } else if (galleryImages.length < plan.minImages) {
    warnings.push(
      `Only ${galleryImages.length} image${galleryImages.length === 1 ? '' : 's'} — listings with at least ` +
        `${plan.recommendedImages} tend to sell better.`
    );
  }

  const variants = draftInput.variants;
  if (Array.isArray(variants) && variants.length) {
    // eBay refuses an inventory item group where any variation has no image
    // at all ("imageUrls cannot be null or empty"), so the orchestrator fills
    // any gap from the main gallery before the draft is ever sent. This stays
    // as a backstop for a draft that reached here some other way.
    const missing = variants.filter((variant) => !variant.imageUrls?.length);
    if (missing.length) {
      errors.push(
        `${missing.length} of ${variants.length} variations have no image. eBay requires every variation to ` +
          `carry at least one photo.`
      );
    }

    // Distinct photos per variant, not the same one repeated — the whole
    // reason a buyer looks at a variation gallery.
    const urls = variants.flatMap((variant) => variant.imageUrls || []);
    if (urls.length && new Set(urls).size === 1 && variants.length > 1) {
      warnings.push('Every variation is showing the same photo, so buyers can’t tell them apart visually.');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { checkDraftImages };
