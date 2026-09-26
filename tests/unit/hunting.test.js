const test = require('node:test');
const assert = require('node:assert');

const huntProfit = require('../../src/modules/hunting/hunt-profit');
const rules = require('../../src/modules/hunting/hunt-rules');
const stats = require('../../src/modules/hunting/hunting-stats');
const duplicates = require('../../src/modules/hunting/hunt-duplicates');

const SITE = { id: 'EBAY_GB', country: 'GB', currency: 'GBP', name: 'eBay UK' };
const NOW = Date.parse('2026-09-27T12:00:00Z');
// Settings fees: 18% ads + 12% processing + £0.30, 60% target return.
const PRICING = { adsFeePercent: 18, processingFeePercent: 12, fixedFeePerOrder: 0.3, targetRoiPercent: 60, shippingCostPerOrder: 0 };

// A competitor selling two colours of one product, Black the best seller.
function competitor(overrides = {}) {
  return {
    title: 'Wireless Earbuds Bluetooth 5.3 Headphones',
    legacyItemId: '123456789012',
    url: 'https://www.ebay.co.uk/itm/123456789012',
    priceText: 'GBP 12.99',
    postage: { cost: 0, service: 'Economy', minDate: '2026-09-29T10:00:00Z', maxDate: '2026-10-01T10:00:00Z' },
    seller: { username: 'shop', feedbackScore: 900, feedbackPercentage: 99.1, business: true },
    sold: 130,
    createdAt: '2026-06-27T12:00:00Z',
    location: { country: 'GB' },
    specifics: { Brand: 'Unbranded' },
    referenceImages: ['https://i.ebayimg.com/c.jpg'],
    variants: [
      { attributes: { Colour: 'Black' }, priceText: 'GBP 12.99', sold: 100, postageCost: 0 },
      { attributes: { Colour: 'White' }, priceText: 'GBP 13.99', sold: 30, postageCost: 0 },
    ],
    ...overrides,
  };
}

function source(overrides = {}) {
  return {
    title: 'TWS Earbuds Wireless',
    sourceUrl: 'https://www.aliexpress.com/item/1005001234567890.html',
    priceText: 'GBP 3.00',
    imageUrls: ['https://ae01.alicdn.com/a.jpg'],
    specifics: {},
    supplier: { orders: '1000+', rating: 4.8, reviews: 320, onSale: true, store: null, deliveryDays: 7 },
    variants: [
      { attributes: { Color: 'black' }, priceText: 'GBP 3.00', stock: 50, skuId: '111' },
      { attributes: { Color: 'white' }, priceText: 'GBP 3.20', stock: 0, skuId: '222' },
      { attributes: { Color: 'Pink' }, priceText: 'GBP 3.10', stock: 5, skuId: '333' },
    ],
    ...overrides,
  };
}

// ---- matching ----------------------------------------------------------------------------

test('valueScore matches the same words, pack sizes and size names, and not different colours', () => {
  assert.strictEqual(huntProfit.valueScore('Black', 'black'), 1);
  assert.strictEqual(huntProfit.valueScore('2PCS', '2 Pack'), 0.9);
  assert.strictEqual(huntProfit.valueScore('Pack of 4', '4 pcs'), 0.9);
  assert.strictEqual(huntProfit.valueScore('2PCS', '4 Pack'), 0);
  assert.strictEqual(huntProfit.valueScore('Extra Large', 'XL'), 1);
  assert.strictEqual(huntProfit.valueScore('Gray', 'grey'), 1);
  assert.strictEqual(huntProfit.valueScore('M Black', 'Black'), 0.8);
  assert.strictEqual(huntProfit.valueScore('Red', 'Blue'), 0);
});

test('optionScore ignores a "Ships From" axis and counts every axis of both sides', () => {
  const option = { attributes: { Color: 'Black', 'Ships From': 'CHINA' } };
  assert.strictEqual(huntProfit.optionScore(option, { attributes: { Colour: 'Black' } }), 1);
  // Colour matches, size doesn't exist on the supplier: half a match.
  assert.strictEqual(huntProfit.optionScore({ attributes: { Color: 'Black' } }, { attributes: { Colour: 'Black', Size: 'M' } }), 0.5);
});

