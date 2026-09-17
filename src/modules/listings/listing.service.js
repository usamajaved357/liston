const crypto = require('crypto');
const listingRepository = require('./listing.repository');
const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const orchestrator = require('../ai-generation/generation.orchestrator');
const imageGates = require('../ai-generation/image-pipeline/gates');
const revisionService = require('./listing-revision.service');
const eps = require('../ai-generation/image-pipeline/eps');
const imageOps = require('../ai-generation/image-pipeline/image.ops');
const descriptionTemplate = require('./description-template');

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

// Read listings are held between the two drafting steps so step two doesn't
// scrape AliExpress a second time (~30s, and flaky). In memory: a preview is
// regenerable, and losing one to a restart costs a re-read, not data. Keyed
// to the user so one seller's preview can never be drafted by another.
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const previews = new Map();

function prunePreviews() {
  const now = Date.now();
  for (const [id, preview] of previews) if (preview.expiresAt <= now) previews.delete(id);
}

// STEP ONE: read both listings, cost nothing, return what the seller needs to
// choose from — the supplier's variation axes with their options and photos.
async function previewDraftSources(connectionId, userId, { competitorUrl, sourceUrl }) {
  prunePreviews();
  const connection = await connectionService.getConnectionSummary(connectionId, userId);
  if (connection.platform_key !== 'ebay') {
    throw new ListingError(`Drafting listings isn't available for ${connection.platform_name} yet`, 400);
  }
  const marketplaceId = connection.settings?.ebay?.marketplaceId || 'EBAY_GB';

  const { competitor, source } = await orchestrator.readSources({ competitorUrl, sourceUrl, marketplaceId });

  const previewId = crypto.randomUUID();
  previews.set(previewId, { competitor, source, userId, connectionId, competitorUrl, sourceUrl, expiresAt: Date.now() + PREVIEW_TTL_MS });

  // Per option, a thumbnail where the supplier has one, so a colour can be
  // chosen by eye rather than by name.
  const axes = (source.variantAxes || []).map((axis) => ({
    name: axis.name,
    hasImages: axis.hasImages,
    values: axis.values.map((value) => ({
      value,
      imageUrl: (source.variants || []).find((v) => v.attributes[axis.name] === value && v.imageUrl)?.imageUrl || null,
      combinations: (source.variants || []).filter((v) => v.attributes[axis.name] === value).length,
    })),
  }));

  return {
    previewId,
    competitor: { title: competitor.title, priceText: competitor.priceText, categoryPath: competitor.categoryBreadcrumb },
    source: {
      title: source.title,
      priceText: source.priceText,
      imageUrls: source.imageUrls || [],
      axes,
      totalCombinations: (source.variants || []).length,
    },
  };
}

