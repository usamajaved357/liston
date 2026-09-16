const ebaySource = require('../sourcing/ebay-listing.source');
const ebayTaxonomy = require('../ebay/ebay.taxonomy');
const aliexpressSource = require('../sourcing/aliexpress');
const { capVariants } = require('../scraping/aliexpress-listing.scraper');
const textGenerator = require('./text-generator.service');
const imagePipeline = require('./image-pipeline');
const { ScrapingError } = require('../scraping/scraping.errors');
const pricingService = require('../pricing/pricing.service');
const priceParser = require('../pricing/price-parser');
const { PricingError } = require('../pricing/pricing.service');

// How many gallery images to build, which of them get a paid AI treatment,
// and the per-variation hero rule all live in the image pipeline's slot plan
// (see image-pipeline/slot-plan.js) rather than as a bare cap here.

// eBay requires every variation in a group to carry a DISTINCT value for the
// varying aspect — two variants both labelled "Warm White" is a rejected
// inventory item group, not a listing with a duplicate.
//
// The model is asked to tidy each supplier option into a clean eBay value,
// and it can over-tidy: a real product with options "1PC Warm White" …
// "4PCS Cold White" came back as four "Warm White"s and four "Cool White"s,
// because it read the axis as colour and dropped the pack size (confirmed
// live). When the cleaned values collide, fall back to the supplier's own
// labels for ALL of them — those are the real purchasable options, so they're
// unique by construction, and a consistent set beats a mix of tidied and raw.
// Tidies the first axis's option labels via the model's mapping, keeping the
// supplier's own labels whenever the tidied set would collide (see below).
// Multi-axis products index by that axis's value rather than by position,
// because the same colour repeats across every model in the matrix.
// A source that predates `variantAxes` (or any caller passing plain variants)
// still has the axis names sitting on the attributes themselves.
function deriveAxesFromVariants(variants) {
  const names = [...new Set(variants.flatMap((variant) => Object.keys(variant.attributes || {})))];
  return names.map((name) => ({
    name,
    values: [...new Set(variants.map((variant) => variant.attributes[name]).filter(Boolean))],
    hasImages: variants.some((variant) => Boolean(variant.imageUrl)),
  }));
}

function cleanPrimaryAxisValues(variants, primaryAxis, content) {
  const labels = variants.map((variant) => variant.attributes[primaryAxis.name]);
  const distinctLabels = [...new Set(labels)];

  const mapping = content.variantAspectValues || {};
  const cleanedByLabel = new Map(distinctLabels.map((label) => [label, mapping[label] || label]));

  // Two supplier options tidied to the same eBay value would collapse two
  // real variations into one — eBay rejects the group. Fall back to the
  // supplier's labels wholesale rather than mixing tidied and raw.
  const cleanedValues = [...cleanedByLabel.values()].map((v) => String(v).trim().toLowerCase());
  if (new Set(cleanedValues).size !== distinctLabels.length) {
    return labels;
  }
  return labels.map((label) => cleanedByLabel.get(label));
}

function resolveVariantAspectValues(variants, variantAspectValues = {}) {
  const labels = variants.map((variant) => Object.values(variant.attributes)[0]);
  const cleaned = labels.map((label) => variantAspectValues[label] || label);

  const isDistinct = new Set(cleaned.map((value) => String(value).trim().toLowerCase())).size === cleaned.length;
  return isDistinct ? cleaned : labels;
}

