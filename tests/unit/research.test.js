const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const researchStats = require('../../src/modules/research/research-stats');
const browseResearch = require('../../src/modules/ebay/browse-research');
const ebayBrowse = require('../../src/modules/ebay/api/ebay.browse');
const researchService = require('../../src/modules/research/research.service');
const connectionService = require('../../src/modules/connections/connection.service');
const appState = require('../../src/db/app-state.repository');
const config = require('../../src/config');
const analysis = require('../../src/modules/research/research-analysis');
const advisor = require('../../src/modules/ai-generation/research-advisor.service');
const listingRepository = require('../../src/modules/listings/listing.repository');

test.afterEach(() => {
  mock.restoreAll();
  browseResearch.forget();
  advisor.forget();
  researchService.resetUsage();
});

const NOW = new Date('2026-09-25T12:00:00Z').getTime();
const listing = (id, price, extra = {}) => ({
  itemId: `v1|${id}|0`,
  legacyItemId: String(id),
  price: { value: price, currency: 'GBP' },
  shipping: { cost: 0, free: true },
  seller: { username: 'shop-a', feedbackScore: 100, feedbackPercentage: 99.5 },
  location: { country: 'GB' },
  createdAt: '2026-06-25T12:00:00Z',
  sold: null,
  ...extra,
});

test('a search is summed up: prices with postage, sellers, where it ships from, how it sells', () => {
  const items = [
    listing(1, 5, { sold: 90 }),
    listing(2, 7, { sold: 0, seller: { username: 'shop-b' } }),
    listing(3, 9, { shipping: { cost: 2, free: false }, location: { country: 'CN' } }),
    listing(4, 20, { location: { country: 'CN' }, createdAt: '2026-09-20T00:00:00Z' }),
  ];
  const s = researchStats.summarise(items, { country: 'GB', total: 812, now: NOW });
  assert.strictEqual(s.total, 812);
  assert.strictEqual(s.sampled, 4);
  assert.deepStrictEqual(s.price, { min: 5, max: 20, median: 9, average: 10.75 }); // 5, 7, 11 (9 + 2 postage), 20
  assert.strictEqual(s.sellers, 2);
  assert.deepStrictEqual(s.topSellers[0], { username: 'shop-a', listings: 3, feedbackScore: 100, feedbackPercentage: 99.5, sold: 90, revenue: 450 });
  assert.strictEqual(s.topSellers[1].sold, 0);
  assert.strictEqual(s.topSellerShare, 75);
  assert.strictEqual(s.freePostage, 75);
  assert.strictEqual(s.domestic, 50);
  assert.strictEqual(s.newInLast30Days, 1);
  // 90 sold over 92 days live, at £5 with free postage
  assert.deepStrictEqual(s.sold, { read: 2, total: 90, perMonth: 29.3, selling: 1, revenue: 450, revenuePerMonth: 146.5 });
  assert.strictEqual(researchStats.revenueOf(listing(9, 3, { sold: 10, shipping: { cost: 1.5 } })), 45);
  assert.strictEqual(researchStats.revenueOf(listing(9, 3)), null);
  assert.strictEqual(researchStats.daysLive(listing(9, 3), NOW), 92);
  assert.strictEqual(researchStats.soldPerMonth(listing(9, 1, { sold: 10, createdAt: '2026-09-24T00:00:00Z' }), NOW), 10, 'at least a month');
  assert.strictEqual(researchStats.soldPerMonth(listing(9, 1), NOW), null);
});