// The single entry point for the "paste a competitor URL + a source URL"
// flow: scrapes both, drafts content + variations with AI, then reuses
// createEbayDraft's existing policy-resolution/eBay-drafting/persist path
// unchanged.
async function generateEbayDraftFromUrls(
  connectionId,
  userId,
  { competitorUrl, sourceUrl, previewId, variantSelection }
) {
  // STEP TWO picks up the listings read in step one. A preview belongs to the
  // user and connection that made it; anything else is treated as expired.
  let preRead = null;
  if (previewId) {
    prunePreviews();
    const preview = previews.get(previewId);
    if (!preview || preview.userId !== userId || preview.connectionId !== connectionId) {
      throw new ListingError('That preview has expired. Read the listings again.', 400);
    }
    preRead = preview;
    competitorUrl = preview.competitorUrl;
    sourceUrl = preview.sourceUrl;
  }
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
    competitor: preRead?.competitor,
    source: preRead?.source,
    variantSelection,
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
    countryOfOrigin: connection.settings?.listing?.countryOfOrigin || 'United Kingdom',
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

  for (const field of ['title', 'description', 'commonTitle', 'commonDescription', 'condition', 'imageUrls']) {
    if (patch[field] !== undefined) draft[field] = patch[field];
  }
  // Shared item specifics live under variesBy on a variation draft, at the
  // top level on a plain one — the editor sends one `aspects` either way.
  if (patch.aspects !== undefined) {
    if (draft.variesBy) draft.variesBy = { ...draft.variesBy, aspects: patch.aspects };
    else draft.aspects = patch.aspects;
  }

  if (patch.price !== undefined) draft.price = patch.price;
  if (patch.quantity !== undefined) draft.quantity = patch.quantity;
  if (patch.listingPolicies !== undefined) {
    // Only IDs the account really has — a typo'd or stale ID would fail at
    // publish with an opaque eBay error instead of here.
    await connectionService.withDecryptedCredentials(listing.connection_id, userId, async (credentials) => {
      const policies = await ebayService.getBusinessPolicies(credentials, draft.marketplaceId || 'EBAY_GB');
      const has = (list, key, id) => list.some((policy) => policy[key] === id);
      if (
        !has(policies.fulfillmentPolicies, 'fulfillmentPolicyId', patch.listingPolicies.fulfillmentPolicyId) ||
        !has(policies.paymentPolicies, 'paymentPolicyId', patch.listingPolicies.paymentPolicyId) ||
        !has(policies.returnPolicies, 'returnPolicyId', patch.listingPolicies.returnPolicyId)
      ) {
        throw new ListingError("One of those policies isn't on this eBay account any more. Refresh and pick again.", 400);
      }
      return policies;
    });
    draft.listingPolicies = patch.listingPolicies;
  }
  // Condition is carried per variant on a variation draft.
  if (patch.condition !== undefined && Array.isArray(draft.variants)) {
    draft.variants = draft.variants.map((variant) => ({ ...variant, condition: patch.condition }));
  }

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
    throw new ListingError("A variation listing needs at least one variation. You've removed them all.", 400);
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
    throw new ListingError('That edit has expired. Run it again.', 400);
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

// The seller's own photo, from their computer, hosted on eBay and put into
// the draft: replacing an existing image (gallery or variant, wherever it
// appears), set as a variant's photo, or appended to the gallery. The bytes
// go up exactly as given — no resizing or padding — after eBay's own limits
// are checked (≥500px, ≤12MB, a real image).
async function uploadDraftImage(id, userId, { dataUrl, replaces, variantIndex }) {
  const listing = await loadEditableDraft(id, userId);
  const draft = { ...(listing.generated_data || {}) };

  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) throw new ListingError('Upload a JPG, PNG, GIF or WEBP image.', 400);
  const buffer = Buffer.from(match[2], 'base64');
  const check = await imageOps.validate(buffer);
  if (!check.ok) throw new ListingError(check.errors.join(' '), 400);
  const source = await imageOps.validateSource(buffer);
  if (!source.ok) throw new ListingError(source.reason, 400);

  const hostedUrl = await connectionService.withDecryptedCredentials(listing.connection_id, userId, async (credentials) => {
    const { accessToken } = await ebayService.ensureValidAccessToken(credentials);
    return eps.upload(accessToken, buffer, { marketplaceId: draft.marketplaceId });
  });

  if (replaces) {
    draft.imageUrls = (draft.imageUrls || []).map((url) => (url === replaces ? hostedUrl : url));
    draft.variants = (draft.variants || []).map((variant) => ({
      ...variant,
      imageUrls: (variant.imageUrls || []).map((url) => (url === replaces ? hostedUrl : url)),
    }));
  } else if (variantIndex !== undefined && Array.isArray(draft.variants)) {
    if (!draft.variants[variantIndex]) throw new ListingError('That variation no longer exists.', 400);
    draft.variants = draft.variants.map((variant, i) => (i === variantIndex ? { ...variant, imageUrls: [hostedUrl] } : variant));
  } else {
    if ((draft.imageUrls || []).length >= 24) throw new ListingError('eBay allows at most 24 images per listing.', 400);
    draft.imageUrls = [...(draft.imageUrls || []), hostedUrl];
  }

  const updated = await listingRepository.updateGeneratedData(id, draft);
  return { listing: updated, imageUrl: hostedUrl };
}