// Turns the supplier's own prices into eBay sell prices that hit the seller's
// target return, per variant.
//
// The catch worth understanding: per-SKU costs are only reliably available
// through AliExpress's official API. The browser scraper reads the ONE price
// the page happens to be displaying — AliExpress moved its SKU data out of
// the page globals, and driving the UI to read each option back failed on 7
// of 8 options in testing. So when per-variant costs are missing, every
// variant is priced from the single product cost, which is correct for
// colour/size options and WRONG for quantity tiers ("1PC" vs "4PCS" are not
// the same purchase). That case is detected and surfaced loudly rather than
// quietly producing a 4-pack priced like a single unit.
function resolvePricing({ source, competitor, pricing }) {
  const settings = pricingService.settingsWithDefaults(pricing);
  const currency = settings.currency;
  const warnings = [];

  // What the competitor actually charges — the market's own answer to "what
  // does this sell for". It can only raise our price, never lower it (see
  // priceForCost). Their lowest price is used as the reference: on a
  // multi-variation competitor listing it's the "from" price buyers see, and
  // it's the conservative choice, since matching their most expensive option
  // would assume our variant is comparable to it.
  const competitorPrice = lowestCompetitorPrice(competitor, currency);

  const productPriceParsed = priceParser.parsePrice(source.priceText, currency);
  if (!productPriceParsed.ok) {
    throw new PricingError(pricingFailureMessage(productPriceParsed, currency, source.priceText));
  }

  const productCost = productPriceParsed.amount;
  const productPrice = pricingService.priceForCost(productCost, settings, { competitorPrice });

  // A variant that carries its own price is priced from it; otherwise it
  // inherits the product-level cost.
  const variantPrices = source.variants.map((variant) => {
    const parsed = priceParser.parsePrice(variant.priceText, currency);
    const cost = parsed.ok ? parsed.amount : productCost;
    return { ...pricingService.priceForCost(cost, settings, { competitorPrice }), costIsExact: parsed.ok };
  });

  const anyExact = variantPrices.some((price) => price.costIsExact);
  const labels = source.variants.map((variant) => Object.values(variant.attributes)[0]);

  if (source.variants.length && !anyExact) {
    if (pricingService.detectQuantityTiers(labels)) {
      // The dangerous case, called out in plain terms: these options cost
      // different amounts and we only know one of them.
      warnings.push(
        `⚠ These options look like different pack sizes (${labels.slice(0, 3).join(', ')}…), which cost different ` +
          `amounts — but the supplier page only exposed one price (${currency} ${productCost.toFixed(2)}), so every ` +
          `option has been priced from it. CHECK THE LARGER PACKS BEFORE PUBLISHING: they are almost certainly ` +
          `underpriced. Connecting the AliExpress API would price each option from its real cost.`
      );
    } else {
      warnings.push(
        `Each option is priced from the supplier's single listed cost of ${currency} ${productCost.toFixed(2)}, ` +
          `since the page didn't expose a price per option.`
      );
    }
  }

  if (productPriceParsed.isRange && !anyExact) {
    warnings.push(
      `The supplier shows a price range, so the lowest (${currency} ${productCost.toFixed(2)}) was used as the ` +
        `cost — options that cost more than this will earn less than your target.`
    );
  }

  if (competitorPrice === null) {
    warnings.push(
      `Couldn't read the competitor's price, so everything is priced at your ${settings.targetRoiPercent}% target ` +
        `return. If they sell for more than that, you may be leaving margin on the table.`
    );
  }
  // Which basis won (competitor price vs. ROI floor) is shown in the price
  // breakdown on the draft itself, so it isn't repeated as a warning.

  return { currency, productCost, productPrice, variantPrices, competitorPrice, warnings };
}

// The competitor's own asking price, in our currency. Browse quotes in the
// marketplace's currency (GBP on EBAY_GB), but it's parsed and checked rather
// than assumed — a mismatch returns null so the competitor signal is simply
// dropped, never misread into a wrong price.
function lowestCompetitorPrice(competitor, currency) {
  if (!competitor) return null;

  const candidates = [competitor.priceText, ...(competitor.variants || []).map((variant) => variant.priceText)]
    .map((text) => priceParser.parsePrice(text, currency))
    .filter((parsed) => parsed.ok)
    .map((parsed) => parsed.amount);

  return candidates.length ? Math.min(...candidates) : null;
}

function pricingFailureMessage(parsed, expectedCurrency, rawText) {
  if (parsed.reason === 'wrong-currency') {
    return (
      `The supplier's price came back in ${parsed.currency} ("${rawText}") rather than ${expectedCurrency}, so it ` +
      `can't be used to work out a sell price. Liston never converts currencies with an assumed rate. Try again, ` +
      `or set the currency in Listing settings to match.`
    );
  }
  if (parsed.reason === 'unknown-currency') {
    return `Couldn't tell what currency the supplier's price ("${rawText}") is in, so it can't be priced safely.`;
  }
  return "Couldn't read a price from the supplier's page, so there's no cost to work a sell price out from.";
}

// Ties source ingestion + AI text generation + image transformation together
// into a draftInput-shaped object ready for listingService.createEbayDraft —
// SKUs are intentionally left unset here; the caller (listingService) assigns
// them right before persisting, since SKU generation is a listing-lifecycle
// concern, not a content-generation one.
//
// The two sides are deliberately asymmetric. The competitor is read through
// eBay's official Browse API (an authenticated read of public data — fast,
// and impossible to be bot-blocked); the AliExpress source still goes through
// a real browser, because AliExpress has no equivalent open read API we're
// registered for yet. Both return the same normalized shape.
const ORIGIN_ASPECT = 'Country/Region of Manufacture';

