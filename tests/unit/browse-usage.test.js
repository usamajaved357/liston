const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const browseUsage = require('../../src/modules/ebay/browse-usage');
const ebayBrowse = require('../../src/modules/ebay/api/ebay.browse');

test.afterEach(() => {
  mock.restoreAll();
  browseUsage._reset();
});

// eBay stands in: the app token is granted, Browse answers `status`.
function fakeEbay(status = 200) {
  return mock.method(global, 'fetch', async (url) =>
    /oauth/.test(String(url))
      ? { ok: true, status: 200, json: async () => ({ access_token: 'app-token', expires_in: 7200 }) }
      : { ok: status < 400, status, json: async () => ({ total: 0, itemSummaries: [] }) }
  );
}

test('every Browse call is counted by name and by who made it', async () => {
  fakeEbay();
  await ebayBrowse.getItemByLegacyId('123', 'EBAY_GB'); // drafting reads a competitor listing
  await browseUsage.as('research', async () => {
    await ebayBrowse.searchItemSummaries({ q: 'socks' }, 'EBAY_GB');
    await ebayBrowse.getItem('v1|1|0', 'EBAY_GB');
    await ebayBrowse.getItem('v1|2|0', 'EBAY_GB');
  });
  await browseUsage.as('health', () => ebayBrowse.searchItemSummaries({ q: 'hats' }, 'EBAY_GB'));

  const snap = browseUsage.snapshot();
  assert.strictEqual(snap.used, 5);
  assert.strictEqual(snap.remaining, 4995);
  assert.deepStrictEqual(snap.byKind, { drafting: 1, research: 3, health: 1 });
  assert.deepStrictEqual(snap.byCall, { getItemByLegacyId: 1, search: 2, getItem: 2 });
  assert.match(snap.resetAt, /T07:00:00\.000Z$/, "eBay's reset, 07:00 UTC");
});

test('a refused call still counts, and eBay saying "too many" marks the day used up', async () => {
  fakeEbay(429);
  await assert.rejects(ebayBrowse.getItem('v1|1|0', 'EBAY_GB'));
  const snap = browseUsage.snapshot();
  assert.strictEqual(snap.used, 1);
  assert.strictEqual(snap.exhausted, true);
});

test("eBay's own figure for the Browse pool replaces the local count", () => {
  browseUsage.record('search');
  browseUsage.applyEbayFigure({
    rateLimits: [
      { apiName: 'Order', resources: [{ name: 'buy.order', rates: [{ limit: 100, remaining: 1, reset: '2030-01-01T07:00:00.000Z' }] }] },
      {
        apiName: 'Browse',
        resources: [
          { name: 'buy.browse.item.bulk', rates: [{ limit: 5000, remaining: 5000 }] },
          { name: 'buy.browse', rates: [{ limit: 5000, remaining: 4120, reset: '2030-01-01T07:00:00.000Z' }] },
        ],
      },
    ],
  });
  const snap = browseUsage.snapshot();
  assert.strictEqual(snap.limit, 5000);
  assert.strictEqual(snap.used, 880);
  assert.strictEqual(snap.resetAt, '2030-01-01T07:00:00.000Z');
  assert.ok(snap.lastSyncedWithEbay);
  assert.deepStrictEqual(snap.byKind, { drafting: 1 }, 'who used it stays as counted');
});
