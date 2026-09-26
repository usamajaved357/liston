// What a product search means for the seller: the price to sell at, the
// words the selling listings use, what could get a listing taken down, and
// one verdict — list it, list it with care, or leave it. Pure: the search's
// listings (with the sold counts read), its eBay breakdown and the account's
// pricing in, advice out. The AI's reading (brand and safety risk, a title)
// is optional and folds in when it arrives.

const { landedPrice, soldPerMonth, round2 } = require('./research-stats');
const { HAZMAT_TRIGGERS } = require('../listings/policy-words');

// Below this (postage included) a listing rarely clears eBay's fees plus a
// supplier's price: a warning, per currency.
const LOW_PRICE = { GBP: 4, USD: 5, EUR: 4.5, AUD: 8, CAD: 7 };
const lowPriceFor = (currency) => LOW_PRICE[currency] || 4;

// ---- price ---------------------------------------------------------------------

// Weighted percentile: the price below which `p` of the weight sits.
function weightedPercentile(points, p) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const total = sorted.reduce((sum, x) => sum + x.weight, 0);
  let run = 0;
  for (const x of sorted) {
    run += x.weight;
    if (run >= total * p) return x.price;
  }
  return sorted[sorted.length - 1]?.price ?? null;
}

// The charm price at or just under a value: 7.20 → 6.99, 7.60 → 7.49.
function charmBelow(value) {
  if (value < 1.5) return round2(value);
  const whole = Math.floor(value);
  const options = [whole - 0.01, whole + 0.49, whole + 0.99].filter((c) => c <= value + 1e-9);
  return round2(Math.max(...options));
}

/**
 * The price to sell at: a touch under where the SALES happen (the listings'
 * prices weighted by how many each sells a month), kept inside the band most
 * sales sit in. Falls back to the middle of all listings when too few have
 * sold to go on. With the account's pricing settings it also says what the
 * seller keeps after eBay's fees and the most they can pay a supplier for
 * their target return.
 */
function priceAdvice(items, { pricing = {} } = {}) {
  const selling = items
    .map((item) => ({ price: landedPrice(item), weight: soldPerMonth(item) || 0 }))
    .filter((x) => x.price > 0 && x.weight > 0);
  const all = items.map((item) => ({ price: landedPrice(item), weight: 1 })).filter((x) => x.price > 0);
  const basis = selling.length >= 3 ? 'sales' : 'listings';
  const points = basis === 'sales' ? selling : all;
  if (!points.length) return null;

  const low = weightedPercentile(points, 0.25);
  const mid = weightedPercentile(points, 0.5);
  const high = weightedPercentile(points, 0.75);
  // 3% under the sales middle wins the price comparison without starting a
  // race to the bottom; never more than 10% under the band's low end.
  const recommended = Math.max(charmBelow(mid * 0.97), charmBelow(low * 0.9));

  const adsPercent = Number(pricing.adsFeePercent ?? 18);
  const processingPercent = Number(pricing.processingFeePercent ?? 12);
  const fixed = Number(pricing.fixedFeePerOrder ?? 0.3);
  const shipping = Number(pricing.shippingCostPerOrder ?? 0);
  const targetRoiPercent = Number(pricing.targetRoiPercent ?? 60);
  const afterFees = round2(recommended * (1 - (adsPercent + processingPercent) / 100) - fixed);
  const maxCost = round2(afterFees / (1 + targetRoiPercent / 100) - shipping);

  return {
    recommended,
    low: round2(low),
    high: round2(high),
    salesMiddle: round2(mid),
    basis,
    basedOn: points.length,
    // How far to trust it: many selling listings agreeing is strong.
    confidence: basis === 'sales' ? (selling.length >= 8 ? 'high' : 'medium') : 'low',
    afterFees,
    maxCost: maxCost > 0 ? maxCost : 0,
    targetRoiPercent,
    fees: { adsPercent, processingPercent, fixed, shipping },
  };
}

// ---- keywords --------------------------------------------------------------------

const STOP = new Set(
  (
    'a an and or the for with of to in on by at from as is are be it its this that new uk us au free fast post postage ' +
    'delivery shipping ship item items pcs pc x high quality best top great hot sale brand genuine'
  ).split(/\s+/)
);
const wordsOf = (title) =>
  String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));