test('eBay\'s search answer maps to what research needs, and is kept for an hour', async () => {
  const calls = mock.method(ebayBrowse, 'searchItemSummaries', async (params) => {
    assert.strictEqual(params.limit, 200);
    assert.match(params.filter, /buyingOptions:\{FIXED_PRICE\}/);
    assert.match(params.filter, /conditions:\{NEW\}/);
    assert.match(params.filter, /price:\[5\.\.20\],priceCurrency:GBP/);
    return {
      total: 8843,
      itemSummaries: [
        {
          itemId: 'v1|374106955627|0',
          legacyItemId: '374106955627',
          title: 'Toe corrector',
          image: { imageUrl: 'https://i.ebayimg.com/x.jpg' },
          itemWebUrl: 'https://www.ebay.co.uk/itm/374106955627',
          price: { value: '6.99', currency: 'GBP' },
          shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '0.00', currency: 'GBP' } }],
          seller: { username: 'ukmove', feedbackPercentage: '100.0', feedbackScore: 3, sellerAccountType: 'BUSINESS' },
          itemLocation: { country: 'GB', postalCode: 'CV21***' },
          categories: [{ categoryId: '19264', categoryName: 'Orthotics' }],
          itemCreationDate: '2026-09-23T05:56:14.000Z',
          itemGroupType: 'SELLER_DEFINED_VARIATIONS',
        },
      ],
    };
  });
  const first = await browseResearch.search({ q: 'Toe corrector', marketplaceId: 'EBAY_GB', condition: 'new', minPrice: 5, maxPrice: 20 });
  assert.strictEqual(first.calls, 1);
  assert.strictEqual(first.total, 8843);
  assert.deepStrictEqual(first.items[0].shipping, { cost: 0, free: true, type: 'FIXED' });
  assert.strictEqual(first.items[0].seller.feedbackPercentage, 100);
  assert.strictEqual(first.items[0].hasVariations, true);
  const again = await browseResearch.search({ q: 'toe corrector', marketplaceId: 'EBAY_GB', condition: 'new', minPrice: 5, maxPrice: 20 });
  assert.strictEqual(again.calls, 0);
  assert.strictEqual(calls.mock.calls.length, 1);
});

test('a listing\'s sold count is eBay\'s estimate; a listing with variations adds up every variation', async () => {
  mock.method(ebayBrowse, 'getItem', async () => ({ estimatedAvailabilities: [{ estimatedSoldQuantity: 602 }] }));
  mock.method(ebayBrowse, 'getItemsByItemGroup', async (legacyId) => {
    assert.strictEqual(legacyId, '388791936148');
    return { items: [{ estimatedAvailabilities: [{ estimatedSoldQuantity: 400 }] }, { estimatedAvailabilities: [{ estimatedSoldQuantity: 55 }] }] };
  });
  assert.deepStrictEqual(await browseResearch.soldCount({ itemId: 'v1|374106955627|0' }, 'EBAY_GB'), { sold: 602, calls: 1 });
  assert.deepStrictEqual(await browseResearch.soldCount({ itemId: 'v1|388791936148|65', legacyItemId: '388791936148', hasVariations: true }, 'EBAY_GB'), { sold: 455, calls: 1 });
  assert.deepStrictEqual(await browseResearch.soldCount({ itemId: 'v1|374106955627|0' }, 'EBAY_GB'), { sold: 602, calls: 0 }, 'kept');
});

test('research reads the top listings\' sold counts within its daily share, then stops', async () => {
  let saved = null;
  mock.method(appState, 'get', async () => saved);
  mock.method(appState, 'set', async (key, value) => {
    saved = value;
  });
  mock.method(connectionService, 'getConnectionSummary', async () => ({ platform_key: 'ebay', marketplace: { id: 'EBAY_GB' } }));
  mock.method(listingRepository, 'findPolicyRefusals', async () => []);
  const items = Array.from({ length: 30 }, (_, i) => browseResearch.mapSummary({ itemId: `v1|${i}|0`, legacyItemId: String(i), title: `Item ${i}`, price: { value: '5.00', currency: 'GBP' } }));
  mock.method(browseResearch, 'search', async () => ({ total: 30, items, calls: 1 }));
  mock.method(browseResearch, 'soldCount', async () => ({ sold: 4, calls: 1 }));
  const original = config.research.dailyCalls;
  config.research.dailyCalls = 11;
  try {
    const result = await researchService.search('owner', 'conn', { q: 'socks' });
    // 1 search + 10 sold reads = the day's 11.
    assert.strictEqual(result.items.filter((i) => i.sold !== null).length, 10);
    assert.strictEqual(result.soldLimited, true);
    assert.deepStrictEqual({ ...result.budget, resetAt: undefined }, { used: 11, limit: 11, remaining: 0, resetAt: undefined });
    assert.match(result.budget.resetAt, /T07:00:00\.000Z$/, "the Browse allowance's own reset");
    assert.strictEqual(result.market.id, 'EBAY_GB');
    assert.strictEqual(result.summary.total, 30);
    await assert.rejects(researchService.search('owner', 'conn', { q: 'hats' }), (err) => err.statusCode === 429);
  } finally {
    config.research.dailyCalls = original;
  }
});

