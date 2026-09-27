// Whether a hunted product is worth listing, option by option. Pure: the
// competitor's eBay listing (optional, as in drafting) and the supplier's
// product (as the sourcing readers return them), the account's pricing and
// fees, and what AliExpress charges to post it, in; the profit check out.
//
// Without a competitor there is no market price: each option is priced as a
// draft would be (supplier price and postage marked up to the account's
// target return, rounded to .99), and the check says so rather than judging
// it against a market it hasn't seen.
//
// Every supplier option is matched to the competitor's variation that sells
// the same thing (Black / M to Black / M, "2PCS" to "2 Pack"), and its
// profit is worked out AT THE COMPETITOR'S PRICE: what buyers already pay
// for it, postage included, less eBay's fees, the supplier's price and the
// supplier's postage. An option with no match is priced at the competitor's
// lowest price, the careful choice. The competitor's best-selling variation
// is found from eBay's sold count per variation, and its match is the
// figure a reviewer judges the product on.

const pricingService = require('../pricing/pricing.service');
const priceParser = require('../pricing/price-parser');
const { soldPerMonth, daysLive } = require('../research/research-stats');
const { hazmatWords, aboutProduct, refusalKind } = require('../research/research-analysis');
const { NO_BRAND } = require('../ebay/browse-research');

const VERSION = 1;
// Options kept on a hunt: a phone case with 160 combinations is still one
// product, and past this the rest are left out of the table.
const MAX_OPTIONS = 300;
const LOW_STOCK = 10;
// Fewer sales a month than this reads as slow.
const SLOW_MONTHLY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;

// ---- matching an option to a variation -------------------------------------------------

// Axes that say where a supplier ships from, not what the product is: never
// matched against the competitor (every warehouse sells the same Black).
const SHIPS_FROM = /ships?\s*from|shipping\s*from|warehouse|dispatch\s*from|origin/i;
const STOP = new Set(['color', 'colour', 'size', 'style', 'type', 'the', 'and', 'with', 'for', 'of', 'a']);
const SIZES = [
  [/^(extra small|x small|xsmall)$/, 'xs'],
  [/^small$/, 's'],
  [/^medium$/, 'm'],
  [/^large$/, 'l'],
  [/^(extra large|x large|xlarge)$/, 'xl'],
  [/^(xx large|xxlarge|2xl|2x large)$/, 'xxl'],
  [/^(xxx large|xxxlarge|3xl|3x large)$/, 'xxxl'],
];

function norm(value) {
  let text = String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/gray/g, 'grey')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [pattern, size] of SIZES) if (pattern.test(text)) text = size;
  return text;
}

const QTY = /(?:^|\s)(\d{1,3})\s?(?:pcs?|pieces?|packs?|pk|pairs?|sets?|x|count|ct|rolls?|units?)(?:\s|$)|(?:pack|set|lot|bundle|box) of (\d{1,3})/;
function quantityOf(value) {
  const match = norm(value).match(QTY);
  return match ? Number(match[1] || match[2]) : null;
}

const tokensOf = (value) => new Set(norm(value).split(' ').filter((t) => t && !STOP.has(t)));

/** How alike two option values are, 0–1: same words 1, same pack size 0.9, one inside the other 0.8. */
function valueScore(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const qa = quantityOf(a);
  const qb = quantityOf(b);
  if (qa !== null && qb !== null) return qa === qb ? 0.9 : 0;
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (!ta.size || !tb.size) return 0;
  const shared = [...ta].filter((t) => tb.has(t)).length;
  if (!shared) return 0;
  if (shared === ta.size || shared === tb.size) return 0.8;
  return shared / new Set([...ta, ...tb]).size >= 0.5 ? 0.6 : 0.3;
}

const productValues = (attributes = {}) =>
  Object.entries(attributes)
    .filter(([name]) => !SHIPS_FROM.test(name))
    .map(([, value]) => value)
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '');

