const { soldPerMonth, landedPrice, median, round2, priceBands, typicalPrices } = require('../research/research-stats');
const { lowPriceFor } = require('../research/research-analysis');

// How good a category or keyword is to hunt in, from its leading listings
// (Discover's scan): how fast they sell, how crowded it is, what buyers pay,
// and whether a seller delivering like this account can compete. Pure:
// listings in (the leading ones with their sold counts read), figures and
// an opportunity score out, each part of the score with the figure behind
// it and what earns all of its points.

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const count = (n) => Number(n).toLocaleString('en-GB');

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i];
}

/** Each listing with how many it sells a month (null until its sold count is read). */
function withPace(listings, now = Date.now()) {
  return listings.map((l) => ({ ...l, soldPerMonth: soldPerMonth(l, now), landed: l.price ? landedPrice(l) : null }));
}

/**
 * The figures a category or keyword is judged on.
 *
 * @param listings  the scan's listings (best match first), each with sold
 *                  (null when not read), createdAt, price, shipping,
 *                  seller, location and delivery.compared
 * @param total     every live listing eBay has for it
 * @param country   the site's country (listings from elsewhere are overseas)
 * @param accountKnown whether the account's delivery window is known
 */
function figures(listings, { total, country, accountKnown = true, now = Date.now() }) {
  const all = withPace(listings, now);
  const read = all.filter((l) => l.soldPerMonth !== null);
  const paces = read.map((l) => l.soldPerMonth).sort((a, b) => a - b);
  const selling = read.filter((l) => l.soldPerMonth >= 1);

  const bySeller = new Map();
  for (const l of all) if (l.seller?.username) bySeller.set(l.seller.username, (bySeller.get(l.seller.username) || 0) + 1);
  const topSeller = [...bySeller.entries()].sort((a, b) => b[1] - a[1])[0] || null;

  const prices = all.map((l) => l.landed).filter((p) => p !== null && p > 0).sort((a, b) => a - b);
  // Who's selling: of the listings that sell every month, how many deliver
  // like the account (or slower, so it can match them) and from abroad.
  const known = selling.filter((l) => l.delivery?.compared && l.delivery.compared !== 'unknown');
  const canMatch = known.filter((l) => l.delivery.compared === 'similar' || l.delivery.compared === 'slower');
  const overseas = selling.filter((l) => l.location?.country && country && l.location.country !== country);

  return {
    total,
    sample: all.length,
    demand: {
      read: read.length,
      selling: selling.length,
      // What the leading listings read sell between them a month, and the share that sell at all.
      monthlySales: Math.round(paces.reduce((sum, p) => sum + p, 0) * 10) / 10,
      sellThrough: read.length ? pct(selling.length, read.length) : null,
      medianPerMonth: paces.length ? median(paces) : null,
      topPerMonth: paces.length ? paces[paces.length - 1] : null,
      soldTotal: read.reduce((sum, l) => sum + (l.sold || 0), 0),
    },
    competition: {
      sellers: bySeller.size,
      topSeller: topSeller ? { username: topSeller[0], share: pct(topSeller[1], all.length) } : null,
    },
    price: prices.length ? { low: round2(quantile(prices, 0.25)), median: round2(median(prices)), high: round2(quantile(prices, 0.75)) } : null,
    fit: accountKnown && known.length ? { sellers: known.length, canMatch: canMatch.length, share: pct(canMatch.length, known.length), overseas: pct(overseas.length, selling.length) } : null,
  };
}

/**
 * The opportunity score (0–100) from the figures: demand (40), how many
 * sell (15), competition (20), fit with the account's delivery (15) and
 * price room (10). { score, band: 'strong' | 'fair' | 'weak', parts }.
 */
