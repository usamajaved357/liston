const imageOps = require('./image.ops');
const eps = require('./eps');
const slotPlan = require('./slot-plan');
const imageScreen = require('./image-screen.service');
const openaiImage = require('../image-generation/openai-image.service');
const config = require('../../../config');
const logger = require('../../../utils/logger');

// The gallery's shot list when generating real product photography: the hero
// first (it's the search thumbnail), then views a buyer actually wants before
// committing — an angle for depth, a close detail for finish, the product in
// use, the back. Each is a separate generation from the same reference photo.
const GALLERY_SHOTS = ['hero', 'angle', 'detail', 'in_use', 'back'];

// Three at once: enough to make a 5-shot gallery a ~1-2 minute job instead of
// four, few enough that a paid-tier account shouldn't see 429s. The
// per-variant heroes in the orchestrator are already parallel across
// distinct photos.
const GENERATION_CONCURRENCY = 3;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function useOpenAi() {
  return config.imageGeneration.provider === 'openai' && openaiImage.isConfigured();
}

// One generated photograph, normalised to eBay's shape. Returns null on any
// failure so the caller can fall back rather than lose the slot.
async function generateShot(referenceBuffers, variant, extraInstruction) {
  try {
    const png = await openaiImage.generateProductShot({ referenceImages: referenceBuffers, variant, extraInstruction });
    const squared = await imageOps.padToSquare(png);
    const check = await imageOps.validate(squared);
    if (!check.ok) return null;
    return { buffer: squared, sourceUrl: `generated:${variant}`, meta: check.meta, sourceMeta: check.meta, warnings: [] };
  } catch (err) {
    logger.warn('Generated shot failed — falling back', { variant, error: err.message });
    return null;
  }
}

// The listing image pipeline, in one place.
//
//   clean supplier photo → gpt-image-1 product shot (high input fidelity)
//     → 1600² square JPEG → eBay EPS
//
// One generator, no second tier. Gallery slots are distinct shots (hero,
// angle, detail, in use, back) from the same references so the product is
// identical across the set; each variant gets its own hero from its own
// supplier photo with the same prompt, so colours read as one product in
// several colours. When generation isn't configured or a shot fails, the
// clean supplier photo takes the slot — never a lesser model's output.

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

  if (useOpenAi() && (usable.length || rejected.length)) {
    return buildGeneratedGallery({ usable, rejected, sourceImageUrls, screened, accessToken, marketplaceId, plan });
  }

  // No generator configured: the gallery is the clean supplier photography,
  // screened and normalised, and nothing else. There is deliberately no
  // second-tier image model here — the earlier background-removal /
  // scene-compositing fallback produced images visibly worse than the source
  // photos it was meant to improve, so an untouched clean photo is the better
  // outcome. The draft carries a warning so the seller knows why.
  const shots = [...usable];
  const finished = shots.slice(0, plan.recommendedImages);

  const warnings = [];
  if (!useOpenAi()) {
    warnings.push('AI product photography is not configured (OPENAI_API_KEY) — the gallery uses the supplier photos as they are.');
  }
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

// Among rejected slides, the ones that at least photograph the whole product
// make better references than collages or screenshots.
function rankRejectedForReference(rejected) {
  const score = (image) => {
    const screen = image.screen || {};
    if (screen.isCollage) return 3;
    if (screen.kind === 'product_photo' && screen.showsWholeProduct) return 0;
    if (screen.kind === 'product_photo') return 1;
    return 2;
  };
  return [...rejected].sort((a, b) => score(a) - score(b));
}

