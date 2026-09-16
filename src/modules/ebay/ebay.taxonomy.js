const { apiBaseUrl } = require('./ebay.oauth');
const { getApplicationToken } = require('./ebay.app-token');
const logger = require('../../utils/logger');

// eBay publishes, per category, exactly which item specifics it expects:
// which are REQUIRED, which accept only values from a fixed list, and whether
// each takes one value or many. Feeding that to the model — and validating
// its answer against it — is the difference between "the AI guessed some
// aspects" and "the listing carries what eBay actually asked for". Without
// it, a wrong or missing required aspect surfaces as a publish rejection
// after the user has already reviewed and approved the draft.
//
// Same application token as Browse: category schemas are public data.

// Category schemas are effectively static (eBay revises them a few times a
// year), and a draft would otherwise pay this call every time. Cached in
// memory for the process lifetime with a day's TTL.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

function cached(key, produce) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  // Store the promise, not the resolved value, so concurrent callers share
  // one in-flight request instead of racing to make the same call.
  const value = produce().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

async function request(path, params) {
  const accessToken = await getApplicationToken();
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${apiBaseUrl()}${path}${query ? `?${query}` : ''}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20 * 1000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = data.errors?.[0];
    const err = new Error(error?.message || `eBay Taxonomy request failed (${res.status})`);
    err.statusCode = 502;
    err.details = { status: res.status, errorId: error?.errorId };
    throw err;
  }
  return data;
}

function getDefaultCategoryTreeId(marketplaceId) {
  return cached(`tree:${marketplaceId}`, async () => {
    const data = await request('/commerce/taxonomy/v1/get_default_category_tree_id', {
      marketplace_id: marketplaceId,
    });
    return data.categoryTreeId;
  });
}

async function getCategorySuggestions(marketplaceId, query) {
  const treeId = await getDefaultCategoryTreeId(marketplaceId);
  const data = await request(`/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions`, { q: query });
  return data.categorySuggestions || [];
}

// Returns eBay's raw aspect metadata for a category. Shape per aspect:
//   { localizedAspectName, aspectConstraint: { aspectRequired, aspectMode,
//     itemToAspectCardinality, aspectMaxLength }, aspectValues: [{ localizedValue }] }
async function getItemAspectsForCategory(marketplaceId, categoryId) {
  return cached(`aspects:${marketplaceId}:${categoryId}`, async () => {
    const treeId = await getDefaultCategoryTreeId(marketplaceId);
    const data = await request(`/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category`, {
      category_id: categoryId,
    });
    return data.aspects || [];
  });
}

// Condensed into just what the model needs to fill aspects correctly, and
// small enough to sit in a prompt: eBay returns up to several thousand
// allowed values for aspects like Brand, which would swamp the context.
const MAX_VALUES_IN_PROMPT = 25;

function summarizeAspects(aspects) {
  return aspects.map((aspect) => {
    const constraint = aspect.aspectConstraint || {};
    const values = (aspect.aspectValues || []).map((v) => v.localizedValue);
    return {
      name: aspect.localizedAspectName,
      required: Boolean(constraint.aspectRequired),
      // SELECTION means eBay only accepts values from its own list;
      // FREE_TEXT means anything reasonable is allowed.
      selectionOnly: constraint.aspectMode === 'SELECTION',
      multiValue: constraint.itemToAspectCardinality === 'MULTI',
      allowedValues: values.slice(0, MAX_VALUES_IN_PROMPT),
      hasMoreValues: values.length > MAX_VALUES_IN_PROMPT,
    };
  });
}

// A category schema is a nice-to-have, not a hard dependency: if eBay's
// Taxonomy API is down we'd rather draft with the model's own judgement (as
// it did before this existed) than fail the whole request.
async function getAspectSchema(marketplaceId, categoryId) {
  try {
    return summarizeAspects(await getItemAspectsForCategory(marketplaceId, categoryId));
  } catch (err) {
    logger.warn('Could not load the eBay aspect schema. Drafting without it', {
      categoryId,
      error: err.message,
    });
    return null;
  }
}

function resetTaxonomyCache() {
  cache.clear();
}

module.exports = {
  getDefaultCategoryTreeId,
  getCategorySuggestions,
  getItemAspectsForCategory,
  summarizeAspects,
  getAspectSchema,
  resetTaxonomyCache,
};