function opportunity(f, { currency = 'GBP' } = {}) {
  const parts = [];
  const m = f.demand.medianPerMonth;
  parts.push({
    key: 'demand',
    label: 'Demand',
    max: 40,
    points: m === null ? 0 : Math.round(40 * Math.min(1, Math.log10(1 + m) / Math.log10(31))),
    value: m === null ? 'Not read yet' : `${m} a month`,
    full: '30+ a month',
    detail: 'How many the leading listings sell a month, the middle one',
  });
  parts.push({
    key: 'selling',
    label: 'Listings selling',
    max: 15,
    points: f.demand.read ? Math.round((15 * f.demand.selling) / f.demand.read) : 0,
    value: f.demand.read ? `${f.demand.selling} of ${f.demand.read}` : 'Not read yet',
    full: 'every one',
    detail: 'Of the leading listings read, how many sell at least one a month',
  });
  const crowd = f.total <= 500 ? 12 : f.total <= 2000 ? 9 : f.total <= 10000 ? 6 : f.total <= 50000 ? 3 : 1;
  const share = f.competition.topSeller?.share ?? 0;
  const spread = share < 20 ? 8 : share < 35 ? 5 : share < 50 ? 2 : 0;
  parts.push({
    key: 'competition',
    label: 'Competition',
    max: 20,
    points: crowd + spread,
    value: `${count(f.total)} live${f.competition.topSeller ? ` · top seller ${share}%` : ''}`,
    full: 'under 500 live, no seller over 20%',
    detail: 'How many listings compete, and how much the biggest seller holds',
  });
  parts.push({
    key: 'fit',
    label: 'Fits your delivery',
    max: 15,
    // Unknown (no postage policy read, or no seller with dates): half.
    points: f.fit ? Math.round((15 * f.fit.share) / 100) : 7,
    value: f.fit ? `${f.fit.canMatch} of ${f.fit.sellers} sellers` : 'Not known: half points',
    full: 'every seller delivers like you or slower',
    detail: 'Of the listings that sell, how many deliver as fast as you or slower, so you can match them',
  });
  const floor = lowPriceFor(currency);
  const middle = f.price?.median ?? 0;
  parts.push({
    key: 'price',
    label: 'Price room',
    max: 10,
    points: middle >= floor * 3 ? 10 : middle >= floor * 1.5 ? 7 : middle >= floor ? 4 : 1,
    value: f.price ? `${middle.toFixed(2)} ${currency}` : 'No prices',
    full: `${(floor * 3).toFixed(2)} ${currency}+`,
    detail: 'What buyers pay with postage, the middle listing: below this there is little left after fees and the supplier',
  });
  const score = Math.max(0, Math.min(100, parts.reduce((sum, p) => sum + p.points, 0)));
  return { score, band: score >= 65 ? 'strong' : score >= 45 ? 'fair' : 'weak', parts };
}

/**
 * The listings to show under "Selling now": the read ones, fastest first,
 * then the rest in eBay's order. Each keeps its best-selling options first.
 */
function sellingNow(listings, now = Date.now()) {
  const all = withPace(listings, now).map((l) => ({
    ...l,
    options: Array.isArray(l.options) ? [...l.options].sort((a, b) => b.sold - a.sold) : null,
  }));
  const read = all.filter((l) => l.soldPerMonth !== null).sort((a, b) => b.soldPerMonth - a.soldPerMonth || (b.sold || 0) - (a.sold || 0));
  return [...read, ...all.filter((l) => l.soldPerMonth === null)];
}

const DELIVERY = [
  { key: 'faster', label: 'Faster than you' },
  { key: 'similar', label: 'Like you' },
  { key: 'slower', label: 'Slower than you' },
  { key: 'unknown', label: 'Not given' },
];
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Where the sales are, for the subject's charts: by price band (with
 * postage; listings counted from all, sales a month from the ones read),
 * by delivery next to the account's, by where listings ship from, by
 * seller, and the leading listings' sales a month in order (the demand
 * curve). Pure.
 */
