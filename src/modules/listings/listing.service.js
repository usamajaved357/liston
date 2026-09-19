const crypto = require('crypto');
const listingRepository = require('./listing.repository');
const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const marketplaces = require('../ebay/marketplaces');
const orchestrator = require('../ai-generation/generation.orchestrator');
const imageGates = require('../ai-generation/image-pipeline/gates');
const { prepareAspectsForEbay } = require('../ai-generation/aspect-validator');
const storeCategory = require('./store-category');
const logger = require('../../utils/logger');
const revisionService = require('./listing-revision.service');
const eps = require('../ai-generation/image-pipeline/eps');
const imageOps = require('../ai-generation/image-pipeline/image.ops');
const descriptionTemplate = require('./description-template');
const ebayTaxonomy = require('../ebay/ebay.taxonomy');
const textGenerator = require('../ai-generation/text-generator.service');
const governor = require('../ebay/request-governor');

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

async function generateEbayDraftFromUrlsNow(
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
  const finalDraftInput = { ...draftInput, skuBase, sku: `Liston-${skuBase.replace(/^AE/, '')}`, ...(storeCategoryNames.length ? { storeCategoryNames } : {}) };

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

  return { listing, policies, category: await categoryInfoFor(listing.generated_data || {}) };
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

  // Renames come first: removals and everything after refer to the new
  // names the editor shows. A value must stay unique on its axis (two
  // variations with the same option is a rejected group).
  for (const rename of patch.renameAxisValues || []) {
    const clash = (draft.variants || []).some(
      (variant) => variant.aspects?.[rename.axis]?.[0] === rename.to && variant.aspects?.[rename.axis]?.[0] !== rename.from
    );
    if (clash) throw new ListingError(`"${rename.to}" is already an option on ${rename.axis}.`, 400);
    draft.variants = (draft.variants || []).map((variant) =>
      variant.aspects?.[rename.axis]?.[0] === rename.from ? { ...variant, aspects: { ...variant.aspects, [rename.axis]: [rename.to] } } : variant
    );
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
    draft.variants = (draft.variants || []).map((variant) => {
      if (!variant.aspects || !(rename.from in variant.aspects)) return variant;
      const aspects = {};
      for (const [name, values] of Object.entries(variant.aspects)) aspects[name === rename.from ? rename.to : name] = values;
      return { ...variant, aspects };
    });
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

  if (patch.variantSkusToRemove?.length) {
    const drop = new Set(patch.variantSkusToRemove);
    draft.variants = (draft.variants || []).filter((_, index) => !drop.has(String(index)));
  }

  for (const removal of patch.removeAxisValues || []) {
    draft = removeAxisValue(draft, removal.axis, removal.value);
  }

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
    draft.warnings.unshift(`Category changed to ${draft.categoryPath.join(' > ')}: title, description and item specifics were refitted. Check them.`);
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

async function removeDraft(id, userId) {
  await loadEditableDraft(id, userId);
  return listingRepository.deleteDraft(id, userId);
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

  const revised = await connectionService.withDecryptedCredentials(listing.connection_id, userId, (credentials) =>
    ebayService.reviseLiveListing(credentials, listing.edit_of_item_id, payload)
  );
  resyncListings(listing.connection_id, userId);
  // The edit is now live; the working copy has done its job.
  await listingRepository.deleteById(listing.id);
  // eBay applies what it can and warns about the rest (a description it
  // refused to replace, for one). The seller must hear that, or they trust
  // a preview that never went live.
  return { ...listing, status: 'published', external_product_id: listing.edit_of_item_id, deleted: true, warnings: revised.warnings || [] };
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

  const draft = listing.generated_data || {};
  const marketplaceId = draft.marketplaceId;

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
  const tidied = dedupeVariationGroup(readied.draft);
  const readyDraft = tidied.draft;
  if (tidied.warnings.length) logger.warn('Draft variations deduplicated for publish', { listingId: id, warnings: tidied.warnings });

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
        ...readyDraft,
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

    resyncListings(listing.connection_id, userId);
    const row = await listingRepository.updateStatus(id, 'published', { externalProductId: result.externalProductId });
    return tidied.warnings.length ? { ...row, warnings: tidied.warnings } : row;
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
    await listingRepository.updateStatus(id, 'pending_review', { errorMessage: err.message?.slice(0, 500) });
    throw err;
  }
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
  const readyDraft = isVariation ? { ...draft, variesBy: { ...draft.variesBy, aspects } } : { ...draft, aspects };
  return { draft: readyDraft, missing };
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
  publish,
  startLiveEdit,
  removeInactiveListing,
  endLiveListing,
  htmlToText,
};
