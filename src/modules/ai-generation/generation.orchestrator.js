const ebayScraper = require('../scraping/ebay-listing.scraper');
const aliexpressScraper = require('../scraping/aliexpress-listing.scraper');
const textGenerator = require('./text-generator.service');
const imageTransformer = require('./image-transformer.service');
const { ScrapingError } = require('../scraping/scraping.errors');

// Cap per-listing gallery images — each one is a paid, non-instant Bria call,
// and eBay listings don't benefit from more than a handful of good shots.
// Per-variant images stay at exactly 1 each (the variant's own colour/size
// photo), separate from this cap.
const MAX_LISTING_IMAGES = 5;

// Ties scraping + AI text generation + image transformation together into a
// draftInput-shaped object ready for listingService.createEbayDraft — SKUs
// are intentionally left unset here; the caller (listingService) assigns
// them right before persisting, since SKU generation is a listing-lifecycle
// concern, not a content-generation one.
//
// `competitorRaw`/`sourceRaw` are optional: when the Liston browser extension
// is installed, the user's own browser (not this server) extracts these raw
// fields — via the exact same shared functions in `dom-extractors/` that
// `ebayScraper`/`aliexpressScraper` use internally — bypassing this server's
// IP entirely for the pages that need it. Either way, the same `normalize()`
// from each scraper module runs on the raw fields before use, so there's one
// place (not two) that decides "does this look like a real listing" and
// shapes the result — Playwright and the extension are just two different
// ways of getting to the same raw-field input.
async function generateDraftInput({
  competitorUrl,
  sourceUrl,
  competitorRaw,
  sourceRaw,
  costPrice,
  sellPrice,
  currency,
  merchantLocationKey,
}) {
  const [competitor, source] = await Promise.all([
    competitorRaw
      ? Promise.resolve({ ...ebayScraper.normalize(competitorRaw), sourceUrl: competitorUrl })
      : ebayScraper.scrapeListing(competitorUrl),
    sourceRaw
      ? Promise.resolve({ ...aliexpressScraper.normalize(sourceRaw), sourceUrl })
      : aliexpressScraper.scrapeListing(sourceUrl),
  ]);

  // The AI never invents this — eBay category IDs aren't guessable from a
  // title/breadcrumb, and a wrong one gets the offer rejected (or silently
  // mis-categorized). Use the competitor's real scraped category directly.
  if (!competitor.categoryId) {
    throw new ScrapingError(
      "Couldn't determine the competitor listing's eBay category — try a different competitor URL.",
      { source: 'ebay' }
    );
  }

  const content = await textGenerator.generateListingContent({ competitor, source, costPrice, sellPrice, currency });

  const hasVariants = source.variants.length > 0;

  if (!hasVariants) {
    const imageUrls = await imageTransformer.transformImages(
      source.imageUrls.slice(0, MAX_LISTING_IMAGES),
      content.imageScenePrompt
    );
    return {
      draftInput: {
        title: content.title,
        description: content.description,
        imageUrls,
        aspects: content.aspects,
        condition: content.condition,
        quantity: 1,
        categoryId: competitor.categoryId,
        price: { value: String(sellPrice), currency },
        merchantLocationKey,
      },
      competitor,
      source,
    };
  }

  const groupImageUrls = await imageTransformer.transformImages(
    source.imageUrls.slice(0, MAX_LISTING_IMAGES),
    content.imageScenePrompt
  );
  const variants = await Promise.all(
    source.variants.map(async (variant) => {
      const label = Object.values(variant.attributes)[0];
      const aspectValue = content.variantAspectValues[label] || label;
      const [imageUrl] = await imageTransformer.transformImages(
        variant.imageUrl ? [variant.imageUrl] : [],
        content.imageScenePrompt
      );
      return {
        imageUrls: imageUrl ? [imageUrl] : groupImageUrls,
        aspects: { [content.varyingAspectName]: [aspectValue] },
        condition: content.condition,
        quantity: 1,
        price: { value: String(sellPrice), currency },
      };
    })
  );

  return {
    draftInput: {
      groupKey: null, // assigned by the caller alongside SKUs
      commonTitle: content.commonTitle,
      commonDescription: content.commonDescription,
      imageUrls: groupImageUrls,
      variesBy: {
        aspects: content.sharedAspects,
        aspectsImageVariesBy: [content.varyingAspectName],
        specifications: [{ name: content.varyingAspectName, values: variants.map((v) => v.aspects[content.varyingAspectName][0]) }],
      },
      variants,
      categoryId: competitor.categoryId,
      merchantLocationKey,
    },
    competitor,
    source,
  };
}

module.exports = { generateDraftInput };
