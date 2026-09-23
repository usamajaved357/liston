const test = require('node:test');
const assert = require('node:assert');

const health = require('../../src/modules/analytics/listing-health');

// An account whose typical listing gets 100 impressions a day, 2%
// click-through and 5% of visits buying.
const bench = { impressionsPerDay: 100, ctr: 0.02, conversion: 0.05, listings: 20 };
const m = (over) => ({ impressions: 3000, views: 60, ctr: 0.02, sold: 3, sales: 30, conversion: 0.05, ...over });
const diagnose = (over) => health.diagnose({ m: m(), measured: true, liveDays: 30, ageDays: 60, bench, price: 10, stock: 5, watchers: 0, ...over });

test("the account's normal rates are medians of listings with enough data, else modest defaults", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ impressions: 3000 + i * 300, views: 60, sold: i, ctr: 0.01 + i * 0.002, liveDays: 30, measured: true }));
  rows.push({ impressions: 10, views: 1, sold: 0, ctr: 0.1, liveDays: 3, measured: true }, { impressions: 0, views: 0, sold: 0, ctr: null, liveDays: 30, measured: false });
  const b = health.benchmarks(rows);
  assert.strictEqual(b.listings, 6, 'a listing under a week old or without traffic is left out');
  assert.strictEqual(b.impressionsPerDay, 125);
  assert.strictEqual(Math.round(b.ctr * 1000) / 1000, 0.015);
  assert.strictEqual(Math.round(b.conversion * 1e6) / 1e6, Math.round((2.5 / 60) * 1e6) / 1e6);
  assert.deepStrictEqual(health.benchmarks(rows.slice(0, 3)), { ...health.FALLBACK, listings: 3 }, 'too few listings: defaults');
});

test('a listing is only judged once it has had a fair chance', () => {
  assert.strictEqual(diagnose({ ageDays: 4 }).stage, 'new');
  assert.strictEqual(diagnose({ measured: false }).stage, 'unmeasured');
  assert.strictEqual(diagnose({ m: m({ impressions: 200, views: 10, ctr: 0.05, sold: 0, conversion: 0 }), liveDays: 2 }).stage, 'low_data');
});

test('the first weak step is the problem, measured against the account, with the money at stake', () => {
  const hidden = diagnose({ m: m({ impressions: 600, views: 12, ctr: 0.02, sold: 0, sales: 0, conversion: 0 }) });
  assert.strictEqual(hidden.stage, 'not_shown');
  // 3,000 impressions expected over 30 days, 600 had: 2,400 × 2% × 5% ≈ 2.4 sales at £10.
  assert.deepStrictEqual(hidden.opportunity, { units: 2.4, amount: 24 });

  const unclicked = diagnose({ m: m({ ctr: 0.008, views: 24, sold: 1, conversion: 1 / 24 }) });
  assert.strictEqual(unclicked.stage, 'not_clicked');
  // 3,000 × (2% − 0.8%) = 36 more visits × 5% (too few visits for its own rate) = 1.8 sales.
  assert.deepStrictEqual(unclicked.opportunity, { units: 1.8, amount: 18 });

  const unbought = diagnose({ m: m({ views: 100, sold: 1, conversion: 0.01 }) });
  assert.strictEqual(unbought.stage, 'not_bought');
  assert.deepStrictEqual(unbought.opportunity, { units: 4, amount: 40 });

  const falling = diagnose({ m: m({ sold: 1, conversion: 1 / 60 }), previous: { sold: 10, days: 30 } });
  assert.strictEqual(falling.stage, 'not_bought', 'a weak step comes before a falling trend');
  const fallingOnly = diagnose({ m: m({ views: 60, sold: 3, conversion: 0.05 }), previous: { sold: 9, days: 30 } });
  assert.strictEqual(fallingOnly.stage, 'declining');
  assert.deepStrictEqual(fallingOnly.opportunity, { units: 6, amount: 60 });

  assert.strictEqual(diagnose({ m: m({ sold: 6, conversion: 0.1 }) }).stage, 'converting');
  assert.strictEqual(diagnose({}).stage, 'healthy');
});