/** How well a supplier option matches a competitor variation, 0–1 (every axis of both counts). */
function optionScore(option, variant) {
  const mine = productValues(option.attributes);
  const theirs = productValues(variant.attributes);
  if (!mine.length || !theirs.length) return 0;
  const total = mine.reduce((sum, value) => sum + Math.max(0, ...theirs.map((other) => valueScore(value, other))), 0);
  return total / Math.max(mine.length, theirs.length);
}

const labelOf = (attributes = {}) => productValues(attributes).join(' / ') || null;

// ---- prices ------------------------------------------------------------------------

const priceIn = (text, currency) => {
  const parsed = priceParser.parsePrice(text, currency);
  return parsed.ok ? parsed.amount : null;
};

/** The competitor's variations as buyers see them: price with postage, sold count. */
function competitorVariations(competitor, currency) {
  const listingPostage = competitor?.postage?.cost ?? 0;
  const variants = competitor?.variants || [];
  if (!variants.length) {
    const price = priceIn(competitor?.priceText, currency);
    return [{ label: null, attributes: {}, price: price === null ? null : round2(price + listingPostage), sold: competitor?.sold ?? null, available: competitor?.available ?? null }];
  }
  return variants.map((v) => {
    const price = priceIn(v.priceText, currency);
    const postage = v.postageCost ?? listingPostage;
    return { label: labelOf(v.attributes), attributes: v.attributes || {}, price: price === null ? null : round2(price + postage), sold: v.sold ?? null, available: v.available ?? null };
  });
}

/** Each supplier option (or the product itself when it has none) with its cost. */
function supplierOptions(source, currency) {
  const productCost = priceIn(source?.priceText, currency);
  const variants = (source?.variants || []).slice(0, MAX_OPTIONS);
  if (!variants.length) {
    return [{ label: null, attributes: {}, imageUrl: (source?.imageUrls || [])[0] || null, cost: productCost, costExact: productCost !== null, stock: source?.stock ?? null, skuId: null }];
  }
  return variants.map((v) => {
    const own = priceIn(v.priceText, currency);
    return {
      label: labelOf(v.attributes) || Object.values(v.attributes || {}).join(' / ') || null,
      attributes: v.attributes || {},
      imageUrl: v.imageUrl || null,
      cost: own ?? productCost,
      costExact: own !== null,
      stock: v.stock ?? null,
      skuId: v.skuId || null,
    };
  });
}

function bestMatch(option, variations) {
  if (variations.length === 1 && !variations[0].label) return { index: 0, score: 1, quality: 'single' };
  let best = null;
  variations.forEach((variation, index) => {
    if (variation.price === null) return;
    const score = optionScore(option, variation);
    if (score < 0.5) return;
    const better =
      !best ||
      score > best.score + 1e-9 ||
      (Math.abs(score - best.score) < 1e-9 && ((variation.sold ?? -1) > (variations[best.index].sold ?? -1) || ((variation.sold ?? -1) === (variations[best.index].sold ?? -1) && variation.price < variations[best.index].price)));
    if (better) best = { index, score };
  });
  if (!best) return null;
  return { ...best, quality: best.score >= 0.95 ? 'exact' : 'close' };
}

// ---- the check ------------------------------------------------------------------------

/**
 * The fee rates to judge with: eBay's actual take on this account's recent
 * orders when there are enough of them (`totals`: { orders, gross, fees,
 * adFees } over `days`), else the account's pricing settings. The fixed
 * per-order fee stays the settings' either way.
 */
