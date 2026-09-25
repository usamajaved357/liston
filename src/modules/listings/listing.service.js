const crypto = require('crypto');
const listingRepository = require('./listing.repository');
const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const marketplaces = require('../ebay/marketplaces');
const orchestrator = require('../ai-generation/generation.orchestrator');
const imageGates = require('../ai-generation/image-pipeline/gates');
const { prepareAspectsForEbay, canonicalizeVariationValues } = require('../ai-generation/aspect-validator');
const storeCategory = require('./store-category');
const logger = require('../../utils/logger');
const { hazmatTriggersIn, HAZMAT_TRIGGERS, REPLACEMENTS, scrubDraft } = require('./policy-words');
const revisionService = require('./listing-revision.service');
const eps = require('../ai-generation/image-pipeline/eps');
const imageOps = require('../ai-generation/image-pipeline/image.ops');
const descriptionTemplate = require('./description-template');
const ebayTaxonomy = require('../ebay/api/ebay.taxonomy');
const textGenerator = require('../ai-generation/text-generator.service');
const governor = require('../ebay/request-governor');
const analyticsService = require('../analytics/analytics.service');
const listingSort = require('./listing-sort');
const { alignVariantPhotos } = require('./variant-photos');
const imagePipeline = require('../ai-generation/image-pipeline');

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

// --- unique custom labels ----------------------------------------------------
//
// eBay treats a SKU as ONE product per account: publishing under a label a
// live listing already uses revises that listing into this product (seen
// live — a headlight draft nearly overwrote an endoscope listing). So a
// label is checked against everything Liston knows before it is used, and
// replaced with a fresh one when it's taken.

// A short, readable, unambiguous tag: no 0/O or 1/I.
const SKU_TAG_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SKU_TAG_PATTERN = /-[A-HJ-NP-Z2-9]{4}$/;

function skuTag() {
  const bytes = crypto.randomBytes(4);
  return [...bytes].map((b) => SKU_TAG_ALPHABET[b % SKU_TAG_ALPHABET.length]).join('');
}

// What a draft's labels are built from: the label as it stands minus any
// tag Liston added, else the Liston prefix plus the supplier's product id.
function skuBaseOf(draft) {
  const current = typeof draft.sku === 'string' ? draft.sku.trim() : '';
  if (current) return current.replace(SKU_TAG_PATTERN, '');
  return `Liston-${String(draft.skuBase || `SRC${Date.now()}`).replace(/^AE/, '')}`;
}

// Where a label is already in use, described for the seller, or null.
//   • another Liston record on this connection (a draft, or a published one)
//   • a live listing in the account's mirror (labels set on eBay directly)
//   • eBay's own offers, when credentials are given (the authority)
async function skuInUse(connectionId, sku, { excludeListingId = null, credentials = null, marketplaceId } = {}) {
  const other = await listingRepository.findOtherWithSku(connectionId, sku, excludeListingId);
  if (other) return other.status === 'published' && other.external_product_id ? `live listing ${other.external_product_id}` : 'another draft';
  if (!credentials) return null;
  const page = await ebayService.listListingsDetailed(credentials, { connectionId, status: 'active', search: sku, perPage: 0 }).catch(() => null);
  const mirrored = page?.items?.find((item) => item.sku === sku || String(item.sku || '').startsWith(`${sku}-`));
  if (mirrored) return `live listing ${mirrored.itemId}`;
  const live = await ebayService.findLiveListingForSku(credentials, sku, marketplaceId).catch(() => ({ listingId: null }));
  return live.listingId ? `live listing ${live.listingId}` : null;
}

// A label nothing else on the account uses: the base plus a fresh tag,
// re-drawn until it's free.
async function uniqueSku(connectionId, base, options = {}) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = `${base}-${skuTag()}`;
    if (!(await skuInUse(connectionId, candidate, options))) return candidate;
  }
  throw new ListingError("Couldn't find a free SKU for this draft. Try again.", 500);
}

// The seller's "give me a new SKU" button.
async function regenerateSku(id, userId) {
  const listing = await loadEditableDraft(id, userId);
  const draft = listing.generated_data || {};
  const sku = await connectionService.withDecryptedCredentials(listing.connection_id, userId, async (credentials) =>
    uniqueSku(listing.connection_id, skuBaseOf(draft), { excludeListingId: id, credentials, marketplaceId: draft.marketplaceId || 'EBAY_GB' })
  );
  const saved = await listingRepository.updateGeneratedData(id, { ...draft, sku });
  return { sku, listing: saved };
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
  // settings.ebay also holds push bookkeeping, so its existence doesn't mean
  // defaults were chosen: a policy without one is left for the editor to
  // ask for, and said so here.
  const unset = [
    ['fulfillmentPolicyId', 'postage'],
    ['paymentPolicyId', 'payment'],
    ['returnPolicyId', 'returns'],
  ]
    .filter(([key]) => !listingPolicies[key])
    .map(([, name]) => name);
  if (unset.length) {
    const list = unset.length > 1 ? `${unset.slice(0, -1).join(', ')} and ${unset[unset.length - 1]}` : unset[0];
    warnings = [...(warnings || []), `This account has no default ${list} policy in Settings: choose ${unset.length > 1 ? 'them' : 'it'} here before publishing.`];
  }

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

  const { competitor, source, categorySuggestions } = await orchestrator.readSources({ competitorUrl, sourceUrl, marketplaceId });

  const previewId = crypto.randomUUID();
  previews.set(previewId, { competitor, source, categorySuggestions, userId, connectionId, competitorUrl, sourceUrl, expiresAt: Date.now() + PREVIEW_TTL_MS });
  const category = await orchestrator.resolveCategory({ competitor, categorySuggestions, marketplaceId });

  // The variations as the draft will shape them (see planVariationAxes):
  // only axes with a real choice, under the names eBay and the competitor
  // use in this category; single-option axes are shown as fixed. The seller
  // chooses from exactly what will be drafted.
  const schema = (await ebayTaxonomy.getAspectSchema(marketplaceId, category.categoryId)) || [];
  const allowedAxes = schema.filter((a) => a.variation).map((a) => a.name);
  const plan = orchestrator.planVariationAxes({ source, competitor, allowedAxes, blockedAxes: schema.filter((a) => !a.variation).map((a) => a.name) });
  // Per option, a thumbnail where the supplier has one, so a colour can be
  // chosen by eye rather than by name.
  const axes = plan.axes.map((axis) => ({
    name: axis.name,
    ebayName: axis.ebayName,
    via: axis.via,
    hasImages: axis.hasImages,
    values: axis.values.map((value) => ({
      value,
      imageUrl: (source.variants || []).find((v) => v.attributes[axis.name] === value && v.imageUrl)?.imageUrl || null,
      combinations: (source.variants || []).filter((v) => v.attributes[axis.name] === value).length,
    })),
  }));
  const competitorAxes = Object.entries(
    (competitor?.variants || []).reduce((acc, v) => {
      for (const [axis, value] of Object.entries(v.attributes || {})) (acc[axis] = acc[axis] || new Set()).add(value);
      return acc;
    }, {})
  ).map(([name, values]) => ({ name, values: [...values] }));

  return {
    previewId,
    competitor: competitor
      ? { title: competitor.title, priceText: competitor.priceText, categoryPath: competitor.categoryBreadcrumb, axes: competitorAxes }
      : null,
    category: { id: category.categoryId, path: category.categoryPath },
    categorySuggestions,
    source: {
      title: source.title,
      priceText: source.priceText,
      imageUrls: source.imageUrls || [],
      axes,
      fixed: Object.entries(plan.fixed).map(([name, value]) => ({ name, value })),
      allowedAxes,
      warnings: plan.warnings,
      totalCombinations: (source.variants || []).length,
    },
  };
}

// The single entry point for the "paste a competitor URL + a source URL"
// flow: scrapes both, drafts content + variations with AI, then reuses
// createEbayDraft's existing policy-resolution/eBay-drafting/persist path
// unchanged.
// The seller is waiting on these, so every eBay call inside runs at
// 'user' priority against the shared allowance, tagged with the account.
function generateEbayDraftFromUrls(connectionId, userId, input) {
  return governor.withContext({ connectionId: String(connectionId), priority: 'user' }, () =>
    generateEbayDraftFromUrlsNow(connectionId, userId, input)
  );
}

// The supplier photos the seller kept in step two, in their order. Only
// photos the preview read are accepted, so a draft can't be pointed at
// anything else.
function keptPhotos(source, imageUrls) {
  const offered = new Set(source.imageUrls || []);
  const kept = [...new Set(imageUrls)].filter((url) => offered.has(url));
  if (!kept.length) throw new ListingError('Keep at least one of the supplier\'s photos.', 400);
  return { ...source, imageUrls: kept, imagesChosen: true };
}

