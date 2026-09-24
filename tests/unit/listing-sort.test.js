const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const { sortListings, sortFor } = require('../../src/modules/listings/listing-sort');
const ebayService = require('../../src/modules/ebay/ebay.service');
const listingRepository = require('../../src/modules/listings/listing.repository');
const listingService = require('../../src/modules/listings/listing.service');

const item = (itemId, over = {}) => ({ itemId, price: { amount: 5, currency: 'GBP' }, quantityAvailable: 10, quantitySold: 0, startTime: '2026-08-01T00:00:00Z', endTime: null, lastSoldAt: null, lastEditedAt: null, ...over });

// Listed 25 May, 25 Jun, 20 Sept: eBay's "time left" order groups them by
// the day of the month they renew; Liston's default is newest listed first.
const ITEMS = [
  item('1', { startTime: '2026-05-25T10:00:00Z', quantitySold: 46, quantityAvailable: 48, lastSoldAt: '2026-09-23T09:00:00Z', price: { amount: 7.9 } }),
  item('2', { startTime: '2026-06-25T10:00:00Z', quantitySold: 1, quantityAvailable: 9, lastSoldAt: '2026-07-17T09:00:00Z', price: { amount: 7.43 }, lastEditedAt: '2026-09-20T09:00:00Z' }),
  item('3', { startTime: '2026-09-20T10:00:00Z', quantitySold: 0, quantityAvailable: 1, price: { amount: 93 } }),
  item('4', { startTime: '2026-05-25T11:00:00Z', quantitySold: 0, quantityAvailable: 5, price: { amount: 3.71 }, lastEditedAt: '2026-09-23T22:00:00Z' }),
];
const ids = (list) => list.map((i) => i.itemId);

test('newest listed first by default, and an unknown sort falls back to it', () => {
  assert.deepStrictEqual(ids(sortListings(ITEMS)), ['3', '2', '4', '1']);
  assert.deepStrictEqual(ids(sortListings(ITEMS, 'nonsense')), ['3', '2', '4', '1']);
});

test('each sort puts the right listings on top', () => {
  assert.deepStrictEqual(ids(sortListings(ITEMS, 'edited')), ['4', '2', '3', '1'], 'latest edit first, never-edited after by newest');
  assert.deepStrictEqual(ids(sortListings(ITEMS, 'best_selling')), ['1', '2', '3', '4']);
  assert.deepStrictEqual(ids(sortListings(ITEMS, 'last_sold')), ['1', '2', '3', '4'], 'most recent sale first, unsold last');
  assert.deepStrictEqual(ids(sortListings(ITEMS, 'not_selling')), ['4', '3', '2', '1'], 'never sold, the longest listed first');
  assert.deepStrictEqual(ids(sortListings(ITEMS, 'low_stock')), ['3', '4', '2', '1']);
  assert.deepStrictEqual(ids(sortListings(ITEMS, 'price_high')), ['3', '1', '2', '4']);
  assert.deepStrictEqual(ids(sortListings(ITEMS, 'price_low')), ['4', '2', '1', '3']);
});

test('ended listings: "newest" is the most recently ended, and stock sorts aren\'t offered', () => {
  const ended = [item('a', { endTime: '2026-09-01T00:00:00Z' }), item('b', { endTime: '2026-09-20T00:00:00Z' })];
  assert.deepStrictEqual(ids(sortListings(ended, 'newest', 'inactive')), ['b', 'a']);
  assert.strictEqual(sortFor('low_stock', 'inactive'), 'newest');
  assert.strictEqual(sortFor('low_stock', 'active'), 'low_stock');
});

test('the Listings tab sorts the whole list, then pages it, with each listing\'s last sale and edit', async () => {
  const list = mock.method(ebayService, 'listListingsDetailed', async () => ({ items: ITEMS.map(({ lastSoldAt, lastEditedAt, ...rest }) => rest), allCount: 4, syncedAt: 1, credentialsChanged: false }));
  mock.method(ebayService, 'lastSalesByItem', async () => new Map([['1', '2026-09-23T09:00:00Z']]));
  mock.method(listingRepository, 'latestChanges', async () => new Map([['4', { changed_at: new Date('2026-09-23T22:00:00Z') }]]));
  try {
    const page1 = await listingService.pageOfListings({}, { connectionId: 'c', status: 'active', sort: 'edited', page: 1, perPage: 2 });
    assert.strictEqual(list.mock.calls[0].arguments[1].perPage, 0, 'the whole list, before paging');
    assert.deepStrictEqual(ids(page1.items), ['4', '3']);
    assert.deepStrictEqual([page1.totalEntries, page1.totalPages, page1.sort], [4, 2, 'edited']);
    const page2 = await listingService.pageOfListings({}, { connectionId: 'c', status: 'active', sort: 'edited', page: 2, perPage: 2 });
    assert.deepStrictEqual(ids(page2.items), ['2', '1']);
    assert.strictEqual(page2.items[1].lastSoldAt, '2026-09-23T09:00:00Z');
  } finally {
    mock.restoreAll();
  }
});
