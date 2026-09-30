const test = require('node:test');
const assert = require('node:assert');
const facts = require('../../src/modules/inbox/thread-facts');
const marketplaces = require('../../src/modules/ebay/marketplaces');

// What the Inbox's details panel adds about a conversation's listing and
// order, from Liston's own copies.

const uk = marketplaces.byId('EBAY_GB');

test('units sold count every line of the item, cancelled orders left out', () => {
  const orders = [
    { orderId: 'a', lineItems: [{ itemId: '111', quantityPurchased: 2 }, { itemId: '222', quantityPurchased: 5 }] },
    { orderId: 'b', lineItems: [{ itemId: 111, quantityPurchased: 1 }] },
    { orderId: 'c', cancelled: true, lineItems: [{ itemId: '111', quantityPurchased: 4 }] },
    { orderId: 'd', lineItems: [{ itemId: '111' }] },
  ];
  assert.deepStrictEqual(facts.soldFrom(orders, '111', (o) => o.cancelled), { units: 4, orders: 3 });
  assert.deepStrictEqual(facts.soldFrom([], '111'), { units: 0, orders: 0 });
});

test('item specifics read as name and value, the empty ones ("Does Not Apply") left out', () => {
  assert.deepStrictEqual(facts.specificsFrom({ Brand: ['Unbranded'], MPN: ['Does Not Apply'], Colour: ['Black', 'White'], Model: ['N/A'], Material: 'Leather', Size: [] }), [
    { name: 'Brand', value: 'Unbranded' },
    { name: 'Colour', value: 'Black, White' },
    { name: 'Material', value: 'Leather' },
  ]);
  assert.deepStrictEqual(facts.specificsFrom(null), []);
});

test("the listing's facts: live or ended, watchers, when listed, sales and (with Analytics) views and conversion over 30 days", () => {
  const snapshot = { live: true, item: { itemId: '111', watchCount: '4', startTime: '2026-07-25T07:47:30.000Z', endTime: null } };
  const all = facts.listingInsights({
    snapshot,
    traffic: { views: 412, impressions: 9100, days: 30 },
    sold: { units: 9, orders: 8 },
    summary: { specifics: { Brand: ['Unbranded'] } },
    supplierUrl: 'https://www.aliexpress.com/item/1005.html',
    canListings: true,
    canAnalytics: true,
  });
  assert.deepStrictEqual(all, {
    live: true,
    watchers: 4,
    listedAt: '2026-07-25T07:47:30.000Z',
    endedAt: null,
    days: 30,
    sold: 9,
    views: 412,
    impressions: 9100,
    conversion: 2.2,
    supplierUrl: 'https://www.aliexpress.com/item/1005.html',
    specifics: [{ name: 'Brand', value: 'Unbranded' }],
  });

  const noAnalytics = facts.listingInsights({ snapshot, traffic: { views: 412, impressions: 9100, days: 30 }, sold: { units: 9, orders: 8 }, canListings: true, canAnalytics: false });
  assert.strictEqual(noAnalytics.views, null, 'views need Analytics access');
  assert.strictEqual(noAnalytics.conversion, null);
  assert.strictEqual(noAnalytics.sold, 9);

  const unstored = facts.listingInsights({ snapshot, traffic: { views: 0, impressions: 0, days: 0 }, sold: { units: 0, orders: 0 }, canListings: true, canAnalytics: true });
  assert.strictEqual(unstored.views, null, 'no stored days is unknown, not zero views');

  const ended = facts.listingInsights({ snapshot: { live: false, item: { itemId: '111', endTime: '2026-09-01T00:00:00.000Z' } }, canListings: true });
  assert.strictEqual(ended.live, false);
  assert.strictEqual(ended.endedAt, '2026-09-01T00:00:00.000Z');
  assert.strictEqual(facts.listingInsights({ snapshot: null, canListings: true }).live, null, "in neither of the account's lists: not known");
  assert.strictEqual(facts.listingInsights({ snapshot, canListings: false }), null, 'nothing without Listings access');
});

test("the supplier order is shown without the buying account's login", () => {
  const rows = [
    { status: 'shipped', source_order_no: '8123', tracking_number: 'LP00123', carrier: 'Cainiao', placed_at: new Date('2026-09-25T10:00:00Z'), placed_by: 'u1', placed_by_name: 'Sara Khan', source_account_email: 'buyer@example.com', source_password: 'secret' },
    { status: 'to_order', source_order_no: null, placed_by: null },
  ];
  const shown = facts.supplierOrders(rows);
  assert.deepStrictEqual(shown[0], { status: 'shipped', statusLabel: 'Shipped', orderNo: '8123', tracking: 'LP00123', carrier: 'Cainiao', placedAt: '2026-09-25T10:00:00.000Z', placedBy: 'Sara Khan' });
  assert.deepStrictEqual(shown[1], { status: 'to_order', statusLabel: 'To order', orderNo: null, tracking: null, carrier: null, placedAt: null, placedBy: null });
  assert.ok(!JSON.stringify(shown).includes('secret') && !JSON.stringify(shown).includes('buyer@example.com'));
});

test("where an order goes: town and postcode, the country only when it isn't the site's", () => {
  assert.strictEqual(facts.shipTo({ city: 'Greenock', postalCode: 'Pa154tb', country: 'United Kingdom' }, uk), 'Greenock, PA154TB');
  assert.strictEqual(facts.shipTo({ city: 'Dublin', postalCode: 'D02 X285', country: 'IE' }, uk), 'Dublin, D02 X285, IE');
  assert.strictEqual(facts.shipTo({ city: 'Leeds', country: 'GB' }, uk), 'Leeds');
  assert.strictEqual(facts.shipTo(null, uk), null);
});