/**
 * The words and two-word phrases in the titles that sell: each title
 * counts by how many it sells a month (plus one, so a search with few
 * sales still reads its titles). `share` is the % of the weight whose title
 * has the term; terms in the search itself are marked.
 */
function keywordsFrom(items, query = '') {
  const inQuery = new Set(wordsOf(query));
  const words = new Map();
  const phrases = new Map();
  let total = 0;
  for (const item of items) {
    const weight = 1 + (soldPerMonth(item) || 0);
    total += weight;
    const list = wordsOf(item.title);
    for (const w of new Set(list)) words.set(w, (words.get(w) || 0) + weight);
    const pairs = new Set();
    for (let i = 0; i < list.length - 1; i += 1) pairs.add(`${list[i]} ${list[i + 1]}`);
    for (const p of pairs) phrases.set(p, (phrases.get(p) || 0) + weight);
  }
  if (!total) return { words: [], phrases: [] };
  const rank = (map, n, min) =>
    [...map]
      .map(([term, weight]) => ({ term, share: Math.round((weight / total) * 100), inQuery: term.split(' ').every((w) => inQuery.has(w)) }))
      .filter((t) => t.share >= min)
      .sort((a, b) => b.share - a.share || a.term.localeCompare(b.term))
      .slice(0, n);
  return { words: rank(words, 24, 3), phrases: rank(phrases, 12, 5) };
}

// ---- risk --------------------------------------------------------------------------

const HAZMAT = new RegExp(`\\b(${[...HAZMAT_TRIGGERS].sort((a, b) => b.length - a.length).map((w) => w.replace(/[-.]/g, '\\$&')).join('|')})\\b`, 'gi');
function hazmatWords(text) {
  return [...new Set([...String(text || '').matchAll(HAZMAT)].map((m) => m[1].toLowerCase()))];
}

// A Liston draft eBay refused for policy: what kind of refusal it was.
function refusalKind(message) {
  const text = String(message || '');
  if (/VeRO|intellectual property|trademark|counterfeit|replica|copyright|brand/i.test(text)) return 'ip';
  if (/Hazardous|PI_HAZ|improper words/i.test(text)) return 'words';
  return 'policy';
}

// A past title is about this product when most of the search's words are in it.
function aboutProduct(title, query) {
  const want = [...new Set(wordsOf(query))];
  if (!want.length) return false;
  const have = new Set(wordsOf(title));
  const hits = want.filter((w) => have.has(w) || have.has(w.replace(/s$/, '')) || have.has(`${w}s`)).length;
  return hits >= Math.max(1, Math.ceil(want.length * 0.6));
}

/**
 * The takedown risks, each { key, label, level: 'ok' | 'warn' | 'bad' |
 * 'unknown', detail, items? }:
 *  - history: Liston drafts for this product eBay refused on the owner's
 *    accounts (eBay publishes no one's violation history — its Compliance
 *    API closed in March 2026 — so this is the history there is);
 *  - words: eBay's automated hazardous-materials word filter, over the
 *    search and the selling titles;
 *  - brand: how much of the market is branded, and whether the brand is one
 *    that has listings taken down (VeRO), per the AI;
 *  - safety: restricted or regulated product, per the AI.
 */
