const { apiBaseUrl } = require('./ebay.oauth');
const { getApplicationToken } = require('./ebay.app-token');
const fs = require('fs');
const path = require('path');
const logger = require('../../../utils/logger');

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
    // eBay's lists can repeat a value ("250 V" twice); each once.
    const values = [...new Set((aspect.aspectValues || []).map((v) => v.localizedValue))];
    return {
      name: aspect.localizedAspectName,
      required: Boolean(constraint.aspectRequired),
      // SELECTION means eBay only accepts values from its own list;
      // FREE_TEXT means anything reasonable is allowed.
      selectionOnly: constraint.aspectMode === 'SELECTION',
      multiValue: constraint.itemToAspectCardinality === 'MULTI',
      // Whether eBay lets this aspect be the thing buyers choose between
      // (Colour, Size…) — the names a variation axis should use.
      variation: Boolean(constraint.aspectEnabledForVariations),
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

// ---------------------------------------------------------------------------
// The whole category tree, held locally.
//
// A category picker needs to browse and search ~16,000 categories instantly;
// eBay's per-query suggestion call alone can't do that (it's slow, and it
// only returns leaves it thinks match). The tree itself is ~4MB and changes a
// few times a year, so it's downloaded once, kept on disk, and flattened
// into an in-memory index: id -> { id, name, parentId, leaf, level }.
const TREE_DIR = path.join(process.cwd(), '.cache');
const TREE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const indexes = new Map();

function treeFile(marketplaceId) {
  return path.join(TREE_DIR, `category-tree-${marketplaceId}.json`);
}

async function loadTree(marketplaceId) {
  const file = treeFile(marketplaceId);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < TREE_TTL_MS) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No usable cached tree; fetch below.
  }
  const treeId = await getDefaultCategoryTreeId(marketplaceId);
  const tree = await request(`/commerce/taxonomy/v1/category_tree/${treeId}`);
  try {
    fs.mkdirSync(TREE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(tree));
  } catch (err) {
    logger.warn('Could not cache the eBay category tree on disk', { error: err.message });
  }
  return tree;
}

function buildIndex(tree) {
  const byId = new Map();
  const walk = (node, parentId) => {
    const c = node.category;
    byId.set(String(c.categoryId), {
      id: String(c.categoryId),
      name: c.categoryName,
      parentId,
      leaf: Boolean(node.leafCategoryTreeNode),
      level: node.categoryTreeNodeLevel,
      children: (node.childCategoryTreeNodes || []).map((child) => String(child.category.categoryId)),
    });
    for (const child of node.childCategoryTreeNodes || []) walk(child, String(c.categoryId));
  };
  walk(tree.rootCategoryNode, null);
  return { byId, rootId: String(tree.rootCategoryNode.category.categoryId), version: tree.categoryTreeVersion };
}