// ---- the profit check -------------------------------------------------------------------------

test('analyse works each option out at its matched competitor price, less fees, cost and postage', () => {
  const result = huntProfit.analyse({ competitor: competitor(), source: source(), pricing: PRICING, site: SITE, now: NOW });
  const black = result.options[0];
  // 12.99 − 3.00 − 18% (2.34) − 12% (1.56) − 0.30 = 5.79; ROI 5.79 / 3.00.
  assert.strictEqual(black.match.label, 'Black');
  assert.strictEqual(black.match.quality, 'exact');
  assert.strictEqual(black.sellPrice, 12.99);
  assert.deepStrictEqual(black.fees, { ads: 2.34, processing: 1.56, fixed: 0.3, total: 4.2 });
  assert.strictEqual(black.profit, 5.79);
  assert.strictEqual(black.roi, 193);
  assert.strictEqual(black.breakEven, 4.71);
  // White matches White's own price.
  assert.strictEqual(result.options[1].sellPrice, 13.99);
  // Pink has no match: priced at the competitor's lowest, and said so.
  assert.strictEqual(result.options[2].match.quality, 'lowest');
  assert.strictEqual(result.options[2].sellPrice, 12.99);
});

test('analyse judges the product on the option matching the best-selling variation', () => {
  const result = huntProfit.analyse({ competitor: competitor(), source: source(), pricing: PRICING, site: SITE, now: NOW });
  assert.strictEqual(result.summary.bestSeller.label, 'Black');
  assert.strictEqual(result.summary.bestSeller.sold, 100);
  assert.strictEqual(result.summary.headline.basis, 'best_seller');
  assert.strictEqual(result.summary.headline.optionIndex, 0);
  assert.strictEqual(result.summary.verdict, 'strong');
  // White is out of stock, so it isn't counted among what can be sold.
  assert.strictEqual(result.summary.inStock, 2);
  assert.strictEqual(result.demand.soldPerMonth, 42.4); // 130 over 92 days
});

test("analyse adds AliExpress's postage only when it's charged outright", () => {
  const charged = { cost: 1.99, freeOver: null, minDays: 5, maxDays: 8, company: 'AliExpress Standard', tracking: true };
  const result = huntProfit.analyse({ competitor: competitor(), source: source(), pricing: PRICING, shipping: charged, site: SITE, now: NOW });
  assert.strictEqual(result.options[0].shipping, 1.99);
  assert.strictEqual(result.options[0].profit, 3.8);
  assert.strictEqual(result.shipping.basis, 'aliexpress');
  assert.strictEqual(result.shipping.counted, 1.99);
});

test('a free-shipping offer ("free over £8") counts as free postage, whatever the option costs', () => {
  const offer = { cost: 1.99, freeOver: 8, minDays: 5, maxDays: 8, company: 'AliExpress Selection Premium shipping', tracking: true };
  const result = huntProfit.analyse({ competitor: competitor(), source: source(), pricing: PRICING, shipping: offer, site: SITE, now: NOW });
  // Every option costs under £8, and none is charged postage.
  assert.ok(result.options.every((o) => o.shipping === 0));
  assert.strictEqual(result.options[0].profit, 5.79);
  assert.strictEqual(result.shipping.counted, 0);
  assert.strictEqual(result.shipping.cost, 1.99);
});

test('analyse falls back to the settings flat postage without an AliExpress quote', () => {
  const result = huntProfit.analyse({ competitor: competitor(), source: source(), pricing: { ...PRICING, shippingCostPerOrder: 1 }, site: SITE, now: NOW });
  assert.strictEqual(result.shipping.basis, 'settings');
  assert.strictEqual(result.options[0].shipping, 1);
  assert.strictEqual(result.options[0].profit, 4.79);
});

test('analyse calls a product that loses money at the competitor price a loss, with a margin check', () => {
  const pricey = source({ variants: [{ attributes: { Color: 'Black' }, priceText: 'GBP 11.00', stock: 20, skuId: '1' }] });
  const result = huntProfit.analyse({ competitor: competitor(), source: pricey, pricing: PRICING, site: SITE, now: NOW });
  assert.strictEqual(result.summary.verdict, 'loss');
  assert.strictEqual(result.checks.find((c) => c.key === 'margin').level, 'bad');
});