function riskChecks({ query, items, breakdown, refusals = [], advice = null, sales = null }) {
  const checks = [];

  // Listings eBay removed, from its sales history for the search: they sold
  // in the last 90 days, then eBay deleted them.
  const removed = sales?.available ? (sales.items || []).filter((i) => i.state === 'removed') : [];
  checks.push({
    key: 'removals',
    label: 'Removed by eBay',
    level: !sales?.available || sales.failed ? 'unknown' : removed.length >= 3 ? 'bad' : removed.length ? 'warn' : 'ok',
    detail: !sales?.available
      ? "Needs eBay's sales history (Marketplace Insights), which eBay hasn't granted Liston yet."
      : sales.failed
        ? "eBay's sales history couldn't be read just now."
        : removed.length
          ? `eBay removed ${removed.length} of the ${sales.items.length} listings that sold in the last ${sales.days} days${removed.reduce((n, i) => n + (i.sold || 0), 0) ? ` (they had sold ${removed.reduce((n, i) => n + (i.sold || 0), 0)})` : ''}.`
          : `None of the ${sales.items.length} listings that sold in the last ${sales.days} days has been removed by eBay.`,
  });

  const past = refusals.filter((r) => aboutProduct(r.title, query));
  const ip = past.filter((r) => refusalKind(r.message) === 'ip');
  checks.push({
    key: 'history',
    label: 'Your eBay history',
    level: past.length ? (ip.length ? 'bad' : 'warn') : 'ok',
    detail: past.length
      ? `eBay refused ${past.length} of your Liston draft${past.length === 1 ? '' : 's'} for this product${ip.length ? ', for brand or intellectual-property reasons' : ''}.`
      : 'eBay has not refused any of your Liston drafts for this product.',
    items: past.slice(0, 5).map((r) => ({ title: r.title, account: r.account, at: r.at, reason: String(r.message || '').slice(0, 200), kind: refusalKind(r.message) })),
  });

  const sellingTitles = items.filter((i) => (i.sold || 0) > 0).map((i) => i.title);
  const inQuery = hazmatWords(query);
  const inTitles = hazmatWords(sellingTitles.join(' '));
  checks.push({
    key: 'words',
    label: "eBay's word filter",
    level: inQuery.length ? 'warn' : 'ok',
    detail: inQuery.length
      ? `eBay's hazardous-materials filter blocks listings with ${inQuery.map((w) => `"${w}"`).join(', ')}, whatever the product. Liston writes around them, but check the product isn't genuinely hazardous.`
      : inTitles.length
        ? `The product name is clear. Some selling titles use ${inTitles.slice(0, 4).map((w) => `"${w}"`).join(', ')}, which Liston keeps out of yours.`
        : 'No words that eBay\'s hazardous-materials filter blocks.',
  });

  const brands = breakdown?.brands || [];
  const counted = brands.reduce((sum, b) => sum + b.count, 0);
  const branded = brands.filter((b) => !b.unbranded);
  const brandedShare = counted ? Math.round((branded.reduce((sum, b) => sum + b.count, 0) / counted) * 100) : null;
  const ai = advice?.brandRisk;
  const brandLevel = ai ? (ai.level === 'high' ? 'bad' : ai.level === 'low' ? 'warn' : 'ok') : brandedShare === null ? 'unknown' : brandedShare >= 60 ? 'warn' : 'ok';
  const topBranded = branded.slice(0, 3).map((b) => b.name);
  checks.push({
    key: 'brand',
    label: 'Brand & VeRO',
    level: brandLevel,
    detail: [
      ai?.reason,
      brandedShare !== null ? `${brandedShare}% of listings name a brand${topBranded.length ? ` (${topBranded.join(', ')})` : ''}.` : null,
    ]
      .filter(Boolean)
      .join(' ') || 'Brand not checked yet.',
    brands: ai?.brands?.length ? ai.brands : topBranded,
  });

  const safety = advice?.safetyRisk;
  checks.push({
    key: 'safety',
    label: 'Restricted or regulated',
    level: safety ? (safety.level === 'high' ? 'bad' : safety.level === 'low' ? 'warn' : 'ok') : 'unknown',
    detail: safety?.reason || 'Not checked yet.',
  });

  return checks;
}

// ---- verdict ---------------------------------------------------------------------

/**
 * One call: { status: 'healthy' | 'caution' | 'unhealthy', label, score
 * (0–100), reasons: [{ tone: 'good' | 'warn' | 'bad', text }] }. Demand,
 * how many listings actually sell, competition, price room and where the
 * rivals ship from make the score; a 'bad' risk makes it "Don't list"
 * whatever the score, a 'warn' holds it at "List with care".
 */
