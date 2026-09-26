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

test("analyse uses AliExpress's postage, free at or over its threshold", () => {
  const shipping = { cost: 1.99, freeOver: 3.05, minDays: 5, maxDays: 8, company: 'AliExpress Standard', tracking: true };
  const result = huntProfit.analyse({ competitor: competitor(), source: source(), pricing: PRICING, shipping, site: SITE, now: NOW });
  assert.strictEqual(result.options[0].shipping, 1.99); // 3.00 is under 3.05
  assert.strictEqual(result.options[0].profit, 3.8);
  assert.strictEqual(result.options[1].shipping, 0); // 3.20 is over it
  assert.strictEqual(result.shipping.basis, 'aliexpress');
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