test('analyse on a competitor without variations uses its one price, and its title to pick the option', () => {
  const single = competitor({ title: 'Wireless Earbuds Pink', variants: [], priceText: 'GBP 9.99', postage: { cost: 1, minDate: null, maxDate: null } });
  const result = huntProfit.analyse({ competitor: single, source: source(), pricing: PRICING, site: SITE, now: NOW });
  assert.ok(result.options.every((o) => o.sellPrice === 10.99 && o.match.quality === 'single'));
  assert.strictEqual(result.summary.headline.optionIndex, 2); // Pink
});

test('feeRates uses the account real rates from enough orders, else its settings', () => {
  assert.strictEqual(huntProfit.feeRates(PRICING, { orders: 5, gross: 100, fees: 20, adFees: 5 }).basis, 'settings');
  const real = huntProfit.feeRates(PRICING, { orders: 100, gross: 2000, fees: 400, adFees: 100 });
  // Processing: (400 − 100 − 0.30 × 100) / 2000 = 13.5%; ads 5%.
  assert.deepStrictEqual({ basis: real.basis, ads: real.adsPercent, processing: real.processingPercent }, { basis: 'orders', ads: 5, processing: 13.5 });
  // Implausible totals (finances still syncing) fall back to the settings.
  assert.strictEqual(huntProfit.feeRates(PRICING, { orders: 100, gross: 2000, fees: 10, adFees: 0 }).basis, 'settings');
});

test('checks flag a named brand, out-of-stock options and a slow supplier, and pass an unbranded one', () => {
  const branded = competitor({ specifics: { Brand: 'Sony' }, postage: { cost: 0, minDate: '2026-09-28T10:00:00Z', maxDate: '2026-09-29T10:00:00Z' } });
  const result = huntProfit.analyse({ competitor: branded, source: source(), pricing: PRICING, shipping: { cost: 0, freeOver: null, minDays: 10, maxDays: 15 }, site: SITE, now: NOW });
  const level = (key) => result.checks.find((c) => c.key === key).level;
  assert.strictEqual(level('brand'), 'warn');
  assert.strictEqual(level('stock'), 'warn');
  assert.strictEqual(level('delivery'), 'warn');
  assert.strictEqual(level('supplier'), 'ok');
  const plain = huntProfit.analyse({ competitor: competitor({ specifics: { Brand: 'Branded' } }), source: source(), pricing: PRICING, site: SITE, now: NOW });
  assert.strictEqual(plain.checks.find((c) => c.key === 'brand').level, 'ok');
});

test('priceChanges lists the options whose supplier price moved since the hunt', () => {
  const result = huntProfit.analyse({ competitor: competitor(), source: source(), pricing: PRICING, site: SITE, now: NOW });
  const later = source({ variants: [{ attributes: { Color: 'black' }, priceText: 'GBP 3.60', stock: 50 }, { attributes: { Color: 'white' }, priceText: 'GBP 3.20', stock: 0 }] });
  assert.deepStrictEqual(huntProfit.priceChanges(result.options, later, 'GBP'), [{ label: 'black', before: 3, after: 3.6 }]);
});

test('draftSelection starts a draft with the values some earning, in-stock option has', () => {
  const rows = [
    { attributes: { Color: 'Black', Size: 'M' }, profit: 2, stock: 5 },
    { attributes: { Color: 'Red', Size: 'M' }, profit: -1, stock: 5 },
    { attributes: { Color: 'Blue', Size: 'L' }, profit: 3, stock: 0 },
  ];
  const axes = [{ name: 'Color', values: [{ value: 'Black' }, { value: 'Red' }, { value: 'Blue' }] }, { name: 'Size', values: [{ value: 'M' }, { value: 'L' }] }];
  assert.deepStrictEqual(huntProfit.draftSelection(rows, axes), { Color: ['Black'], Size: ['M'] });
  assert.strictEqual(huntProfit.draftSelection(rows.map((r) => ({ ...r, profit: -1 })), axes), null);
});

// ---- rules ----------------------------------------------------------------------------------