async function generateEbayDraftFromUrlsNow(
  connectionId,
  userId,
  { competitorUrl, sourceUrl, previewId, variantSelection, imageUrls }
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
    preRead = imageUrls ? { ...preview, source: keptPhotos(preview.source, imageUrls) } : preview;
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
    categorySuggestions: preRead?.categorySuggestions,
    variantSelection,
    accessToken,
    // Sell prices are derived from the supplier's own cost plus these
    // settings, not typed per draft. Undefined is fine — the pricing service
    // falls back to its documented defaults (60% ROI, 18% ads, 12%
    // processing, £0.30 per order).
    pricing: { currency: marketplaces.currencyFor(ebaySettings.marketplaceId || 'EBAY_GB'), ...(connection.settings?.pricing || {}) },
    merchantLocationKey: ebaySettings.merchantLocationKey,
    // The competitor is read from — and the category schema fetched for —
    // the same marketplace the listing will be published to, so the category
    // ids and aspect names line up.
    marketplaceId: ebaySettings.marketplaceId || 'EBAY_GB',
    countryOfOrigin: connection.settings?.listing?.countryOfOrigin || marketplaces.summary(ebaySettings.marketplaceId || 'EBAY_GB').countryName,
  });

  // Only the SKU BASE is decided here; the actual SKUs are stamped at publish
  // (see withSkus). A draft that's edited for days shouldn't be holding SKUs
  // reserved against an eBay index that will have moved on by the time it
  // goes live.
  // The seller-visible SKU (eBay's "custom label"). Defaults to a Liston
  // prefix plus the supplier's product id; editable on the draft.
  const skuBase = baseSkuFromSourceUrl(sourceUrl);
  // Filed under the seller's own Shop department when one fits (their
  // "New in" when none does); editable on the draft.
  const storeCategoryNames = await suggestStoreCategoriesFor(connectionId, userId, draftInput);
  // Drafting the same supplier product twice must not hand both drafts the
  // same label; eBay itself is consulted at publish (see publishNow).
  const sku = await uniqueSku(connectionId, `Liston-${skuBase.replace(/^AE/, '')}`);
  const finalDraftInput = { ...draftInput, skuBase, sku, ...(storeCategoryNames.length ? { storeCategoryNames } : {}) };

  return createEbayDraft(connectionId, userId, finalDraftInput, {
    sourceData: { competitor, source },
    // What the automated steps couldn't do (dropped aspects, variants with no
    // photo of their own). Persisted so the review page can show it rather
    // than the seller finding out from a live listing.
    warnings,
  });
}

async function suggestStoreCategoriesFor(connectionId, userId, draft) {
  try {
    const { categories } = await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) =>
      ebayService.getStoreCategoriesCached(credentials, connectionId)
    );
    const isVariation = Array.isArray(draft.variants) && draft.variants.length > 0;
    return storeCategory.suggestStoreCategories(categories, {
      title: isVariation ? draft.commonTitle : draft.title,
      categoryPath: draft.categoryPath || [],
      specifics: isVariation ? draft.variesBy?.aspects : draft.aspects,
    }).names;
  } catch (err) {
    logger.warn('Could not suggest a Shop category', { connectionId, error: err.message });
    return [];
  }
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

  return {
    listing,
    policies,
    category: await categoryInfoFor(listing.generated_data || {}),
    // Words eBay's hazardous-materials filter blocks, for the editor to
    // flag as the seller types (see policy-words.js).
    policyWords: HAZMAT_TRIGGERS,
  };
}

// What the editor needs to know about a draft's category: whether eBay lets
// it carry variations, and its full item-specifics schema so every specific
// eBay lists (required or optional) can be shown, filled or not.
async function categoryInfoFor(draft) {
  if (!draft.categoryId) return null;
  const marketplaceId = draft.marketplaceId || 'EBAY_GB';
  const [variationsSupported, aspects] = await Promise.all([
    ebayTaxonomy.getVariationsSupported(marketplaceId, draft.categoryId),
    ebayTaxonomy.getEditorAspectSchema(marketplaceId, draft.categoryId),
  ]);
  return {
    id: String(draft.categoryId),
    path: draft.categoryPath || [],
    variationsSupported,
    aspects: aspects || [],
    // The attribute names eBay accepts as variations here (null when unknown).
    variationAspects: aspects ? aspects.filter((a) => a.variation).map((a) => a.name) : null,
    // Item specifics of this category that eBay does NOT let a listing vary
    // by ("Unit Quantity"). Any other name is fine: eBay accepts a seller's
    // own variation attribute alongside the ones it suggests.
    blockedVariationAspects: aspects ? aspects.filter((a) => !a.variation).map((a) => a.name) : null,
  };
}

