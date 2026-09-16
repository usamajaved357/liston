const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const taxonomy = require('../../src/modules/ebay/ebay.taxonomy');
const appToken = require('../../src/modules/ebay/ebay.app-token');

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