const OWNER = { userId: 'o', isOwner: true, canHunt: true, canReview: true, canDraft: true };
const REVIEWER = { userId: 'r', isOwner: false, canHunt: true, canReview: true, canDraft: false };
const HUNTER = { userId: 'h', isOwner: false, canHunt: true, canReview: false, canDraft: false };
const LISTER = { userId: 'l', isOwner: false, canHunt: false, canReview: false, canDraft: true };

test('stageOf follows the draft and the eBay item after the review', () => {
  assert.strictEqual(rules.stageOf({ status: 'approved', listing_id: null, item_ids: [] }), 'approved');
  assert.strictEqual(rules.stageOf({ status: 'approved', listing_id: 'x', item_ids: [] }), 'drafted');
  assert.strictEqual(rules.stageOf({ status: 'approved', listing_id: null, item_ids: ['1'] }), 'listed');
});

test('nobody but the owner decides on their own find; hunters edit and withdraw only their own waiting ones', () => {
  const byReviewer = { status: 'pending', hunter_user_id: 'r', listing_id: null, item_ids: [] };
  const byHunter = { status: 'pending', hunter_user_id: 'h', listing_id: null, item_ids: [] };
  assert.strictEqual(rules.rules.canDecide(byReviewer, REVIEWER), false);
  assert.strictEqual(rules.rules.canDecide(byReviewer, OWNER), true);
  assert.strictEqual(rules.rules.canDecide(byHunter, REVIEWER), true);
  assert.strictEqual(rules.rules.canDecide(byHunter, HUNTER), false);
  assert.strictEqual(rules.rules.canEdit(byHunter, HUNTER), true);
  assert.strictEqual(rules.rules.canEdit(byHunter, REVIEWER), false);
  assert.strictEqual(rules.rules.canWithdraw(byHunter, HUNTER), true);
  assert.strictEqual(rules.rules.canWithdraw({ ...byHunter, status: 'approved' }, HUNTER), false);
  assert.strictEqual(rules.rules.canResubmit({ ...byHunter, status: 'sent_back' }, HUNTER), true);
});

test('drafting needs an approved product and Listings access; a drafted one is settled', () => {
  const approved = { status: 'approved', hunter_user_id: 'h', listing_id: null, item_ids: [] };
  assert.strictEqual(rules.rules.canDraft(approved, LISTER), true);
  assert.strictEqual(rules.rules.canDraft(approved, REVIEWER), false);
  assert.strictEqual(rules.rules.canDraft({ ...approved, status: 'pending' }, LISTER), false);
  assert.strictEqual(rules.rules.canDecide({ ...approved, listing_id: 'x' }, OWNER), false);
});

test('decisionFields needs a reason to reject and a note to send back', () => {
  assert.deepStrictEqual(rules.decisionFields({ decision: 'approve', note: ' good ' }), { status: 'approved', reject_reason: null, decision_note: 'good' });
  assert.throws(() => rules.decisionFields({ decision: 'reject' }), /Choose why/);
  assert.throws(() => rules.decisionFields({ decision: 'reject', reason: 'other' }), /Say why/);
  assert.strictEqual(rules.decisionFields({ decision: 'reject', reason: 'low_profit' }).reject_reason, 'low_profit');
  assert.throws(() => rules.decisionFields({ decision: 'send_back', note: '' }), /what the hunter should change/);
  assert.strictEqual(rules.decisionFields({ decision: 'send_back', note: 'Find a cheaper supplier' }).status, 'sent_back');
});

// ---- figures ------------------------------------------------------------------------------

test('hunterFigures counts products by where they stand, and the approval rate over decided ones', () => {
  const hunts = [
    { status: 'pending', item_ids: [] },
    { status: 'approved', item_ids: [] },
    { status: 'approved', listing_id: 'd', item_ids: [] },
    { status: 'approved', listing_id: 'd', item_ids: ['1'] },
    { status: 'rejected', item_ids: [] },
    { status: 'sent_back', item_ids: [] },
  ];
  assert.deepStrictEqual(stats.hunterFigures(hunts), { hunted: 6, approved: 3, rejected: 1, sentBack: 1, waiting: 1, drafted: 2, listed: 1, approvalRate: 75 });
});