const ENOUGH_ORDERS = 20;
function feeRates(pricing, totals = null, days = 90) {
  const settings = pricingService.settingsWithDefaults(pricing);
  const fixed = Number(settings.fixedFeePerOrder || 0);
  const fromSettings = { basis: 'settings', adsPercent: Number(settings.adsFeePercent), processingPercent: Number(settings.processingFeePercent), fixed };
  if (!totals || Number(totals.orders) < ENOUGH_ORDERS || !(Number(totals.gross) > 0)) return { ...fromSettings, orders: totals ? Number(totals.orders) || 0 : 0 };
  const gross = Number(totals.gross);
  const ads = (Number(totals.adFees) / gross) * 100;
  const processing = ((Number(totals.fees) - Number(totals.adFees) - fixed * Number(totals.orders)) / gross) * 100;
  // A figure outside what eBay could plausibly charge means the totals are
  // incomplete (finances still syncing): the settings are safer.
  if (!(processing > 3 && processing < 30) || !(ads >= 0 && ads < 40)) return { ...fromSettings, orders: Number(totals.orders) };
  return { basis: 'orders', adsPercent: round1(ads), processingPercent: round1(processing), fixed, orders: Number(totals.orders), days };
}

/**
 * The option a reviewer judges the product on: the supplier option matching
 * the competitor's best-selling variation (or, for a listing without
 * variations, the option its title or specifics name). Its index into
 * `supplierOptions`, how it was chosen, and the competitor variation.
 */
function bestSellerOption(source, competitor, currency) {
  const options = supplierOptions(source, currency);
  const variations = competitorVariations(competitor, currency);
  if (variations.length > 1 || variations[0]?.label) {
    const top = variations.reduce((best, v, i) => ((v.sold ?? 0) > (variations[best]?.sold ?? 0) ? i : best), -1);
    if (top < 0 || !(variations[top].sold > 0)) return { variation: null, optionIndex: null, quality: null };
    let chosen = null;
    options.forEach((option, index) => {
      const score = optionScore(option, variations[top]);
      if (score >= 0.5 && (!chosen || score > chosen.score || (score === chosen.score && option.stock !== 0 && options[chosen.index].stock === 0))) chosen = { index, score };
    });
    return { variation: { ...variations[top], index: top }, optionIndex: chosen ? chosen.index : null, quality: chosen ? (chosen.score >= 0.95 ? 'exact' : 'close') : null };
  }
  const listing = variations[0] || { label: null, sold: null };
  if (options.length === 1) return { variation: listing, optionIndex: 0, quality: 'single' };
  // The option the competitor's title or specifics name ("… Black"), else none.
  const words = `${competitor?.title || ''} ${Object.values(competitor?.specifics || {}).join(' ')}`;
  let chosen = null;
  options.forEach((option, index) => {
    const values = productValues(option.attributes);
    const score = values.length && values.every((value) => norm(words).includes(norm(value))) ? 1 : 0;
    if (score > 0 && (!chosen || (option.stock !== 0 && options[chosen.index].stock === 0))) chosen = { index, score };
  });
  return { variation: listing, optionIndex: chosen ? chosen.index : null, quality: chosen ? 'close' : null };
}

/** The supplier option to ask AliExpress's postage for (the best seller's, else the first in stock). */
function shippingAnchor(source, competitor, currency) {
  const options = supplierOptions(source, currency);
  const { optionIndex } = bestSellerOption(source, competitor, currency);
  const anchor = optionIndex !== null ? options[optionIndex] : options.find((o) => o.stock !== 0 && o.skuId) || options[0];
  return anchor || null;
}

// What postage costs a sale. AliExpress's free-shipping offers ("free over
// £8", Choice products) count as free: a seller's orders clear them, so the
// fee is only added when the supplier charges postage outright.
const hasFreeOffer = (shipping) => shipping.freeOver !== null && shipping.freeOver !== undefined;
function postageFor(shipping) {
  return hasFreeOffer(shipping) ? 0 : Number(shipping.cost) || 0;
}

function daysUntil(iso, now) {
  if (!iso) return null;
  const end = new Date(iso).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.max(1, Math.ceil((end - now) / DAY_MS));
}

/**
 * The profit check. `pricing`: the account's pricing settings; `fees`: from
 * feeRates; `shipping`: AliExpress's postage for one option ({ cost,
 * freeOver, minDays, maxDays, company }) or null (the settings' flat cost is
 * used); `site`: the account's marketplace; `refusals`: the owner's drafts
 * eBay refused for policy (listing.repository.findPolicyRefusals).
 */