test('price bands are sized to where most prices sit, with the expensive tail grouped', () => {
  const prices = [...Array(150)].map((_, i) => Math.round((0.99 + i * 0.03) * 100) / 100).concat([5, 6, 7, 8, 9, 10, 12, 15, 20, 25.61]).sort((a, b) => a - b);
  const bands = researchStats.priceBands(prices);
  assert.ok(bands.length >= 5, 'spread over several bands, not one');
  assert.strictEqual(bands.at(-1).to, null, 'the tail is one "and up" band');
  assert.strictEqual(bands.reduce((sum, b) => sum + b.count, 0), prices.length);
  assert.ok(Math.max(...bands.map((b) => b.count)) < 60, 'no band swallows most listings');
});

// ---- the analysis ----------------------------------------------------------------

const selling = (id, price, perMonth, extra = {}) => ({ ...listing(id, price), sold: perMonth * 3, soldPerMonth: perMonth, ...extra }); // 3 months live

test("eBay's breakdown of a search: brands (generic ones marked) and the dominant category; a search it won't break down still runs", async () => {
  const b = browseResearch.breakdownOf({
    dominantCategoryId: '19264',
    categoryDistributions: [{ categoryId: '1', categoryName: 'Other', matchCount: 3 }, { categoryId: '19264', categoryName: 'Orthotics', matchCount: 900 }],
    aspectDistributions: [
      { localizedAspectName: 'Colour', aspectValueDistributions: [{ localizedAspectValue: 'Blue', matchCount: 5 }] },
      { localizedAspectName: 'Brand', aspectValueDistributions: [{ localizedAspectValue: 'Unbranded', matchCount: 700 }, { localizedAspectValue: 'Nike', matchCount: 90 }, { localizedAspectValue: 'Generic', matchCount: 50 }, { localizedAspectValue: 'Not Specified', matchCount: 20 }] },
    ],
  });
  assert.deepStrictEqual(b.brands, [
    { name: 'Unbranded', count: 700, unbranded: true },
    { name: 'Nike', count: 90, unbranded: false },
    { name: 'Generic', count: 50, unbranded: true },
    { name: 'Not Specified', count: 20, unbranded: true },
  ]);
  assert.strictEqual(b.categories[0].name, 'Orthotics');
  assert.strictEqual(b.categoryId, '19264');
  assert.strictEqual(browseResearch.breakdownOf(undefined), null);

  const seen = [];
  mock.method(ebayBrowse, 'searchItemSummaries', async (params) => {
    seen.push(params.fieldgroups || null);
    if (params.fieldgroups) throw Object.assign(new Error('bad fieldgroups'), { details: { status: 400 } });
    return { total: 1, itemSummaries: [] };
  });
  const found = await browseResearch.search({ q: 'socks', marketplaceId: 'EBAY_GB' });
  assert.deepStrictEqual(seen, ['MATCHING_ITEMS,ASPECT_REFINEMENTS', null]);
  assert.strictEqual(found.calls, 2);
  assert.strictEqual(found.breakdown, null);
});

test('the price to sell at follows where the sales are, a touch under, and says what the seller keeps', () => {
  // Most sales at £8.99; a slow £3 listing and a £20 one barely count.
  const items = [selling(1, 8.99, 60), selling(2, 8.99, 40), selling(3, 9.5, 20), selling(4, 3, 1), selling(5, 20, 1), listing(6, 2)];
  const p = analysis.priceAdvice(items, { pricing: { adsFeePercent: 10, processingFeePercent: 13, fixedFeePerOrder: 0.3, targetRoiPercent: 50, shippingCostPerOrder: 0 } });
  assert.strictEqual(p.basis, 'sales');
  assert.strictEqual(p.basedOn, 5);
  assert.strictEqual(p.salesMiddle, 8.99);
  assert.strictEqual(p.recommended, 8.49, '3% under £8.99 is £8.72; the charm price under it');
  assert.strictEqual(p.afterFees, 6.24); // 8.49 × 0.77 − 0.30
  assert.strictEqual(p.maxCost, 4.16); // 6.24 ÷ 1.5
  assert.deepStrictEqual(p.fees, { adsPercent: 10, processingPercent: 13, fixed: 0.3, shipping: 0 });

  const unsold = analysis.priceAdvice([listing(1, 4), listing(2, 6), listing(3, 8)]);
  assert.strictEqual(unsold.basis, 'listings');
  assert.strictEqual(unsold.confidence, 'low');
  assert.strictEqual(analysis.priceAdvice([]), null);
  assert.strictEqual(analysis.charmBelow(7.2), 6.99);
  assert.strictEqual(analysis.charmBelow(7.6), 7.49);
  assert.strictEqual(analysis.charmBelow(7.99), 7.99);
});