test('reviewerFigures counts each product once per decision and leaves the owner own finds out of time to decide', () => {
  const rows = [
    { kind: 'hunt.approved', subject_id: 'a' },
    { kind: 'hunt.rejected', subject_id: 'a' },
    { kind: 'hunt.sent_back', subject_id: 'b' },
    { kind: 'hunt.approved', subject_id: 'c' },
  ];
  const decided = [
    { reviewer_user_id: 'r', hunter_user_id: 'h', submitted_at: '2026-09-01T10:00:00Z', decided_at: '2026-09-01T14:00:00Z' },
    { reviewer_user_id: 'o', hunter_user_id: 'o', submitted_at: '2026-09-01T10:00:00Z', decided_at: '2026-09-09T10:00:00Z' },
  ];
  assert.deepStrictEqual(stats.reviewerFigures(rows, decided), { reviewed: 3, approved: 2, rejected: 1, sentBack: 1, avgHoursToDecide: 4 });
});

test('salesByItem adds up orders per listing without cancelled ones, and salesFor per currency', () => {
  const orders = [
    { createdAt: '2026-09-20T10:00:00Z', total: { currency: 'GBP' }, lineItems: [{ itemId: '1', quantityPurchased: 2, price: { amount: 5, currency: 'GBP' } }] },
    { createdAt: '2026-09-21T10:00:00Z', total: { currency: 'GBP' }, lineItems: [{ itemId: '1', quantityPurchased: 1, price: { amount: 5, currency: 'GBP' } }, { itemId: '2', quantityPurchased: 1, price: { amount: 9, currency: 'GBP' } }] },
    { createdAt: '2026-09-22T10:00:00Z', cancelled: true, lineItems: [{ itemId: '1', quantityPurchased: 1, price: { amount: 5, currency: 'GBP' } }] },
  ];
  const byItem = stats.salesByItem(orders, { isCancelled: (o) => o.cancelled });
  assert.deepStrictEqual(byItem.get('1'), { orders: 2, units: 3, sales: 15, currency: 'GBP', lastAt: '2026-09-21T10:00:00Z' });
  assert.deepStrictEqual(stats.salesFor(['1', '2', '9'], byItem), [{ currency: 'GBP', orders: 3, units: 4, sales: 24, lastAt: '2026-09-21T10:00:00Z' }]);
});

test('reasonCounts lists only the rejection reasons used, most common first', () => {
  const hunts = [{ status: 'rejected', reject_reason: 'low_demand', item_ids: [] }, { status: 'rejected', reject_reason: 'low_profit', item_ids: [] }, { status: 'rejected', reject_reason: 'low_profit', item_ids: [] }];
  assert.deepStrictEqual(stats.reasonCounts(hunts).map((r) => [r.key, r.count]), [['low_profit', 2], ['low_demand', 1]]);
});

// ---- duplicates ----------------------------------------------------------------------------

test('describe warns about hunts, drafts and live listings of the same product on any account, and similar titles', () => {
  const found = duplicates.describe(
    {
      hunts: [{ id: 'h1', connection_id: 'b', connection_label: 'Selvora', title: 'Earbuds', stage: 'rejected', hunter_name: 'Ali', source_product_id: '1005', competitor_item_id: '999', created_at: 'x' }],
      listings: [{ id: 'l1', status: 'published', external_product_id: '555', connection_id: 'a', account: 'Walexo', title: 'Earbuds', same_supplier: true, same_competitor: false }],
      live: [
        { connectionId: 'a', account: 'Walexo', itemId: '555', title: 'Earbuds' }, // the same listing, not repeated
        { connectionId: 'c', account: 'North', itemId: '123456789012', title: 'Wireless Earbuds' }, // the competitor is ours
      ],
      allLive: [
        { connectionId: 'c', account: 'North', itemId: '777', title: 'Wireless Earbuds Bluetooth 5.3 Headphones Black' },
        { connectionId: 'c', account: 'North', itemId: '778', title: 'Garden hose reel' },
      ],
    },
    { productId: '1005', itemId: '123456789012', title: 'Wireless Earbuds Bluetooth 5.3 Headphones', connectionId: 'a' }
  );
  assert.deepStrictEqual(found.map((d) => d.type), ['hunt', 'listing', 'own_competitor', 'similar']);
  assert.strictEqual(found[0].same, 'supplier');
  assert.strictEqual(found[0].sameAccount, false);
  assert.strictEqual(found[1].sameAccount, true);
  assert.strictEqual(found[3].itemId, '777');
});