function analyse({ competitor, source, pricing = {}, fees, shipping = null, site, refusals = [], now = Date.now() }) {
  const currency = site.currency;
  const settings = pricingService.settingsWithDefaults({ ...pricing, currency });
  const rates = fees || feeRates(pricing);
  const feeRate = (rates.adsPercent + rates.processingPercent) / 100;
  const target = Number(settings.targetRoiPercent);
  const hasCompetitor = Boolean(competitor);
  const options = supplierOptions(source, currency);
  const variations = competitorVariations(competitor, currency);
  const priced = variations.filter((v) => v.price !== null);
  const lowest = priced.length ? Math.min(...priced.map((v) => v.price)) : null;
  const flatShipping = Number(settings.shippingCostPerOrder || 0);
  const warnings = [];

  const priceRules = { ...settings, adsFeePercent: rates.adsPercent, processingFeePercent: rates.processingPercent, fixedFeePerOrder: rates.fixed };
  const rows = options.map((option) => {
    const match = hasCompetitor ? bestMatch(option, variations) : null;
    const variation = match ? variations[match.index] : null;
    const ship = shipping ? postageFor(shipping) : flatShipping;
    // No competitor: the price a draft would list it at.
    const ownPrice = !hasCompetitor && option.cost > 0 ? pricingService.priceForCost(option.cost, { ...priceRules, shippingCostPerOrder: ship || 0 }).floorPrice : null;
    const sellPrice = hasCompetitor ? variation?.price ?? lowest : ownPrice;
    const matched = variation
      ? { label: variation.label, price: variation.price, sold: variation.sold, quality: match.quality }
      : hasCompetitor && lowest !== null
        ? { label: null, price: lowest, sold: null, quality: 'lowest' }
        : ownPrice !== null
          ? { label: null, price: ownPrice, sold: null, quality: 'target' }
          : null;
    const row = {
      label: option.label,
      attributes: option.attributes,
      imageUrl: option.imageUrl,
      skuId: option.skuId,
      cost: option.cost === null ? null : round2(option.cost),
      costExact: option.costExact,
      stock: option.stock,
      shipping: round2(ship || 0),
      match: matched,
      sellPrice: sellPrice === null || sellPrice === undefined ? null : round2(sellPrice),
      fees: null,
      profit: null,
      roi: null,
      margin: null,
      breakEven: null,
      targetPrice: null,
    };
    if (option.cost === null || !(option.cost > 0) || sellPrice === null || sellPrice === undefined) return row;
    const totalCost = option.cost + (ship || 0);
    const ads = round2(sellPrice * (rates.adsPercent / 100));
    const processing = round2(sellPrice * (rates.processingPercent / 100));
    const profit = round2(sellPrice - totalCost - ads - processing - rates.fixed);
    const quoted = pricingService.priceForCost(option.cost, { ...priceRules, shippingCostPerOrder: ship || 0 }, { competitorPrice: sellPrice });
    return {
      ...row,
      totalCost: round2(totalCost),
      fees: { ads, processing, fixed: round2(rates.fixed), total: round2(ads + processing + rates.fixed) },
      profit,
      roi: round1((profit / totalCost) * 100),
      margin: round1((profit / sellPrice) * 100),
      breakEven: feeRate < 1 ? round2((totalCost + rates.fixed) / (1 - feeRate)) : null,
      // The price a draft would list it at: the target return's floor, or the competitor's price when that's higher.
      targetPrice: quoted.floorPrice,
      yourPrice: quoted.sellPrice,
    };
  });

  if (options.length > 1 && !options.some((o) => o.costExact)) {
    warnings.push(`AliExpress showed one price for every option, so each is costed at ${currency} ${options[0].cost?.toFixed(2) ?? '?'}. Check bigger packs before approving.`);
  }
  if ((source?.variants || []).length > MAX_OPTIONS) warnings.push(`Only the first ${MAX_OPTIONS} of the supplier's ${(source.variants || []).length} options are shown.`);
  if (hasCompetitor && lowest === null) warnings.push("The competitor's price couldn't be read in " + currency + ', so no profit could be worked out.');

  // ---- summary ----
  const inStock = rows.filter((r) => r.stock !== 0);
  const withProfit = inStock.filter((r) => r.profit !== null);
  const pick = hasCompetitor ? bestSellerOption(source, competitor, currency) : { variation: null, optionIndex: null, quality: null };
  const bestSellerRow = pick.optionIndex !== null ? rows[pick.optionIndex] : null;
  const bestRowIndex = withProfit.length ? rows.indexOf(withProfit.reduce((a, b) => (b.profit > a.profit ? b : a))) : null;
  // Without a competitor every option earns about the target by design, so
  // the figure shown is the cheapest option's: the price buyers would see first.
  const entryIndex = withProfit.length ? rows.indexOf(withProfit.reduce((a, b) => (b.sellPrice < a.sellPrice ? b : a))) : null;
  const headline = !hasCompetitor
    ? entryIndex !== null
      ? { basis: 'your_price', optionIndex: entryIndex, profit: rows[entryIndex].profit, roi: rows[entryIndex].roi }
      : { basis: null, optionIndex: null, profit: null, roi: null }
    : bestSellerRow && bestSellerRow.profit !== null
      ? { basis: 'best_seller', optionIndex: pick.optionIndex, profit: bestSellerRow.profit, roi: bestSellerRow.roi }
      : bestRowIndex !== null
        ? { basis: 'best_option', optionIndex: bestRowIndex, profit: rows[bestRowIndex].profit, roi: rows[bestRowIndex].roi }
        : { basis: null, optionIndex: null, profit: null, roi: null };
  const verdict = headline.profit === null ? 'unknown' : !hasCompetitor ? 'unpriced' : headline.roi >= target ? 'strong' : headline.profit > 0 ? 'thin' : 'loss';

  // ---- demand ----
  const sold = competitor?.sold ?? null;
  const demand = {
    sold,
    soldPerMonth: soldPerMonth({ sold, createdAt: competitor?.createdAt }, now),
    daysLive: daysLive({ createdAt: competitor?.createdAt }, now),
    available: competitor?.available ?? null,
    variations: (competitor?.variants || []).length,
    sellingVariations: (competitor?.variants || []).filter((v) => (v.sold || 0) > 0).length,
  };

  const deliveryDays = competitor?.postage?.maxDate ? { min: daysUntil(competitor.postage.minDate, now), max: daysUntil(competitor.postage.maxDate, now) } : null;
  const country = competitor?.location?.country || null;
  const supplierDays = shipping?.maxDays ? { min: shipping.minDays ?? null, max: shipping.maxDays } : source?.supplier?.deliveryDays ? { min: null, max: source.supplier.deliveryDays } : null;

  const result = {
    version: VERSION,
    currency,
    targetRoiPercent: target,
    // Null when the product was checked without a competitor.
    competitor: !hasCompetitor ? null : {
      itemId: competitor?.legacyItemId || null,
      url: competitor?.url || competitor?.sourceUrl || null,
      title: competitor?.title || '',
      // eBay's 300px copy: a thumbnail here, not the 1600px original.
      imageUrl: ((competitor?.referenceImages || [])[0] || '').replace(/\/s-l\d+\.(jpg|jpeg|png|webp)$/i, '/s-l300.$1') || null,
      lowestPrice: lowest,
      postage: competitor?.postage ? { cost: competitor.postage.cost, service: competitor.postage.service, days: deliveryDays } : null,
      seller: competitor?.seller || null,
      country,
      abroad: Boolean(country && site.country && country !== site.country),
      categoryPath: competitor?.categoryBreadcrumb || [],
    },
    source: {
      productId: null,
      url: source?.sourceUrl || null,
      title: source?.title || '',
      imageUrl: (source?.imageUrls || [])[0] || null,
      options: (source?.variants || []).length || 1,
      supplier: source?.supplier || null,
      days: supplierDays,
    },
    shipping: shipping
      ? {
          basis: 'aliexpress',
          // What's counted per sale (free with a free-shipping offer) and what AliExpress quoted.
          counted: postageFor(shipping),
          cost: shipping.cost,
          freeOver: shipping.freeOver ?? null,
          company: shipping.company || null,
          minDays: shipping.minDays ?? null,
          maxDays: shipping.maxDays ?? null,
          tracking: Boolean(shipping.tracking),
        }
      : { basis: 'settings', counted: flatShipping, cost: flatShipping },
    fees: rates,
    demand,
    sales: { variations: salesByVariation(competitor, rows, currency) },
    options: rows,
    summary: {
      entryPrice: entryIndex !== null ? rows[entryIndex].sellPrice : null,
      headline,
      bestSeller: pick.variation
        ? { label: pick.variation.label, price: pick.variation.price, sold: pick.variation.sold, optionIndex: pick.optionIndex, quality: pick.quality }
        : null,
      bestOptionIndex: bestRowIndex,
      total: rows.length,
      inStock: inStock.length,
      profitable: withProfit.filter((r) => r.profit > 0).length,
      belowTarget: withProfit.filter((r) => r.roi < target).length,
      verdict,
    },
    warnings,
    checks: [],
  };
  result.checks = checksFor({ competitor, source, result, refusals, target });
  return result;
}