// Streams one of the draft's own images back to the seller as a download —
// the browser can't force a download of a cross-origin eBay URL itself.
// Only URLs that belong to this draft are served, so this is not an open proxy.
async function fetchDraftImage(id, userId, url) {
  const listing = await listingRepository.findByIdForUser(id, userId);
  if (!listing) throw new ListingError('Listing not found', 404);
  const draft = listing.generated_data || {};
  const known = new Set([...(draft.imageUrls || []), ...(draft.variants || []).flatMap((v) => v.imageUrls || [])]);
  if (!known.has(url)) throw new ListingError("That image isn't part of this listing.", 404);

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new ListingError('Could not fetch that image from eBay.', 502);
  const buffer = Buffer.from(await res.arrayBuffer());
  const meta = await imageOps.describe(buffer).catch(() => ({ format: 'jpeg' }));
  const ext = meta.format === 'jpeg' ? 'jpg' : meta.format || 'jpg';
  return { buffer, contentType: `image/${meta.format || 'jpeg'}`, extension: ext };
}

async function removeDraft(id, userId) {
  await loadEditableDraft(id, userId);
  return listingRepository.deleteDraft(id, userId);
}

// The account's own live listings, for the "You may also like" cards. Read
// at render time so the carousel is always current, and never includes the
// listing being published. Failure here costs the carousel, not the publish.
async function recommendedListings(credentials, connection, { exclude, count }) {
  try {
    const { items } = await ebayService.listActiveListings(credentials, { pageNumber: 1, entriesPerPage: 50 });
    return (items || [])
      .filter((item) => item.viewItemUrl && item.itemId !== exclude)
      .slice(0, count)
      .map((item) => ({
        url: item.viewItemUrl,
        imageUrl: item.imageUrl,
        name: item.title,
        price: item.price ? `£${Number(item.price.amount).toFixed(2)}` : null,
      }));
  } catch {
    return [];
  }
}

// The branded description for a draft: the AI copy inside this account's
// template, with this account's live listings recommended underneath.
async function renderDraftDescription(listing, userId) {
  const draft = listing.generated_data || {};
  const isVariation = Array.isArray(draft.variants) && draft.variants.length > 0;

  return connectionService.withDecryptedCredentials(listing.connection_id, userId, async (credentials, connection) => {
    let template = descriptionTemplate.templateWithDefaults(connection.settings?.template);

    // Anything the seller hasn't filled in comes from the store itself —
    // eBay already holds the store's name, the logo they uploaded and the
    // live feedback score. A blank field means "use eBay's", never "leave a
    // hole". Failure here just leaves the blanks blank.
    if (!template.storeName || !template.logoUrl || !template.feedbackPercent) {
      try {
        const profile = await ebayService.getStoreProfile(credentials);
        template = {
          ...template,
          storeName: template.storeName || profile.storeName || connection.label,
          logoUrl: template.logoUrl || profile.logoUrl || '',
          feedbackPercent: template.feedbackPercent || profile.feedbackPercent || '',
        };
      } catch {
        template = { ...template, storeName: template.storeName || connection.label };
      }
    }

    const recommended = await recommendedListings(credentials, connection, {
      exclude: listing.external_product_id,
      count: template.recommendedCount,
    });
    return descriptionTemplate.renderDescription({
      template,
      productName: isVariation ? draft.commonTitle : draft.title,
      description: isVariation ? draft.commonDescription : draft.description,
      recommended,
      condition: draft.condition || draft.variants?.[0]?.condition || 'NEW',
    });
  });
}

async function previewDescription(id, userId) {
  const listing = await listingRepository.findByIdForUser(id, userId);
  if (!listing) throw new ListingError('Listing not found', 404);
  return renderDraftDescription(listing, userId);
}

// ---- Editing a listing that is already live on eBay ----
//
// The live item is loaded into the same draft shape the editor already
// understands, kept as a transient row (edit_of_item_id set) and then either
// revised in place on eBay or discarded. It never appears in Drafts.

