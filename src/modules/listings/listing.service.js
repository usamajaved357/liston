const crypto = require('crypto');
const listingRepository = require('./listing.repository');
const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const orchestrator = require('../ai-generation/generation.orchestrator');
const imageGates = require('../ai-generation/image-pipeline/gates');

class ListingError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Liston is the only place these drafts are visible — eBay never shows an
// offer created via the Inventory API anywhere in Seller Hub until it's
// published, so `generated_data` is the sole source of truth the review page
// renders from (it's a full snapshot of what was sent to eBay, not
// re-derived from a cheap combined read of the Inventory + Offer APIs,
// which doesn't exist as one call).
// Derives a base SKU from the AliExpress product id in the URL so repeated
// drafts of the same product are recognizable — falls back to a timestamp
// if the URL shape ever differs (AliExpress item URLs aren't guaranteed
// stable across their own site redesigns).
function baseSkuFromSourceUrl(sourceUrl) {
  const match = sourceUrl.match(/\/item\/(\d+)\.html/);
  return match ? `AE${match[1]}` : `SRC${Date.now()}`;
}

function shortRandomSuffix() {
  return crypto.randomBytes(3).toString('hex');
}

async function createEbayDraft(connectionId, userId, draftInput, { sourceData, warnings } = {}) {
  const isVariation = Array.isArray(draftInput.variants) && draftInput.variants.length > 0;

  const result = await connectionService.withDecryptedCredentials(connectionId, userId, (credentials, connection) => {
    if (connection.platform_key !== 'ebay') {
      throw new ListingError(`Drafting listings isn't available for ${connection.platform_name} yet`, 400);
    }

    const ebaySettings = connection.settings?.ebay;
    if (!ebaySettings) {
      throw new ListingError(
        'This eBay connection has no default business policies selected yet. Choose them in Settings before drafting a listing.',
        400
      );
    }

    const listingPolicies = {
      fulfillmentPolicyId: ebaySettings.fulfillmentPolicyId,
      paymentPolicyId: ebaySettings.paymentPolicyId,
      returnPolicyId: ebaySettings.returnPolicyId,
    };
    const marketplaceId = draftInput.marketplaceId || ebaySettings.marketplaceId || 'EBAY_GB';

    return isVariation
      ? ebayService.draftVariationListing(credentials, { ...draftInput, marketplaceId, listingPolicies }).then((r) => ({ ...r, marketplaceId, listingPolicies }))
      : ebayService.draftListing(credentials, { ...draftInput, marketplaceId, listingPolicies }).then((r) => ({ ...r, marketplaceId, listingPolicies }));
  });

  // Snapshot the policies actually attached at draft time, alongside the raw
  // input — the review page reads this back rather than the connection's
  // current defaults, which may change before the draft is published.
  const row = await listingRepository.createDraft({
    connectionId,
    sku: isVariation ? null : draftInput.sku,
    platformOfferId: isVariation ? null : result.offerId,
    platformGroupKey: isVariation ? result.groupKey : null,
    generatedData: {
      ...draftInput,
      marketplaceId: result.marketplaceId,
      listingPolicies: result.listingPolicies,
      ...(warnings?.length ? { warnings } : {}),
    },
    sourceData,
  });

  return row;
}