// ---- risks ------------------------------------------------------------------------------

// Words sellers put in the Brand field that name no brand.
const NOT_A_BRAND = /^(branded|other|oem|generic brand|no brand name|brand new|new)$/i;
const brandOf = (specifics = {}) => {
  const key = Object.keys(specifics).find((k) => /^(brand|brand name|marke|marque|marca)$/i.test(k.trim()));
  const value = key ? String(specifics[key] || '').trim() : '';
  return value && !NO_BRAND.test(value) && !NOT_A_BRAND.test(value) ? value : null;
};

/**
 * What could stop it selling or get it taken down, each { key, label,
 * level: 'ok' | 'warn' | 'bad' | 'unknown', detail }. None of these calls
 * anything: the brand the listings name, eBay's hazardous-word filter, the
 * owner's own refused drafts, stock, delivery and the supplier's record.
 */
function checksFor({ competitor, source, result, refusals = [], target }) {
  const checks = [];
  const brand = brandOf(competitor?.specifics) || brandOf(source?.specifics);
  checks.push({
    key: 'brand',
    label: 'Brand & VeRO',
    level: brand ? 'warn' : 'ok',
    detail: brand
      ? `Listed under the brand "${brand}". Make sure it isn't VeRO-protected, or that the product really is generic before listing it as Unbranded.`
      : 'Unbranded on both listings.',
  });

  const words = hazmatWords(`${competitor?.title || ''} ${source?.title || ''}`);
  checks.push({
    key: 'words',
    label: "eBay's word filter",
    level: words.length ? 'warn' : 'ok',
    detail: words.length
      ? `The titles use ${words.slice(0, 4).map((w) => `"${w}"`).join(', ')}, which eBay's hazardous-materials filter blocks. Liston writes around them; check the product isn't hazardous.`
      : "No words eBay's hazardous-materials filter blocks.",
  });

  const past = refusals.filter((r) => aboutProduct(r.title, competitor?.title || source?.title || ''));
  const ip = past.filter((r) => refusalKind(r.message) === 'ip');
  checks.push({
    key: 'history',
    label: 'Your eBay history',
    level: past.length ? (ip.length ? 'bad' : 'warn') : 'ok',
    detail: past.length
      ? `eBay refused ${past.length} of your drafts for a product like this${ip.length ? ', for brand or intellectual-property reasons' : ''}.`
      : 'eBay has not refused any of your drafts for a product like this.',
  });

  // How fast the competitor sells it: none in a month is a product nobody
  // buys, whatever it would earn.
  const demand = result.demand;
  const perMonth = demand.soldPerMonth;
  checks.push({
    key: 'demand',
    label: 'Demand',
    level: demand.sold === null ? 'unknown' : perMonth >= SLOW_MONTHLY ? 'ok' : demand.sold === 0 && (demand.daysLive ?? 0) >= 30 ? 'bad' : 'warn',
    detail: !result.competitor
      ? 'No competitor listing to judge demand from. Add one to see how many sell.'
      : demand.sold === null
        ? "eBay doesn't show how many the competitor has sold."
        : demand.sold === 0
          ? `The competitor hasn't sold any${demand.daysLive !== null ? ` in ${demand.daysLive} days` : ''}.`
          : perMonth >= SLOW_MONTHLY
            ? `The competitor sells about ${perMonth} a month (${demand.sold} in all).`
            : `Slow: about ${perMonth} a month (${demand.sold} in all).`,
  });

  const rows = result.options;
  const known = rows.filter((r) => r.stock !== null && r.stock !== undefined);
  const out = known.filter((r) => r.stock === 0);
  const low = known.filter((r) => r.stock > 0 && r.stock < LOW_STOCK);
  const head = result.summary.headline.optionIndex !== null ? rows[result.summary.headline.optionIndex] : null;
  checks.push({
    key: 'stock',
    label: 'Supplier stock',
    level: !known.length ? 'unknown' : out.length === rows.length || (head && head.stock === 0) ? 'bad' : out.length || low.length ? 'warn' : 'ok',
    detail: !known.length
      ? "AliExpress didn't say how many it has."
      : out.length === rows.length
        ? 'Every option is out of stock at the supplier.'
        : [
            out.length ? `${out.length} of ${rows.length} option${rows.length === 1 ? '' : 's'} out of stock` : null,
            low.length ? `${low.length} with fewer than ${LOW_STOCK} left` : null,
          ]
            .filter(Boolean)
            .join(', ')
            .replace(/^./, (c) => c.toUpperCase()) ||
          `Every option in stock (the lowest has ${Math.min(...known.map((r) => r.stock))}).`,
  });

  const theirs = result.competitor?.postage?.days?.max ?? null;
  const ours = result.source.days?.max ?? null;
  checks.push({
    key: 'delivery',
    label: 'Delivery time',
    level: theirs === null || ours === null ? 'unknown' : ours > theirs + 3 ? 'warn' : 'ok',
    detail:
      !result.competitor
        ? ours === null
          ? 'No competitor to compare delivery with.'
          : `The supplier delivers in up to ${ours} days. There's no competitor to compare with.`
        : theirs === null || ours === null
          ? 'Delivery times could not be compared.'
        : ours > theirs + 3
          ? `Buyers get the competitor's within about ${theirs} days; the supplier takes up to ${ours}. Slower delivery sells less.`
          : `The supplier delivers in up to ${ours} days, close to the competitor's ${theirs}.`,
  });

  const s = source?.supplier;
  checks.push({
    key: 'supplier',
    label: 'Supplier record',
    level: !s ? 'unknown' : s.onSale === false ? 'bad' : (s.rating !== null && s.rating < 4.5) || (s.reviews !== null && s.reviews < 5) ? 'warn' : 'ok',
    detail: !s
      ? "AliExpress didn't give the product's record."
      : s.onSale === false
        ? 'The product is no longer on sale at AliExpress.'
        : [s.rating !== null ? `Rated ${s.rating}` : null, s.reviews !== null ? `${s.reviews} review${s.reviews === 1 ? '' : 's'}` : null, s.orders ? `${s.orders} orders` : null].filter(Boolean).join(' · ') ||
          'No rating yet.',
  });

  const thin = Boolean(result.competitor) && result.summary.headline.roi !== null && result.summary.headline.roi < target;
  if (thin) {
    checks.push({
      key: 'margin',
      label: 'Return',
      level: result.summary.headline.profit > 0 ? 'warn' : 'bad',
      detail: result.summary.headline.profit > 0 ? `Below your ${target}% target return at the competitor's price.` : "Loses money at the competitor's price.",
    });
  }
  return checks;
}

