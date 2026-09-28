const { wordsOf, lowPriceFor } = require('../research/research-analysis');
const { soldPerMonth, landedPrice, median, round2, daysLive } = require('../research/research-stats');
const compliance = require('./discover-compliance');

// Products, not listings: what a hunter is after. The same product is sold
// by several sellers under slightly different titles; its real demand is
// all of them together, and how many sellers make a living from it says
// whether it's proven or one shop's fluke. Pure.
//
// A product is judged the way a dropshipper would:
//   - demand: what its listings sell between them a month
//   - proven: how many sellers sell it every month (one is a fluke)
//   - delivery gap: how much of its sales come from sellers delivering like
//     this account or slower — if only next-day UK stock sells it, a
//     dropshipper can't compete
//   - price room: what buyers pay against the floor under which fees and the
//     supplier leave nothing
//   - momentum: rising (selling faster lately than over its life) or new
//     (a listing launched lately already selling)
//   - spread: whether one listing takes nearly all of it
// Anything that would break eBay's rules never gets here (discover-compliance
// hides it first); a filtered word is noted, since it's only wording.

const NEW_DAYS = 90;
const UNBRANDED = /^(unbranded|un-branded|does not apply|n\/a|na|none|no brand|no|generic|unbrand|nobrand|not specified|-)$/i;
const OVERLAP = 0.5;
// Variant tokens ("20m", "5m", "2pcs", "12v") tell listings of one product apart; they're not the product.
const VARIANT = /^\d+(\.\d+)?(m|cm|mm|ml|l|kg|g|w|v|k|pcs|pc|pack|pk|x|ft|inch|in|led|leds|led-|a|ah|mah|hz|gb|tb|mp|p|lm|db|ct|pairs?|pcs)?$/;
const EXTRA_STOP = new Set(['set', 'kit', 'pack', 'bundle', 'lot', 'piece', 'pieces', 'pair', 'style', 'type', 'size', 'colour', 'color', 'colours', 'colors', 'multi', 'various', 'assorted', 'choose', 'choice', 'options']);

/** The words that say what a listing is: its title's words less the subject's, stop words and variant tokens. */
function coreWords(title, subjectWords = new Set()) {
  const stem = (w) => w.replace(/(?<=\w{3})s$/, '');
  return new Set(
    wordsOf(title)
      .map(stem)
      .filter((w) => w.length > 2 && !EXTRA_STOP.has(w) && !VARIANT.test(w) && !subjectWords.has(w))
  );
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both += 1;
  return both / Math.min(a.size, b.size);
}

/**
 * Groups a subject's listings into products, best-selling first: each
 * listing joins the first product whose leading title shares most of its
 * core words. Listings should carry sold (null when unread), createdAt,
 * price, shipping, seller, delivery.compared and, when known, recent.
 * @returns [{ leader, listings }]
 */
function groupProducts(listings, { subject = '', now = Date.now() } = {}) {
  const subjectWords = new Set(wordsOf(subject).map((w) => w.replace(/(?<=\w{3})s$/, '')));
  const ordered = listings
    .map((l) => ({ l, pace: soldPerMonth(l, now), words: coreWords(l.title, subjectWords) }))
    .sort((a, b) => (b.pace ?? -1) - (a.pace ?? -1) || (b.l.sold || 0) - (a.l.sold || 0));
  const groups = [];
  for (const item of ordered) {
    let best = null;
    let bestScore = 0;
    for (const g of groups) {
      const score = overlap(g.words, item.words);
      const shared = [...item.words].filter((w) => g.words.has(w)).length;
      // Half its words in common, and at least three of them (two when a title has few).
      if (score >= OVERLAP && shared >= Math.min(3, Math.min(g.words.size, item.words.size)) && score > bestScore) {
        best = g;
        bestScore = score;
      }
    }
    if (best) best.listings.push(item.l);
    else groups.push({ leader: item.l, words: item.words, listings: [item.l] });
  }
  return groups.map(({ leader, listings: ls }) => ({ leader, listings: ls }));
}

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

/**
 * One product's figures and score for this account. `account` known means
 * delivery is compared. { score, band, reasons: [{ good, text }], ... }.
 */