test('the demand check calls no sales in a month bad, a few slow, and steady sales fine', () => {
  const level = (overrides) => huntProfit.analyse({ competitor: competitor(overrides), source: source(), pricing: PRICING, site: SITE, now: NOW }).checks.find((c) => c.key === 'demand').level;
  assert.strictEqual(level({}), 'ok');
  assert.strictEqual(level({ sold: 0, createdAt: '2026-08-01T00:00:00Z' }), 'bad');
  assert.strictEqual(level({ sold: 0, createdAt: '2026-09-20T00:00:00Z' }), 'warn');
  assert.strictEqual(level({ sold: 4, createdAt: '2026-06-27T12:00:00Z' }), 'warn');
  assert.strictEqual(level({ sold: null }), 'unknown');
});

test('without a competitor each option is priced as a draft would be, and the check says there is no market to judge', () => {
  const result = huntProfit.analyse({ competitor: null, source: source(), pricing: PRICING, site: SITE, now: NOW });
  assert.strictEqual(result.competitor, null);
  const black = result.options[0];
  // The target-return floor for £3.00: (3 × 1.6 + 0.30) / 0.7 = 7.29 → £7.99.
  assert.strictEqual(black.sellPrice, 7.99);
  assert.strictEqual(black.match.quality, 'target');
  assert.ok(black.roi >= 60);
  assert.strictEqual(result.summary.verdict, 'unpriced');
  assert.strictEqual(result.summary.headline.basis, 'your_price');
  assert.strictEqual(result.summary.bestSeller, null);
  assert.strictEqual(result.summary.entryPrice, 7.99);
  const check = (key) => result.checks.find((c) => c.key === key);
  assert.strictEqual(check('demand').level, 'unknown');
  assert.match(check('demand').detail, /No competitor/);
  assert.strictEqual(check('margin'), undefined);
  assert.deepStrictEqual(result.warnings, []);
});

test('a live listing of the same product under different words is named as similar (word forms count as one word)', () => {
  assert.strictEqual(duplicates.stem('Curlers'), 'curl');
  assert.strictEqual(duplicates.stem('curling'), 'curl');
  assert.strictEqual(duplicates.stem('glass'), 'glass');
  const found = duplicates.describe(
    {
      allLive: [
        { connectionId: 'a', account: 'Walexo', itemId: '407245015055', title: 'Heatless Curling Rod Headband Soft Hair Curler Overnight Polyester Foam UK' },
        { connectionId: 'a', account: 'Walexo', itemId: '406937377702', title: 'Universal Hair Diffuser Silicone Dryer Attachment Curl Styling Tool UK' },
      ],
    },
    {
      productId: '1005008682747289',
      itemId: '800514348405',
      titles: ['Heatless Hair Curlers Satin Curling Rod Headband No Heat Overnight Curls', 'Heatless Curling Rod Headband Soft Hair Curler No Heat Hair Rollers Curlers Lazy Sleeping Curls Curling Hairband Styling Tools'],
      connectionId: 'a',
    }
  );
  assert.deepStrictEqual(found.map((d) => [d.type, d.itemId, d.sameAccount]), [['similar', '407245015055', true]]);
  assert.strictEqual(found[0].similarity, 67);
});

test('baseSkuFromSourceUrl-style labels: a few shared generic words are not a similar title', () => {
  assert.strictEqual(duplicates.titleSimilarity('Red Cotton T-Shirt for Men UK', 'Red Wine Glass Set for Men'), 0);
});

// ---- sales history and score ---------------------------------------------------------------

const huntSales = require('../../src/modules/hunting/hunt-sales');

test('salesByVariation splits the competitor sales by variation, with the supplier options matched to each', () => {
  const result = huntProfit.analyse({ competitor: competitor(), source: source(), pricing: PRICING, site: SITE, now: NOW });
  assert.deepStrictEqual(
    result.sales.variations.map((v) => [v.label, v.sold, v.share, v.supplier]),
    [
      ['Black', 100, 76.9, ['black']],
      ['White', 30, 23.1, ['white']],
    ]
  );
  assert.strictEqual(huntProfit.analyse({ competitor: null, source: source(), pricing: PRICING, site: SITE, now: NOW }).sales.variations.length, 0);
});

