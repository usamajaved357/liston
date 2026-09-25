// Variation photos belong to one option, not to one row.
//
// eBay shows a photo per value of ONE variation attribute (the group's
// aspectsImageVariesBy): on a Colour × Size listing every "Red" row shows
// Red's photo, whatever the size. A photo set on the "Red / M" row alone was
// lost: eBay took Red's photo from whichever Red row came first, and a
// listing that named no photo attribute showed none of them. So a photo set
// on a row goes to every row with the same value, and eBay is told which
// attribute the photos follow.

const PHOTO_LIKE = /colou?r|pattern|style|design|print|flavou?r|scent|finish/i;

/** The attribute a draft's variation photos follow. */
function photoAxis(draft) {
  const names = (draft.variesBy?.specifications || []).map((spec) => spec.name);
  const set = draft.variesBy?.aspectsImageVariesBy?.[0];
  if (set && names.includes(set)) return set;
  if (names.length <= 1) return names[0] || null;
  return names.find((name) => PHOTO_LIKE.test(name)) || names[0];
}

const sameList = (a = [], b = []) => a.length === b.length && a.every((url, i) => url === b[i]);

/**
 * Every variation of one option gets the same photos. `changed` are the
 * rows whose photo the seller just set; theirs wins for their option,
 * otherwise the option's first row with a photo does. When the options
 * end up with different photos, the draft names the attribute they follow.
 * Returns the same object when nothing needed to change.
 */
function alignVariantPhotos(draft, changed = []) {
  const variants = draft.variants;
  if (!Array.isArray(variants) || !variants.length) return draft;
  const axis = photoAxis(draft);
  if (!axis) return draft;
  const valueOf = (variant) => variant?.aspects?.[axis]?.[0];

  const photos = new Map();
  for (const index of changed) {
    const variant = variants[Number(index)];
    if (valueOf(variant) !== undefined && variant.imageUrls?.length) photos.set(valueOf(variant), variant.imageUrls);
  }
  for (const variant of variants) {
    const value = valueOf(variant);
    if (value !== undefined && !photos.has(value) && variant.imageUrls?.length) photos.set(value, variant.imageUrls);
  }

  const aligned = variants.map((variant) => {
    const own = photos.get(valueOf(variant));
    return own && !sameList(own, variant.imageUrls) ? { ...variant, imageUrls: own } : variant;
  });
  const differ = new Set([...photos.values()].map((urls) => urls[0])).size > 1;
  const name = differ && draft.variesBy && draft.variesBy.aspectsImageVariesBy?.[0] !== axis;
  // The same draft back when nothing moved, so callers can tell.
  if (!name && aligned.every((variant, i) => variant === variants[i])) return draft;
  return { ...draft, variants: aligned, ...(name ? { variesBy: { ...draft.variesBy, aspectsImageVariesBy: [axis] } } : {}) };
}

module.exports = { photoAxis, alignVariantPhotos };
