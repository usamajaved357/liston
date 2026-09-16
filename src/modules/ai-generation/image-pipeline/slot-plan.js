// Structure first, model last.
//
// A gallery isn't "some images" — it's a set of roles a buyer expects to see
// filled: what the product looks like, from another angle, in use, how big it
// is, what arrives in the box. Deciding that structure up front and then
// filling it is what separates a listing that looks professionally shot from
// one that looks like a supplier dump.
//
// The hero is per-variation on purpose: when a listing varies by colour, each
// colour needs its own thumbnail. One shared photo across every colour is the
// pattern eBay's search ranking penalises and the single biggest driver of
// "not as described" returns.

const DEFAULT_SLOTS = [
  { key: 'hero', role: 'gallery', perVariation: true, required: true, composite: true },
  { key: 'angle', role: 'detail', perVariation: false, required: false, composite: true },
  { key: 'in_use', role: 'lifestyle', perVariation: false, required: false, composite: true },
  { key: 'scale', role: 'detail', perVariation: false, required: false, composite: false },
  { key: 'packaging', role: 'detail', perVariation: false, required: false, composite: false },
];

// eBay allows 24 images. Every usable supplier photo is listed (the seller
// drops what they don't want in the editor) — an earlier cap of 5 quietly
// hid the rest of the gallery.
const EBAY_MAX_IMAGES = 24;

const DEFAULT_PLAN = {
  minImages: 3,
  recommendedImages: EBAY_MAX_IMAGES,
  slots: DEFAULT_SLOTS,
  // Never true. eBay's automated systems flag text, watermarks, borders and
  // badges on images and suppress the listing's visibility — the opposite of
  // Amazon's conventions. Every spec, feature and trust claim belongs in the
  // description and item specifics, never burned into pixels. Kept as an
  // explicit field so the rule is auditable rather than implicit.
  textAllowedOnImage: false,
};

// Per-category overrides go here as they're learned. Categories are keyed by
// eBay leaf category id, so a rule only ever applies where it was validated.
const CATEGORY_PLANS = {};

function planForCategory(categoryId) {
  return CATEGORY_PLANS[String(categoryId)] || DEFAULT_PLAN;
}

// How many of the source's gallery images are worth compositing. Compositing
// is a paid, ~17s call each, and past the first few shots the returns fall
// off sharply — so only the slots marked composite:true get one.
function compositeSlotCount(plan = DEFAULT_PLAN) {
  return plan.slots.filter((slot) => slot.composite && !slot.perVariation).length;
}

module.exports = { DEFAULT_PLAN, DEFAULT_SLOTS, planForCategory, compositeSlotCount };
