const crypto = require('crypto');
const listingRepository = require('./listing.repository');
const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const orchestrator = require('../ai-generation/generation.orchestrator');
const imageGates = require('../ai-generation/image-pipeline/gates');
const revisionService = require('./listing-revision.service');
const eps = require('../ai-generation/image-pipeline/eps');

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

// A draft lives ONLY in Liston until it's published — nothing is created on
// eBay here.
//
// It used to build every inventory item and offer up front, which meant a
// 108-variant listing fired ~216 eBay calls before the seller had even looked
// at it. That made drafting slow, left orphan SKUs behind on every abandoned
// draft, and made editing near-impossible: each change would have had to be
// reconciled against objects already living on eBay. Keeping the draft local
// makes editing a plain update of `generated_data`, and the eBay build moves
// wholesale to `publish` (same functions, later moment).
async function createEbayDraft(connectionId, userId, draftInput, { sourceData, warnings } = {}) {
  const isVariation = Array.isArray(draftInput.variants) && draftInput.variants.length > 0;

  // Still read the connection now, so a misconfigured one fails immediately
  // rather than after the seller has reviewed a draft they can't publish.
  const connection = await connectionService.getConnectionSummary(connectionId, userId);
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

  // Snapshot the policies as they stand now — the draft publishes with these,
  // not with whatever the connection's defaults happen to be days later.
  const listingPolicies = {
    fulfillmentPolicyId: ebaySettings.fulfillmentPolicyId,
    paymentPolicyId: ebaySettings.paymentPolicyId,
    returnPolicyId: ebaySettings.returnPolicyId,
  };

  return listingRepository.createDraft({
    connectionId,
    sku: isVariation ? null : draftInput.sku,
    // Both stay NULL until publish actually creates something on eBay.
    platformOfferId: null,
    platformGroupKey: null,
    generatedData: {
      ...draftInput,
      marketplaceId: draftInput.marketplaceId || ebaySettings.marketplaceId || 'EBAY_GB',
      listingPolicies,
      ...(warnings?.length ? { warnings } : {}),
    },
    sourceData,
  });
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

  // Only the SKU BASE is decided here; the actual SKUs are stamped at publish
  // (see withSkus). A draft that's edited for days shouldn't be holding SKUs
  // reserved against an eBay index that will have moved on by the time it
  // goes live.
  const finalDraftInput = { ...draftInput, skuBase: baseSkuFromSourceUrl(sourceUrl) };

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

// Only a draft can be edited. Once a listing is live, eBay owns it — editing
// `generated_data` then would silently diverge from what buyers see.
async function loadEditableDraft(id, userId) {
  const listing = await listingRepository.findByIdForUser(id, userId);
  if (!listing) {
    throw new ListingError('Listing not found', 404);
  }
  if (listing.status !== 'pending_review') {
    throw new ListingError(`Only a draft can be edited (this listing is "${listing.status}")`, 400);
  }
  return listing;
}

// Removes every combination that uses a given value on a given axis —
// dropping "Pink" on a 6-colour x 27-model product removes 27 variations in
// one action, which is the only practical way to curate a matrix that size.
function removeAxisValue(draft, axisName, value) {
  const variants = (draft.variants || []).filter((variant) => variant.aspects?.[axisName]?.[0] !== value);
  return {
    ...draft,
    variants,
    variesBy: draft.variesBy && {
      ...draft.variesBy,
      // The axis keeps only values still backed by a real variation,
      // otherwise eBay is told about an option a buyer can't select.
      specifications: (draft.variesBy.specifications || [])
        .map((spec) => ({
          ...spec,
          values: spec.values.filter((v) => variants.some((variant) => variant.aspects?.[spec.name]?.[0] === v)),
        }))
        .filter((spec) => spec.values.length > 0),
    },
  };
}

/**
 * Applies an edit to a draft. The patch carries only what changed; anything
 * absent is left alone.
 */
async function updateDraft(id, userId, patch) {
  const listing = await loadEditableDraft(id, userId);
  let draft = { ...(listing.generated_data || {}) };

  // ORDER MATTERS. Every index in the patch refers to the draft as the editor
  // last saw it, so per-variant edits are applied first, then single-row
  // removals (by original index), then axis-wide removals. Any other order
  // would shift indexes under the editor's feet.
  if (patch.variants) {
    draft.variants = (draft.variants || []).map((variant, index) => {
      const change = patch.variants[String(index)];
      if (!change) return variant;
      return {
        ...variant,
        ...(change.price !== undefined ? { price: change.price } : {}),
        ...(change.quantity !== undefined ? { quantity: change.quantity } : {}),
        ...(change.imageUrls !== undefined ? { imageUrls: change.imageUrls } : {}),
      };
    });
  }

  if (patch.variantSkusToRemove?.length) {
    const drop = new Set(patch.variantSkusToRemove);
    draft.variants = (draft.variants || []).filter((_, index) => !drop.has(String(index)));
  }

  for (const removal of patch.removeAxisValues || []) {
    draft = removeAxisValue(draft, removal.axis, removal.value);
  }

  for (const field of ['title', 'description', 'commonTitle', 'commonDescription', 'condition', 'aspects', 'imageUrls']) {
    if (patch[field] !== undefined) draft[field] = patch[field];
  }

  if (patch.price !== undefined) draft.price = patch.price;

  // An axis-wide removal can leave a specification value with no variation
  // behind it; the same tidy-up covers single-row removals too.
  if (draft.variesBy?.specifications) {
    draft.variesBy = {
      ...draft.variesBy,
      specifications: draft.variesBy.specifications
        .map((spec) => ({
          ...spec,
          values: spec.values.filter((v) => (draft.variants || []).some((variant) => variant.aspects?.[spec.name]?.[0] === v)),
        }))
        .filter((spec) => spec.values.length > 0),
    };
  }

  if (Array.isArray(draft.variants) && draft.variants.length === 0) {
    throw new ListingError("A variation listing needs at least one variation — you've removed them all.", 400);
  }

  const updated = await listingRepository.updateGeneratedData(id, draft);
  // Returned rather than enforced: an edit that leaves a gap should be
  // visible immediately in the editor, not only refused later at publish.
  return { listing: updated, imageCheck: imageGates.checkDraftImages(draft) };
}

// AI revisions are PROPOSALS — they read the draft but never write it. The
// seller accepts by sending the change back through updateDraft, which is
// the same path a hand edit takes.
async function proposeTextRevision(id, userId, instruction) {
  const listing = await loadEditableDraft(id, userId);
  return revisionService.reviseText({ draft: listing.generated_data || {}, instruction });
}

async function proposeImageRevision(id, userId, { imageUrl, instruction }) {
  const listing = await loadEditableDraft(id, userId);
  const draft = listing.generated_data || {};

  // Only an image already on this draft can be revised — otherwise this
  // endpoint would happily process any URL the caller supplied.
  const known = [...(draft.imageUrls || []), ...(draft.variants || []).flatMap((v) => v.imageUrls || [])];
  if (!known.includes(imageUrl)) {
    throw new ListingError("That image isn't part of this draft", 400);
  }

  return revisionService.reviseImage({ imageUrl, instruction });
}

/**
 * Accepts a proposed image: uploads it to eBay Picture Services (which is
 * what makes the URL permanent) and swaps it into the draft in place of the
 * one it was generated from.
 */
async function acceptImageRevision(id, userId, { proposalId, replaces }) {
  const listing = await loadEditableDraft(id, userId);
  const proposal = revisionService.takeProposal(proposalId);
  if (!proposal) {
    throw new ListingError('That edit has expired — run it again.', 400);
  }

  const draft = { ...(listing.generated_data || {}) };
  const marketplaceId = draft.marketplaceId;

  const hostedUrl = await connectionService.withDecryptedCredentials(listing.connection_id, userId, async (credentials) => {
    const { accessToken } = await ebayService.ensureValidAccessToken(credentials);
    return eps.upload(accessToken, proposal.buffer, { marketplaceId });
  });

  draft.imageUrls = (draft.imageUrls || []).map((url) => (url === replaces ? hostedUrl : url));
  draft.variants = (draft.variants || []).map((variant) => ({
    ...variant,
    imageUrls: (variant.imageUrls || []).map((url) => (url === replaces ? hostedUrl : url)),
  }));

  const updated = await listingRepository.updateGeneratedData(id, draft);
  return { listing: updated, imageUrl: hostedUrl };
}

async function removeDraft(id, userId) {
  await loadEditableDraft(id, userId);
  return listingRepository.deleteDraft(id, userId);
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

  const draft = listing.generated_data || {};
  const marketplaceId = draft.marketplaceId;
  // Drafts created before drafts went local already have their eBay objects;
  // anything newer is built here, now.
  const alreadyOnEbay = Boolean(listing.platform_offer_id || listing.platform_group_key);

  try {
    const result = await connectionService.withDecryptedCredentials(listing.connection_id, userId, async (credentials) => {
      if (alreadyOnEbay) {
        return listing.platform_group_key
          ? ebayService.publishGroup(credentials, listing.platform_group_key, marketplaceId)
          : ebayService.publishDraft(credentials, listing.platform_offer_id, marketplaceId);
      }

      // SKUs are assigned at publish rather than at draft: a failed publish
      // leaves half-created SKUs behind, and eBay's SKU index is eventually
      // consistent enough that reusing them on a retry fails. A fresh run
      // suffix each attempt sidesteps that entirely.
      const built = withSkus(draft, listing.connection_id);
      const isVariation = Array.isArray(built.variants) && built.variants.length > 0;

      const created = isVariation
        ? await ebayService.draftVariationListing(credentials, built)
        : await ebayService.draftListing(credentials, built);

      const published = isVariation
        ? await ebayService.publishGroup(credentials, created.groupKey, marketplaceId)
        : await ebayService.publishDraft(credentials, created.offerId, marketplaceId);

      return { ...published, created, isVariation };
    });

    if (!alreadyOnEbay) {
      await listingRepository.setPlatformIds(id, {
        platformOfferId: result.isVariation ? null : result.created.offerId,
        platformGroupKey: result.isVariation ? result.created.groupKey : null,
      });
    }

    return listingRepository.updateStatus(id, 'published', { externalProductId: result.externalProductId });
  } catch (err) {
    // Publishing 100+ variants is minutes of eBay calls and can fail part way
    // through. The draft stays `pending_review` so it's still editable and
    // retryable, with eBay's own reason recorded against it.
    await listingRepository.updateStatus(id, 'pending_review', { errorMessage: err.message?.slice(0, 500) });
    throw err;
  }
}

// Assigns the SKUs (and group key) a publish needs, without mutating the
// stored draft.
function withSkus(draft, connectionId) {
  // `skuBase` is set when the draft is generated from URLs; the fallback
  // covers drafts created another way.
  const base = draft.skuBase || draft.sku || `SKU${connectionId.slice(0, 8)}`;
  const runSuffix = shortRandomSuffix();

  if (Array.isArray(draft.variants) && draft.variants.length) {
    return {
      ...draft,
      groupKey: `${base}-${runSuffix}`,
      variants: draft.variants.map((variant, index) => ({ ...variant, sku: `${base}-${runSuffix}-${index + 1}` })),
    };
  }
  return { ...draft, sku: `${base}-${runSuffix}` };
}

module.exports = {
  ListingError,
  createEbayDraft,
  generateEbayDraftFromUrls,
  listPendingDrafts,
  getDraftDetail,
  updateDraft,
  removeDraft,
  proposeTextRevision,
  proposeImageRevision,
  acceptImageRevision,
  removeAxisValue,
  publish,
};