test('keywords come from the titles that sell, weighted by their sales', () => {
  const items = [
    selling(1, 5, 100, { title: 'Bunion Corrector Toe Straightener Silicone Night Splint' }),
    selling(2, 5, 50, { title: 'Toe Straightener Bunion Relief Silicone Gel' }),
    { ...listing(3, 5), title: 'Hallux Valgus Brace Orthopedic' },
  ];
  const k = analysis.keywordsFrom(items, 'bunion corrector');
  const bunion = k.words.find((w) => w.term === 'bunion');
  assert.ok(bunion.share >= 99 && bunion.inQuery);
  const straightener = k.words.find((w) => w.term === 'straightener');
  assert.ok(straightener.share >= 99 && !straightener.inQuery, 'in every selling title');
  assert.ok((k.words.find((w) => w.term === 'hallux')?.share ?? 0) < 2, 'an unsold title barely counts');
  assert.ok(k.phrases.some((p) => p.term === 'toe straightener'));
});

test('risk checks: your own refused drafts for the product, eBay\'s word filter, brand and safety', () => {
  const refusals = [
    { title: 'Toe Corrector Bunion Splint 2 Pack', message: 'This listing may be in violation of the VeRO program (intellectual property).', account: 'Walexo', at: '2026-08-01' },
    { title: 'Garden Solar Lights', message: 'Hazardous Materials policy', account: 'Walexo', at: '2026-08-02' },
  ];
  const items = [selling(1, 5, 10, { title: 'Toe corrector with magnet therapy' })];
  const noAi = analysis.riskChecks({ query: 'toe corrector bunion', items, breakdown: { brands: [{ name: 'Unbranded', count: 90, unbranded: true }, { name: 'Dr Scholl', count: 10, unbranded: false }] }, refusals });
  const by = Object.fromEntries(noAi.map((r) => [r.key, r]));
  assert.strictEqual(by.history.level, 'bad');
  assert.strictEqual(by.history.items.length, 1, 'only the product searched');
  assert.strictEqual(by.history.items[0].kind, 'ip');
  assert.strictEqual(by.words.level, 'ok');
  assert.match(by.words.detail, /"magnet"/, 'a selling title\'s trigger word is pointed out');
  assert.strictEqual(by.brand.level, 'ok');
  assert.match(by.brand.detail, /10% of listings name a brand \(Dr Scholl\)/);
  assert.strictEqual(by.safety.level, 'unknown');

  const withAi = analysis.riskChecks({
    query: 'lithium battery pack',
    items: [],
    breakdown: null,
    refusals: [],
    advice: { brandRisk: { level: 'high', brands: ['Anker'], reason: 'Anker enforces VeRO.' }, safetyRisk: { level: 'low', reason: 'Needs UKCA marking.' } },
  });
  const ai = Object.fromEntries(withAi.map((r) => [r.key, r]));
  assert.strictEqual(ai.history.level, 'ok');
  assert.strictEqual(ai.words.level, 'warn');
  assert.strictEqual(ai.brand.level, 'bad');
  assert.deepStrictEqual(ai.brand.brands, ['Anker']);
  assert.strictEqual(ai.safety.level, 'warn');
});

const market = (extra = {}) => ({
  total: 4000,
  sampled: 200,
  price: { min: 5, max: 30, median: 14, average: 15 },
  sellers: 120,
  topSellerShare: 6,
  domestic: 80,
  newInLast30Days: 10,
  sold: { read: 20, total: 6000, perMonth: 420, selling: 17 },
  ...extra,
});

