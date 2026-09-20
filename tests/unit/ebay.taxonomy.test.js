const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const taxonomy = require('../../src/modules/ebay/api/ebay.taxonomy');
const appToken = require('../../src/modules/ebay/api/ebay.app-token');

// Shaped like a real get_item_aspects_for_category response (EBAY_GB / 20702,
// captured live during implementation).
const ASPECTS_RESPONSE = {
  aspects: [
    {
      localizedAspectName: 'Type',
      aspectConstraint: { aspectRequired: true, aspectMode: 'FREE_TEXT', itemToAspectCardinality: 'SINGLE' },
      aspectValues: [],
    },
    {
      localizedAspectName: 'Colour',
      aspectConstraint: { aspectRequired: false, aspectMode: 'SELECTION', itemToAspectCardinality: 'MULTI' },
      aspectValues: [{ localizedValue: 'White' }, { localizedValue: 'Black' }],
    },
  ],
};

function stubFetch(handler) {
  return mock.method(global, 'fetch', async (url) => {
    const body = handler(String(url));
    return { ok: true, status: 200, json: async () => body };
  });
}

test.beforeEach(() => {
  taxonomy.resetTaxonomyCache();
  appToken.resetApplicationTokenCache();
});

test.afterEach(() => {
  mock.restoreAll();
});