// The OpenAI path. The best clean supplier photo (plus a second one when the
// gallery has it, e.g. front + back) is the reference for every shot, so the
// product stays identical across the set. If a shot fails, the clean supplier
// photo takes that slot rather than leaving a hole.
async function buildGeneratedGallery({ usable, rejected, sourceImageUrls, screened, accessToken, marketplaceId, plan }) {
  // Up to three clean supplier photos go in as references — front, back and
  // a detail where the gallery has them. A single reference showed the glove
  // from one side, and the model invented the other; with the palm shot
  // alongside, the grip pattern has somewhere to come from.
  // When the supplier gallery is nothing but infographic slides (a GPS tag
  // listing shipped seven — every one with headline text and callouts), the
  // slides are still the only pictures of the product that exist. They go in
  // as references for the generator, which reproduces the physical product
  // and not the slide, and they are never published themselves. Without this
  // the draft had no images at all. Confirmed live.
  const slidesOnly = !usable.length;
  const referenceSet = slidesOnly ? rankRejectedForReference(rejected) : usable;
  const references = referenceSet.slice(0, 3).map((image) => image.buffer);
  const extraInstruction = slidesOnly
    ? 'The reference images are marketing slides. Reproduce ONLY the physical product they show — ignore and omit every ' +
      'piece of text, headline, callout, arrow, icon, logo, watermark and decorative graphic. Output a clean photograph.'
    : undefined;
  const shots = [];

  // Generated concurrently. Each shot is ~40s, so five in sequence was four
  // minutes of the seller staring at a spinner — confirmed on a real draft.
  // Bounded so a burst can't trip OpenAI's per-minute image limit outright;
  // the service retries a 429 with backoff for anything that does. Order is
  // preserved, so the hero stays first.
  const results = await mapWithConcurrency(
    GALLERY_SHOTS.slice(0, plan.recommendedImages),
    GENERATION_CONCURRENCY,
    (variant) => generateShot(references, variant, extraInstruction)
  );
  for (const shot of results) if (shot) shots.push(shot);

  // Clean supplier photos not already represented fill any remaining slots —
  // a real photo of the actual product is still worth showing.
  for (const image of usable) {
    if (shots.length >= plan.recommendedImages) break;
    shots.push(image);
  }

  const warnings = [];
  const skipped = sourceImageUrls.length - screened.length;
  if (skipped > 0) warnings.push(`${skipped} of the supplier's ${sourceImageUrls.length} photos were too small to use.`);
  if (rejected.length) {
    warnings.push(
      `${rejected.length} of the supplier's photos were marketing graphics (text overlays or photo collages) — ` +
        `eBay doesn't allow those on listing images, so they were left out.`
    );
  }
  const generated = shots.filter((image) => image.sourceUrl.startsWith('generated:')).length;
  if (slidesOnly) {
    warnings.push(
      `Every supplier photo was a marketing slide, so the ${generated} listing image(s) were generated from them — ` +
        `check the product looks right before publishing.`
    );
  } else if (generated < GALLERY_SHOTS.length) {
    warnings.push(`${GALLERY_SHOTS.length - generated} generated shot(s) failed and were replaced with supplier photos.`);
  }
  if (!shots.length) {
    warnings.push('No usable listing images could be produced — add photos before publishing.');
  }
  const overlays = openaiImage.activeOverlays();
  if (overlays.length) {
    warnings.push(
      `Images carry a ${overlays.join(', ')}. eBay's picture policy discourages badges, text and borders on listing ` +
        `images and can reduce visibility for them — switch them off in the image settings if you'd rather not.`
    );
  }

  const imageUrls = await eps.uploadAll(accessToken, shots.slice(0, plan.recommendedImages), { marketplaceId });
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

  // With real generation available, each colour gets its own premium hero
  // from its own supplier photo — the same prompt every time, so the
  // variants read as one product in several colours.
  if (useOpenAi()) {
    const reference = await imageOps.prepare(sourceImageUrl);
    if (reference) {
      const shot = await generateShot([reference.buffer], 'hero');
      if (shot) {
        try {
          return await eps.upload(accessToken, shot.buffer, { marketplaceId });
        } catch (err) {
          logger.warn('EPS upload failed for a generated variant image', { error: err.message });
        }
      }
    }
  }

  // Without a generator (or when it failed above) the variant's own supplier
  // photo, normalised, is the honest choice — it is at least a real photo of
  // that exact colour.
  const prepared = await imageOps.prepare(sourceImageUrl);
  if (!prepared) return null;

  try {
    return await eps.upload(accessToken, prepared.buffer, { marketplaceId });
  } catch (err) {
    logger.warn('EPS upload failed for a variant image — falling back to the source URL', { error: err.message });
    return prepared.sourceUrl;
  }
}

module.exports = { buildGalleryImages, buildVariantImage };