test('the verdict: a busy, spread-out market is good to list; a takedown risk overrides any score', () => {
  const ok = [{ key: 'words', label: "eBay's word filter", level: 'ok', detail: '' }];
  const good = analysis.verdict({ summary: market(), price: { recommended: 13.49, maxCost: 5.8, targetRoiPercent: 60 }, risks: ok, currency: 'GBP' });
  assert.strictEqual(good.status, 'healthy');
  assert.strictEqual(good.label, 'Good to list');
  assert.ok(good.score >= 90, `score ${good.score}`);

  const brand = analysis.verdict({ summary: market(), risks: [{ key: 'brand', label: 'Brand & VeRO', level: 'bad', detail: 'Nike enforces VeRO.' }], currency: 'GBP' });
  assert.strictEqual(brand.status, 'unhealthy');
  assert.strictEqual(brand.label, "Don't list");
  assert.strictEqual(brand.reasons[0].tone, 'bad');

  const careful = analysis.verdict({ summary: market(), risks: [{ key: 'safety', label: 'Restricted', level: 'warn', detail: 'Needs marking.' }], currency: 'GBP' });
  assert.strictEqual(careful.status, 'caution');

  // Busy and spread out, but £3.39 with postage leaves nothing for a supplier.
  const thin = analysis.verdict({ summary: market({ price: { median: 3.39 } }), risks: ok, currency: 'GBP' });
  assert.ok(thin.score >= 65, `score ${thin.score}`);
  assert.strictEqual(thin.label, 'List with care');

  const dead = analysis.verdict({
    summary: market({ sold: { read: 20, total: 12, perMonth: 2, selling: 3 }, topSellerShare: 45, total: 90000, price: { median: 2.5 }, domestic: 10 }),
    risks: [],
    currency: 'GBP',
  });
  assert.strictEqual(dead.status, 'unhealthy');
  assert.strictEqual(dead.label, 'Not worth listing');
});

test('advice: the AI reading folds into the risks and verdict, and re-reads nothing from eBay', async () => {
  mock.method(appState, 'get', async () => null);
  mock.method(appState, 'set', async () => {});
  mock.method(connectionService, 'getConnectionSummary', async () => ({ platform_key: 'ebay', marketplace: { id: 'EBAY_GB' }, settings: { pricing: { targetRoiPercent: 40 } } }));
  mock.method(listingRepository, 'findPolicyRefusals', async () => []);
  const searchCall = mock.method(ebayBrowse, 'searchItemSummaries', async () => ({
    total: 2,
    itemSummaries: [
      { itemId: 'v1|1|0', title: 'Nike Air socks', price: { value: '9.99', currency: 'GBP' }, itemCreationDate: '2026-06-01T00:00:00Z' },
      { itemId: 'v1|2|0', title: 'Nike crew socks', price: { value: '8.99', currency: 'GBP' }, itemCreationDate: '2026-06-01T00:00:00Z' },
    ],
  }));
  const soldCall = mock.method(ebayBrowse, 'getItem', async () => ({ estimatedAvailabilities: [{ estimatedSoldQuantity: 30 }] }));
  const ai = mock.method(advisor, 'advise', async (key, input) => {
    assert.strictEqual(input.items.length, 2);
    assert.strictEqual(input.currency, 'GBP');
    return { title: 'Crew socks', keywords: ['crew socks'], brandRisk: { level: 'high', brands: ['Nike'], reason: 'Nike enforces VeRO.' }, safetyRisk: { level: 'none', reason: 'Fine.' }, summary: '' };
  });

  const first = await researchService.search('owner', 'conn', { q: 'nike socks' });
  assert.strictEqual(first.items[0].revenue, 299.7);
  assert.ok(first.items[0].daysLive > 0);
  assert.strictEqual(first.analysis.price.targetRoiPercent, 40, "the account's own pricing");
  assert.strictEqual(first.analysis.risks.find((r) => r.key === 'safety').level, 'unknown');

  const advised = await researchService.advice('owner', 'conn', { q: 'nike socks' });
  assert.strictEqual(advised.advice.title, 'Crew socks');
  assert.strictEqual(advised.analysis.verdict.label, "Don't list");
  assert.strictEqual(ai.mock.calls.length, 1);
  assert.strictEqual(searchCall.mock.calls.length, 1, 'the kept search');
  assert.strictEqual(soldCall.mock.calls.length, 2, 'the kept sold counts');
});