function applyOrigin(aspects = {}, countryOfOrigin) {
  if (!countryOfOrigin) return aspects;
  const cleaned = Object.fromEntries(
    Object.entries(aspects).filter(([name]) => !/country|origin|region of manufacture/i.test(name))
  );
  return { ...cleaned, [ORIGIN_ASPECT]: [countryOfOrigin] };
}

// STEP ONE of drafting: read both listings and nothing else. No AI, no
// images, no cost — just enough for the seller to see what the supplier
// offers and choose which variations to actually list. Nobody lists all 162
// combinations of a phone case, and generating photography for variations
// that get deleted afterwards is money and minutes thrown away.
async function readSources({ competitorUrl, sourceUrl, marketplaceId = 'EBAY_GB' }) {
  // The AliExpress scrape is by far the slowest step (a real browser, ~30s),
  // so it starts first and everything cheap overlaps with it. Kept as a
  // floating promise deliberately — awaited below.
  const sourcePromise = aliexpressSource.fetchProduct(sourceUrl);
  // Attached immediately so a scrape that rejects before we await it can't
  // surface as an unhandled rejection and take the process down.
  sourcePromise.catch(() => {});

  const competitor = await ebaySource.fetchListing(competitorUrl, marketplaceId);

  // The AI never invents this — eBay category IDs aren't guessable from a
  // title/breadcrumb, and a wrong one gets the offer rejected (or silently
  // mis-categorized). Browse returns the competitor's real leaf category id.
  if (!competitor.categoryId) {
    throw new ScrapingError(
      "Couldn't determine the competitor listing's eBay category — try a different competitor URL.",
      { source: 'ebay' }
    );
  }

  const source = await sourcePromise;
  return { competitor, source };
}

// Keeps only the variations whose value on EVERY axis was selected. A
// selection of {Colour: [Black], Model: [15 Pro, 16]} yields exactly the two
// Black combinations — the cartesian product of what was ticked, restricted
// to combinations the supplier actually offers.
function selectVariants(source, selection) {
  if (!selection || !Object.keys(selection).length) return source;

  const variants = (source.variants || []).filter((variant) =>
    Object.entries(variant.attributes).every(([axis, value]) => {
      const chosen = selection[axis];
      return !chosen || chosen.includes(value);
    })
  );

  const variantAxes = (source.variantAxes || []).map((axis) => ({
    ...axis,
    values: axis.values.filter((value) => !selection[axis.name] || selection[axis.name].includes(value)),
  }));

  return { ...source, variants, variantAxes };
}

