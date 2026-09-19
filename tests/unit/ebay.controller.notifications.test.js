const test = require('node:test');
const assert = require('node:assert');
const { _planFor: planFor } = require('../../src/modules/ebay/ebay.controller');

// What each eBay push does to an account's mirrors. The point of the plan:
// a sale never re-reads every listing (15–20 calls on a big account); it
// is one GetItem on the sold item plus an incremental orders read.
test('a sale re-reads orders and patches the one item, never the listings', () => {
  for (const eventName of ['ItemSold', 'FixedPriceTransaction']) {
    assert.deepStrictEqual(planFor({ eventName, itemId: '123' }), { kinds: ['orders'], saleItemId: '123' });
  }
});

test('a sale with no item id falls back to a listings re-read', () => {
  assert.deepStrictEqual(planFor({ eventName: 'ItemSold', itemId: null }), { kinds: ['orders', 'listings'], saleItemId: null });
});

test('listing events re-read the listings; payment and dispatch marks re-read the orders', () => {
  for (const eventName of ['ItemListed', 'ItemRevised', 'ItemClosed', 'ItemUnsold']) {
    assert.deepStrictEqual(planFor({ eventName, itemId: '1' }), { kinds: ['listings'], saleItemId: null });
  }
  for (const eventName of ['ItemMarkedPaid', 'ItemMarkedShipped']) {
    assert.deepStrictEqual(planFor({ eventName, itemId: '1' }), { kinds: ['orders'], saleItemId: null });
  }
});

test('an unknown event re-reads everything', () => {
  assert.deepStrictEqual(planFor({ eventName: 'SomethingNew', itemId: null }), { kinds: ['listings', 'orders'], saleItemId: null });
});