// eBay descriptions are HTML; the editor works in plain text with the
// template applied at publish. Keep the paragraph and line structure.
function htmlToText(html) {
  let text = String(html || '');
  // Liston's own template wraps the seller's copy in .eb-desc; anything
  // outside it (header, badges, carousel) is template, not description.
  const start = text.indexOf('<div class="eb-desc">');
  if (start >= 0) {
    const end = text.indexOf('</div>\n  </div>', start);
    text = end > start ? text.slice(start + '<div class="eb-desc">'.length, end) : text.slice(start);
  }
  text = text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**');
  text = text.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, '==$1==');
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<\/(ul|ol)>/gi, '\n\n').replace(/<p[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '• ');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function draftFromLiveItem(item, marketplaceId) {
  const base = {
    imageUrls: item.imageUrls,
    categoryId: item.categoryId,
    categoryPath: item.categoryPath,
    marketplaceId,
    merchantLocationKey: '',
    liveItemId: item.itemId,
  };
  if (item.variations.length) {
    const axes = Object.keys(item.variationSpecificsSet);
    const picturesByAxis = Object.fromEntries(item.variationPictures.map((p) => [p.specificName, p.byValue]));
    const imageAxis = item.variationPictures[0]?.specificName;
    return {
      ...base,
      commonTitle: item.title,
      commonDescription: htmlToText(item.description),
      variesBy: {
        aspects: item.specifics,
        aspectsImageVariesBy: imageAxis ? [imageAxis] : [],
        specifications: axes.map((name) => ({ name, values: item.variationSpecificsSet[name] })),
      },
      variants: item.variations.map((v) => {
        const value = imageAxis ? v.specifics[imageAxis]?.[0] : null;
        const own = value ? picturesByAxis[imageAxis]?.[value] : null;
        return {
          sku: v.sku || undefined,
          imageUrls: own && own.length ? own : item.imageUrls.slice(0, 1),
          aspects: v.specifics,
          condition: item.condition || 'NEW',
          quantity: Math.max(0, v.quantity - v.quantitySold),
          price: { value: v.price ? v.price.amount.toFixed(2) : '0.00', currency: v.price?.currency || item.currency || 'GBP' },
        };
      }),
    };
  }
  return {
    ...base,
    title: item.title,
    description: htmlToText(item.description),
    aspects: item.specifics,
    condition: item.condition || 'NEW',
    quantity: Math.max(0, item.quantity - item.quantitySold),
    price: { value: item.price ? item.price.amount.toFixed(2) : '0.00', currency: item.price?.currency || item.currency || 'GBP' },
  };
}

async function startLiveEdit(connectionId, userId, itemId) {
  const existing = await listingRepository.findLiveEdit(connectionId, userId, itemId);
  if (existing) return existing;

  return connectionService.withDecryptedCredentials(connectionId, userId, async (credentials, connection) => {
    const item = await ebayService.getLiveItem(credentials, itemId);
    if (item.listingType && item.listingType !== 'FixedPriceItem') {
      throw new ListingError('Only fixed-price listings can be edited here.', 400);
    }
    let draft = draftFromLiveItem(item, connection.settings?.ebay?.marketplaceId);

    // If Liston published this item, start from its own draft: the plain
    // description with its formatting is far better than reversing HTML.
    const own = await listingRepository.findPublishedByItemId(connectionId, itemId);
    const ownDraft = own?.generated_data;
    if (ownDraft) {
      const isVariation = Array.isArray(ownDraft.variants) && ownDraft.variants.length > 0;
      const liveIsVariation = Array.isArray(draft.variants);
      if (isVariation === liveIsVariation) {
        draft = isVariation
          ? { ...draft, commonDescription: ownDraft.commonDescription || draft.commonDescription }
          : { ...draft, description: ownDraft.description || draft.description };
      }
    }

    return listingRepository.createLiveEdit({ connectionId, itemId, sku: item.sku, generatedData: draft });
  });
}

async function publishLiveEdit(listing, userId) {
  const draft = listing.generated_data || {};
  const isVariation = Array.isArray(draft.variants) && draft.variants.length > 0;
  const imageCheck = imageGates.checkDraftImages(draft);
  if (!imageCheck.ok) throw new ListingError(imageCheck.errors.join(' '), 400);

  const html = await renderDraftDescription(listing, userId);
  const specifics = isVariation ? draft.variesBy?.aspects : draft.aspects;
  const payload = {
    title: isVariation ? draft.commonTitle : draft.title,
    descriptionHtml: html,
    imageUrls: draft.imageUrls,
    specifics,
    conditionId: ebayService.conditionIdFor(isVariation ? draft.variants[0]?.condition : draft.condition),
  };
  if (isVariation) {
    const imageAxis = draft.variesBy?.aspectsImageVariesBy?.[0];
    const byValue = {};
    if (imageAxis) {
      for (const v of draft.variants) {
        const value = v.aspects?.[imageAxis]?.[0];
        if (value && !byValue[value] && v.imageUrls?.length) byValue[value] = v.imageUrls;
      }
    }
    payload.variations = draft.variants.map((v) => ({
      sku: v.sku,
      price: { amount: Number(v.price.value), currency: v.price.currency },
      quantity: v.quantity,
      specifics: v.aspects,
    }));
    payload.variationSpecificsSet = Object.fromEntries((draft.variesBy?.specifications || []).map((s) => [s.name, s.values]));
    payload.variationPictures = imageAxis ? [{ specificName: imageAxis, byValue }] : [];
  } else {
    payload.price = { amount: Number(draft.price.value), currency: draft.price.currency };
    payload.quantity = draft.quantity;
  }

  await connectionService.withDecryptedCredentials(listing.connection_id, userId, (credentials) =>
    ebayService.reviseLiveListing(credentials, listing.edit_of_item_id, payload)
  );
  ebayService.invalidateListings(listing.connection_id);
  // The edit is now live; the working copy has done its job.
  await listingRepository.deleteById(listing.id);
  return { ...listing, status: 'published', external_product_id: listing.edit_of_item_id, deleted: true };
}

// Removes an ended listing for good: eBay's own Inventory objects if Liston
// created them, every Liston record of it, and it's hidden from the Inactive
// tab from now on. eBay has no API for clearing its own Unsold list, so the
// entry can linger in Seller Hub until eBay purges it (90 days).
async function removeInactiveListing(connectionId, userId, itemId) {
  const rows = await listingRepository.findAllByItemId(connectionId, itemId);
  const offerIds = rows.map((r) => r.platform_offer_id).filter(Boolean);
  const groupKeys = rows.map((r) => r.platform_group_key).filter(Boolean);
  const skus = rows.flatMap((r) => {
    const d = r.generated_data || {};
    return Array.isArray(d.variants) ? d.variants.map((v) => v.sku).filter(Boolean) : r.sku ? [r.sku] : [];
  });

  await connectionService.withDecryptedCredentials(connectionId, userId, async (credentials, connection) => {
    if (offerIds.length || groupKeys.length || skus.length) {
      for (const offerId of offerIds) await ebayService.deleteInventoryObjects(credentials, { offerId });
      for (const groupKey of groupKeys) await ebayService.deleteInventoryObjects(credentials, { groupKey });
      if (skus.length) await ebayService.deleteInventoryObjects(credentials, { skus });
    }
    const hidden = new Set((connection.settings?.hiddenItemIds || []).map(String));
    hidden.add(String(itemId));
    await connectionService.updateConnectionSettings(connectionId, userId, { hiddenItemIds: [...hidden] });
    return {};
  });

  await listingRepository.deleteByItemId(connectionId, itemId);
  ebayService.invalidateListings(connectionId);
}

async function publish(id, userId) {
  const listing = await listingRepository.findByIdForUser(id, userId);
  if (!listing) {
    throw new ListingError('Listing not found', 404);
  }
  if (listing.status !== 'pending_review') {
    throw new ListingError(`Only a listing pending review can be published (this one is "${listing.status}")`, 400);
  }
  if (listing.edit_of_item_id) {
    return publishLiveEdit(listing, userId);
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
      // The branded HTML is the offer's listingDescription; the plain text
      // stays as the inventory item's (4,000-char) description.
      const html = await renderDraftDescription(listing, userId);
      const branded = {
        ...draft,
        ...(Array.isArray(draft.variants) && draft.variants.length ? { commonListingDescription: html } : { listingDescription: html }),
      };
      const built = withSkus(branded, listing.connection_id);
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

    ebayService.invalidateListings(listing.connection_id);
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
  renderDraftDescription,
  uploadDraftImage,
  fetchDraftImage,
  ListingError,
  createEbayDraft,
  previewDraftSources,
  generateEbayDraftFromUrls,
  listPendingDrafts,
  getDraftDetail,
  previewDescription,
  updateDraft,
  removeDraft,
  proposeTextRevision,
  proposeImageRevision,
  acceptImageRevision,
  removeAxisValue,
  publish,
  startLiveEdit,
  removeInactiveListing,
  htmlToText,
};
