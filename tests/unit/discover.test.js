const test = require('node:test');
const assert = require('node:assert');

const scoring = require('../../src/modules/discover/discover-scoring');
const keywords = require('../../src/modules/discover/discover-keywords');
const trends = require('../../src/modules/discover/discover-trends');

const NOW = Date.parse('2026-09-28T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
// A listing live `days` days that has sold `sold` (null: not read).
const listing = (title, { sold = null, days = 60, price = 10, ship = 0, seller = 'a', country = 'GB', compared = 'similar' } = {}) => ({
  title,
  sold,
  createdAt: daysAgo(days),
  price: { value: price, currency: 'GBP' },
  shipping: { cost: ship },
  seller: { username: seller },
  location: { country },
  delivery: { compared },
});

test('a subject is judged on how fast its leading listings sell, how crowded it is, what buyers pay and whether you can match the sellers', () => {
  const listings = [
    listing('Cat water fountain 2L', { sold: 120, days: 60, seller: 'a', compared: 'faster' }), // 60 a month
    listing('Cat water fountain LED', { sold: 30, days: 90, seller: 'b', compared: 'similar' }), // 10 a month
    listing('Pet fountain stainless', { sold: 4, days: 120, seller: 'c', compared: 'slower', country: 'CN' }), // 1 a month
    listing('Pet fountain filter', { sold: 0, days: 30, seller: 'a', compared: 'unknown' }), // 0
    listing('Fountain pump', { sold: null, seller: 'd', price: 3, ship: 1 }), // not read
  ];
  const f = scoring.figures(listings, { total: 1800, country: 'GB', now: NOW });
  assert.deepStrictEqual(f.demand, { read: 4, selling: 3, monthlySales: 71, sellThrough: 75, medianPerMonth: 5.5, topPerMonth: 60, soldTotal: 154 });
  assert.deepStrictEqual(f.competition, { sellers: 4, topSeller: { username: 'a', share: 40 } });
  assert.deepStrictEqual(f.price, { low: 10, median: 10, high: 10 });
  // Of the three that sell: one faster than you, one like you, one slower → two you can match; one abroad.
  assert.deepStrictEqual(f.fit, { sellers: 3, canMatch: 2, share: 67, overseas: 33 });

  const o = scoring.opportunity(f, { currency: 'GBP' });
  assert.strictEqual(o.score, o.parts.reduce((sum, p) => sum + p.points, 0));
  assert.deepStrictEqual(
    o.parts.map((p) => [p.key, p.points, p.max]),
    [
      ['demand', 22, 40],
      ['selling', 11, 15],
      ['competition', 11, 20], // 1,800 live (9), the biggest seller holds 40% (2)
      ['fit', 10, 15],
      ['price', 7, 10],
    ]
  );
  assert.deepStrictEqual([o.score, o.band], [61, 'fair']);
  assert.strictEqual(o.parts[0].value, '5.5 a month');

  // Without the account's delivery known, fit earns half its points.
  const unknown = scoring.opportunity(scoring.figures(listings, { total: 1800, country: 'GB', accountKnown: false, now: NOW }));
  assert.strictEqual(unknown.parts.find((p) => p.key === 'fit').points, 7);

  // Where the sales are: by delivery next to yours, by country, by seller, and the leading listings in order.
  const c = scoring.charts(listings, { country: 'GB', now: NOW });
  assert.deepStrictEqual(c.delivery.map((d) => [d.key, d.listings, d.perMonth]), [['faster', 1, 60], ['similar', 2, 10], ['slower', 1, 1], ['unknown', 1, 0]]);
  assert.deepStrictEqual(c.countries.map((g) => [g.key, g.perMonth, g.domestic]), [['GB', 70, true], ['CN', 1, false]]);
  assert.deepStrictEqual(c.sellers.map((g) => [g.key, g.perMonth]), [['a', 60], ['b', 10], ['c', 1]]);
  assert.deepStrictEqual(c.demandCurve.map((d) => d.perMonth), [60, 10, 1, 0]);
  assert.strictEqual(c.priceBands.reduce((n, b) => n + b.listings, 0), 5, 'every listing in a price band');

  // Selling now: the read ones fastest first, then the unread.
  assert.deepStrictEqual(
    scoring.sellingNow(listings, NOW).map((l) => l.title),
    ['Cat water fountain 2L', 'Cat water fountain LED', 'Pet fountain stainless', 'Pet fountain filter', 'Fountain pump']
  );
});

test("keywords are the phrases of the titles that sell, next to how common they are; the subject's own words and one seller's words are left out", () => {
  const sells = (title, sold) => listing(title, { sold, days: 30 });
  const listings = [
    sells('Micro rice fairy lights battery warm white', 60),
    sells('Micro rice fairy lights battery copper wire', 40),
    sells('Micro rice lights copper wire 10m', 30),
    sells('Solar garden fairy lights outdoor', 3),
    sells('Solar garden lights outdoor waterproof', 2),
    sells('Solar garden lights outdoor stake', 1),
    sells('Christmas tree lights plug in', 0),
    sells('Christmas tree lights 500 led', 0),
    // One seller's hit: its words are its own, not the market's.
    sells('Neon sign bedroom wall lights', 80),
  ];
  const found = keywords.fromListings(listings, { query: 'Fairy Lights', now: NOW });
  const terms = found.map((k) => k.term);
  assert.ok(terms.includes('micro rice'), 'the phrase buyers pick');
  assert.ok(!terms.some((t) => t.split(' ').every((w) => ['fairy', 'lights', 'light'].includes(w))), "the category's own words aren't keywords");
  assert.ok(!terms.some((t) => t.includes('neon')), "one listing's sales don't make a keyword");
  assert.ok(!terms.includes('micro'), 'the longer phrase stands for the word inside it');
  const micro = found.find((k) => k.term === 'micro rice');
  assert.deepStrictEqual([micro.listings, micro.selling, micro.listingShare], [3, 3, 33.3]);
  assert.ok(micro.salesShare > micro.listingShare && micro.lift > 1);
});

test('your keywords add up the traffic and sales of your listings by the words in their titles', () => {
  const rows = [
    { title: 'Cat water fountain 2L', impressions: 1000, views: 50, sold: 5 },
    { title: 'Cat water fountain filter', impressions: 600, views: 20, sold: 1 },
    { title: 'Dog bowl stainless', impressions: 300, views: 3, sold: 0 },
    { title: 'Dog bowl slow feeder', impressions: null, views: null, sold: 2 }, // traffic not measured; its sales still count
  ];
  const found = keywords.fromTraffic(rows);
  const fountain = found.find((k) => k.term === 'cat water fountain');
  assert.deepStrictEqual(
    { listings: fountain.listings, impressions: fountain.impressions, views: fountain.views, sold: fountain.sold, ctr: fountain.ctr, conversion: fountain.conversion },
    { listings: 2, impressions: 1600, views: 70, sold: 6, ctr: 4.38, conversion: 8.57 }
  );
  // Sales count every listing (they come from orders); traffic only the measured ones.
  // One keyword's traffic: the listings with every word of it, singular or plural.
  assert.deepStrictEqual(keywords.trafficFor(rows, 'cat water fountains'), { listings: 2, measured: 2, impressions: 1600, views: 70, sold: 6, ctr: 4.38, conversion: 8.57 });
  assert.strictEqual(keywords.trafficFor(rows, 'parrot cage'), null);
  const bowl = found.find((k) => k.term === 'dog bowl');
  assert.deepStrictEqual([bowl.listings, bowl.measured, bowl.impressions, bowl.sold, bowl.conversion], [2, 1, 300, 2, 0]);
  assert.strictEqual(found[0].sold, 6, 'most sales first');
});

test("a watched listing's recent sales are the difference between its readings a week apart, or across the days it has", () => {
  const reads = [
    { item_id: '1', day: '2026-09-20', sold: 100 },
    { item_id: '1', day: '2026-09-21', sold: 104 },
    { item_id: '1', day: '2026-09-28', sold: 130 },
    { item_id: '2', day: '2026-09-25', sold: 10 },
    { item_id: '2', day: '2026-09-28', sold: 16 },
    { item_id: '3', day: '2026-09-28', sold: 50 }, // one reading: nothing to compare yet
  ];
  const recent = trends.recentSales(reads);
  assert.deepStrictEqual(recent.get('1'), { sold: 26, days: 7, from: '2026-09-21', to: '2026-09-28' });
  assert.deepStrictEqual(recent.get('2'), { sold: 6, days: 3, from: '2026-09-25', to: '2026-09-28' });
  assert.strictEqual(recent.has('3'), false);

  const listings = [
    { legacyItemId: '1', title: 'Steady seller', soldPerMonth: 110 }, // 26 in 7 days ≈ lifetime pace: not rising
    { legacyItemId: '2', title: 'Taking off', soldPerMonth: 15 }, // 2 a day now vs 0.5 over its life
    { legacyItemId: '3', title: 'New read', soldPerMonth: 5 },
  ];
  const summary = trends.summarise(listings, recent);
  assert.deepStrictEqual(summary.recent, { sold: 32, days: 7, listings: 2 });
  assert.deepStrictEqual(summary.rising.map((l) => [l.title, l.lift]), [['Taking off', 4]]);
});

test('sales day by day come from the daily readings, spread over a gap, unknown days left empty', () => {
  const reads = [
    { item_id: '1', day: '2026-09-25', sold: 10 },
    { item_id: '1', day: '2026-09-26', sold: 14 },
    { item_id: '1', day: '2026-09-28', sold: 20 }, // 6 over two days: 3 each
    { item_id: '2', day: '2026-09-27', sold: 5 },
    { item_id: '2', day: '2026-09-28', sold: 7 },
  ];
  const days = trends.dailySales(reads, { today: '2026-09-28', days: 5 });
  assert.deepStrictEqual(days, [
    { day: '2026-09-24', value: null },
    { day: '2026-09-25', value: null },
    { day: '2026-09-26', value: 4 },
    { day: '2026-09-27', value: 3 },
    { day: '2026-09-28', value: 5 },
  ]);
  assert.strictEqual(trends.dailySales([{ item_id: '1', day: '2026-09-28', sold: 3 }], { today: '2026-09-28' }), null, 'one reading: nothing to chart');
});

const compliance = require('../../src/modules/discover/discover-compliance');

test("a subject's checks: eBay's word filter in its titles, restricted items by name, how branded it is, and the AI's reading", () => {
  const titles = (list) => list.map((title) => ({ title }));
  const fairy = compliance.check({
    name: 'Fairy Lights',
    listings: titles(['Fairy lights battery warm white', 'Fairy lights battery copper', 'Solar fairy lights', 'USB fairy lights', 'Plug in fairy lights']),
    brands: [
      { name: 'Unbranded', count: 90, unbranded: true },
      { name: 'Lumineo', count: 10, unbranded: false },
    ],
  });
  assert.strictEqual(fairy.level, 'check', 'two in five titles use a word the filter reacts to');
  assert.deepStrictEqual(fairy.titles.hazmat[0], { word: 'battery', listings: 2, share: 40, safer: 'power cell' });
  assert.deepStrictEqual(fairy.brands, { branded: 10, top: [{ name: 'Lumineo', count: 10, share: 10 }] });

  const knives = compliance.check({ name: 'pocket knife', listings: titles(['Folding pocket knife', 'Pocket knife sharpener']) });
  assert.strictEqual(knives.level, 'risky');
  assert.deepStrictEqual(knives.subject.restricted.map((r) => r.label), ['Weapons and knives']);

  const branded = compliance.check({ name: 'phone case', listings: titles(['Case for phone']), advice: { brandRisk: { level: 'high', brands: ['MagSafe'], reason: 'Apple takes down MagSafe listings.' }, safetyRisk: { level: 'none', reason: '' } } });
  assert.strictEqual(branded.level, 'risky', 'the AI names a VeRO brand');
  assert.strictEqual(branded.ai.brand.brands[0], 'MagSafe');

  assert.strictEqual(compliance.check({ name: 'cat water fountain', listings: titles(['Cat water fountain 2L']) }).level, 'clear');
  // A keyword row's flag: a restricted item, a filtered word, or a brand named.
  assert.deepStrictEqual(compliance.flagOf('magsafe phone case', ['MagSafe']), { restricted: null, hazmat: null, brand: 'MagSafe' });
  assert.deepStrictEqual(compliance.flagOf('lithium battery pack').hazmat, 'lithium');
  assert.strictEqual(compliance.flagOf('magnetic phone mount'), null, '"magnetic" passes eBay\'s filter; "magnet" doesn\'t');
});