// ---- sales by variation ------------------------------------------------------------------

/**
 * The competitor's sales split by variation (eBay's sold count for each,
 * lifetime), most sold first: [{ label, sold, share (% of all sold), price,
 * available, supplier: [the supplier options matched to it] }]. A listing
 * without variations is one row. Empty without a competitor.
 */
function salesByVariation(competitor, rows, currency) {
  if (!competitor) return [];
  const variations = competitorVariations(competitor, currency);
  const total = variations.reduce((sum, v) => sum + (v.sold || 0), 0);
  return variations
    .map((v) => ({
      label: v.label,
      sold: v.sold,
      share: total && v.sold !== null ? Math.round((v.sold / total) * 1000) / 10 : null,
      price: v.price,
      available: v.available ?? null,
      supplier: (rows || [])
        .filter((r) => r.match && (r.match.quality === 'exact' || r.match.quality === 'close' || r.match.quality === 'single') && r.match.label === v.label)
        .map((r) => r.label || 'The product')
        .slice(0, 4),
    }))
    .sort((a, b) => (b.sold ?? -1) - (a.sold ?? -1));
}

/** A reading of the competitor's sold counts, to keep: { sold, available, variations }. */
function salesReading(competitor, currency) {
  if (!competitor) return null;
  return {
    sold: competitor.sold ?? null,
    available: competitor.available ?? null,
    variations: competitorVariations(competitor, currency).map((v) => ({ label: v.label, sold: v.sold, available: v.available ?? null, price: v.price })),
  };
}