test('out of stock is never shown in search, and flags say restock or offer to watchers', () => {
  const out = diagnose({ stock: 0 });
  assert.strictEqual(out.stage, 'not_shown');
  assert.strictEqual(out.reasons[0].key, 'stock');
  assert.deepStrictEqual(diagnose({ daysOfStock: 4, m: m({ sold: 5, conversion: 5 / 60 }) }).flags, ['restock']);
  assert.deepStrictEqual(diagnose({ watchers: 4, m: m({ views: 20, sold: 0, conversion: 0 }) }).flags, ['watchers']);
});

test('reasons come from what is known about the listing, each with its fix', () => {
  const quality = { titleLength: 42, photos: 3, specificsCount: 4, descriptionLength: 120, categoryId: '1', shippingCost: 2.99, dispatchDays: 5, returnsAccepted: false, currency: 'GBP' };
  const hidden = diagnose({ m: m({ impressions: 300 }), quality, price: 20, peerPrice: 10 });
  assert.deepStrictEqual(hidden.reasons.map((r) => [r.key, r.status, r.fix]), [
    ['title', 'fail', 'title'],
    ['specifics', 'warn', 'specifics'],
    ['price', 'warn', 'price'],
  ]);
  const unbought = diagnose({ m: m({ views: 100, sold: 0, conversion: 0 }), quality: { ...quality, competitor: { cheapest: 8.5 } }, price: 12, watchers: 5 });
  assert.deepStrictEqual(
    unbought.reasons.map((r) => r.key),
    ['conversion', 'competitor', 'photos', 'description', 'postage', 'dispatch', 'returns', 'watchers']
  );
  assert.match(unbought.reasons.find((r) => r.key === 'competitor').text, /GBP 8\.50 delivered, 6\.49 less than yours/);
  const checked = diagnose({ m: m({ impressions: 300 }), quality: { specificsMissing: ['Brand', 'Material'] } });
  assert.match(checked.reasons.find((r) => r.key === 'specifics').text, /2 item specifics eBay recommends are empty \(Brand, Material\)/);
});

test("quality from Liston's own draft, and from a deeper check against the category", () => {
  assert.deepStrictEqual(
    health.qualityFromDraft({ title: 'Lamp', imageUrls: ['a', 'b'], aspects: { Brand: ['X'], Colour: [''] }, description: '**Bright** lamp', categoryId: 12 }),
    { source: 'draft', titleLength: 4, photos: 2, specificsCount: 1, descriptionLength: 11, categoryId: '12' }
  );
  const q = health.qualityFromItem(
    { title: 'Lamp', imageUrls: ['a'], specifics: { Brand: ['X'] }, variationSpecificsSet: { Colour: ['Red'] }, description: '<p>Hi</p>', categoryId: '12', shipping: { cost: 0, dispatchDays: 1 }, returnsAccepted: true, currency: 'GBP' },
    [{ name: 'Brand', required: true }, { name: 'Colour', recommended: true }, { name: 'Material', recommended: true }, { name: 'Style' }],
    { cheapest: 5 }
  );
  assert.deepStrictEqual(q.specificsMissing, ['Material'], 'a variation attribute counts as filled; optional ones are not asked for');
  assert.deepStrictEqual([q.photos, q.specificsCount, q.specificsRecommended, q.shippingCost, q.dispatchDays, q.returnsAccepted, q.descriptionLength], [1, 2, 3, 0, 1, true, 2]);
});

test('a weak step worth under half a sale is noted on the listing but kept out of "Needs attention"', () => {
  // A week, 400 impressions clicked at 1.1% (weak against 2%): 400 × 0.9% × 5% ≈ 0.2 more sales.
  const small = diagnose({ m: m({ impressions: 400, ctr: 0.011, views: 5, sold: 0, conversion: 0 }), liveDays: 7, price: 10 });
  assert.strictEqual(small.stage, 'not_clicked');
  assert.deepStrictEqual([small.problem, small.minor], [false, true]);
  assert.ok(small.opportunity.units < health.MIN_STAKE_UNITS);
  const big = diagnose({ m: m({ ctr: 0.008, views: 24, sold: 1, conversion: 1 / 24 }) });
  assert.deepStrictEqual([big.problem, big.minor], [true, false]);
});
