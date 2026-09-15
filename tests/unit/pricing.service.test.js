const test = require('node:test');
const assert = require('node:assert');

const pricing = require('../../src/modules/pricing/pricing.service');
const { parsePrice, detectCurrency } = require('../../src/modules/pricing/price-parser');

// The seller's stated rule: 60%+ ROI after eBay ads (12–18%), order
// processing (~12%) and £0.30 per order. ROI means profit ÷ cost.

test('priceForCost hits the target ROI exactly when rounding is off', () => {
  const result = pricing.priceForCost(2.0, { roundTo99: false });

  // (2.00 × 1.6 + 0.30) ÷ (1 − 0.30) = 5.00
  assert.strictEqual(result.sellPrice, 5);
  assert.strictEqual(result.roiPercent, 60);
});

test('priceForCost never lands BELOW target once rounded to .99', () => {
  // Rounding is upward only, so the realised return can exceed the target
  // but must never undershoot it.
  for (const cost of [0.5, 0.99, 2, 3.75, 5, 12.5, 40]) {
    const result = pricing.priceForCost(cost, {});
    assert.ok(
      result.roiPercent >= 60,
      `cost ${cost} produced ${result.roiPercent}% ROI, below the 60% target`
    );
    assert.ok(String(result.sellPrice).endsWith('.99'), `cost ${cost} produced ${result.sellPrice}`);
  }
});

test('priceForCost breakdown reconciles exactly', () => {
  const r = pricing.priceForCost(5, {});
  const reconstructed = r.sellPrice - r.totalCost - r.fees.ads - r.fees.processing - r.fees.fixed;
  assert.ok(Math.abs(reconstructed - r.profit) < 0.011, 'profit must equal price minus cost and every fee');
});

test('priceForCost adds shipping to the cost base before working out the return', () => {
  const without = pricing.priceForCost(2, { roundTo99: false });
  const withShipping = pricing.priceForCost(2, { shippingCostPerOrder: 1.5, roundTo99: false });

  assert.ok(withShipping.sellPrice > without.sellPrice);
  assert.strictEqual(withShipping.totalCost, 3.5);
  assert.strictEqual(withShipping.roiPercent, 60);
});

test('priceForCost respects a lower ads rate by charging less for the same return', () => {
  const highAds = pricing.priceForCost(5, { adsFeePercent: 18, roundTo99: false });
  const lowAds = pricing.priceForCost(5, { adsFeePercent: 12, roundTo99: false });

  assert.ok(lowAds.sellPrice < highAds.sellPrice);
  // Rounding to the penny is also upward, so the realised return sits just
  // above target rather than exactly on it.
  assert.ok(lowAds.roiPercent >= 60 && lowAds.roiPercent < 61);
});

test('priceForCost refuses when fees would consume the entire sale price', () => {
  assert.throws(
    () => pricing.priceForCost(5, { adsFeePercent: 60, processingFeePercent: 45 }),
    (err) => err instanceof pricing.PricingError && /100%/.test(err.message)
  );
});

test('priceForCost refuses an unusable cost rather than inventing a price', () => {
  assert.throws(() => pricing.priceForCost(0, {}), pricing.PricingError);
  assert.throws(() => pricing.priceForCost(null, {}), pricing.PricingError);
  assert.throws(() => pricing.priceForCost('abc', {}), pricing.PricingError);
});

test('roundUpTo99 always rounds upward', () => {
  assert.strictEqual(pricing.roundUpTo99(4.12), 4.99);
  assert.strictEqual(pricing.roundUpTo99(4.99), 4.99);
  assert.strictEqual(pricing.roundUpTo99(5.0), 5.99);
  assert.strictEqual(pricing.roundUpTo99(5.5), 5.99);
});

// Quantity-tier detection is what stands between the seller and a 4-pack
// priced like a single unit, whenever per-variant costs aren't available.

test('detectQuantityTiers spots pack-size options', () => {
  assert.strictEqual(
    pricing.detectQuantityTiers(['1PC Warm White', '2PCS Warm White', '4PCS Cold White']),
    true
  );
  assert.strictEqual(pricing.detectQuantityTiers(['2 Pack', '4 Pack']), true);
});

test('detectQuantityTiers leaves ordinary colour and size options alone', () => {
  assert.strictEqual(pricing.detectQuantityTiers(['Black', 'Red', 'Blue']), false);
  assert.strictEqual(pricing.detectQuantityTiers(['Small', 'Medium', 'Large']), false);
});