test('an AI title never runs past eBay\'s 80 characters, and is cut at a word', () => {
  const long = 'Bunion Corrector Toe Straightener Silicone Night Splint Hallux Valgus Relief Pain Pack of Two';
  const t = advisor.fitTitle(long);
  assert.ok(t.length <= 80);
  assert.ok(long.startsWith(t));
  assert.ok(!t.endsWith(' '));
  assert.strictEqual(advisor.fitTitle('  Short   title '), 'Short title');
});

test('a brand the AI flags as a takedown risk never stays in its suggested title', () => {
  assert.strictEqual(advisor.withoutBrands('Shockproof Magnetic Magsafe Phone Case for iPhone 12', ['MagSafe']), 'Shockproof Magnetic Phone Case for iPhone 12');
  assert.strictEqual(advisor.withoutBrands("Dr. Scholl's Bunion Pads", ["Dr. Scholl's"]), 'Bunion Pads');
  assert.strictEqual(advisor.withoutBrands('Nikelike Socks by Nike', ['Nike']), 'Nikelike Socks by', 'whole words only');
});

test("research's eBay calls show under research in the Browse usage the admin sees", async () => {
  const browseUsage = require('../../src/modules/ebay/browse-usage');
  browseUsage._reset();
  mock.method(appState, 'get', async () => null);
  mock.method(appState, 'set', async () => {});
  mock.method(connectionService, 'getConnectionSummary', async () => ({ platform_key: 'ebay', marketplace: { id: 'EBAY_GB' } }));
  mock.method(listingRepository, 'findPolicyRefusals', async () => []);
  mock.method(global, 'fetch', async (url) => {
    const u = String(url);
    if (/oauth/.test(u)) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 7200 }) };
    if (/item_summary\/search/.test(u)) return { ok: true, status: 200, json: async () => ({ total: 1, itemSummaries: [{ itemId: 'v1|1|0', title: 'Socks', price: { value: '5.00', currency: 'GBP' } }] }) };
    return { ok: true, status: 200, json: async () => ({ estimatedAvailabilities: [{ estimatedSoldQuantity: 3 }] }) };
  });
  await researchService.search('owner', 'conn', { q: 'socks' });
  const snap = browseUsage.snapshot();
  assert.deepStrictEqual(snap.byKind, { research: 2 }, 'one search, one sold count');
  assert.deepStrictEqual(snap.byCall, { search: 1, getItem: 1 });
  browseUsage._reset();
});

// ---- delivery next to the account's ------------------------------------------

const delivery = require('../../src/modules/research/delivery');
const ebayService = require('../../src/modules/ebay/ebay.service');

test('working days skip weekends; a listing window comes from eBay\'s delivery dates', () => {
  // Fri 25 Sep 2026 → Wed 30 Sep: Mon, Tue, Wed = 3 working days.
  assert.strictEqual(delivery.workingDaysBetween('2026-09-25T12:00:00Z', '2026-09-30T12:00:00Z'), 3);
  assert.strictEqual(delivery.workingDaysBetween('2026-09-25T12:00:00Z', '2026-09-24T12:00:00Z'), 0);
  assert.deepStrictEqual(delivery.listingWindow({ deliveryDates: { min: '2026-09-29T00:00:00Z', max: '2026-10-02T00:00:00Z' } }, NOW), { min: 2, max: 5 });
  assert.strictEqual(delivery.listingWindow({ deliveryDates: null }, NOW), null);
});