function describe(group, { currency = 'GBP', accountKnown = true, now = Date.now() } = {}) {
  const idOf = (l) => String(l.legacyItemId || l.itemId);
  const items = group.listings.map((l) => ({ l, pace: soldPerMonth(l, now), landed: l.price ? landedPrice(l) : null, days: daysLive(l, now) }));
  const read = items.filter((x) => x.pace !== null);
  const perMonth = round2(read.reduce((s, x) => s + x.pace, 0));
  const sold = read.reduce((s, x) => s + (x.l.sold || 0), 0);
  const sellers = new Set(items.map((x) => x.l.seller?.username).filter(Boolean));
  const sellingSellers = new Set(read.filter((x) => x.pace >= 1).map((x) => x.l.seller?.username).filter(Boolean));
  const bySeller = new Map();
  for (const x of read) bySeller.set(x.l.seller?.username || idOf(x.l), (bySeller.get(x.l.seller?.username || idOf(x.l)) || 0) + x.pace);
  const leaderShare = perMonth ? pct(Math.max(0, ...bySeller.values()), perMonth) : null;
  const prices = items.map((x) => x.landed).filter((p) => p !== null && p > 0).sort((a, b) => a - b);
  const price = prices.length ? { low: round2(prices[0]), median: round2(median(prices)), high: round2(prices[prices.length - 1]) } : null;

  // Delivery: the sales from sellers delivering like the account or slower.
  const known = read.filter((x) => x.l.delivery?.compared && x.l.delivery.compared !== 'unknown');
  const matchSales = known.filter((x) => x.l.delivery.compared === 'similar' || x.l.delivery.compared === 'slower').reduce((s, x) => s + x.pace, 0);
  const knownSales = known.reduce((s, x) => s + x.pace, 0);
  const delivery = accountKnown && known.length ? { known: true, share: pct(matchSales, knownSales), sellers: known.length, perMonth: round2(matchSales) } : { known: false, share: null, sellers: 0, perMonth: null };

  // Momentum: rising (recent pace against lifetime), or new and already selling.
  const recent = items.filter((x) => x.l.recent && x.l.recent.days >= 2);
  const recentSold = recent.reduce((s, x) => s + x.l.recent.sold, 0);
  const recentDays = recent.length ? Math.max(...recent.map((x) => x.l.recent.days)) : 0;
  const recentPerDay = recentDays ? recentSold / recentDays : null;
  const lifePerDay = recent.length ? recent.reduce((s, x) => s + (x.pace || 0), 0) / 30 : null;
  const lift = recentPerDay !== null && lifePerDay ? Math.round((recentPerDay / lifePerDay) * 10) / 10 : null;
  const rising = lift !== null && lift >= 1.5 && recentSold >= 3;
  const newest = items.filter((x) => x.days !== null && x.pace !== null).sort((a, b) => a.days - b.days)[0] || null;
  const isNew = Boolean(newest && newest.days <= NEW_DAYS && newest.pace >= 10);

  // The score.
  const floor = lowPriceFor(currency);
  const reasons = [];
  const demand = Math.round(35 * Math.min(1, Math.log10(1 + perMonth) / Math.log10(1001)));
  reasons.push({ good: perMonth >= 30, text: read.length ? `${count(perMonth)} sales a month across ${read.length} listing${read.length === 1 ? '' : 's'}` : 'Sold counts not read yet' });
  const n = sellingSellers.size;
  const proven = n >= 3 ? 15 : n === 2 ? 10 : n === 1 ? 5 : 0;
  reasons.push({ good: n >= 2, text: n >= 2 ? `${n} sellers sell it every month: proven` : n === 1 ? "One seller's product: not proven yet" : 'No seller sells it every month' });
  let fit = 10;
  if (delivery.known) {
    fit = Math.round((20 * delivery.share) / 100);
    reasons.push({ good: delivery.share >= 40, text: delivery.share >= 40 ? `${delivery.share}% of its sales come from sellers delivering like you or slower: you can compete` : delivery.share > 0 ? `Only ${delivery.share}% of its sales come from sellers delivering like you or slower` : 'Only faster sellers sell it: hard to compete on delivery' });
  } else reasons.push({ good: null, text: accountKnown ? 'Delivery not given by its sellers' : 'Your delivery isn’t known, so it isn’t compared' });
  const mid = price?.median ?? 0;
  const room = mid >= floor * 3 ? 15 : mid >= floor * 2 ? 12 : mid >= floor * 1.5 ? 8 : mid >= floor ? 4 : 0;
  reasons.push({ good: room >= 8, text: price ? (room >= 12 ? `Sells at ${money(mid, currency)}: room after fees and the supplier` : room >= 8 ? `Sells at ${money(mid, currency)}: some room after fees` : `Sells at ${money(mid, currency)}: little left after fees`) : 'No price' });
  const momentum = rising ? 10 : isNew ? 7 : perMonth >= 1 ? 3 : 0;
  if (rising) reasons.push({ good: true, text: `Rising: selling ${lift}× faster lately than over its life` });
  else if (isNew) reasons.push({ good: true, text: `New: a listing ${newest.days} days old already sells ${count(newest.pace)} a month` });
  const spread = leaderShare === null ? 3 : leaderShare < 60 ? 5 : leaderShare < 80 ? 3 : 0;
  if (leaderShare !== null && leaderShare >= 80 && n >= 2) reasons.push({ good: false, text: `One seller takes ${leaderShare}% of its sales` });
  // Its brand (from the readings' Brand specific): the leading listing's, else any listing's named one.
  const brandOf = (l) => (l.brand && !UNBRANDED.test(l.brand) ? l.brand : null);
  const brandRead = items.some((x) => x.l.brand !== null && x.l.brand !== undefined);
  const brand = brandOf(group.leader) || items.map((x) => brandOf(x.l)).find(Boolean) || null;
  // Sellers: the leading listing's feedback, and the smallest seller that sells it (can a small shop compete?).
  const leaderSeller = group.leader.seller || {};
  const smallest = read
    .filter((x) => x.pace >= 1 && x.l.seller?.feedbackScore !== null && x.l.seller?.feedbackScore !== undefined)
    .map((x) => Number(x.l.seller.feedbackScore))
    .sort((a, b) => a - b)[0];
  const hazmat = compliance.termsIn(group.leader.title).hazmat;
  if (hazmat.length) reasons.push({ good: null, text: `“${hazmat[0]}” trips eBay's word filter: word your title around it` });
  const score = Math.max(0, Math.min(100, demand + proven + fit + room + momentum + spread));

  return {
    key: idOf(group.leader),
    name: group.leader.title,
    image: group.leader.image || null,
    url: group.leader.url || null,
    category: group.leader.category || null,
    categoryId: group.leader.categoryId || null,
    listings: items.length,
    itemIds: items.map((x) => idOf(x.l)),
    read: read.length,
    sellers: sellers.size,
    selling: n,
    perMonth,
    sold,
    price,
    delivery,
    leaderShare,
    momentum: rising ? 'rising' : isNew ? 'new' : perMonth >= 1 ? 'steady' : 'quiet',
    lift,
    newestDays: newest ? newest.days : null,
    recent: recent.length ? { sold: recentSold, days: recentDays } : null,
    score,
    band: score >= 65 ? 'strong' : score >= 45 ? 'fair' : 'weak',
    parts: { demand, proven, fit, room, momentum, spread },
    reasons,
    flag: compliance.flagOf(group.leader.title),
    brand,
    // null until a reading carries the brand specific (older readings don't).
    branded: brandRead ? Boolean(brand) : null,
    seller: { username: leaderSeller.username || null, score: leaderSeller.feedbackScore ?? null, percentage: leaderSeller.feedbackPercentage ?? null },
    smallestSellerScore: smallest ?? null,
  };
}

const count = (n) => (n >= 100 ? Math.round(n).toLocaleString('en-GB') : String(Math.round(n * 10) / 10));
const money = (n, currency) => `${currency === 'GBP' ? '£' : currency === 'USD' || currency === 'AUD' || currency === 'CAD' ? '$' : currency === 'EUR' ? '€' : `${currency} `}${Number(n).toFixed(2)}`;

/**
 * A subject's products, best first: grouped, described and scored.
 * Products with no listing read come last, unscored on demand.
 */
function productsOf(listings, { subject = '', currency = 'GBP', accountKnown = true, now = Date.now(), limit = 12 } = {}) {
  return groupProducts(listings, { subject, now })
    .map((g) => describe(g, { currency, accountKnown, now }))
    .sort((a, b) => b.score - a.score || b.perMonth - a.perMonth)
    .slice(0, limit);
}

module.exports = { groupProducts, describe, productsOf, coreWords, NEW_DAYS, money };