// ---- drafting from a hunt ----------------------------------------------------------------

const optionKey = (attributes = {}) =>
  Object.entries(attributes)
    .map(([n, v]) => `${norm(n)}=${norm(v)}`)
    .sort()
    .join('|');

/**
 * What the supplier charges now against what the hunt was judged on, per
 * option: [{ label, before, after }], biggest change first (only options
 * whose price moved by a penny or more).
 */
function priceChanges(rows, freshSource, currency) {
  const now = new Map(supplierOptions(freshSource, currency).map((o) => [optionKey(o.attributes), o.cost]));
  const changes = [];
  for (const row of rows || []) {
    const after = now.get(optionKey(row.attributes));
    if (after === undefined || after === null || row.cost === null) continue;
    if (Math.abs(after - row.cost) >= 0.01) changes.push({ label: row.label, before: row.cost, after: round2(after) });
  }
  return changes.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
}

/**
 * The options to start a draft with: on each axis of the draft screen,
 * the values some profitable, in-stock option has. An axis where every
 * value earns (or none does) is left as it is. { axisName: [values] } or
 * null when there's nothing to leave out.
 */
function draftSelection(rows, axes) {
  const earning = (rows || []).filter((r) => r.profit !== null && r.profit > 0 && r.stock !== 0);
  if (!earning.length) return null;
  const selection = {};
  for (const axis of axes || []) {
    const values = (axis.values || []).map((v) => (typeof v === 'string' ? v : v.value));
    const keep = values.filter((value) => earning.some((r) => r.attributes?.[axis.name] === value));
    if (keep.length && keep.length < values.length) selection[axis.name] = keep;
  }
  return Object.keys(selection).length ? selection : null;
}

/** A short line for lists: "Black / M" or "The listing". */
function optionLabel(row) {
  return row?.label || 'The product';
}

module.exports = { analyse, feeRates, priceChanges, draftSelection, salesByVariation, salesReading, shippingAnchor, bestSellerOption, supplierOptions, competitorVariations, optionScore, valueScore, quantityOf, norm, optionLabel, VERSION, MAX_OPTIONS, ENOUGH_ORDERS };