test("the account's window is its handling time plus its postage service's working days", () => {
  const policy = {
    name: 'Standard 5-7',
    handlingTime: { value: 1, unit: 'DAY' },
    shippingOptions: [{ optionType: 'DOMESTIC', shippingServices: [{ sortOrder: 2, shippingServiceCode: 'UK_RoyalMailFirstClassStandard' }, { sortOrder: 1, shippingServiceCode: 'UK_OtherCourier5To7Days' }] }],
  };
  const fromList = delivery.accountWindow(policy, [{ service: 'UK_OtherCourier5To7Days', description: 'Other courier (5 to 7 days)', min: 5, max: 7 }]);
  assert.deepStrictEqual([fromList.min, fromList.max, fromList.service, fromList.serviceName], [6, 8, 'UK_OtherCourier5To7Days', 'Other courier (5 to 7 days)']);
  const fromCode = delivery.accountWindow(policy, []);
  assert.deepStrictEqual([fromCode.min, fromCode.max], [6, 8], 'read from the service code when eBay\'s list lacks it');
  assert.deepStrictEqual(delivery.transitFromCode('UK_Parcelforce48'), { min: 2, max: 2 });
  assert.strictEqual(delivery.accountWindow(null), null);

  const account = { min: 6, max: 8 };
  assert.strictEqual(delivery.compare({ min: 2, max: 3 }, account), 'faster');
  assert.strictEqual(delivery.compare({ min: 5, max: 7 }, account), 'similar');
  assert.strictEqual(delivery.compare({ min: 10, max: 15 }, account), 'slower');
  assert.strictEqual(delivery.compare(null, account), 'unknown');
});

test("research compares with listings that deliver like the account by default, and says how many deliver faster or slower", async () => {
  mock.method(appState, 'get', async () => null);
  mock.method(appState, 'set', async () => {});
  mock.method(connectionService, 'getConnectionSummary', async () => ({ platform_key: 'ebay', marketplace: { id: 'EBAY_GB' }, settings: { ebay: { fulfillmentPolicyId: 'p1' } } }));
  mock.method(listingRepository, 'findPolicyRefusals', async () => []);
  mock.method(connectionService, 'withDecryptedCredentials', async (id, owner, action) => action({ accessToken: 't' }));
  mock.method(ebayService, 'postagePolicyDetails', async (credentials, { fulfillmentPolicyId }) => {
    assert.strictEqual(fulfillmentPolicyId, 'p1');
    return { policy: { handlingTime: { value: 1 }, shippingOptions: [{ optionType: 'DOMESTIC', shippingServices: [{ shippingServiceCode: 'UK_OtherCourier5To7Days' }] }] }, services: [] };
  });
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString();
  const searchCall = mock.method(ebayBrowse, 'searchItemSummaries', async (params) => {
    assert.strictEqual(params.deliveryCountry, 'GB', 'eBay estimates delivery for a UK buyer');
    return {
      total: 3,
      itemSummaries: [
        { itemId: 'v1|1|0', title: 'Fast', price: { value: '9.99', currency: 'GBP' }, shippingOptions: [{ shippingCost: { value: '0' }, minEstimatedDeliveryDate: day(1), maxEstimatedDeliveryDate: day(3) }] },
        { itemId: 'v1|2|0', title: 'Like us', price: { value: '6.99', currency: 'GBP' }, shippingOptions: [{ shippingCost: { value: '0' }, minEstimatedDeliveryDate: day(8), maxEstimatedDeliveryDate: day(11) }] },
        { itemId: 'v1|3|0', title: 'No dates', price: { value: '5.99', currency: 'GBP' } },
      ],
    };
  });
  mock.method(ebayBrowse, 'getItem', async () => ({ estimatedAvailabilities: [{ estimatedSoldQuantity: 1 }] }));

  const like = await researchService.search('owner', 'conn', { q: 'lamp' });
  assert.deepStrictEqual(like.items.map((i) => i.title), ['Like us']);
  assert.strictEqual(like.delivery.filter, 'similar');
  assert.deepStrictEqual(like.delivery.counts, { similar: 1, faster: 1, slower: 0, unknown: 1, all: 3 });
  assert.deepStrictEqual([like.delivery.account.min, like.delivery.account.max], [6, 8]);
  assert.strictEqual(like.summary.price.median, 6.99, 'the figures are worked out from those listings only');

  const all = await researchService.search('owner', 'conn', { q: 'lamp', delivery: 'all' });
  assert.strictEqual(all.items.length, 3);
  const faster = await researchService.search('owner', 'conn', { q: 'lamp', delivery: 'faster' });
  assert.deepStrictEqual(faster.items.map((i) => i.title), ['Fast']);
  assert.strictEqual(searchCall.mock.calls.length, 1, 'switching group re-reads nothing from eBay');
});