// STEP TWO: everything that costs something — AI text, image generation,
// eBay uploads — run only over the variations the seller kept.
async function generateDraftInput({
  competitorUrl,
  sourceUrl,
  // Already-read listings (from readSources) and the seller's variation
  // choice. When absent, both listings are read here — the single-call path
  // is still valid for callers that don't need a selection step.
  competitor: competitorIn,
  source: sourceIn,
  variantSelection,
  // The connection's Listing settings (target ROI, ads/processing fees, fixed
  // fee, shipping). Prices are DERIVED from the supplier's own cost and these
  // — the seller no longer types a cost or a sell price per draft.
  pricing,
  merchantLocationKey,
  marketplaceId = 'EBAY_GB',
  countryOfOrigin = 'United Kingdom',
  // The seller's own eBay token. Needed because finished images are uploaded
  // to eBay Picture Services under their account, which is what makes the
  // URLs permanent (and is the only way eBay can serve images we generated).
  accessToken,
}) {
  const read =
    competitorIn && sourceIn ? { competitor: competitorIn, source: sourceIn } : await readSources({ competitorUrl, sourceUrl, marketplaceId });
  const competitor = read.competitor;
  // Selection first, cap second: the seller sees every option the supplier
  // offers, and only what survives their choice is subject to the listing
  // size limit.
  let source = capVariants(selectVariants(read.source, variantSelection));

  if ((read.source.variants || []).length && !source.variants.length) {
    throw new ScrapingError('None of the variations you selected exist on the supplier listing.', { source: 'aliexpress' });
  }

  // Exactly one combination chosen is not a variation listing — it's a
  // plain listing of that combination. Built as a one-variant group, its
  // colour and model sat on the variant instead of the listing, so eBay's
  // required "Colour" came up empty (confirmed on a real draft). Fold the
  // chosen attributes into the item specifics and draft it as a single SKU.
  if (source.variants.length === 1) {
    const [only] = source.variants;
    source = {
      ...source,
      specifics: { ...(source.specifics || {}), ...only.attributes },
      imageUrls: only.imageUrl ? [only.imageUrl, ...(source.imageUrls || []).filter((u) => u !== only.imageUrl)] : source.imageUrls,
      priceText: only.priceText || source.priceText,
      variants: [],
      variantAxes: [],
    };
  }

  // eBay publishes the exact item specifics it expects for this category —
  // which are required, which accept only listed values. The model drafts
  // against that real schema instead of guessing, and its answer is validated
  // against it before the user ever sees the draft.
  const aspectSchema = await ebayTaxonomy.getAspectSchema(marketplaceId, competitor.categoryId);

  // Costs and prices are worked out before drafting so the model can be told
  // the real numbers, and so a pricing problem (wrong currency, unreadable
  // price) fails fast instead of after a paid AI call.
  const priced = resolvePricing({ source, competitor, pricing });

  const content = await textGenerator.generateListingContent({
    competitor,
    source,
    costPrice: priced.productCost,
    sellPrice: priced.productPrice.sellPrice,
    currency: priced.currency,
    aspectSchema,
  });

  const hasVariants = source.variants.length > 0;

  // The seller's stated origin, always. Supplier and competitor data both say
  // China, and it was being copied straight into "Country of Origin". eBay's
  // aspect for this is "Country/Region of Manufacture"; any origin-shaped
  // aspect the model produced is replaced, and the standard one is set.
  const aspectsKey = hasVariants ? 'sharedAspects' : 'aspects';
  content[aspectsKey] = applyOrigin(content[aspectsKey], countryOfOrigin);

  const { imageUrls: galleryImageUrls, warnings: imageWarnings } = await imagePipeline.buildGalleryImages({
    sourceImageUrls: source.imageUrls,
    accessToken,
    marketplaceId,
    categoryId: competitor.categoryId,
  });

  // Surfaced on the review page so the seller sees what the automated steps
  // couldn't do, rather than discovering it on a live listing.
  const warnings = [...priced.warnings, ...(content.aspectWarnings || []), ...imageWarnings];

  if (!hasVariants) {
    return {
      draftInput: {
        title: content.title,
        description: content.description,
        imageUrls: galleryImageUrls,
        aspects: content.aspects,
        condition: content.condition,
        quantity: 1,
        categoryId: competitor.categoryId,
        categoryPath: competitor.categoryBreadcrumb || [],
        price: { value: String(priced.productPrice.sellPrice), currency: priced.currency },
        // The full working — cost, each fee, profit and realised ROI — so the
        // review page can show WHY the price is what it is instead of a bare
        // number the seller has to trust.
        priceBreakdown: priced.productPrice,
        merchantLocationKey,
      },
      warnings,
      competitor,
      source,
    };
  }

  // The supplier's axes, cleaned for eBay. The model tidies the FIRST axis's
  // labels (it's the one that tends to be messy — "1PC Warm White"); later
  // axes like Model or Size come through already clean, so they're used
  // verbatim rather than risking the model rewriting "iPhone 15 Pro" into
  // something eBay won't match.
  // Two different names per axis, and conflating them silently emptied every
  // variant's aspects: `name` is the SUPPLIER's key on the scraped attributes
  // ("Color"), while `ebayName` is what the listing should call it
  // ("Colour"). Only the primary axis gets renamed by the model; later axes
  // keep the supplier's own naming, which is already listing-appropriate.
  const sourceAxes = source.variantAxes?.length
    ? source.variantAxes
    : deriveAxesFromVariants(source.variants);
  const axes = sourceAxes.map((axis, index) => ({
    ...axis,
    ebayName: index === 0 ? content.varyingAspectName || axis.name : axis.name,
  }));
  const primaryAxis = axes[0];
  const cleanedPrimary = cleanPrimaryAxisValues(source.variants, primaryAxis, content);

  // Per-variant photos come from ONE axis (colour), so a 6x27 matrix still
  // only needs 6 images, not 162. Processing each distinct photo once also
  // keeps the paid image calls proportional to real photos rather than to
  // the size of the matrix.
  const distinctImages = [...new Set(source.variants.map((v) => v.imageUrl).filter(Boolean))];
  const builtImages = new Map(
    await Promise.all(
      distinctImages.map(async (url) => [
        url,
        await imagePipeline.buildVariantImage({ sourceImageUrl: url, accessToken, marketplaceId }),
      ])
    )
  );

  const variants = source.variants.map((variant, index) => {
    const imageUrl = variant.imageUrl ? builtImages.get(variant.imageUrl) : null;
    // One value per axis — this is what lets a buyer pick BOTH their colour
    // and their phone model, instead of guessing.
    const aspects = {};
    for (const axis of axes) {
      const raw = variant.attributes[axis.name];
      if (raw === undefined) continue;
      aspects[axis.ebayName] = [axis === primaryAxis ? cleanedPrimary[index] : raw];
    }
    return {
      imageUrls: imageUrl ? [imageUrl] : [],
      ownImage: Boolean(imageUrl),
      aspects,
      condition: content.condition,
      quantity: 1,
      price: { value: String(priced.variantPrices[index].sellPrice), currency: priced.currency },
      priceBreakdown: priced.variantPrices[index],
    };
  });

  // EVERY variant must carry at least one image: eBay rejects the whole
  // inventory item group outright with "imageUrls cannot be null or empty"
  // (confirmed live — it killed a real draft before the seller ever saw a
  // review page). So a variant without its own photo falls back to the main
  // gallery image rather than being left empty.
  //
  // That fallback is stated plainly rather than hidden, because it isn't
  // harmless: showing several options the same photo is what drives "not as
  // described" returns. The two cases read very differently to a buyer, so
  // they're reported differently.
  const withoutOwnImage = variants.filter((variant) => !variant.ownImage);
  const fallbackImage = galleryImageUrls.slice(0, 1);

  for (const variant of variants) {
    if (!variant.imageUrls.length) variant.imageUrls = fallbackImage;
    delete variant.ownImage;
  }

  // The supplier offered more combinations than a single eBay listing should
  // carry, so some were dropped — said plainly, since a silently truncated
  // matrix means options a buyer can see on AliExpress but can't buy here.
  const chosen = selectVariants(read.source, variantSelection).variants.length;
  if (chosen > variants.length) {
    warnings.push(
      `You chose ${chosen} combinations, more than one listing should carry; this draft has the first ` +
        `${variants.length}. Split the rest into a second listing, or narrow the selection.`
    );
  }

  if (withoutOwnImage.length && fallbackImage.length) {
    warnings.push(
      withoutOwnImage.length === variants.length
        ? `The supplier has no separate photo per option, so every variation shows the main product photo. ` +
          `Adding a photo per option would help buyers pick the right one.`
        : `${withoutOwnImage.length} of ${variants.length} variations had no photo of their own, so they show the ` +
          `main product photo while the others show theirs. Worth adding the missing ones before publishing — ` +
          `mismatched variation photos are a common cause of returns.`
    );
  }

  return {
    draftInput: {
      groupKey: null, // assigned by the caller alongside SKUs
      commonTitle: content.commonTitle,
      commonDescription: content.commonDescription,
      imageUrls: galleryImageUrls,
      variesBy: {
        aspects: content.sharedAspects,
        // Only the axis that actually carries a distinct photo per option
        // changes the picture eBay shows. Naming an axis here that has no
        // per-option photography (Size, Model) just makes eBay swap to the
        // same image.
        aspectsImageVariesBy: axes.filter((axis) => axis.hasImages).map((axis) => axis.ebayName),
        // One entry PER AXIS — this is the list that makes eBay render a
        // dropdown for each. Values are taken from the variants actually
        // built, so a capped matrix never advertises an option that has no
        // variation behind it.
        specifications: axes.map((axis) => ({
          name: axis.ebayName,
          values: [...new Set(variants.map((v) => v.aspects[axis.ebayName]?.[0]).filter(Boolean))],
        })),
      },
      variants,
      categoryId: competitor.categoryId,
      categoryPath: competitor.categoryBreadcrumb || [],
      merchantLocationKey,
    },
    warnings,
    competitor,
    source,
  };
}

module.exports = { generateDraftInput, readSources, selectVariants, applyOrigin, resolveVariantAspectValues, resolvePricing };