function getCategoryIndex(marketplaceId) {
  const hit = indexes.get(marketplaceId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = loadTree(marketplaceId)
    .then(buildIndex)
    .catch((err) => {
      indexes.delete(marketplaceId);
      throw err;
    });
  indexes.set(marketplaceId, { value, expiresAt: Date.now() + TREE_TTL_MS });
  return value;
}

// [{ id, name }] from the top level down to the category itself (root
// excluded). Unknown ids give [].
async function getCategoryPath(marketplaceId, categoryId) {
  const index = await getCategoryIndex(marketplaceId);
  const chain = [];
  let node = index.byId.get(String(categoryId));
  while (node && node.parentId !== null) {
    chain.unshift({ id: node.id, name: node.name });
    node = index.byId.get(node.parentId);
  }
  return chain;
}

function summarizeNode(index, node) {
  return { id: node.id, name: node.name, leaf: node.leaf, childCount: node.children.length };
}

// Direct children of a category (top-level categories when parentId is
// omitted) — the browse side of the picker.
async function getCategoryChildren(marketplaceId, parentId) {
  const index = await getCategoryIndex(marketplaceId);
  const parent = index.byId.get(parentId ? String(parentId) : index.rootId);
  if (!parent) return [];
  return parent.children.map((id) => summarizeNode(index, index.byId.get(id)));
}

const MAX_SEARCH_RESULTS = 40;

// Search for the picker: eBay's own suggestions first (they understand
// "coin holder" means Car Parts), then local name matches so a seller who
// knows the category's name finds it even when eBay's suggestions miss.
async function searchCategories(marketplaceId, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const index = await getCategoryIndex(marketplaceId);
  const seen = new Set();
  const results = [];
  const push = (node) => {
    if (!node || seen.has(node.id) || results.length >= MAX_SEARCH_RESULTS) return;
    seen.add(node.id);
    results.push(summarizeNode(index, node));
  };

  const suggestions = await getCategorySuggestions(marketplaceId, query).catch(() => []);
  for (const suggestion of suggestions) push(index.byId.get(String(suggestion.category?.categoryId)));

  // Local matches, best first: exact name, then name starts with the query,
  // then name contains it. Leaves before branches within each tier, since a
  // listing can only sit in a leaf.
  const tiers = [[], [], []];
  for (const node of index.byId.values()) {
    if (node.parentId === null) continue;
    const name = node.name.toLowerCase();
    if (name === q) tiers[0].push(node);
    else if (name.startsWith(q)) tiers[1].push(node);
    else if (name.includes(q)) tiers[2].push(node);
  }
  for (const tier of tiers) {
    tier.sort((a, b) => Number(b.leaf) - Number(a.leaf) || a.name.localeCompare(b.name));
    for (const node of tier) push(node);
  }

  return Promise.all(results.map(async (r) => ({ ...r, path: (await getCategoryPath(marketplaceId, r.id)).map((p) => p.name) })));
}

// eBay's own guess at the right leaf categories for a product title — the
// suggestions offered next to a draft's category. Returned with paths so
// they read like the picker's rows.
async function suggestCategories(marketplaceId, title, limit = 5) {
  const suggestions = await getCategorySuggestions(marketplaceId, String(title || '').slice(0, 200)).catch(() => []);
  const out = [];
  for (const suggestion of suggestions.slice(0, limit)) {
    const id = String(suggestion.category?.categoryId || '');
    if (!id) continue;
    const path = await getCategoryPath(marketplaceId, id).catch(() => []);
    out.push({
      id,
      name: suggestion.category?.categoryName || path[path.length - 1]?.name || id,
      path: path.length ? path.map((p) => p.name) : (suggestion.categoryTreeNodeAncestors || []).map((a) => a.categoryName).reverse().concat(suggestion.category?.categoryName || []),
    });
  }
  return out;
}

// Whether a leaf category accepts multi-variation listings. This comes from
// the Metadata API (application token, not counted against the Trading
// allowance); Trading's GetCategoryFeatures, which used to answer this, was
// retired in May 2026. Null when eBay couldn't be asked.
async function getVariationsSupported(marketplaceId, categoryId) {
  return cached(`variations:${marketplaceId}:${categoryId}`, async () => {
    try {
      const data = await request(`/sell/metadata/v1/marketplace/${marketplaceId}/get_listing_structure_policies`, {
        filter: `categoryIds:{${categoryId}}`,
      });
      const policy = (data.listingStructurePolicies || []).find((p) => String(p.categoryId) === String(categoryId));
      return policy ? Boolean(policy.variationsSupported) : null;
    } catch (err) {
      logger.warn('Could not check whether the category supports variations', { categoryId, error: err.message });
      return null;
    }
  });
}

// The complete aspect schema for the editor: every specific eBay lists for
// the category with its required flag and allowed values (capped, since
// Brand alone can run to thousands). Null when eBay couldn't be asked.
const MAX_VALUES_IN_EDITOR = 300;

async function getEditorAspectSchema(marketplaceId, categoryId) {
  try {
    const aspects = await getItemAspectsForCategory(marketplaceId, categoryId);
    return aspects.map((aspect) => {
      const constraint = aspect.aspectConstraint || {};
      // eBay's lists can repeat a value ("250 V" twice); each once.
      const values = [...new Set((aspect.aspectValues || []).map((v) => v.localizedValue))];
      return {
        name: aspect.localizedAspectName,
        required: Boolean(constraint.aspectRequired),
        recommended: constraint.aspectUsage === 'RECOMMENDED',
        selectionOnly: constraint.aspectMode === 'SELECTION',
        multiValue: constraint.itemToAspectCardinality === 'MULTI',
        variation: Boolean(constraint.aspectEnabledForVariations),
        allowedValues: values.slice(0, MAX_VALUES_IN_EDITOR),
        hasMoreValues: values.length > MAX_VALUES_IN_EDITOR,
      };
    });
  } catch (err) {
    logger.warn('Could not load the eBay aspect schema for the editor', { categoryId, error: err.message });
    return null;
  }
}

function resetTaxonomyCache() {
  cache.clear();
  indexes.clear();
}

module.exports = {
  getDefaultCategoryTreeId,
  getCategorySuggestions,
  getItemAspectsForCategory,
  summarizeAspects,
  getAspectSchema,
  getEditorAspectSchema,
  getCategoryIndex,
  getCategoryPath,
  getCategoryChildren,
  searchCategories,
  suggestCategories,
  getVariationsSupported,
  resetTaxonomyCache,
};