// The variation attributes eBay refuses in this category, with what it
// accepts instead. eBay turns down an item specific of the category that it
// doesn't let vary ("Unit Quantity is not allowed as a variation specific",
// seen live); a name it doesn't list at all is the seller's own attribute,
// which it accepts. Empty when fine or unknown.
async function disallowedVariationAxes(draft) {
  const specs = draft.variesBy?.specifications || [];
  if (!specs.length || !draft.categoryId) return { bad: [], allowed: [] };
  const aspects = await ebayTaxonomy.getEditorAspectSchema(draft.marketplaceId || 'EBAY_GB', draft.categoryId);
  if (!aspects) return { bad: [], allowed: [] };
  const allowed = aspects.filter((a) => a.variation).map((a) => a.name);
  if (!allowed.length) return { bad: [], allowed: [] };
  const blocked = new Set(aspects.filter((a) => !a.variation).map((a) => a.name.toLowerCase()));
  return { bad: specs.map((s) => s.name).filter((name) => blocked.has(name.toLowerCase())), allowed };
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

// Puts removed variations back (`indexes` into draft.removedVariants): each
// returns to the list, and any option it carries that its attribute no
// longer lists (the whole value was removed) is listed again. One that
// matches a variation already there (the seller re-added it by hand) isn't
// doubled.
function restoreVariants(draft, indexes) {
  const removed = draft.removedVariants || [];
  const wanted = new Set(indexes.map(Number));
  const keyOf = (variant) => JSON.stringify(Object.entries(variant.aspects || {}).sort(([a], [b]) => a.localeCompare(b)));
  const present = new Set((draft.variants || []).map(keyOf));
  const back = [];
  for (const [index, entry] of removed.entries()) {
    if (!wanted.has(index)) continue;
    const { removedAt, ...variant } = entry;
    void removedAt;
    if (present.has(keyOf(variant))) continue;
    present.add(keyOf(variant));
    back.push(variant);
  }
  let specifications = draft.variesBy?.specifications || [];
  for (const variant of back) {
    for (const [axis, [value]] of Object.entries(variant.aspects || {})) {
      if (value === undefined) continue;
      const spec = specifications.find((s) => s.name === axis);
      if (!spec) specifications = [...specifications, { name: axis, values: [value] }];
      else if (!spec.values.includes(value)) specifications = specifications.map((s) => (s === spec ? { ...s, values: [...s.values, value] } : s));
    }
  }
  return {
    ...draft,
    variants: [...(draft.variants || []), ...back],
    removedVariants: removed.filter((_, index) => !wanted.has(index)),
    ...(draft.variesBy ? { variesBy: { ...draft.variesBy, specifications } } : {}),
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
    // A photo set on one row is its option's photo (every size of that colour).
    const photoRows = Object.keys(patch.variants).filter((index) => patch.variants[index]?.imageUrls !== undefined);
    if (photoRows.length) draft = alignVariantPhotos(draft, photoRows);
  }

  // Renames come first: removals and everything after refer to the new
  // names the editor shows. A value must stay unique on its axis (two
  // variations with the same option is a rejected group).
  for (const rename of patch.renameAxisValues || []) {
    const clash = (draft.variants || []).some(
      (variant) => variant.aspects?.[rename.axis]?.[0] === rename.to && variant.aspects?.[rename.axis]?.[0] !== rename.from
    );
    if (clash) throw new ListingError(`"${rename.to}" is already an option on ${rename.axis}.`, 400);
    const renameValue = (variant) =>
      variant.aspects?.[rename.axis]?.[0] === rename.from ? { ...variant, aspects: { ...variant.aspects, [rename.axis]: [rename.to] } } : variant;
    draft.variants = (draft.variants || []).map(renameValue);
    // A removed variation put back later must match the names it returns to.
    if (draft.removedVariants?.length) draft.removedVariants = draft.removedVariants.map(renameValue);
    if (draft.variesBy?.specifications) {
      draft.variesBy = {
        ...draft.variesBy,
        specifications: draft.variesBy.specifications.map((spec) =>
          spec.name === rename.axis ? { ...spec, values: spec.values.map((v) => (v === rename.from ? rename.to : v)) } : spec
        ),
      };
    }
  }
  for (const rename of patch.renameAxes || []) {
    if (rename.from === rename.to) continue;
    // Renaming onto another axis would fold two choices into one, leaving
    // variations that only differed on the old axis identical.
    const otherAxes = (draft.variesBy?.specifications || []).map((spec) => spec.name).filter((name) => name !== rename.from);
    if (otherAxes.some((name) => name.toLowerCase() === rename.to.toLowerCase())) {
      throw new ListingError(`"${rename.to}" is already a variation attribute on this listing.`, 400);
    }
    // Not an item specific eBay refuses to vary by in this category; the
    // seller's own names are fine.
    const { bad, allowed } = await disallowedVariationAxes({ ...draft, variesBy: { specifications: [{ name: rename.to }] } });
    if (bad.length) {
      throw new ListingError(
        `eBay doesn't allow "${rename.to}" as a variation attribute in this category — it's a fixed item specific here. Use one it suggests (${allowed.join(', ')}) or a name of your own.`,
        400
      );
    }
    const renameAxis = (variant) => {
      if (!variant.aspects || !(rename.from in variant.aspects)) return variant;
      const aspects = {};
      for (const [name, values] of Object.entries(variant.aspects)) aspects[name === rename.from ? rename.to : name] = values;
      return { ...variant, aspects };
    };
    draft.variants = (draft.variants || []).map(renameAxis);
    if (draft.removedVariants?.length) draft.removedVariants = draft.removedVariants.map(renameAxis);
    if (draft.variesBy) {
      draft.variesBy = {
        ...draft.variesBy,
        specifications: (draft.variesBy.specifications || []).map((spec) => (spec.name === rename.from ? { ...spec, name: rename.to } : spec)),
        aspectsImageVariesBy: (draft.variesBy.aspectsImageVariesBy || []).map((name) => (name === rename.from ? rename.to : name)),
      };
    }
  }

  // New options. On a single-axis listing that's one new variation; on a
  // multi-axis one it's one per combination the copied option already has
  // (a new colour gets every size the copied colour comes in).
  for (const add of patch.addAxisValues || []) {
    const variants = draft.variants || [];
    if (variants.some((variant) => variant.aspects?.[add.axis]?.[0] === add.value)) {
      throw new ListingError(`"${add.value}" is already an option on ${add.axis}.`, 400);
    }
    const source = variants.filter((variant) => variant.aspects?.[add.axis]?.[0] === (add.copyFrom ?? variants[0]?.aspects?.[add.axis]?.[0]));
    if (!source.length) throw new ListingError(`Nothing to copy the new ${add.axis} option from.`, 400);
    const created = source.map((variant) => ({
      ...variant,
      sku: undefined,
      aspects: { ...variant.aspects, [add.axis]: [add.value] },
    }));
    draft.variants = [...variants, ...created];
    if (draft.variesBy?.specifications) {
      draft.variesBy = {
        ...draft.variesBy,
        specifications: draft.variesBy.specifications.map((spec) => (spec.name === add.axis ? { ...spec, values: [...spec.values, add.value] } : spec)),
      };
    }
  }

  // Removed variations are kept on the draft (removedVariants) until it's
  // published, so the editor can put one back; eBay is never sent them.
  const before = draft.variants || [];
  if (patch.variantSkusToRemove?.length) {
    const drop = new Set(patch.variantSkusToRemove);
    draft.variants = before.filter((_, index) => !drop.has(String(index)));
  }

  for (const removal of patch.removeAxisValues || []) {
    draft = removeAxisValue(draft, removal.axis, removal.value);
  }
  const kept = new Set(draft.variants || []);
  const removedNow = before.filter((variant) => !kept.has(variant));
  if (removedNow.length) {
    const at = new Date().toISOString();
    draft.removedVariants = [...(draft.removedVariants || []), ...removedNow.map((variant) => ({ ...variant, removedAt: at }))];
  }

  // Putting removed variations back (by their place in removedVariants).
  if (patch.restoreVariants?.length) draft = restoreVariants(draft, patch.restoreVariants);

  for (const field of ['title', 'description', 'commonTitle', 'commonDescription', 'condition', 'imageUrls', 'sku', 'storeCategoryNames']) {
    if (patch[field] !== undefined) draft[field] = patch[field];
  }
  if (patch.secondaryCategoryId !== undefined) draft.secondaryCategoryId = patch.secondaryCategoryId || null;

  // Moving category: the path comes from eBay's tree (never typed), and the
  // title, description and specifics are refitted by the model to the new
  // category's vocabulary and required specifics. Facts stay; wording moves.
  if (patch.categoryId !== undefined && String(patch.categoryId) !== String(draft.categoryId)) {
    const marketplaceId = draft.marketplaceId || 'EBAY_GB';
    const path = await ebayTaxonomy.getCategoryPath(marketplaceId, patch.categoryId);
    if (!path.length) throw new ListingError("That category isn't in eBay's tree for this marketplace.", 400);
    const leaf = (await ebayTaxonomy.getCategoryChildren(marketplaceId, patch.categoryId)).length === 0;
    if (!leaf) throw new ListingError('Pick a final category (one with no sub-categories); eBay only lists in those.', 400);

    draft.categoryId = String(patch.categoryId);
    draft.categoryPath = path.map((p) => p.name);

    const aspectSchema = await ebayTaxonomy.getAspectSchema(marketplaceId, draft.categoryId);
    const refit = await textGenerator.refitContentForCategory({
      draft,
      source: listing.source_data?.source || null,
      categoryPath: draft.categoryPath,
      aspectSchema,
      variationAxes: (draft.variesBy?.specifications || []).map((spec) => spec.name),
    });
    const isVariation = Array.isArray(draft.variants) && draft.variants.length > 0;
    const origin = draft.variesBy?.aspects?.['Country/Region of Manufacture'] || draft.aspects?.['Country/Region of Manufacture'];
    const aspects = { ...refit.aspects, ...(origin ? { 'Country/Region of Manufacture': origin } : {}) };
    if (isVariation) {
      draft.commonTitle = refit.title;
      draft.commonDescription = refit.description;
      draft.variesBy = { ...draft.variesBy, aspects };
    } else {
      draft.title = refit.title;
      draft.description = refit.description;
      draft.aspects = aspects;
    }
    draft.warnings = [...(draft.warnings || []).filter((w) => !/^Category changed/.test(w)), ...refit.warnings];
    draft.warnings.unshift(`Category changed to ${draft.categoryPath.join(' > ')}: the title and item specifics were refitted to it. Check them.`);
    // Nothing the patch also carries for these fields should win over a
    // refit the seller just asked for; the editor sends the category alone.
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

  let updated = await listingRepository.updateGeneratedData(id, draft);
  // A recorded publish failure was about the draft as it was; a category
  // change is the usual fix for it, so the stale message goes with it.
  if (patch.categoryId !== undefined && listing.error_message) {
    updated = await listingRepository.updateStatus(id, 'pending_review', { errorMessage: null });
  }
  // Returned rather than enforced: an edit that leaves a gap should be
  // visible immediately in the editor, not only refused later at publish.
  return { listing: updated, imageCheck: imageGates.checkDraftImages(draft) };
}

// AI revisions are PROPOSALS — they read the draft but never write it. The
// seller accepts by sending the change back through updateDraft, which is
// the same path a hand edit takes.
async function proposeTextRevision(id, userId, instruction, current = null) {
  const listing = await loadEditableDraft(id, userId);
  const draft = listing.generated_data || {};
  // What the model may pick from: the account's policies and Shop
  // categories by name, and the specifics eBay requires here.
  const [policies, category] = await Promise.all([
    draft.listingPolicies
      ? connectionService
          .withDecryptedCredentials(listing.connection_id, userId, (credentials) => ebayService.getBusinessPolicies(credentials))
          .catch(() => null)
      : null,
    categoryInfoFor(draft).catch(() => null),
  ]);
  const options = {
    policies: policies && {
      postage: (policies.fulfillmentPolicies || []).map((p) => ({ id: p.fulfillmentPolicyId, name: p.name })),
      payment: (policies.paymentPolicies || []).map((p) => ({ id: p.paymentPolicyId, name: p.name })),
      returns: (policies.returnPolicies || []).map((p) => ({ id: p.returnPolicyId, name: p.name })),
    },
    requiredAspects: (category?.aspects || []).filter((a) => a.required).map((a) => a.name),
    storeCategories: current?.storeCategories || [],
  };
  return revisionService.reviseText({ draft, instruction, current, options });
}

// Rewrites every word eBay's hazardous-materials filter reacts to, on the
// draft itself. Words with a safe replacement in the fixed table (the
// common ones: lead → weight, battery → power cell…) are swapped straight
// away, at no cost. Only a word the table has no wording for goes to the
// model, which can rephrase the sentence rather than just drop the word —
// and it returns the passages it changes, not the whole listing. Whatever
// is left after that is swapped by the table. Applied and saved, not
// proposed: the seller asked for exactly this.
async function fixPolicyWords(id, userId) {
  const listing = await loadEditableDraft(id, userId);
  let draft = listing.generated_data || {};
  const before = hazmatTriggersIn(draft);
  if (!before.length) return { changed: false, before: [], remaining: [], summary: 'No word from the filter list is in this draft.' };

  const words = [...new Set(before.map((entry) => entry.match(/^"([^"]+)"/)[1]))];
  const uncovered = words.filter((w) => !Object.prototype.hasOwnProperty.call(REPLACEMENTS, w.toLowerCase()));
  const applied = [];
  if (uncovered.length) {
    try {
      const proposal = await revisionService.reviseText({
        draft,
        purpose: 'editor.policy',
        instruction:
          `Remove every occurrence of ${uncovered.map((w) => `"${w}"`).join(', ')} from the title, the description, the item specifics and the variation option names. ` +
          `This is mandatory even where the word describes the product accurately — eBay's automated filter refuses the listing while any of them is present. ` +
          `Rephrase so the meaning survives without the word. Change only the sentences that contain it: return the new title if it has one, ` +
          `descriptionEdits for the description, every changed item specific, and a renameAxisValues entry for every option name that contained one of the words.`,
        options: {},
      });
      if (!proposal.cannotDo && Object.keys(proposal.changes).length) {
        const patch = {};
        for (const key of ['title', 'commonTitle', 'description', 'commonDescription']) if (proposal.changes[key] !== undefined) patch[key] = proposal.changes[key];
        if (proposal.changes.aspects) {
          const current = Array.isArray(draft.variants) && draft.variants.length ? draft.variesBy?.aspects : draft.aspects;
          patch.aspects = { ...(current || {}), ...proposal.changes.aspects };
        }
        if (proposal.changes.renameAxisValues?.length) patch.renameAxisValues = proposal.changes.renameAxisValues;
        if (Object.keys(patch).length) {
          const result = await updateDraft(id, userId, patch);
          draft = result.listing.generated_data || draft;
          applied.push(proposal.summary || 'Reworded by the AI editor.');
        }
      }
    } catch (err) {
      logger.warn('AI rewording of policy words failed; falling back to replacement', { listingId: id, error: err.message });
    }
  }

  // Backstop: whatever is still there is swapped for safe wording.
  if (hazmatTriggersIn(draft).length) {
    const { changes } = scrubDraft(draft);
    if (Object.keys(changes).length) {
      const result = await updateDraft(id, userId, changes);
      draft = result.listing.generated_data || draft;
      applied.push(uncovered.length ? 'Remaining words swapped for safe wording.' : `Swapped ${words.map((w) => `"${w}"`).join(', ')} for safe wording.`);
    }
  }

  const remaining = hazmatTriggersIn(draft);
  const fresh = await listingRepository.findByIdForUser(id, userId);
  return { changed: applied.length > 0, before, remaining, summary: applied.join(' '), listing: fresh };
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
function uploadDraftImage(id, userId, input) {
  return governor.withContext({ priority: 'user' }, () => uploadDraftImageNow(id, userId, input));
}

async function uploadDraftImageNow(id, userId, { dataUrl, replaces, variantIndex }) {
  const listing = await loadEditableDraft(id, userId);
  const draft = { ...(listing.generated_data || {}) };

  // Whatever the browser labelled it — AI tools save .avif, .jfif, .webp, or
  // a file with no type at all — the bytes decide: anything that reads as a
  // picture is taken, and a format eBay doesn't take is sent as a JPEG.
  const match = /^data:[^,]*;base64,(.+)$/is.exec(dataUrl || '');
  if (!match) throw new ListingError('Choose a photo to upload.', 400);
  const buffer = await imageOps.toUploadable(Buffer.from(match[1], 'base64')).catch(() => {
    throw new ListingError(
      "That file couldn't be read as a picture. Save it as JPG or PNG and upload it again (iPhone HEIC photos need converting first).",
      400
    );
  });
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
    Object.assign(draft, alignVariantPhotos(draft, [variantIndex]));
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

// When eBay refuses the draft's variation attribute in its category, the
// ways out, ready to click: categories eBay itself suggests for this product
// where variations are allowed AND an attribute like ours is accepted (with
// the name to use there), and the attribute names accepted where we are.
async function variationFixes(id, userId) {
  const listing = await loadEditableDraft(id, userId);
  const draft = listing.generated_data || {};
  const marketplaceId = draft.marketplaceId || 'EBAY_GB';
  const specs = draft.variesBy?.specifications || [];
  if (!specs.length) return { axes: [], allowedHere: [], categories: [] };

  const { bad, allowed } = await disallowedVariationAxes(draft);
  if (!bad.length) return { axes: [], allowedHere: allowed, categories: [] };

  // Candidates: what the draft already carries plus a fresh ask for the
  // title, minus the category we're in.
  const title = draft.commonTitle || draft.title || '';
  const fresh = await ebayTaxonomy.suggestCategories(marketplaceId, title, 8).catch(() => []);
  const seen = new Set([String(draft.categoryId)]);
  const candidates = [...(draft.categorySuggestions || []), ...fresh].filter((c) => {
    if (seen.has(String(c.id))) return false;
    seen.add(String(c.id));
    return true;
  });

  const categories = [];
  for (const candidate of candidates.slice(0, 8)) {
    const [supported, aspects] = await Promise.all([
      ebayTaxonomy.getVariationsSupported(marketplaceId, candidate.id),
      ebayTaxonomy.getEditorAspectSchema(marketplaceId, candidate.id),
    ]);
    if (supported === false || !aspects) continue;
    const allowedThere = aspects.filter((a) => a.variation).map((a) => a.name);
    // Every refused attribute must have a home there: an exact name, or the
    // closest allowed one.
    const mapping = {};
    let fits = true;
    for (const axis of bad) {
      const exact = allowedThere.find((n) => n.toLowerCase() === axis.toLowerCase());
      const close = exact || orchestrator.closestVariationAspect(axis, allowedThere);
      if (!close) {
        fits = false;
        break;
      }
      mapping[axis] = close;
    }
    if (fits) categories.push({ id: String(candidate.id), name: candidate.name, path: candidate.path, axisNames: mapping });
    if (categories.length >= 3) break;
  }

  return { axes: bad, allowedHere: allowed, categories };
}

// Moves the draft to one of those categories and renames the refused
// attribute(s) to what that category accepts, as one action.
async function applyVariationFix(id, userId, { categoryId, axisNames }) {
  await updateDraft(id, userId, { categoryId: String(categoryId) });
  const renames = Object.entries(axisNames || {})
    .filter(([from, to]) => from !== to)
    .map(([from, to]) => ({ from, to }));
  if (renames.length) return updateDraft(id, userId, { renameAxes: renames });
  const listing = await listingRepository.findByIdForUser(id, userId);
  return { listing, imageCheck: imageGates.checkDraftImages(listing.generated_data || {}) };
}

// Lifts one variation out of a variation draft into a plain single-item
// draft of its own. The way to list a product whose category refuses
// multi-variation listings: each option becomes its own listing.
async function splitVariant(id, userId, index) {
  const listing = await loadEditableDraft(id, userId);
  const draft = listing.generated_data || {};
  const variant = (draft.variants || [])[index];
  if (!variant) throw new ListingError('That variation is no longer on the draft.', 404);

  const optionLabel = Object.values(variant.aspects || {})
    .map((values) => values[0])
    .filter(Boolean)
    .join(' ');
  let title = draft.commonTitle || '';
  if (optionLabel && !title.toLowerCase().includes(optionLabel.toLowerCase())) {
    const candidate = `${title} ${optionLabel}`.trim();
    title = candidate.length <= 80 ? candidate : `${title.slice(0, 80 - optionLabel.length - 1).trimEnd()} ${optionLabel}`;
  }

  const imageUrls = [...new Set([...(variant.imageUrls || []), ...(draft.imageUrls || [])])];
  const single = {
    title,
    description: draft.commonDescription,
    imageUrls,
    aspects: { ...(draft.variesBy?.aspects || {}), ...(variant.aspects || {}) },
    condition: variant.condition || 'NEW',
    quantity: variant.quantity ?? 1,
    categoryId: draft.categoryId,
    categoryPath: draft.categoryPath || [],
    categorySuggestions: draft.categorySuggestions || [],
    secondaryCategoryId: draft.secondaryCategoryId || null,
    storeCategoryNames: draft.storeCategoryNames || [],
    price: variant.price,
    priceBreakdown: variant.priceBreakdown,
    merchantLocationKey: draft.merchantLocationKey,
    marketplaceId: draft.marketplaceId,
    listingPolicies: draft.listingPolicies,
    skuBase: draft.skuBase,
    sku: draft.sku ? `${draft.sku}-${index + 1}` : undefined,
    splitFromListingId: id,
  };

  return listingRepository.createDraft({
    connectionId: listing.connection_id,
    sku: single.sku || null,
    platformOfferId: null,
    platformGroupKey: null,
    generatedData: single,
    sourceData: listing.source_data,
  });
}

// Returns the removed row (for the team activity record).
async function removeDraft(id, userId) {
  const draft = await loadEditableDraft(id, userId);
  await listingRepository.deleteDraft(id, userId);
  return draft;
}

// The account's own live listings, for the "You may also like" cards. Read
// at render time so the carousel is always current, and never includes the
// listing being published. Failure here costs the carousel, not the publish.
// The account's best sellers, from the mirror (no eBay call per render).
async function recommendedListings(credentials, connection, { exclude, count, seed }) {
  if (!(Number(count) > 0)) return [];
  try {
    const { items } = await ebayService.bestSellingListings(credentials, connection.id, {
      exclude,
      count: Number(count),
      push: ebayService.pushEnabled(connection),
      seed,
    });
    return items;
  } catch {
    return [];
  }
}

// The branded description for a draft: the AI copy inside this account's
// template, with this account's live listings recommended underneath.
async function renderDraftDescription(listing, userId) {
  const draft = listing.generated_data || {};
  const isVariation = Array.isArray(draft.variants) && draft.variants.length > 0;
  return renderWithTemplate(listing.connection_id, userId, {
    template: null,
    productName: isVariation ? draft.commonTitle : draft.title,
    description: isVariation ? draft.commonDescription : draft.description,
    condition: (isVariation ? draft.variants[0]?.condition : draft.condition) || 'NEW',
    exclude: listing.external_product_id || listing.edit_of_item_id,
    // The listing's own mix of best sellers, stable across preview and publish.
    seed: listing.edit_of_item_id || listing.id,
  });
}

// The Theme tab's preview: an unsaved template over a sample product.
function renderTemplatePreview(connectionId, userId, template, sample) {
  return renderWithTemplate(connectionId, userId, { template, ...sample, exclude: null, seed: null });
}

async function renderWithTemplate(connectionId, userId, { template: override, productName, description, condition, exclude, seed }) {
  return connectionService.withDecryptedCredentials(connectionId, userId, async (credentials, connection) => {
    const marketplaceId = connection.settings?.ebay?.marketplaceId;
    let template = descriptionTemplate.templateWithDefaults(override || connection.settings?.template, marketplaceId);

    // Anything the seller hasn't filled in comes from the store itself —
    // eBay already holds the store's name, the logo they uploaded and the
    // live feedback score. A blank field means "use eBay's", never "leave a
    // hole". Failure here just leaves the blanks blank.
    if (!template.storeName || !template.logoUrl || !template.feedbackPercent) {
      try {
        const profile = await ebayService.getStoreProfile(credentials, connection.id);
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

    const recommended = await recommendedListings(credentials, connection, { exclude, count: template.recommendedCount, seed });
    return descriptionTemplate.renderDescription({ template, marketplaceId, productName, description, recommended, condition });
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
  // Liston's styled lists carry their own marker (✓, ★, 1. …): keep it.
  text = text.replace(/<li[^>]*>\s*<span class="eb-b">([^<]*)<\/span>/gi, '$1 ');
  // A section heading sits directly above its content, with no blank line.
  text = text.replace(/(<p class="eb-h">[\s\S]*?<\/p>)\s*<p>/gi, '$1');
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
  const fallbackCurrency = marketplaces.currencyFor(marketplaceId);
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
          price: { value: v.price ? v.price.amount.toFixed(2) : '0.00', currency: v.price?.currency || item.currency || fallbackCurrency },
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
    price: { value: item.price ? item.price.amount.toFixed(2) : '0.00', currency: item.price?.currency || item.currency || fallbackCurrency },
  };
}

// `fromInactive`: opened from the Inactive tab, i.e. to relist it.
async function startLiveEdit(connectionId, userId, itemId, { fromInactive = false } = {}) {
  const existing = await listingRepository.findLiveEdit(connectionId, userId, itemId);
  if (existing) {
    // An unfinished edit is resumed, but whether the listing is still live
    // is read again when it's unknown (a copy from before Liston recorded
    // it) or when it's opened to relist and not yet marked ended — so a
    // stale copy never opens an ended listing as live (1 GetItem).
    const known = existing.source_data && 'liveStatus' in existing.source_data;
    if (known && !(fromInactive && !existing.source_data.ended)) return existing;
    return connectionService.withDecryptedCredentials(connectionId, userId, async (credentials) => {
      const item = await ebayService.getLiveItem(credentials, itemId);
      const ended = Boolean(item.listingStatus && item.listingStatus !== 'Active');
      const { ended: _was, ...rest } = existing.source_data || {};
      const sourceData = { ...rest, liveStatus: item.listingStatus || null, ...(ended ? { ended: true } : {}) };
      return listingRepository.updateSourceData(existing.id, sourceData);
    });
  }

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

    // The listing as it was, so publishing the edit can record what changed
    // (for its before/after figures in Analytics). An ended listing is
    // marked: publishing it relists it rather than revising.
    const ended = Boolean(item.listingStatus && item.listingStatus !== 'Active');
    return listingRepository.createLiveEdit({
      connectionId,
      itemId,
      sku: item.sku,
      generatedData: draft,
      sourceData: { liveOriginal: editSnapshot(draft), liveStatus: item.listingStatus || null, ...(ended ? { ended: true } : {}) },
    });
  });
}

// What a live edit is judged by: the things buyers see in search and on
// the listing. Text is kept as a fingerprint, not copied.
function editSnapshot(draft) {
  const variation = Array.isArray(draft.variants) && draft.variants.length > 0;
  const fingerprint = (value) => crypto.createHash('sha1').update(JSON.stringify(value ?? '')).digest('hex').slice(0, 12);
  const aspects = (variation ? draft.variesBy?.aspects : draft.aspects) || {};
  const sortedAspects = Object.keys(aspects)
    .sort()
    .map((k) => [k, aspects[k]]);
  const prices = variation ? draft.variants.map((v) => Number(v.price?.value)).filter(Number.isFinite) : [Number(draft.price?.value)].filter(Number.isFinite);
  return {
    title: String((variation ? draft.commonTitle : draft.title) || ''),
    mainPhoto: draft.imageUrls?.[0] || null,
    photos: (draft.imageUrls || []).length,
    photoSet: fingerprint(draft.imageUrls || []),
    price: prices.length ? Math.min(...prices) : null,
    quantity: variation ? draft.variants.reduce((sum, v) => sum + (Number(v.quantity) || 0), 0) : Number(draft.quantity) || 0,
    specifics: Object.values(aspects).filter((v) => (v || []).some((x) => String(x).trim())).length,
    specificsSet: fingerprint(sortedAspects),
    description: fingerprint(variation ? draft.commonDescription : draft.description),
  };
}

// The fields that differ between two snapshots, with readable before/after
// values (fingerprints stay out of them).
function editDifferences(before, after) {
  if (!before || !after) return null;
  const fields = [];
  if (before.title !== after.title) fields.push('title');
  if (before.mainPhoto !== after.mainPhoto) fields.push('main_photo');
  else if (before.photoSet !== after.photoSet) fields.push('photos');
  if (before.price !== after.price) fields.push('price');
  if (before.quantity !== after.quantity) fields.push('quantity');
  if (before.specificsSet !== after.specificsSet) fields.push('specifics');
  if (before.description !== after.description) fields.push('description');
  if (!fields.length) return null;
  const readable = ({ title, mainPhoto, photos, price, quantity, specifics }) => ({ title, mainPhoto, photos, price, quantity, specifics });
  return { fields, before: readable(before), after: readable(after) };
}

/**
 * One page of the account's live (or ended) listings for the Listings tab,
 * in the chosen order (listing-sort.js), each with its latest sale and its
 * latest edit from Liston. The whole list is sorted before paging, so page
 * 1 is the top of everything; no eBay call beyond the cached list.
 */
async function pageOfListings(credentials, { connectionId, status, search, sort, page = 1, perPage = 25, hiddenItemIds = [], push = false }) {
  const all = await ebayService.listListingsDetailed(credentials, { connectionId, status, search, page: 1, perPage: 0, hiddenItemIds, push });
  const current = all.credentialsChanged ? all.credentials : credentials;
  const [lastSold, edits] = await Promise.all([
    ebayService.lastSalesByItem(current, { connectionId, push }).catch(() => new Map()),
    listingRepository.latestChanges(connectionId, new Date(0)).catch(() => new Map()),
  ]);
  const items = all.items.map((item) => ({
    ...item,
    lastSoldAt: lastSold.get(String(item.itemId)) || null,
    lastEditedAt: edits.get(String(item.itemId))?.changed_at || null,
  }));
  const sortKey = listingSort.sortFor(sort, status);
  const sorted = listingSort.sortListings(items, sortKey, status);
  const size = perPage > 0 ? perPage : Math.max(1, sorted.length);
  const totalPages = Math.max(1, Math.ceil(sorted.length / size));
  const safePage = Math.min(Math.max(1, page), totalPages);
  return {
    items: sorted.slice((safePage - 1) * size, safePage * size),
    totalEntries: sorted.length,
    totalPages,
    page: safePage,
    perPage: size,
    sort: sortKey,
    allCount: all.allCount,
    syncedAt: all.syncedAt,
    credentialsChanged: all.credentialsChanged,
    credentials: all.credentials,
  };
}

async function publishLiveEdit(listing, userId) {
  let draft = listing.generated_data || {};
  const isVariation = Array.isArray(draft.variants) && draft.variants.length > 0;
  // An ended listing can't be revised (eBay refuses any change to it); it
  // is relisted instead, with the edit's fields, as a new item.
  let relist = Boolean(listing.source_data?.ended);
  const imageCheck = imageGates.checkDraftImages(draft);
  if (!imageCheck.ok) throw new ListingError(imageCheck.errors.join(' '), 400);
  const photos = await readyPhotosForPublish(listing, draft, userId);
  draft = photos.draft;
  if (relist) {
    const stock = isVariation ? draft.variants.reduce((sum, v) => sum + (Number(v.quantity) || 0), 0) : Number(draft.quantity) || 0;
    if (stock <= 0) throw new ListingError('Set the quantity above 0 before relisting: eBay won’t relist a listing with no stock.', 400);
  }

  const html = await renderDraftDescription(listing, userId);
  // Same readiness rules as a new publish (no axis in the shared set,
  // identifiers marked "Does Not Apply").
  const readied = await readyAspectsForPublish(draft);
  if (readied.missing.length) {
    throw new ListingError(
      `eBay requires ${readied.missing.join(', ')} for this category. Fill ${readied.missing.length === 1 ? 'it' : 'them'} in item specifics, then publish again.`,
      400
    );
  }
  const specifics = isVariation ? readied.draft.variesBy?.aspects : readied.draft.aspects;
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

  // A listing Liston published itself lives in eBay's Inventory system, which
  // the Trading revise refuses to touch; it is revised through the Inventory
  // API instead. Liston's own record says which; failing that, eBay's answer
  // to the Trading revise does.
  const own = await listingRepository.findPublishedByItemId(listing.connection_id, listing.edit_of_item_id);
  const inventoryRef = inventoryRefFor(own, readied.draft, listing);
  const storeCategoryNames = draft.storeCategoryNames || own?.generated_data?.storeCategoryNames;
  const reviseViaInventory = (credentials, ref) =>
    ebayService.reviseInventoryListing(credentials, {
      ...ref,
      draft: { ...readied.draft, sku: ref.sku || readied.draft.sku },
      listingDescription: html,
      marketplaceId: draft.marketplaceId,
      storeCategoryNames,
    });
  const revised = await connectionService.withDecryptedCredentials(listing.connection_id, userId, async (credentials) => {
    if (inventoryRef) return reviseViaInventory(credentials, inventoryRef);
    return reviseOrRelist(credentials);
  }).catch((err) => {
    // eBay won't have two identical listings from one seller live at once:
    // say which one is live and what to do, not eBay's paragraph.
    const liveId = relist ? ebayService.duplicateListingOf(err) : null;
    if (liveId === null) throw err;
    throw new ListingError(
      `eBay won't relist this: the same item is already live on this account${liveId ? ` as #${liveId}` : ''}. Add stock or variations to that listing instead, or end it first and relist this one.`,
      409
    );
  });
  async function reviseOrRelist(credentials) {
    try {
      if (relist) return await ebayService.relistLiveListing(credentials, listing.connection_id, listing.edit_of_item_id, payload);
      try {
        return await ebayService.reviseLiveListing(credentials, listing.edit_of_item_id, payload);
      } catch (err) {
        // It ended after the edit was opened: put it back instead.
        if (!ebayService.isEndedListingError(err)) throw err;
        relist = true;
        return await ebayService.relistLiveListing(credentials, listing.connection_id, listing.edit_of_item_id, payload);
      }
    } catch (err) {
      // Liston's SKU scheme gives the inventory objects away; failing that
      // (another tool's SKUs), eBay's inventory item says which group.
      let guessed = ebayService.isInventoryManagedError(err) ? guessInventoryRef(readied.draft, listing) : null;
      if (!guessed && ebayService.isInventoryManagedError(err)) {
        const skus = isVariation ? readied.draft.variants.map((v) => v.sku) : [readied.draft.sku || listing.sku];
        guessed = await ebayService.inventoryRefForSkus(credentials, { skus, isVariation }).catch(() => null);
      }
      if (!guessed) {
        if (ebayService.isInventoryManagedError(err)) {
          throw new ListingError(
            relist
              ? "This listing was created through eBay's Inventory API by another tool, and eBay only lets that tool relist it. Relist it there, or draft it again in Liston."
              : "This listing was created through eBay's Inventory API by another tool, and eBay only lets that tool revise it. Edit it there, or end it and relist it from Liston.",
            400
          );
        }
        throw err;
      }
      return reviseViaInventory(credentials, guessed);
    }
  }
  if (photos.warnings.length && revised) revised.warnings = [...photos.warnings, ...(revised.warnings || [])];
  resyncListings(listing.connection_id, userId);
  if (relist) return finishRelist(listing, draft, own, revised);
  // What changed, for the listing's before/after figures in Analytics. A
  // failure to record never fails the edit itself.
  const changed = editDifferences(listing.source_data?.liveOriginal, editSnapshot(draft));
  if (changed) {
    await listingRepository
      .recordListingChange(listing.connection_id, listing.edit_of_item_id, changed)
      .catch((err) => logger.warn('Listing change not recorded', { itemId: listing.edit_of_item_id, error: err.message }));
  }
  // The listing's deeper check follows the edit, so its health stops
  // asking for fixes that just went live.
  await analyticsService
    .checkAfterEdit(listing.connection_id, listing.edit_of_item_id, draft)
    .catch((err) => logger.warn('Health check not updated after edit', { itemId: listing.edit_of_item_id, error: err.message }));
  // Liston's record of the published listing follows the edit, so the next
  // edit starts from what is live and the draft never contradicts eBay.
  if (own) {
    const { liveItemId, ...edited } = draft;
    await listingRepository.updateGeneratedData(own.id, { ...(own.generated_data || {}), ...edited }).catch(() => {});
  }
  // The edit is now live; the working copy has done its job.
  await listingRepository.deleteById(listing.id);
  // eBay applies what it can and warns about the rest (a description it
  // refused to replace, for one). The seller must hear that, or they trust
  // a preview that never went live.
  return { ...listing, status: 'published', external_product_id: listing.edit_of_item_id, deleted: true, changedFields: changed?.fields || [], warnings: revised.warnings || [] };
}

// After a relist: eBay's new item number (from the Trading relist, or the
// Inventory publish for a listing Liston made) becomes the one Liston's
// record points at, the ended one leaves the Inactive tab, and the working
// copy goes. A relist is a new listing, so no before/after is recorded.
async function finishRelist(listing, draft, own, revised) {
  const newItemId = String(revised.relistedFrom ? revised.itemId : revised.listingId || listing.edit_of_item_id);
  ebayService.removeListingFromMirror(listing.connection_id, listing.edit_of_item_id);
  if (own) {
    const { liveItemId, ...edited } = draft;
    await listingRepository.updateGeneratedData(own.id, { ...(own.generated_data || {}), ...edited }).catch(() => {});
    if (newItemId !== String(listing.edit_of_item_id)) await listingRepository.setExternalProductId(own.id, newItemId).catch(() => {});
  }
  await listingRepository.deleteById(listing.id);
  logger.info('Ended listing relisted', { connectionId: listing.connection_id, from: listing.edit_of_item_id, to: newItemId });
  return { ...listing, status: 'published', external_product_id: newItemId, relisted: true, relistedFrom: String(listing.edit_of_item_id), deleted: true, warnings: revised.warnings || [] };
}

// Where on eBay's Inventory system a Liston-published listing lives, from
// Liston's own record of publishing it: the group key for a variation
// listing, the offer id (and SKU) for a single one. Null when Liston has no
// such record — the listing was made some other way.
function inventoryRefFor(own, draft, listing) {
  if (!own) return null;
  if (own.platform_group_key) return { groupKey: own.platform_group_key };
  if (own.platform_offer_id) return { offerId: own.platform_offer_id, sku: own.sku || own.generated_data?.sku || draft.sku || listing.sku };
  return null;
}

// Without a record, Liston's own SKU scheme still gives it away: variation
// SKUs are "<group key>-<n>", a single one is the offer's SKU.
function guessInventoryRef(draft, listing) {
  if (Array.isArray(draft.variants) && draft.variants.length) {
    const first = draft.variants.find((v) => typeof v.sku === 'string' && /-\d+$/.test(v.sku));
    return first ? { groupKey: first.sku.replace(/-\d+$/, '') } : null;
  }
  const sku = draft.sku || listing.sku;
  return sku ? { sku } : null;
}

// Ends a live listing on eBay now. A working copy opened for editing it is
// dropped — there is nothing left to publish changes to.
async function endLiveListing(connectionId, userId, itemId) {
  const result = await connectionService.withDecryptedCredentials(connectionId, userId, (credentials) =>
    ebayService.endLiveListing(credentials, connectionId, itemId)
  );
  const workingCopy = await listingRepository.findLiveEdit(connectionId, userId, itemId);
  if (workingCopy) await listingRepository.deleteById(workingCopy.id);
  return { itemId: String(itemId), endTime: result.endTime, warnings: result.warnings || [] };
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
  // Gone from the Inactive tab at once, no eBay round trip needed.
  ebayService.removeListingFromMirror(connectionId, itemId);
}

// After something we published or revised: re-read the account's listings
// from eBay in the background so every open Listings tab updates on its
// own. Nothing waits on it, and a failure just means the next view refreshes.
function resyncListings(connectionId, userId) {
  connectionService
    .withDecryptedCredentials(connectionId, userId, (credentials) => ebayService.syncAccount(credentials, connectionId, ['listings']))
    .catch(() => ebayService.invalidateListings(connectionId));
}

async function publish(id, userId) {
  const listing = await listingRepository.findByIdForUser(id, userId);
  if (listing?.connection_id) {
    return governor.withContext({ connectionId: String(listing.connection_id), priority: 'user' }, () => publishNow(listing, id, userId));
  }
  return publishNow(listing, id, userId);
}

/**
 * What a draft still lacks before eBay would take it, in the seller's
 * words and in the editor's terms (title, price, policies, variation
 * names), so the publish says what to fix instead of eBay's rejection after
 * the build. Empty when nothing is missing.
 */
function draftGaps(draft) {
  const gaps = [];
  const variants = Array.isArray(draft.variants) ? draft.variants : [];
  const isVariation = variants.length > 0;
  const title = isVariation ? draft.commonTitle ?? draft.title : draft.title;
  if (!String(title || '').trim()) gaps.push('Add a title.');
  const priced = (p) => Number(p?.value) > 0;
  if (isVariation) {
    const unpriced = variants.map((v, i) => (priced(v.price) ? null : i + 1)).filter(Boolean);
    if (unpriced.length) gaps.push(`Enter a price for variation${unpriced.length === 1 ? '' : 's'} ${unpriced.join(', ')} in the variations table.`);
  } else if (!priced(draft.price)) {
    gaps.push('Enter a price.');
  }
  const policies = draft.listingPolicies;
  if (policies) {
    const missing = [
      ['fulfillmentPolicyId', 'postage'],
      ['paymentPolicyId', 'payment'],
      ['returnPolicyId', 'returns'],
    ]
      .filter(([key]) => !String(policies[key] || '').trim())
      .map(([, name]) => name);
    const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}` : missing[0];
    if (missing.length) gaps.push(`Choose a ${list} policy.`);
  }
  for (const spec of draft.variesBy?.specifications || []) {
    if (!String(spec.name || '').trim()) {
      gaps.push('A variation attribute has no name. Rename it in the variations table.');
      continue;
    }
    if ((spec.values || []).some((v) => !String(v || '').trim())) {
      gaps.push(`"${spec.name}" has an option with no name. Rename or remove it in the variations table.`);
    }
  }
  return gaps;
}

async function publishNow(listing, id, userId) {
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

  let draft = listing.generated_data || {};
  const marketplaceId = draft.marketplaceId;

  const gaps = draftGaps(draft);
  if (gaps.length) throw new ListingError(`Before publishing: ${gaps.join(' ')}`, 400);

  // A category that refuses variations fails at eBay with an opaque error
  // after minutes of building; say it up front, with the way out.
  if (Array.isArray(draft.variants) && draft.variants.length > 1 && draft.categoryId) {
    const supported = await ebayTaxonomy.getVariationsSupported(marketplaceId || 'EBAY_GB', draft.categoryId);
    if (supported === false) {
      throw new ListingError(
        `eBay doesn't allow multi-variation listings in "${(draft.categoryPath || []).slice(-1)[0] || draft.categoryId}". ` +
          `Change the category, or list each variation separately from the variations table.`,
        400
      );
    }
    const { bad, allowed } = await disallowedVariationAxes(draft);
    if (bad.length) {
      throw new ListingError(
        `eBay doesn't allow "${bad.join('", "')}" as a variation attribute in this category. Rename it to one eBay suggests ` +
          `(${allowed.join(', ')}) or a name of your own, change the category, or list the options separately.`,
        400
      );
    }
  }
  // Every photo on eBay, and every row of an option with that option's
  // photo. Drafts made before drafts went local already have their eBay
  // objects, photos included.
  const alreadyBuilt = Boolean(listing.platform_offer_id || listing.platform_group_key);
  const photos = alreadyBuilt ? { draft, warnings: [] } : await readyPhotosForPublish(listing, draft, userId);
  draft = photos.draft;
  // The item specifics eBay will actually accept: no variation attribute
  // repeated in the shared set, identifiers the product lacks marked "Does
  // Not Apply", and anything still required but empty named here rather
  // than in eBay's rejection after the build. Applied to the copy sent, not
  // the stored draft, so older drafts get it too.
  const readied = await readyAspectsForPublish(draft);
  if (readied.missing.length) {
    throw new ListingError(
      `eBay requires ${readied.missing.join(', ')} for this category. Fill ${readied.missing.length === 1 ? 'it' : 'them'} in item specifics, then publish again.`,
      400
    );
  }
  // A value eBay lists nothing for, on an axis it only takes listed values
  // on, is a certain rejection — said here, with the options, not after the
  // group has been built.
  const certain = (readied.unmatched || []).find((u) => u.selectionOnly);
  if (certain) {
    throw new ListingError(explainRejectedAxisValue({ axis: certain.axis, value: certain.value }, readied.unmatched), 400);
  }
  if (readied.warnings.length) logger.info('Draft option values sent under eBay spelling', { listingId: id, warnings: readied.warnings });
  const tidied = dedupeVariationGroup(readied.draft);
  const readyDraft = tidied.draft;
  if (tidied.warnings.length) logger.warn('Draft variations deduplicated for publish', { listingId: id, warnings: tidied.warnings });

  // Drafts created before drafts went local already have their eBay objects;
  // anything newer is built here, now.
  const alreadyOnEbay = Boolean(listing.platform_offer_id || listing.platform_group_key);
  const skuWarnings = [];
  // What this attempt built on eBay, for the failure path below.
  const attempt = { built: null, credentials: null };
  // Product identifiers (EAN/UPC/ISBN) the draft carries explicitly; see
  // the "field is missing" retry below for how one gets added.
  let identifiers = { ...(draft.identifiers || {}) };
  let identifierRetried = false;

  const runAttempt = () =>
    connectionService.withDecryptedCredentials(listing.connection_id, userId, async (credentials) => {
      if (alreadyOnEbay) {
        return listing.platform_group_key
          ? ebayService.publishGroup(credentials, listing.platform_group_key, marketplaceId)
          : ebayService.publishDraft(credentials, listing.platform_offer_id, marketplaceId);
      }

      // A label already used elsewhere on the account is swapped for a
      // fresh one here, on the draft too, rather than failing — or worse,
      // revising the listing that owns it.
      let sku = typeof readyDraft.sku === 'string' && readyDraft.sku.trim() ? readyDraft.sku.trim() : null;
      if (sku) {
        const takenBy = await skuInUse(listing.connection_id, sku, { excludeListingId: id, credentials, marketplaceId });
        if (takenBy) {
          const fresh = await uniqueSku(listing.connection_id, skuBaseOf(readyDraft), { excludeListingId: id, credentials, marketplaceId });
          skuWarnings.push(`SKU changed from ${sku} to ${fresh}: ${sku} is already used by ${takenBy}.`);
          logger.warn('Draft SKU replaced for publish', { listingId: id, from: sku, to: fresh, takenBy });
          await listingRepository.updateGeneratedData(id, { ...draft, sku: fresh });
          sku = fresh;
        }
      }

      // SKUs are assigned at publish rather than at draft: a failed publish
      // leaves half-created SKUs behind, and eBay's SKU index is eventually
      // consistent enough that reusing them on a retry fails. A fresh run
      // suffix each attempt sidesteps that entirely.
      // The branded HTML is the offer's listingDescription; the plain text
      // stays as the inventory item's (4,000-char) description.
      const html = await renderDraftDescription(listing, userId);
      const branded = {
        ...readyDraft,
        identifiers,
        ...(sku ? { sku } : {}),
        ...(Array.isArray(draft.variants) && draft.variants.length ? { commonListingDescription: html } : { listingDescription: html }),
      };
      const built = withSkus(branded, listing.connection_id);
      attempt.built = built;
      attempt.credentials = credentials;
      const isVariation = Array.isArray(built.variants) && built.variants.length > 0;

      const created = isVariation
        ? await ebayService.draftVariationListing(credentials, built)
        : await ebayService.draftListing(credentials, built);

      const published = isVariation
        ? await ebayService.publishGroup(credentials, created.groupKey, marketplaceId)
        : await ebayService.publishDraft(credentials, created.offerId, marketplaceId);

      return { ...published, created, isVariation };
    });

  try {
    let result;
    for (;;) {
      try {
        result = await runAttempt();
        break;
      } catch (err) {
        // Some categories require a barcode (EAN/UPC/ISBN) on the product
        // itself. eBay's sanctioned answer for a product that has none is its
        // "Does not apply" text, so that is sent and the publish retried once,
        // and kept on the draft so later publishes don't hit it again.
        const field = missingIdentifierField(err);
        if (!field || identifierRetried || alreadyOnEbay || identifiers[field]) throw err;
        identifierRetried = true;
        if (attempt.built && attempt.credentials) {
          const skus = Array.isArray(attempt.built.variants) && attempt.built.variants.length ? attempt.built.variants.map((v) => v.sku) : [attempt.built.sku];
          await ebayService.deleteInventoryObjects(attempt.credentials, { groupKey: attempt.built.groupKey, skus }).catch(() => {});
        }
        identifiers = { ...identifiers, [field]: ebayService.notApplicableText(marketplaceId) };
        await listingRepository.updateGeneratedData(id, { ...draft, identifiers });
        skuWarnings.push(
          `eBay requires ${field === 'upc' ? 'a' : 'an'} ${field.toUpperCase()} in this category and the draft had none, so "${identifiers[field]}" was sent. ` +
            `If the product has a barcode, add it as a ${field.toUpperCase()} item specific and it will be used instead.`
        );
        logger.warn('Draft publish retried with a product identifier', { listingId: id, field, value: identifiers[field] });
      }
    }

    if (!alreadyOnEbay) {
      await listingRepository.setPlatformIds(id, {
        platformOfferId: result.isVariation ? null : result.created.offerId,
        platformGroupKey: result.isVariation ? result.created.groupKey : null,
      });
    }

    resyncListings(listing.connection_id, userId);
    const row = await listingRepository.updateStatus(id, 'published', { externalProductId: result.externalProductId });
    const warnings = [...photos.warnings, ...skuWarnings, ...readied.warnings, ...tidied.warnings];
    return warnings.length ? { ...row, warnings } : row;
  } catch (err) {
    // Publishing 100+ variants is minutes of eBay calls and can fail part way
    // through. The draft stays `pending_review` so it's still editable and
    // retryable, with eBay's own reason recorded against it.
    // What was actually sent alongside eBay's reason: "Part Type is
    // missing" reads very differently when the log shows it was there.
    logger.warn('Draft publish failed', {
      listingId: id,
      categoryId: draft.categoryId,
      message: err.message,
      ebayErrors: err.details,
      sharedAspects: Object.keys((Array.isArray(readyDraft.variants) && readyDraft.variants.length ? readyDraft.variesBy?.aspects : readyDraft.aspects) || {}),
      axes: (readyDraft.variesBy?.specifications || []).map((s) => `${s.name}(${s.values.length})`),
      variants: Array.isArray(readyDraft.variants) ? readyDraft.variants.length : 0,
    });
    if (isPolicyBlock(err)) {
      // eBay keeps its verdict on the objects a refused attempt created and
      // answers "do not relist" to any retry that reuses them — which a
      // seller-set label does. So they are cleared and the draft gets a fresh
      // label; once the words are fixed, the next publish starts clean.
      let cleared = false;
      let freshSku = null;
      if (attempt.built && attempt.credentials) {
        const skus = Array.isArray(attempt.built.variants) && attempt.built.variants.length ? attempt.built.variants.map((v) => v.sku) : [attempt.built.sku];
        await ebayService.deleteInventoryObjects(attempt.credentials, { groupKey: attempt.built.groupKey, skus }).catch(() => {});
        cleared = true;
        freshSku = await uniqueSku(listing.connection_id, skuBaseOf(draft), { excludeListingId: id }).catch(() => null);
        if (freshSku) await listingRepository.updateGeneratedData(id, { ...draft, sku: freshSku });
      }
      // The words the draft was published with, so the trigger can be found
      // from the log when the known list doesn't name it.
      logger.warn('Policy block: text as sent', {
        listingId: id,
        title: readyDraft.commonTitle || readyDraft.title,
        description: readyDraft.commonDescription || readyDraft.description,
        aspects: Array.isArray(readyDraft.variants) && readyDraft.variants.length ? readyDraft.variesBy?.aspects : readyDraft.aspects,
        options: (readyDraft.variesBy?.specifications || []).map((sp) => `${sp.name}: ${sp.values.join(' | ')}`),
      });
      err.message = explainPolicyBlock(err, readyDraft, { cleared, freshSku });
      err.statusCode = 400;
    }
    // An option value eBay refused even though its schema called the axis
    // free text: named with the values it does take, since eBay's own
    // message points at an API call the seller can't make.
    const rejected = rejectedAxisValue(err);
    if (rejected) {
      err.message = explainRejectedAxisValue(rejected, readied.unmatched);
      err.statusCode = 400;
    }
    // Anything else eBay refused about the draft itself (a value it won't
    // take, a field it wants) is the seller's to fix: a 400 with eBay's
    // words, not a server error.
    if (err.ebayStatus >= 400 && err.ebayStatus < 500 && err.statusCode >= 500) {
      err.statusCode = 400;
      err.message = String(err.message || '').replace(/^A user error has occurred\.\s*/i, '');
    }
    await listingRepository.updateStatus(id, 'pending_review', { errorMessage: err.message?.slice(0, 500) });
    throw err;
  }
}

// Before anything goes to eBay: every photo on eBay's own picture service
// (eBay refuses a listing whose photos mix its hosting with a supplier's)
// and every row of an option showing that option's photo. Saved on the
// draft, so it happens once.
async function readyPhotosForPublish(listing, draft, userId) {
  let ready = alignVariantPhotos(draft);
  const warnings = [];
  if (imagePipeline.unhostedImages(ready).length) {
    const hosting = await connectionService.withDecryptedCredentials(listing.connection_id, userId, async (credentials) => {
      const { accessToken } = await ebayService.ensureValidAccessToken(credentials);
      return imagePipeline.hostDraftImages(ready, { accessToken, marketplaceId: ready.marketplaceId });
    });
    if (!hosting.ok) {
      throw new ListingError("eBay couldn't take this listing's photos. Replace them with your own copies (Upload) and publish again.", 400);
    }
    ready = hosting.draft;
    const n = hosting.dropped.length;
    if (n) {
      warnings.push(
        n === 1
          ? "1 photo couldn't be put on eBay and was left out. Add it again with Upload if you need it."
          : `${n} photos couldn't be put on eBay and were left out. Add them again with Upload if you need them.`
      );
    }
  }
  if (ready !== draft) await listingRepository.updateGeneratedData(listing.id, ready);
  return { draft: ready, warnings };
}

// eBay treats "Camo Brown", "camo brown" and "Camo  Brown" as the same
// option, and rejects the whole group ("Duplicate name-value combination in
// variation specifics") when two variations end up with the same
// combination, or a specification lists a value twice. Two supplier SKUs
// with the same display label, or an axis renamed onto a name another axis
// already uses, both get there. The copy sent to eBay is tidied here; the
// stored draft is untouched, and what was dropped is reported.
function optionKey(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function dedupeVariationGroup(draft) {
  const warnings = [];
  if (!Array.isArray(draft.variants) || !draft.variants.length) return { draft, warnings };

  // Specifications: one entry per axis name, each value once.
  const specsByName = new Map();
  for (const spec of draft.variesBy?.specifications || []) {
    const key = optionKey(spec.name);
    const entry = specsByName.get(key) || { name: spec.name, values: [], seen: new Set() };
    for (const value of spec.values || []) {
      const valueKey = optionKey(value);
      if (!valueKey || entry.seen.has(valueKey)) continue;
      entry.seen.add(valueKey);
      entry.values.push(value);
    }
    specsByName.set(key, entry);
  }
  const specifications = [...specsByName.values()].map(({ name, values }) => ({ name, values }));

  // Variations: the first of each combination stays; later identical ones
  // can't be told apart by a buyer anyway.
  const axisNames = specifications.map((s) => s.name);
  const seen = new Set();
  const dropped = [];
  const variants = draft.variants.filter((variant) => {
    const combo = axisNames.map((axis) => `${optionKey(axis)}=${optionKey(variant.aspects?.[axis]?.[0])}`).join('|');
    if (seen.has(combo)) {
      dropped.push(axisNames.map((axis) => `${axis}: ${variant.aspects?.[axis]?.[0] ?? '—'}`).join(', '));
      return false;
    }
    seen.add(combo);
    return true;
  });

  if (dropped.length) {
    const unique = [...new Set(dropped)];
    warnings.push(
      `${dropped.length} duplicate variation${dropped.length === 1 ? ' was' : 's were'} left out: eBay needs every variation to be a ` +
        `different combination, and ${unique.length === 1 ? 'this one appeared' : 'these appeared'} more than once — ${unique.join('; ')}.`
    );
  }

  // Every specification value must still be backed by a variation.
  const kept = specifications
    .map((spec) => ({
      ...spec,
      values: spec.values.filter((value) => variants.some((variant) => optionKey(variant.aspects?.[spec.name]?.[0]) === optionKey(value))),
    }))
    .filter((spec) => spec.values.length > 0);

  return {
    draft: { ...draft, variants, variesBy: { ...(draft.variesBy || {}), specifications: kept } },
    warnings,
  };
}

// eBay's policy block, with what the seller can actually do about it.
function isPolicyBlock(err) {
  const text = `${err.message || ''} ${JSON.stringify(err.details || '')}`;
  return /Hazardous Materials|PI_HAZ|improper words|violation of eBay policy/i.test(text);
}

// eBay 25002 "The EAN field is missing. Please add EAN to the listing and
// try again." — the identifier it wants, lower-cased, or null.
function missingIdentifierField(err) {
  const texts = [err?.message, ...((err?.details || []).flatMap((d) => [d.message, ...((d.parameters || []).map((p) => p.value))]))];
  for (const text of texts) {
    const m = /\bThe (EAN|UPC|ISBN) field is missing/i.exec(String(text || ''));
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function explainPolicyBlock(err, draft, { cleared = false, freshSku = null } = {}) {
  if (!isPolicyBlock(err)) return null;
  const triggers = hazmatTriggersIn(draft);
  return (
    `eBay refused this listing under its Hazardous Materials policy — an automated filter that reacts to words in the title, description, item specifics or variation option names. ` +
    (triggers.length
      ? `Words it commonly reacts to were found: ${triggers.join('; ')}. Reword or remove them, then publish again.`
      : `No word from the known list was found in the title, description, item specifics or option names, so rewording is unlikely to help. eBay's "Please do not relist" wording means it recognises this as an item it previously removed from this account under that policy (it matches on photos and title, not just words). Check Seller Hub for a removed listing of this product, appeal it from eBay's removal message, or relist with genuinely different photos.`) +
    (cleared ? ` What the failed attempts had created on eBay has been cleared${freshSku ? ` and the draft has a fresh SKU (${freshSku})` : ''}, so the next publish starts clean.` : '')
  );
}

// Item specifics as eBay accepts them (see prepareAspectsForEbay), on a
// copy of the draft. Without a schema (Taxonomy down) only the axis rule
// applies; a missing required aspect then surfaces from eBay as before.
async function readyAspectsForPublish(draft) {
  const isVariation = Array.isArray(draft.variants) && draft.variants.length > 0;
  const axes = isVariation ? (draft.variesBy?.specifications || []).map((s) => s.name) : [];
  const schema = draft.categoryId
    ? await ebayTaxonomy.getEditorAspectSchema(draft.marketplaceId || 'EBAY_GB', draft.categoryId).catch(() => null)
    : null;
  const current = isVariation ? draft.variesBy?.aspects : draft.aspects;
  const { aspects, missing } = prepareAspectsForEbay(current, schema, axes);
  if (!isVariation) return { draft: { ...draft, aspects }, missing, warnings: [] };

  // Option values under eBay's own spelling ("XXL" -> "2XL"): eBay now
  // rejects custom values on axes it still calls free text, so a value that
  // plainly means one of its listed ones is sent as that one, and said so.
  const canon = canonicalizeVariationValues(
    { specifications: draft.variesBy?.specifications || [], variants: draft.variants },
    schema
  );
  const warnings = [];
  const byAxis = new Map();
  for (const r of canon.renamed) byAxis.set(r.axis, [...(byAxis.get(r.axis) || []), `${r.from} → ${r.to}`]);
  for (const [axis, pairs] of byAxis) {
    warnings.push(`${axis} options were sent under eBay's spelling for this category: ${pairs.join(', ')}.`);
  }
  const readyDraft = {
    ...draft,
    variants: canon.variants,
    variesBy: { ...draft.variesBy, aspects, specifications: canon.specifications },
  };
  return { draft: readyDraft, missing, warnings, unmatched: canon.unmatched };
}

// eBay 25129 "XXL is not a valid value for Size. Select a value from the
// available options." — the axis and value it refused, or null.
function rejectedAxisValue(err) {
  const texts = [err?.message, ...((err?.details || []).flatMap((d) => [d.message, ...((d.parameters || []).map((p) => p.value))]))];
  for (const text of texts) {
    // The value sits at the start of its own sentence; in the combined
    // message that sentence follows a ";" or "(".
    const m = /(?:^|[;(]\s*)([^;()]+?) is not a valid value for ([^.;()]+?)\. Select a value/i.exec(String(text || ''));
    if (m) return { value: m[1].trim(), axis: m[2].trim() };
  }
  return null;
}

// What the seller can do about a refused option value: which one, and the
// values eBay does take on that axis, instead of eBay's "use
// getItemAspectsForCategory".
function explainRejectedAxisValue(rejected, unmatched = []) {
  const hint = unmatched.find((u) => u.axis.toLowerCase() === rejected.axis.toLowerCase());
  const options = hint?.allowedValues?.length ? ` eBay's ${rejected.axis} values for this category are: ${hint.allowedValues.join(', ')}.` : '';
  return (
    `eBay only accepts its own ${rejected.axis} values in this category and "${rejected.value}" isn't one of them.` +
    options +
    ` Rename the "${rejected.value}" option under Variations to one of those, then publish again.`
  );
}

// Assigns the SKUs (and group key) a publish needs, without mutating the
// stored draft.
function withSkus(draft, connectionId) {
  // The seller's own SKU (custom label) is used as-is when they set one;
  // otherwise the generated base gets a per-attempt suffix so a retried
  // publish never collides with SKUs a failed attempt left behind.
  const own = typeof draft.sku === 'string' && draft.sku.trim() ? draft.sku.trim() : null;
  const base = own || `${draft.skuBase || `SKU${connectionId.slice(0, 8)}`}-${shortRandomSuffix()}`;

  if (Array.isArray(draft.variants) && draft.variants.length) {
    return {
      ...draft,
      groupKey: base,
      variants: draft.variants.map((variant, index) => ({ ...variant, sku: `${base}-${index + 1}` })),
    };
  }
  return { ...draft, sku: base };
}

module.exports = {
  pageOfListings,
  editSnapshot,
  editDifferences,
  renderDraftDescription,
  renderTemplatePreview,
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
  variationFixes,
  applyVariationFix,
  splitVariant,
  removeDraft,
  proposeTextRevision,
  proposeImageRevision,
  acceptImageRevision,
  removeAxisValue,
  dedupeVariationGroup,
  regenerateSku,
  hazmatTriggersIn,
  fixPolicyWords,
  uniqueSku,
  skuInUse,
  publish,
  startLiveEdit,
  removeInactiveListing,
  endLiveListing,
  htmlToText,
};