function charts(listings, { country, now = Date.now() } = {}) {
  const all = withPace(listings, now);
  const prices = all.map((l) => l.landed).filter((p) => p !== null && p > 0).sort((a, b) => a - b);
  const bands = priceBands(typicalPrices(prices)).map((b) => ({ from: b.from, to: b.to, listings: 0, perMonth: 0 }));
  const bandOf = (price) => bands.find((b) => price >= b.from && (b.to === null || price < b.to)) || (price < (bands[0]?.from ?? 0) ? bands[0] : bands[bands.length - 1]);
  const group = (keyOf) => {
    const map = new Map();
    for (const l of all) {
      const key = keyOf(l);
      if (key === null || key === undefined) continue;
      const g = map.get(key) || { key, listings: 0, perMonth: 0 };
      g.listings += 1;
      g.perMonth += l.soldPerMonth || 0;
      map.set(key, g);
    }
    return map;
  };
  for (const l of all) {
    if (!l.landed || !bands.length) continue;
    const band = bandOf(l.landed);
    band.listings += 1;
    band.perMonth += l.soldPerMonth || 0;
  }
  const delivery = group((l) => l.delivery?.compared || 'unknown');
  const countries = group((l) => l.location?.country || null);
  const sellers = group((l) => l.seller?.username || null);
  const tidy = (g) => ({ ...g, perMonth: round1(g.perMonth) });
  return {
    priceBands: bands.map(tidy),
    delivery: DELIVERY.map((d) => ({ ...tidy(delivery.get(d.key) || { key: d.key, listings: 0, perMonth: 0 }), label: d.label })).filter((d) => d.listings),
    countries: [...countries.values()]
      .map((g) => ({ ...tidy(g), domestic: g.key === country }))
      .sort((a, b) => b.perMonth - a.perMonth || b.listings - a.listings)
      .slice(0, 6),
    sellers: [...sellers.values()]
      .filter((g) => g.perMonth > 0)
      .map(tidy)
      .sort((a, b) => b.perMonth - a.perMonth)
      .slice(0, 6),
    demandCurve: all
      .filter((l) => l.soldPerMonth !== null)
      .sort((a, b) => b.soldPerMonth - a.soldPerMonth)
      .slice(0, 25)
      .map((l) => ({ itemId: String(l.legacyItemId || l.itemId), title: l.title, perMonth: l.soldPerMonth })),
  };
}

const DELIVERY_FIT = { similar: 1, slower: 1, unknown: 0.75, faster: 0.45 };

/**
 * The best products to hunt among the leading listings: the ones that sell
 * every month, weighed by whether a seller delivering like the account can
 * match them and whether the price leaves room after fees. Each with why.
 * Pure: the listings should already be the ones Discover may show.
 * [{ ...listing, bet: { score, reasons: [text] } }], best first.
 */
function bestBets(listings, { currency = 'GBP', limit = 4, now = Date.now() } = {}) {
  const floor = lowPriceFor(currency);
  const scored = withPace(listings, now)
    .filter((l) => l.soldPerMonth !== null && l.soldPerMonth >= 1 && l.landed)
    .map((l) => {
      const compared = l.delivery?.compared || 'unknown';
      const fit = DELIVERY_FIT[compared] ?? 0.75;
      const room = l.landed >= floor * 3 ? 1 : l.landed >= floor * 1.5 ? 0.8 : l.landed >= floor ? 0.5 : 0.2;
      const reasons = [
        `Sells ${l.soldPerMonth >= 100 ? count(Math.round(l.soldPerMonth)) : Math.round(l.soldPerMonth * 10) / 10} a month`,
        compared === 'similar' ? 'Delivers like you' : compared === 'slower' ? 'Slower than you: you can beat it' : compared === 'faster' ? 'Faster than you' : 'Delivery not given',
        room >= 0.8 ? 'Price leaves room after fees' : room >= 0.5 ? 'Price is tight' : 'Little left after fees',
      ];
      return { ...l, bet: { score: Math.round(Math.log10(1 + l.soldPerMonth) * fit * room * 1000) / 1000, reasons } };
    })
    .sort((a, b) => b.bet.score - a.bet.score || b.soldPerMonth - a.soldPerMonth);
  // One per seller, so a strip isn't one shop's range.
  const sellers = new Set();
  const out = [];
  for (const l of scored) {
    const seller = l.seller?.username || l.itemId;
    if (sellers.has(seller)) continue;
    sellers.add(seller);
    out.push(l);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { figures, opportunity, sellingNow, withPace, charts, bestBets };