// The single entry point for the "paste a competitor URL + a source URL"
// flow: scrapes both, drafts content + variations with AI, then reuses
// createEbayDraft's existing policy-resolution/eBay-drafting/persist path
// unchanged.
async function generateEbayDraftFromUrls(
  connectionId,
  userId,
  { competitorUrl, sourceUrl }
) {
  const connection = await connectionService.getConnectionSummary(connectionId, userId);
  if (connection.platform_key !== 'ebay') {
    throw new ListingError(`Drafting listings isn't available for ${connection.platform_name} yet`, 400);
  }
  const ebaySettings = connection.settings?.ebay;
  if (!ebaySettings?.merchantLocationKey) {
    throw new ListingError(
      'This eBay connection has no default business policies or shipping location selected yet. Choose them in Settings before drafting a listing.',
      400
    );
  }

  // The image pipeline uploads finished images to eBay Picture Services under
  // this seller's account, so it needs their token before drafting starts.
  const { accessToken } = await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) =>
    ebayService.ensureValidAccessToken(credentials)
  );

  const { draftInput, warnings, competitor, source } = await orchestrator.generateDraftInput({
    competitorUrl,
    sourceUrl,
    accessToken,
    // Sell prices are derived from the supplier's own cost plus these
    // settings, not typed per draft. Undefined is fine — the pricing service
    // falls back to its documented defaults (60% ROI, 18% ads, 12%
    // processing, £0.30 per order).
    pricing: connection.settings?.pricing,
    merchantLocationKey: ebaySettings.merchantLocationKey,
    // The competitor is read from — and the category schema fetched for —
    // the same marketplace the listing will be published to, so the category
    // ids and aspect names line up.
    marketplaceId: ebaySettings.marketplaceId || 'EBAY_GB',
  });

  const baseSku = baseSkuFromSourceUrl(sourceUrl);
  const isVariation = Array.isArray(draftInput.variants);
  // Every SKU (group and per-variant) gets its own random suffix, not just
  // the group key — reusing the same deterministic SKU string across retries
  // or repeat drafts of the same product left it colliding with a SKU
  // created (and deleted) by a previous attempt, which eBay's offer-
  // availability check treats as "not available" for a while (an eventually-
  // consistent index, not a fresh-creation propagation delay as first
  // suspected — confirmed live: `createOfferWithRetry` still failed after
  // exhausting every retry against the same reused SKU).
  const runSuffix = shortRandomSuffix();
  const finalDraftInput = isVariation
    ? {
        ...draftInput,
        groupKey: `${baseSku}-${runSuffix}`,
        variants: draftInput.variants.map((variant, index) => ({ ...variant, sku: `${baseSku}-${runSuffix}-${index + 1}` })),
      }
    : { ...draftInput, sku: `${baseSku}-${runSuffix}` };

  return createEbayDraft(connectionId, userId, finalDraftInput, {
    sourceData: { competitor, source },
    // What the automated steps couldn't do (dropped aspects, variants with no
    // photo of their own). Persisted so the review page can show it rather
    // than the seller finding out from a live listing.
    warnings,
  });
}

async function listPendingDrafts(connectionId, userId) {
  return listingRepository.findPendingByConnection(connectionId, userId);
}

async function getDraftDetail(id, userId) {
  const listing = await listingRepository.findByIdForUser(id, userId);
  if (!listing) {
    throw new ListingError('Listing not found', 404);
  }

  let policies = null;
  if (listing.connection_id) {
    try {
      policies = await connectionService.withDecryptedCredentials(listing.connection_id, userId, (credentials) =>
        ebayService.getBusinessPolicies(credentials)
      );
    } catch {
      // Policies are just display context here — if the live eBay call
      // fails, still show the draft rather than blocking the review page.
      policies = null;
    }
  }

  return { listing, policies };
}

async function publish(id, userId) {
  const listing = await listingRepository.findByIdForUser(id, userId);
  if (!listing) {
    throw new ListingError('Listing not found', 404);
  }
  if (listing.status !== 'pending_review') {
    throw new ListingError(`Only a listing pending review can be published (this one is "${listing.status}")`, 400);
  }

  // Images are the single biggest driver of whether a listing sells, so the
  // ones that would produce a visibly broken gallery (no images at all, or
  // variations with no photo of their own) block the publish rather than
  // going live and underperforming. Neither is auto-fixable without lying to
  // the buyer, so it's reported for the seller to resolve.
  const imageCheck = imageGates.checkDraftImages(listing.generated_data || {});
  if (!imageCheck.ok) {
    throw new ListingError(imageCheck.errors.join(' '), 400);
  }

  const result = await connectionService.withDecryptedCredentials(listing.connection_id, userId, (credentials) =>
    listing.platform_group_key
      ? ebayService.publishGroup(credentials, listing.platform_group_key, listing.generated_data?.marketplaceId)
      : ebayService.publishDraft(credentials, listing.platform_offer_id, listing.generated_data?.marketplaceId)
  );

  return listingRepository.updateStatus(id, 'published', { externalProductId: result.externalProductId });
}

module.exports = {
  ListingError,
  createEbayDraft,
  generateEbayDraftFromUrls,
  listPendingDrafts,
  getDraftDetail,
  publish,
};
