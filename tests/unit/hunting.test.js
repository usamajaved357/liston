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
  assert.strictEqual(huntProfit.draftBasis(rows), 'earning', 'no sold counts matched: every option that earns');
});

test('draftSelection drops the variations that never sold on the competitor listing', () => {
  // Ten colours listed, only Black ever sold: the draft is Black.
  const colours = ['Black', 'White', 'Red', 'Blue'];
  const rows = colours.map((c) => ({ attributes: { Color: c }, profit: 2, stock: 10, match: { label: c, sold: c === 'Black' ? 40 : 0, quality: 'exact' } }));
  const axes = [{ name: 'Color', values: colours.map((value) => ({ value })) }];
  assert.strictEqual(huntProfit.draftBasis(rows), 'selling');
  assert.deepStrictEqual(huntProfit.draftSelection(rows, axes), { Color: ['Black'] });
  // An option only priced at the listing's lowest price isn't proof it sells.
  const lowest = rows.map((r) => ({ ...r, match: { label: null, sold: null, quality: 'lowest' } }));
  assert.strictEqual(huntProfit.draftSelection(lowest, axes), null, 'every value kept: nothing to leave out');
  // The one that sold doesn't earn: the options that earn, as before.
  const blackLoses = rows.map((r) => (r.attributes.Color === 'Black' ? { ...r, profit: -1 } : r));
  assert.strictEqual(huntProfit.draftBasis(blackLoses), 'earning');
  assert.deepStrictEqual(huntProfit.draftSelection(blackLoses, axes), { Color: ['White', 'Red', 'Blue'] });
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

test('nobody but the owner decides on their own find; hunters edit their own waiting ones and never remove one', () => {
  const byReviewer = { status: 'pending', hunter_user_id: 'r', listing_id: null, item_ids: [] };
  const byHunter = { status: 'pending', hunter_user_id: 'h', listing_id: null, item_ids: [] };
  assert.strictEqual(rules.rules.canDecide(byReviewer, REVIEWER), false);
  // One Liston's supplier search found isn't the reviewer's own find: they decide on it.
  assert.strictEqual(rules.rules.canDecide({ ...byReviewer, found_by_liston: true }, REVIEWER), true);
  assert.strictEqual(rules.rules.canDecide({ ...byHunter, found_by_liston: true }, HUNTER), false, 'still a reviewer decision');
  assert.strictEqual(rules.rules.canDecide(byReviewer, OWNER), true);
  assert.strictEqual(rules.rules.canDecide(byHunter, REVIEWER), true);
  assert.strictEqual(rules.rules.canDecide(byHunter, HUNTER), false);
  assert.strictEqual(rules.rules.canEdit(byHunter, HUNTER), true);
  assert.strictEqual(rules.rules.canEdit(byHunter, REVIEWER), false);
  // Only a reviewer removes a product, at any stage, the owner included.
  for (const stage of [{ status: 'pending' }, { status: 'sent_back' }, { status: 'approved' }, { status: 'rejected' }, { status: 'approved', listing_id: 'x' }, { status: 'approved', item_ids: ['1'] }]) {
    const product = { ...byHunter, ...stage };
    assert.strictEqual(rules.rules.canRemove(product, HUNTER), false);
    assert.strictEqual(rules.rules.canRemove(product, LISTER), false);
    assert.strictEqual(rules.rules.canRemove(product, REVIEWER), true);
    assert.strictEqual(rules.rules.canRemove(product, OWNER), true);
  }
  assert.strictEqual(rules.rules.canResubmit({ ...byHunter, status: 'sent_back' }, HUNTER), true);
  // Fixing and resubmitting are the hunter's alone, not a reviewer's or the owner's.
  assert.strictEqual(rules.rules.canResubmit({ ...byHunter, status: 'sent_back' }, REVIEWER), false);
  assert.strictEqual(rules.rules.canResubmit({ ...byHunter, status: 'sent_back' }, OWNER), false);
  assert.strictEqual(rules.rules.canEdit({ ...byHunter, status: 'sent_back' }, OWNER), false);
  // A rejected product can be fixed by its hunter or a reviewer (the owner included), not anyone else.
  const rejected = { ...byHunter, status: 'rejected', reject_reason: 'low_profit', reviewer_user_id: 'r' };
  assert.strictEqual(rules.rules.canEdit(rejected, HUNTER), true);
  assert.strictEqual(rules.rules.canEdit(rejected, REVIEWER), true);
  assert.strictEqual(rules.rules.canEdit(rejected, OWNER), true);
  assert.strictEqual(rules.rules.canEdit(rejected, LISTER), false);
  assert.strictEqual(rules.rules.canEdit({ ...rejected, hunter_user_id: 'someone' }, HUNTER), false);
  // Resubmitting a rejected product is the hunter's alone.
  assert.strictEqual(rules.rules.canResubmit(rejected, HUNTER), true);
  assert.strictEqual(rules.rules.canResubmit(rejected, REVIEWER), false);
  assert.strictEqual(rules.rules.canResubmit(rejected, OWNER), false);
  assert.strictEqual(rules.rules.canResubmit({ ...rejected, status: 'approved' }, HUNTER), false);
});

test('an approved product drafts itself; drafting by hand (Listings access or reviewing) is for when that failed; a drafted one is settled', () => {
  const approved = { status: 'approved', hunter_user_id: 'h', listing_id: null, item_ids: [] };
  assert.strictEqual(rules.rules.canDraft(approved, LISTER), true);
  assert.strictEqual(rules.rules.canDraft(approved, REVIEWER), true, 'a reviewer can retry the draft they started');
  assert.strictEqual(rules.rules.canDraft({ ...approved, status: 'pending' }, LISTER), false);
  assert.strictEqual(rules.rules.canDraft({ ...approved, listing_id: 'x' }, LISTER), false, 'drafted: it is on the Drafts page now');
  // While its automatic draft runs, no second one; one stuck for 15 minutes counts as failed.
  const drafting = { ...approved, draft_status: 'drafting', draft_attempted_at: new Date().toISOString() };
  assert.strictEqual(rules.draftStateOf(drafting), 'drafting');
  assert.strictEqual(rules.rules.canDraft(drafting, LISTER), false);
  assert.strictEqual(rules.draftStateOf({ ...drafting, draft_attempted_at: new Date(Date.now() - 20 * 60000).toISOString() }), 'failed');
  assert.strictEqual(rules.draftStateOf({ ...approved, draft_status: 'failed' }), 'failed');
  assert.strictEqual(rules.draftStateOf({ ...approved, draft_status: 'failed', listing_id: 'x' }), null);
  assert.strictEqual(rules.rules.canDecide({ ...approved, listing_id: 'x' }, OWNER), false);
  // Liston's own rejection: the hunter may remove it (they can't remove anything else).
  const byListon = { status: 'rejected', reject_reason: 'mismatch', reviewer_user_id: null, hunter_user_id: HUNTER.userId, listing_id: null, item_ids: [] };
  assert.strictEqual(rules.autoRejected(byListon), true);
  assert.strictEqual(rules.rules.canRemove(byListon, HUNTER), true);
  assert.strictEqual(rules.rules.canRemove({ ...byListon, reject_reason: 'low_profit', reviewer_user_id: 'r' }, HUNTER), false);
  assert.strictEqual(rules.reasonLabel('mismatch'), "Supplier doesn't match the eBay listing");
  assert.throws(() => rules.decisionFields({ decision: 'reject', reason: 'mismatch' }), /Choose why/, 'only Liston gives that reason');
});

test("the supplier must sell every one of the eBay listing's variations (more is fine); a listing without variations is compared on its title", () => {
  const ebay = (variants, title = 'Wireless earbuds bluetooth headphones') => ({ title, priceText: 'GBP 12.99', postage: { cost: 0 }, variants: variants.map((v) => ({ attributes: v, priceText: 'GBP 12.99' })) });
  const ali = (variants, title = 'TWS wireless earbuds bluetooth 5.3') => ({ title, priceText: 'GBP 3.00', variants: variants.map((v, i) => ({ attributes: v, priceText: 'GBP 3.00', skuId: String(i) })) });
  // eBay has one colour; the supplier has five including it: a match.
  assert.strictEqual(huntProfit.matchCheck(ebay([{ Colour: 'Black' }]), ali([{ Color: 'Black' }, { Color: 'White' }, { Color: 'Red' }, { Color: 'Blue' }, { Color: 'Pink' }]), 'GBP'), null);
  // eBay sells a colour the supplier doesn't have: a mismatch, naming it.
  const missing = huntProfit.matchCheck(ebay([{ Colour: 'Black' }, { Colour: 'Green' }]), ali([{ Color: 'Black' }, { Color: 'White' }]), 'GBP');
  assert.strictEqual(missing.kind, 'variations');
  assert.deepStrictEqual(missing.missing, ['Green']);
  assert.match(missing.reason, /1 of the eBay listing's 2 variations isn't among the supplier's options: Green/);
  // Sizes spelt differently are the same size.
  assert.strictEqual(huntProfit.matchCheck(ebay([{ Size: 'Large' }, { Size: 'XL' }]), ali([{ Size: 'L' }, { Size: 'Extra Large' }]), 'GBP'), null);
  // No variations on eBay: the titles must share what the product is.
  assert.strictEqual(huntProfit.matchCheck(ebay([]), ali([{ Color: 'Black' }]), 'GBP'), null);
  const other = huntProfit.matchCheck(ebay([], 'Cat water fountain 2L automatic'), ali([], 'LED strip lights 5m RGB'), 'GBP');
  assert.strictEqual(other.kind, 'product');
  assert.strictEqual(huntProfit.matchCheck(null, ali([]), 'GBP'), null, 'no competitor: nothing to compare with');
});

test('only the variations that sold must be among the supplier options; an option with extra axes still covers one', () => {
  const ebay = (variants) => ({ title: 'Smart speaker', priceText: 'GBP 30', postage: { cost: 0 }, variants: variants.map(([attributes, sold]) => ({ attributes, priceText: 'GBP 30', sold })) });
  const ali = (variants) => ({ title: 'Smart speaker', priceText: 'GBP 9', variants: variants.map((v, i) => ({ attributes: v, priceText: 'GBP 9', skuId: String(i) })) });
  // Four colours listed, only Charcoal sold: a supplier with Charcoal is enough.
  const listing = ebay([[{ Colour: 'Charcoal' }, 25], [{ Colour: 'Glacier White' }, 0], [{ Colour: 'Deep Sea Blue' }, 0], [{ Colour: 'Lilac' }, 0]]);
  assert.strictEqual(huntProfit.matchCheck(listing, ali([{ Color: 'Charcoal' }]), 'GBP'), null);
  // Without the one that sells, it's a mismatch that says it's the selling one.
  const missing = huntProfit.matchCheck(listing, ali([{ Color: 'Glacier White' }, { Color: 'Lilac' }]), 'GBP');
  assert.deepStrictEqual([missing.missing, missing.selling, missing.total], [['Charcoal'], true, 1]);
  assert.match(missing.reason, /best-selling variation/);
  // A stray variation with a handful of sales among thousands doesn't decide it: the best sellers covering 80% of units do.
  const tail = ebay([[{ Colour: 'Black' }, 900], [{ Colour: 'White' }, 90], [{ Colour: 'Green' }, 3]]);
  assert.strictEqual(huntProfit.matchCheck(tail, ali([{ Color: 'Black' }, { Color: 'White' }]), 'GBP'), null);
  assert.deepStrictEqual(huntProfit.matchCheck(ebay([[{ Colour: 'Black' }, 500], [{ Colour: 'White' }, 450]]), ali([{ Color: 'Black' }]), 'GBP').missing, ['White'], 'White is most of the rest of its sales');
  // No sold counts at all: every variation must be there, as before.
  assert.deepStrictEqual(huntProfit.matchCheck(ebay([[{ Colour: 'Black' }, null], [{ Colour: 'Red' }, null]]), ali([{ Color: 'Black' }]), 'GBP').missing, ['Red']);
  // "Black / UK plug / 2 pcs" covers the listing's "Black".
  assert.strictEqual(huntProfit.matchCheck(ebay([[{ Colour: 'Black' }, 9]]), ali([{ Color: 'Black', Plug: 'UK', Quantity: '2 pcs' }]), 'GBP'), null);
  assert.ok(huntProfit.coverScore({ attributes: { Color: 'Black', Plug: 'UK', Quantity: '2 pcs' } }, { attributes: { Colour: 'Black' } }) >= 0.75);
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

test('each part of the sales score carries its figure and what earns full points', () => {
  // The STEM kit: 6.3 a month, 9 sold, no readings yet, a single listing.
  const score = huntSales.salesScore({ demand: { sold: 9, soldPerMonth: 6.3 }, variations: [] });
  assert.strictEqual(score.score, 54);
  assert.deepStrictEqual(
    score.parts.map((p) => [p.key, p.points, p.max, p.value, p.full]),
    [
      ['velocity', 22, 45, '6.3 a month', '60+ a month'],
      ['proven', 7, 20, '9 sold', '500+ sold'],
      ['trend', 10, 20, 'Not read yet: half points', 'rising sales'],
      ['breadth', 15, 15, 'Selling', 'any sale'],
    ]
  );
});

// ---- notifications ------------------------------------------------------------------------

const { noticeFor } = require('../../src/modules/hunting/hunt-notice');
const push = require('../../src/modules/notifications/push');

test('the hunter is told what the reviewer did, with the reason and the note', () => {
  const approved = noticeFor('hunt.approved', { title: 'Wireless earbuds', by: 'Sara' });
  assert.deepStrictEqual([approved.title, approved.body], ['Approved: Wireless earbuds', 'Sara approved your product. Liston is drafting it now.']);
  // Liston's own rejection says so, with the reason and what's missing.
  const byListon = noticeFor('hunt.rejected', { title: 'Wireless earbuds', reason: "Supplier doesn't match the eBay listing", note: 'Missing: Green', system: true });
  assert.deepStrictEqual([byListon.title, byListon.body], ['Rejected by Liston: Wireless earbuds', "Liston rejected it automatically: Supplier doesn't match the eBay listing. “Missing: Green”"]);
  assert.strictEqual(byListon.detail.system, true);
  const rejected = noticeFor('hunt.rejected', { title: 'Wireless earbuds', by: 'Sara', reason: 'Low demand', note: 'Too few sales' });
  assert.deepStrictEqual([rejected.title, rejected.body], ['Rejected: Wireless earbuds', 'Sara rejected it: Low demand. “Too few sales”']);
  // Its parts too, for the bell to lay out.
  assert.deepStrictEqual(rejected.detail, { product: 'Wireless earbuds', by: 'Sara', reason: 'Low demand', note: 'Too few sales' });
  assert.match(noticeFor('hunt.sent_back', { title: 'Earbuds', by: null, note: 'Find a cheaper supplier' }).body, /^A reviewer sent it back for you to improve\. “Find a cheaper supplier”$/);
  assert.strictEqual(noticeFor('hunt.removed', { title: 'Earbuds', by: 'Sam' }).body, 'Sam removed your hunted product.');
  // Long titles are cut to fit a notification.
  assert.ok(noticeFor('hunt.approved', { title: 'x'.repeat(200), by: 'Sam' }).title.length <= 70);
  assert.strictEqual(noticeFor('hunt.updated', { title: 'Earbuds' }), null);
});

test('a push the browser no longer has is reported gone, so it is forgotten', async () => {
  if (!push.configured()) return; // no VAPID keys on this machine
  const sub = { endpoint: 'https://push.example.com/abc', p256dh: 'k', auth: 'a' };
  let sent = null;
  assert.deepStrictEqual(await push.send(sub, { title: 'Hi' }, { sendImpl: async (s, body) => { sent = { s, body }; } }), { sent: true });
  assert.strictEqual(JSON.parse(sent.body).title, 'Hi');
  assert.deepStrictEqual(sent.s.keys, { p256dh: 'k', auth: 'a' });
  assert.deepStrictEqual(await push.send(sub, {}, { sendImpl: async () => { throw Object.assign(new Error('Gone'), { statusCode: 410 }); } }), { gone: true });
  await assert.rejects(push.send(sub, {}, { sendImpl: async () => { throw Object.assign(new Error('Boom'), { statusCode: 500 }); } }));
});

// ---- finding a supplier by itself ------------------------------------------------------------

const sourcing = require('../../src/modules/hunting/hunt-sourcing');

test('auto-sourcing searches with the words that name the product and a bigger copy of the photo', () => {
  assert.strictEqual(sourcing.searchWords('NEW 4FT LED Strip Lights Batten Tube Light Office Workshop Garage - FREE UK Postage'), '4ft led strip lights batten tube light');
  assert.strictEqual(sourcing.searchImage('https://i.ebayimg.com/images/g/abc/s-l225.jpg'), 'https://i.ebayimg.com/images/g/abc/s-l500.jpg');
  assert.strictEqual(sourcing.searchImage(null), null);
});

test('only an AliExpress product that looks like the same thing is checked: most title words, and the same size', () => {
  const listing = '4FT LED Strip Lights Batten Tube Light Office Workshop Garage Ceiling Lamp White';
  assert.strictEqual(sourcing.sameProduct(listing, { title: '4FT 120cm LED Batten Tube Light Ceiling Lamp Garage Workshop Office Strip Lights', via: 'text' }).same, true);
  // Too few of its words: another product (a two-word match was all a listing without variations needed before).
  assert.strictEqual(sourcing.sameProduct(listing, { title: '12V/24V LED Light Strip 6cm 10cm Hard Rigid Tube Bar', via: 'text' }).same, false);
  // A photo match needs fewer words, but a different size is still another product.
  assert.deepStrictEqual(sourcing.sizesIn('4FT 120cm 1.2M 2L').lengths.map(Math.round), [122, 120, 120]);
  assert.strictEqual(sourcing.sameProduct(listing, { title: 'LED Batten Tube Light Garage 60cm Ceiling Workshop', via: 'image' }).why, 'A different size from the eBay listing');
  assert.strictEqual(sourcing.sameProduct(listing, { title: '1.2M LED Tube Bar Fixture Super Bright Ceiling Light Garage', via: 'image' }).same, true);
  // In turn from each search, alike ones only, a text result under 4 stars skipped with why.
  const image = [{ productId: '1', title: '1.2M LED Tube Batten Light Garage Ceiling', via: 'image' }];
  const text = [
    { productId: '2', title: '4FT LED Batten Tube Light Garage Workshop Ceiling Strip Lights', via: 'text', rating: 3.2 },
    { productId: '3', title: '4FT LED Batten Tube Light Garage Workshop Ceiling Strip Lights Office', via: 'text', rating: 4.6 },
    { productId: '4', title: 'Phone case', via: 'text', rating: 4.9 },
  ];
  const { check, skipped } = sourcing.candidatesToCheck({ image, text }, listing);
  assert.deepStrictEqual(check.map((c) => c.productId), ['1', '3']);
  assert.deepStrictEqual(skipped.map((c) => [c.productId, /stars/.test(c.why)]), [['2', true], ['4', false]]);
});

test('a checked supplier will do at 4.0 stars or more, selling what sells, in stock, at the target return; the best has the highest return', () => {
  const result = (over = {}) => ({ targetRoiPercent: 60, mismatch: null, source: { supplier: { rating: 4.5, onSale: true } }, shipping: { basis: 'aliexpress', cost: 0, freeOver: null }, summary: { inStock: 2, headline: { profit: 3, roi: 80 } }, ...over });
  assert.deepStrictEqual(sourcing.judge(result()), { ok: true, why: null, profit: 3, roi: 80 });
  // A listing without variations: judged on a typical option, so a cheap extra can't carry a product.
  const single = result({
    summary: { inStock: 4, bestSeller: { label: null, sold: 305 }, headline: { basis: 'best_option', profit: 9, roi: 300 } },
    options: [
      { label: 'green', stock: 5, profit: 2, roi: 40 },
      { label: 'grey', stock: 5, profit: 2.2, roi: 45 },
      { label: 'blue', stock: 5, profit: 2.1, roi: 42 },
      { label: 'filter sponge 4 pcs', stock: 5, profit: 9, roi: 300 },
    ],
  });
  assert.deepStrictEqual(sourcing.judgedOn(single), { profit: 2.1, roi: 42, basis: 'typical' });
  assert.strictEqual(sourcing.judge(single).why, '42% return, under your 60% target');
  // Under the target but earning: still a match (belowTarget), shown to add by hand; a loss isn't.
  assert.deepStrictEqual(sourcing.judge(single), { ok: false, belowTarget: true, why: '42% return, under your 60% target', profit: 2.1, roi: 42 });
  assert.strictEqual(sourcing.judge(result({ summary: { inStock: 2, headline: { profit: -0.5, roi: -10 } } })).belowTarget, undefined);
  assert.match(sourcing.judge(result({ source: { supplier: { rating: 3.9 } } })).why, /3.9 stars/);
  assert.strictEqual(sourcing.judge(result({ source: { supplier: { rating: 0 } } })).why, 'No rating on AliExpress yet');
  assert.match(sourcing.judge(result({ summary: { inStock: 2, headline: { profit: 1, roi: 40 } } })).why, /40% return, under your 60% target/);
  assert.strictEqual(sourcing.judge(result({ mismatch: { reason: 'Missing Black' } })).why, 'Missing Black');
  assert.strictEqual(sourcing.judge(result({ summary: { inStock: 0, headline: { profit: 3, roi: 80 } } })).why, 'Out of stock');
  // Free postage only: free outright, or free over an amount (AliExpress's Choice offer).
  assert.strictEqual(sourcing.judge(result({ shipping: { basis: 'aliexpress', cost: 1.99, freeOver: 8 } })).ok, true);
  assert.strictEqual(sourcing.judge(result({ shipping: { basis: 'aliexpress', cost: 1.99, freeOver: null } })).why, "Postage isn't free (1.99 a parcel)");
  assert.strictEqual(sourcing.judge(result({ shipping: { basis: 'settings', cost: 2 } })).why, "AliExpress didn't quote postage for it");
  // Judged on some other option while the listing's best seller has no match: not one to pick by itself.
  const unmatched = result({ summary: { inStock: 3, bestSeller: { label: 'Black', sold: 40 }, headline: { basis: 'best_option', profit: 3, roi: 90 } } });
  // (A listing without variations has no best-selling variation to match.)
  assert.strictEqual(sourcing.judge(unmatched).why, "The listing's best seller (Black) isn't among its options");
  assert.strictEqual(sourcing.judge({ ...unmatched, summary: { ...unmatched.summary, headline: { basis: 'best_seller', profit: 3, roi: 90 } } }).ok, true);
  // Only a close match for the best seller (an adapter for a memory card), or a return too good to be the same product: left to a person.
  const close = { ...unmatched, summary: { ...unmatched.summary, bestSeller: { label: '32GB', sold: 40, quality: 'close' }, headline: { basis: 'best_seller', profit: 4.75, roi: 90 } } };
  assert.match(sourcing.judge(close).why, /only a close match/);
  assert.match(sourcing.judge(result({ summary: { inStock: 2, headline: { profit: 4.75, roi: 880 } } })).why, /too cheap to be sure/);
  const a = { verdict: { ok: true }, result: result() };
  const b = { verdict: { ok: true }, result: result({ summary: { inStock: 1, headline: { profit: 2, roi: 120 } } }) };
  assert.strictEqual(sourcing.best([a, b, { verdict: { ok: false }, result: result() }]), b);
  assert.strictEqual(sourcing.best([{ verdict: { ok: false }, result: result() }]), null);
  // Alike on every figure: the photo match, then the one found first.
  const text = { verdict: { ok: true }, result: result(), candidate: { via: 'text' }, order: 0 };
  const photo = { verdict: { ok: true }, result: result(), candidate: { via: 'image' }, order: 1 };
  assert.strictEqual(sourcing.best([text, photo]), photo);
  assert.strictEqual(sourcing.best([{ ...text, order: 2 }, { ...text, order: 1 }]).order, 1);
  // Matches under the target return count only when asked for, the best return first; one at the target still wins.
  const under = (roi) => ({ verdict: { ok: false, belowTarget: true, roi, profit: 1 }, result: result() });
  assert.strictEqual(sourcing.best([under(40)]), null);
  const u50 = under(50);
  assert.strictEqual(sourcing.best([under(40), u50, { verdict: { ok: false }, result: result() }], { belowTarget: true }), u50);
  assert.strictEqual(sourcing.best([under(50), a], { belowTarget: true }), a);
  // All that will do, best first: the photos are compared in this order until one is the same product.
  assert.deepStrictEqual(sourcing.ranked([a, under(90), b, { verdict: { ok: false }, result: result() }]), [b, a]);
  assert.deepStrictEqual(sourcing.ranked([under(40), u50, a], { belowTarget: true }).map((c) => c.verdict.roi ?? 'a'), ['a', 50, 40]);
});
