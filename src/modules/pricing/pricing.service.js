// Works out what to charge on eBay so a sale actually clears a target return,
// rather than leaving the seller to guess a multiplier and hope.
//
// THE MATH
//
// Per order, starting from the sell price S:
//   - eBay ads take a percentage of S
//   - order processing (final value fee) takes a percentage of S
//   - a fixed fee is charged per order (£0.30)
//   - the goods themselves cost C (item + shipping)
//
//   profit = S − C − (ads% + processing%) × S − fixed
//   ROI    = profit ÷ C          ← return on what was spent, per the seller
//
// Setting ROI to the target and solving for S:
//
//   S = ( C × (1 + target) + fixed ) ÷ ( 1 − ads% − processing% )
//
// Everything is computed per variant, because a variant's cost can differ
// enormously from its siblings — "1PC" and "4PCS" of the same product are not
// the same purchase.

const DEFAULT_PRICING = {
  targetRoiPercent: 60,
  // eBay Promoted Listings is a bid, typically 12–18%. Defaulting to the top
  // of that range prices defensively: if the real ad rate comes in lower, the
  // seller beats their target rather than missing it.
  adsFeePercent: 18,
  processingFeePercent: 12,
  fixedFeePerOrder: 0.3,
  shippingCostPerOrder: 0,
  currency: 'GBP',
  // eBay shoppers are used to charm pricing, and rounding UP to .99 can only
  // increase the realised ROI above target — never below it.
  roundTo99: true,
  // The target ROI is a FLOOR, not a target to settle on. If the competitor
  // is already selling the same product for more than our floor, that is the
  // market telling us what buyers pay — so follow it and take the wider
  // margin. If they're selling for less, hold the floor rather than chasing
  // them into a price that doesn't clear the target.
  followCompetitorPrice: true,
};

class PricingError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function settingsWithDefaults(pricing = {}) {
  return { ...DEFAULT_PRICING, ...pricing };
}

function roundUpTo99(value) {
  // 4.12 → 4.99, 4.99 → 4.99, 5.01 → 5.99. Always upward, so the target
  // return is met or exceeded, never undershot.
  const whole = Math.floor(value);
  const candidate = whole + 0.99;
  return candidate >= value - 1e-9 ? candidate : whole + 1.99;
}

/**
 * @param itemCost  what the variant costs from the supplier, in the settings currency
 * @param pricing   the connection's pricing settings (partial is fine)
 * @returns { sellPrice, cost, fees, profit, roiPercent, ... } — the full
 *          breakdown, so the review page can show WHY a price is what it is
 *          rather than presenting a bare number.
 */
function priceForCost(itemCost, pricing = {}, { competitorPrice } = {}) {
  const settings = settingsWithDefaults(pricing);
  const cost = Number(itemCost);

  if (!Number.isFinite(cost) || cost <= 0) {
    throw new PricingError('Cannot work out a price without a valid supplier cost.');
  }

  const feeRate = (Number(settings.adsFeePercent) + Number(settings.processingFeePercent)) / 100;
  if (!Number.isFinite(feeRate) || feeRate >= 1) {
    throw new PricingError(
      'Your ads and processing fees add up to 100% or more of the sale price, so no price can be profitable. Lower them in Listing settings.'
    );
  }

  const totalCost = cost + Number(settings.shippingCostPerOrder || 0);
  const target = Number(settings.targetRoiPercent) / 100;
  const fixed = Number(settings.fixedFeePerOrder || 0);

  const exact = (totalCost * (1 + target) + fixed) / (1 - feeRate);
  const floorPrice = settings.roundTo99 ? roundUpTo99(exact) : Math.ceil(exact * 100) / 100;

  // The competitor's price is only ever allowed to push the price UP. Taking
  // the higher of the two means a competitor selling above our floor sets the
  // price (wider margin, and we're not leaving money on the table against a
  // proven market price), while a competitor selling below it is ignored —
  // undercutting into a price that misses the target return is how a
  // dropshipper ends up busy and unprofitable.
  const competitor = Number(competitorPrice);
  const useCompetitor =
    settings.followCompetitorPrice && Number.isFinite(competitor) && competitor > floorPrice;

  const sellPrice = useCompetitor ? competitor : floorPrice;

  // Recomputed from the ROUNDED price — this is what the seller will actually
  // realise, which is the number worth showing, not the target that was aimed at.
  const adsFee = round2(sellPrice * (Number(settings.adsFeePercent) / 100));
  const processingFee = round2(sellPrice * (Number(settings.processingFeePercent) / 100));
  const profit = round2(sellPrice - totalCost - adsFee - processingFee - fixed);

  return {
    sellPrice: round2(sellPrice),
    itemCost: round2(cost),
    shippingCost: round2(Number(settings.shippingCostPerOrder || 0)),
    totalCost: round2(totalCost),
    fees: { ads: adsFee, processing: processingFee, fixed: round2(fixed) },
    // The rates behind the fees, so the editor can re-run this working for a
    // price the seller types without a round trip.
    feeRates: { adsPercent: Number(settings.adsFeePercent), processingPercent: Number(settings.processingFeePercent) },
    profit,
    roiPercent: round2((profit / totalCost) * 100),
    currency: settings.currency,
    targetRoiPercent: Number(settings.targetRoiPercent),
    // Which rule set this price, so the review page can explain it rather
    // than showing a number whose origin isn't obvious.
    basis: useCompetitor ? 'competitor' : 'target-roi',
    floorPrice: round2(floorPrice),
    competitorPrice: Number.isFinite(competitor) ? round2(competitor) : null,
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Supplier "colour" options are often really quantity tiers — "1PC Warm
// White", "4PCS Cold White", "2 Pack". Those cost wildly different amounts,
// so pricing them all from one product-level cost underprices the big packs,
// which is how a seller loses money without noticing. When per-variant costs
// aren't available (the scraper can't read them; the official API can), this
// is what flags it.
const QUANTITY_TIER = /(^|[^a-z0-9])(\d+)\s?(pcs?|pieces?|pack|packs|set|sets|x)\b/i;

function looksLikeQuantityTier(label) {
  return QUANTITY_TIER.test(String(label || ''));
}

function detectQuantityTiers(variantLabels) {
  const matches = variantLabels.filter(looksLikeQuantityTier);
  // One "2 Pack" among otherwise plain colours isn't a tiered set; several
  // means the axis really is quantity.
  return matches.length >= 2;
}

module.exports = {
  DEFAULT_PRICING,
  PricingError,
  priceForCost,
  settingsWithDefaults,
  roundUpTo99,
  looksLikeQuantityTier,
  detectQuantityTiers,
};