test('history turns daily readings of the sold count into sales per day, last 7 days and a trend', () => {
  const day = (d, h = 9) => new Date(Date.UTC(2026, 8, d, h)).toISOString();
  const readings = [
    { taken_at: day(20), sold: 100, variations: [{ label: 'Black', sold: 80 }, { label: 'White', sold: 20 }] },
    { taken_at: day(21), sold: 104, variations: [] },
    { taken_at: day(23), sold: 110, variations: [] },
    { taken_at: day(27), sold: 122, variations: [{ label: 'Black', sold: 95 }, { label: 'White', sold: 27 }] },
  ];
  const h = huntSales.history(readings, { now: Date.parse(day(27, 12)), lifetimePerDay: 1 });
  assert.strictEqual(h.readings, 4);
  assert.strictEqual(h.coveredDays, 7);
  assert.deepStrictEqual(h.days.map((d) => d.sold), [0, 4, 0, 6, 0, 0, 0, 12]);
  assert.strictEqual(h.soldLast7, 22);
  assert.strictEqual(h.perDay, 3.1);
  assert.strictEqual(h.trend, 'up'); // 3.1 a day against its usual 1
  assert.deepStrictEqual(h.byVariation, [{ label: 'Black', sold: 15 }, { label: 'White', sold: 7 }]);
  assert.strictEqual(huntSales.history(readings.slice(0, 1)).days.length, 0);
});

test('salesScore weighs sales a month, sold in all, the trend and options selling; half marks for trend until tracked', () => {
  const untracked = huntSales.salesScore({ demand: { sold: 130, soldPerMonth: 42.4 }, variations: [{ label: 'Black', sold: 100 }, { label: 'White', sold: 30 }] });
  assert.deepStrictEqual(untracked.parts.map((p) => p.points), [41, 16, 10, 15]);
  assert.strictEqual(untracked.score, 82);
  assert.strictEqual(untracked.label, 'Hot');
  assert.strictEqual(untracked.estimate, true);
  const cooling = huntSales.salesScore({ demand: { sold: 130, soldPerMonth: 42.4 }, variations: [], history: { coveredDays: 8, soldLast7: 0, trend: 'down' } });
  assert.strictEqual(cooling.parts.find((p) => p.key === 'trend').points, 0);
  assert.strictEqual(huntSales.salesScore({ demand: { sold: 0, soldPerMonth: 0 }, variations: [] }).label, 'Cold');
  assert.strictEqual(huntSales.salesScore({ demand: { sold: null } }), null);
});

test("a dip in eBay's sold count doesn't cancel the sales read before it", () => {
  const at = (d) => new Date(Date.UTC(2026, 8, d, 9)).toISOString();
  const h = huntSales.history(
    [
      { taken_at: at(24), sold: 50 },
      { taken_at: at(25), sold: 55 },
      { taken_at: at(26), sold: 53 },
      { taken_at: at(27), sold: 56 },
    ],
    { now: Date.parse(at(27)) + 3600000 }
  );
  assert.strictEqual(h.soldLast7, 8);
});

// ---- sold history pasted from eBay --------------------------------------------------------

const soldHistory = require('../../src/modules/hunting/sold-history');

// eBay's purchase history page as Chrome copies it (tab-separated rows) and
// as Safari does (one cell a line), both around the page's own text.
const CHROME_PASTE = [
  'Skip to main content', 'Purchase history', 'Heatless Hair Curlers Satin Curling Rod Headband No Heat Overnight Curls', 'Recent purchases',
  'User ID\tVariation\tBuy It Now price\tQuantity\tDate of purchase',
  'b***e\tcolor: Pink\t£7.99\t1\t25 Sep 2026 at 3:01:06pm BST',
  '4***e\tcolor: Brown\t£7.99\t1\t23 Sep 2026 at 9:40:39pm BST',
  '9***5\tcolor: Pink\t£7.99\t2\t22 Sep 2026 at 8:57:47am BST',
  '8***5\tcolor: Brown\t£7.99\t1\t7 Sep 2026 at 9:55:09am BST',
  '3***7\tcolor: Pink\t£7.99\t1\t4 Sep 2026 at 6:44:41pm BST',
  'About eBay\tAnnouncements\tCopyright © 1995-2026 eBay Inc.',
].join('\n');