function verdict({ summary, price, risks = [], currency }) {
  const reasons = [];
  let score = 0;
  const sold = summary.sold;

  // Demand (35)
  if (!sold) {
    score += 10;
    reasons.push({ tone: 'warn', text: 'Sold counts not read, so demand is unknown.' });
  } else {
    const pm = sold.perMonth;
    const points = pm >= 300 ? 35 : pm >= 100 ? 28 : pm >= 30 ? 18 : pm >= 10 ? 10 : 3;
    score += points;
    reasons.push({
      tone: points >= 28 ? 'good' : points >= 18 ? 'warn' : 'bad',
      text: `The top ${sold.read} listings sell about ${Math.round(pm)} a month${points >= 28 ? ' — steady demand' : points >= 18 ? ' — modest demand' : ' — little demand'}.`,
    });
    // Sell-through (15)
    const ratio = sold.read ? sold.selling / sold.read : 0;
    const st = ratio >= 0.6 ? 15 : ratio >= 0.35 ? 9 : 3;
    score += st;
    if (st < 15) reasons.push({ tone: st >= 9 ? 'warn' : 'bad', text: `Only ${sold.selling} of ${sold.read} leading listings have sold at all.` });
  }

  // Competition (25)
  let comp = 25;
  if (summary.topSellerShare >= 40) {
    comp -= 12;
    reasons.push({ tone: 'bad', text: `One seller has ${summary.topSellerShare}% of the top listings.` });
  } else if (summary.topSellerShare >= 25) {
    comp -= 6;
    reasons.push({ tone: 'warn', text: `The biggest seller has ${summary.topSellerShare}% of the top listings.` });
  }
  if (summary.total > 50000) {
    comp -= 8;
    reasons.push({ tone: 'warn', text: `${summary.total.toLocaleString('en-GB')} live listings — a crowded search; a sharp title and price matter.` });
  } else if (summary.total > 10000) {
    comp -= 4;
  }
  if (summary.sampled && summary.newInLast30Days / summary.sampled > 0.3) {
    comp -= 4;
    reasons.push({ tone: 'warn', text: `${summary.newInLast30Days} of the top ${summary.sampled} went live in the last 30 days — sellers are piling in.` });
  }
  score += Math.max(0, comp);
  if (comp >= 21) reasons.push({ tone: 'good', text: `Competition is spread over ${summary.sellers} sellers.` });

  // Price room (15)
  const middle = summary.price?.median ?? 0;
  const floor = lowPriceFor(currency);
  const room = middle >= floor * 3 ? 15 : middle >= floor * 1.5 ? 11 : middle >= floor ? 7 : 2;
  score += room;
  if (room <= 7) {
    reasons.push({ tone: room <= 2 ? 'bad' : 'warn', text: `Buyers pay about ${middle.toFixed(2)} ${currency} with postage — little left after eBay's fees and the supplier.` });
  } else if (price && price.maxCost > 0) {
    reasons.push({ tone: 'good', text: `Room for margin: at ${price.recommended.toFixed(2)} ${currency} you can pay a supplier up to ${price.maxCost.toFixed(2)} for your ${price.targetRoiPercent}% target.` });
  }

  // Where rivals ship from (10)
  score += summary.domestic >= 70 ? 10 : summary.domestic >= 40 ? 6 : 2;
  if (summary.domestic < 40) reasons.push({ tone: 'warn', text: `${100 - summary.domestic}% ship from overseas — cheap direct-from-China listings set the price.` });

  score = Math.max(0, Math.min(100, Math.round(score)));
  const bad = risks.filter((r) => r.level === 'bad');
  const warn = risks.filter((r) => r.level === 'warn');
  for (const r of bad) reasons.unshift({ tone: 'bad', text: `${r.label}: ${r.detail}` });
  for (const r of warn) reasons.push({ tone: 'warn', text: `${r.label}: ${r.detail}` });

  let status = score >= 65 ? 'healthy' : score >= 40 ? 'caution' : 'unhealthy';
  if (bad.length) status = 'unhealthy';
  // A risk to check, or a price too thin for fees and a supplier, is never
  // an unqualified "go".
  else if ((warn.length || room <= 7) && status === 'healthy') status = 'caution';
  const label = bad.length
    ? "Don't list"
    : { healthy: 'Good to list', caution: 'List with care', unhealthy: 'Not worth listing' }[status];
  return { status, label, score, reasons };
}

module.exports = { priceAdvice, keywordsFrom, riskChecks, verdict, charmBelow, aboutProduct, refusalKind, hazmatWords, wordsOf, lowPriceFor };