test('detectQuantityTiers needs more than one tier to call it a quantity axis', () => {
  // A lone "2 Pack" beside plain colours isn't a tiered set.
  assert.strictEqual(pricing.detectQuantityTiers(['Black', 'Red', '2 Pack']), false);
});

// --- price parsing ---------------------------------------------------------

test('parsePrice accepts the currency it was asked for, including fullwidth symbols', () => {
  // AliExpress renders GBP with a fullwidth ￡, not the ASCII £.
  assert.deepStrictEqual(parsePrice('￡0.99', 'GBP').amount, 0.99);
  assert.deepStrictEqual(parsePrice('£12.50', 'GBP').amount, 12.5);
  assert.deepStrictEqual(parsePrice('GBP 5.00', 'GBP').amount, 5);
});

test('parsePrice REFUSES a price quoted in another currency', () => {
  // The live failure this exists for: the server's location made AliExpress
  // quote "Rs.849" for a £0.99 product. Read as GBP that is ~350x wrong, so
  // it is refused rather than converted with an assumed rate.
  const result = parsePrice('Rs.849', 'GBP');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'wrong-currency');
  assert.strictEqual(result.currency, 'PKR');
});

test('parsePrice refuses a price whose currency cannot be identified', () => {
  const result = parsePrice('849', 'GBP');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'unknown-currency');
});

test('parsePrice takes the low end of a range and flags that it was one', () => {
  const result = parsePrice('£1.99 - £4.99', 'GBP');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.amount, 1.99);
  assert.strictEqual(result.isRange, true);
});

test('parsePrice handles European grouping without misreading the amount', () => {
  assert.strictEqual(parsePrice('€1.234,56', 'EUR').amount, 1234.56);
  assert.strictEqual(parsePrice('£1,234.56', 'GBP').amount, 1234.56);
});

test('detectCurrency recognises the symbols suppliers actually render', () => {
  assert.strictEqual(detectCurrency('￡0.99'), 'GBP');
  assert.strictEqual(detectCurrency('US $1.20'), 'USD');
  assert.strictEqual(detectCurrency('Rs.849'), 'PKR');
  assert.strictEqual(detectCurrency('849'), null);
});

// --- competitor-aware pricing ---------------------------------------------
// The seller's rule: the target ROI is a FLOOR. If the competitor already
// sells above it, follow their price and take the wider margin; if they sell
// below it, hold the floor rather than undercutting into a weak return.

test('priceForCost matches the competitor when they sell above our floor', () => {
  const result = pricing.priceForCost(1.47, {}, { competitorPrice: 8.99 });

  assert.strictEqual(result.sellPrice, 8.99);
  assert.strictEqual(result.basis, 'competitor');
  assert.strictEqual(result.floorPrice, 3.99);
  assert.ok(result.roiPercent > 60);
});

test('priceForCost ignores a competitor selling below our floor', () => {
  const result = pricing.priceForCost(1.47, {}, { competitorPrice: 2.5 });

  // Undercutting into a price that misses the target return is exactly what
  // this rule exists to prevent.
  assert.strictEqual(result.sellPrice, 3.99);
  assert.strictEqual(result.basis, 'target-roi');
  assert.ok(result.roiPercent >= 60);
});

test('priceForCost holds the floor when the competitor matches it exactly', () => {
  const result = pricing.priceForCost(1.47, {}, { competitorPrice: 3.99 });
  assert.strictEqual(result.sellPrice, 3.99);
  assert.strictEqual(result.basis, 'target-roi');
});

test('priceForCost recomputes fees and profit from the competitor price, not the floor', () => {
  const result = pricing.priceForCost(1.47, {}, { competitorPrice: 8.99 });
  const reconstructed = result.sellPrice - result.totalCost - result.fees.ads - result.fees.processing - result.fees.fixed;

  assert.ok(Math.abs(reconstructed - result.profit) < 0.011);
  // Fees scale with the higher price, so they must exceed the floor's fees.
  assert.ok(result.fees.ads > 3.99 * 0.18 - 0.01);
});

test('priceForCost ignores the competitor entirely when the seller turns it off', () => {
  const result = pricing.priceForCost(1.47, { followCompetitorPrice: false }, { competitorPrice: 14.99 });
  assert.strictEqual(result.sellPrice, 3.99);
  assert.strictEqual(result.basis, 'target-roi');
});

test('priceForCost falls back to the floor when no competitor price is known', () => {
  for (const missing of [null, undefined, NaN]) {
    const result = pricing.priceForCost(1.47, {}, { competitorPrice: missing });
    assert.strictEqual(result.sellPrice, 3.99);
    assert.strictEqual(result.basis, 'target-roi');
  }
});