test('parse reads each sale from a pasted purchase history page, ignoring the page around it', () => {
  const rows = soldHistory.parse(CHROME_PASTE);
  assert.strictEqual(rows.length, 5);
  assert.deepStrictEqual(rows[0], { soldAt: '2026-09-25T14:01:06.000Z', variation: 'Color: Pink', price: 7.99, currency: 'GBP', quantity: 1 });
  assert.strictEqual(rows[2].quantity, 2);
  // Safari puts each cell on its own line; US pages write dates month first, in dollars.
  const safari = soldHistory.parse('Recent purchases\n0***c\ncolor: Brown\n£7.99\n1\n22 Sep 2026 at 5:26:40am BST\n1***b\ncolor: Brown\n£7.99\n1\n18 Sep 2026 at 7:44:19pm BST');
  assert.deepStrictEqual(safari.map((r) => r.soldAt), ['2026-09-22T04:26:40.000Z', '2026-09-18T18:44:19.000Z']);
  const us = soldHistory.parse('a***b\tColor: Black, Size: M\tUS $12.50\t1\tSep 25, 2026 at 3:01:06pm PDT');
  assert.deepStrictEqual(us[0], { soldAt: '2026-09-25T22:01:06.000Z', variation: 'Color: Black, Size: M', price: 12.5, currency: 'USD', quantity: 1 });
  assert.deepStrictEqual(soldHistory.parse('nothing useful here'), []);
});

test('insights work out exact sales by period, pace, price and variation from the dated sales', () => {
  const figures = soldHistory.insights(soldHistory.parse(CHROME_PASTE), { now: Date.parse('2026-09-27T12:00:00Z') });
  assert.deepStrictEqual(figures.windows.d3, { units: 1, orders: 1 });
  assert.deepStrictEqual(figures.windows.d7, { units: 4, orders: 3 });
  assert.deepStrictEqual(figures.windows.d30, { units: 6, orders: 5 });
  assert.strictEqual(figures.daysSinceLast, 1);
  // 6 units since 4 Sep (22.7 days): 0.26 a day.
  assert.strictEqual(figures.perDay, 0.26);
  assert.strictEqual(figures.perMonth, 7.8);
  assert.deepStrictEqual(figures.price, { average: 7.99, median: 7.99, low: 7.99, high: 7.99, volatility: 0 });
  assert.deepStrictEqual(figures.byVariation.map((v) => [v.variation, v.units, v.share]), [['Color: Pink', 4, 66.7], ['Color: Brown', 2, 33.3]]);
  assert.strictEqual(figures.daily.length, 30);
  assert.strictEqual(figures.trend, 'up'); // 4 in the last 15 days against 2 before
  assert.strictEqual(soldHistory.insights([]), null);
  assert.strictEqual(soldHistory.purchaseHistoryUrl('https://www.ebay.co.uk/itm/800514348405', '800514348405'), 'https://www.ebay.co.uk/bin/purchaseHistory?item=800514348405');
});

test('with eBay sold history pasted, the score uses its real pace and recency', () => {
  const exact = { perMonth: 17.1, daysSinceLast: 2, trend: 'up' };
  const score = huntSales.salesScore({ demand: { sold: 12, soldPerMonth: 8.6 }, variations: [], exact });
  assert.strictEqual(score.exact, true);
  assert.strictEqual(score.estimate, false);
  assert.strictEqual(score.parts.find((p) => p.key === 'trend').points, 20);
  assert.match(score.parts[0].detail, /17.1 a month/);
  const stale = huntSales.salesScore({ demand: { sold: 12, soldPerMonth: 8.6 }, variations: [], exact: { perMonth: 2, daysSinceLast: 20, trend: null } });
  assert.strictEqual(stale.parts.find((p) => p.key === 'trend').points, 0);
});