test('getItemAspectsForCategory resolves the tree id then the category aspects', async () => {
  const fetchMock = stubFetch((url) => {
    if (url.includes('get_default_category_tree_id')) return { categoryTreeId: '3' };
    if (url.includes('get_item_aspects_for_category')) return ASPECTS_RESPONSE;
    return { access_token: 'app-token', expires_in: 7200 };
  });

  const aspects = await taxonomy.getItemAspectsForCategory('EBAY_GB', '20702');

  assert.strictEqual(aspects.length, 2);
  const aspectCall = fetchMock.mock.calls.find((c) => String(c.arguments[0]).includes('get_item_aspects_for_category'));
  assert.match(String(aspectCall.arguments[0]), /category_tree\/3\//);
  assert.match(String(aspectCall.arguments[0]), /category_id=20702/);
});

test('getItemAspectsForCategory caches, so a repeat call makes no further requests', async () => {
  const fetchMock = stubFetch((url) => {
    if (url.includes('get_default_category_tree_id')) return { categoryTreeId: '3' };
    if (url.includes('get_item_aspects_for_category')) return ASPECTS_RESPONSE;
    return { access_token: 'app-token', expires_in: 7200 };
  });

  await taxonomy.getItemAspectsForCategory('EBAY_GB', '20702');
  const callsAfterFirst = fetchMock.mock.calls.length;
  await taxonomy.getItemAspectsForCategory('EBAY_GB', '20702');

  assert.strictEqual(fetchMock.mock.calls.length, callsAfterFirst);
});

test('summarizeAspects condenses eBay metadata into the prompt/validation shape', () => {
  const summary = taxonomy.summarizeAspects(ASPECTS_RESPONSE.aspects);

  assert.deepStrictEqual(summary[0], {
    name: 'Type',
    required: true,
    selectionOnly: false,
    multiValue: false,
    variation: false,
    allowedValues: [],
    hasMoreValues: false,
  });
  assert.strictEqual(summary[1].selectionOnly, true);
  assert.strictEqual(summary[1].multiValue, true);
  assert.deepStrictEqual(summary[1].allowedValues, ['White', 'Black']);
});

test('summarizeAspects truncates very long value lists and flags that it did', () => {
  const many = {
    localizedAspectName: 'Brand',
    aspectConstraint: { aspectRequired: false, aspectMode: 'SELECTION', itemToAspectCardinality: 'SINGLE' },
    aspectValues: Array.from({ length: 400 }, (_, i) => ({ localizedValue: `Brand ${i}` })),
  };

  const [summary] = taxonomy.summarizeAspects([many]);

  assert.strictEqual(summary.allowedValues.length, 25);
  assert.strictEqual(summary.hasMoreValues, true);
});

test('getAspectSchema degrades to null rather than failing the whole draft', async () => {
  mock.method(global, 'fetch', async () => ({
    ok: false,
    status: 503,
    json: async () => ({ errors: [{ message: 'Service unavailable' }] }),
  }));

  // A category schema improves a draft but isn't worth losing one over —
  // drafting proceeds on the model's own judgement, as it did before.
  assert.strictEqual(await taxonomy.getAspectSchema('EBAY_GB', '20702'), null);
});

// --- the local category index --------------------------------------------

const fs = require('fs');
const path = require('path');

// A tiny tree in the real get_category_tree shape.
const TREE_RESPONSE = {
  categoryTreeId: '999',
  categoryTreeVersion: '1',
  rootCategoryNode: {
    category: { categoryId: '0', categoryName: 'Root' },
    categoryTreeNodeLevel: 0,
    childCategoryTreeNodes: [
      {
        category: { categoryId: '10', categoryName: 'Vehicle Parts' },
        categoryTreeNodeLevel: 1,
        childCategoryTreeNodes: [
          { category: { categoryId: '11', categoryName: 'Cup Holders' }, categoryTreeNodeLevel: 2, leafCategoryTreeNode: true },
          { category: { categoryId: '12', categoryName: 'Other Car Parts' }, categoryTreeNodeLevel: 2, leafCategoryTreeNode: true },
        ],
      },
      {
        category: { categoryId: '20', categoryName: 'Coins' },
        categoryTreeNodeLevel: 1,
        childCategoryTreeNodes: [{ category: { categoryId: '21', categoryName: 'Coin Holders' }, categoryTreeNodeLevel: 2, leafCategoryTreeNode: true }],
      },
    ],
  },
};

const TEST_MARKET = 'EBAY_TEST';
const treeFile = path.join(process.cwd(), '.cache', `category-tree-${TEST_MARKET}.json`);

function stubTreeFetch() {
  return stubFetch((url) => {
    if (url.includes('get_default_category_tree_id')) return { categoryTreeId: '999' };
    if (url.includes('get_category_suggestions')) return { categorySuggestions: [{ category: { categoryId: '11', categoryName: 'Cup Holders' } }] };
    if (url.includes('get_listing_structure_policies')) return { listingStructurePolicies: [{ categoryId: '12', variationsSupported: false }] };
    if (url.includes('/category_tree/999')) return TREE_RESPONSE;
    return { access_token: 'app-token', expires_in: 7200 };
  });
}

test.afterEach(() => {
  try {
    fs.unlinkSync(treeFile);
  } catch {
    // not written by this test
  }
});

test('getCategoryPath walks the tree from the top level down, excluding the root', async () => {
  stubTreeFetch();
  const path = await taxonomy.getCategoryPath(TEST_MARKET, '11');
  assert.deepStrictEqual(path.map((p) => p.name), ['Vehicle Parts', 'Cup Holders']);
  assert.deepStrictEqual(await taxonomy.getCategoryPath(TEST_MARKET, 'nope'), []);
});

test('getCategoryChildren lists top-level categories, then a branch, with leaf flags', async () => {
  stubTreeFetch();
  const top = await taxonomy.getCategoryChildren(TEST_MARKET);
  assert.deepStrictEqual(top.map((c) => c.name), ['Vehicle Parts', 'Coins']);
  assert.strictEqual(top[0].leaf, false);
  const branch = await taxonomy.getCategoryChildren(TEST_MARKET, '10');
  assert.deepStrictEqual(branch.map((c) => [c.name, c.leaf]), [['Cup Holders', true], ['Other Car Parts', true]]);
});

test('searchCategories puts eBay suggestions first, then local name matches with paths', async () => {
  stubTreeFetch();
  const results = await taxonomy.searchCategories(TEST_MARKET, 'coin');
  // The suggestion (Cup Holders) leads even though its name does not match;
  // Coin Holders follows from the local name search.
  assert.deepStrictEqual(results.map((r) => r.name), ['Cup Holders', 'Coin Holders', 'Coins']);
  assert.deepStrictEqual(results[1].path, ['Coins', 'Coin Holders']);
});

test('getVariationsSupported reads the Metadata API and returns null for an unknown category', async () => {
  stubTreeFetch();
  assert.strictEqual(await taxonomy.getVariationsSupported(TEST_MARKET, '12'), false);
  assert.strictEqual(await taxonomy.getVariationsSupported(TEST_MARKET, '11'), null);
});

test('the category tree is cached on disk and reused without refetching', async () => {
  const fetchMock = stubTreeFetch();
  await taxonomy.getCategoryPath(TEST_MARKET, '11');
  assert.ok(fs.existsSync(treeFile));
  const treeCalls = () => fetchMock.mock.calls.filter((c) => /category_tree\/999(\?|$)/.test(String(c.arguments[0]))).length;
  assert.strictEqual(treeCalls(), 1);

  taxonomy.resetTaxonomyCache();
  await taxonomy.getCategoryPath(TEST_MARKET, '21');
  assert.strictEqual(treeCalls(), 1);
});
