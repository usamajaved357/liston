// What a product means to this account and its owner, on top of the market
// reading every Liston account on the site shares. Pure.
//
// - Yours (`ownedOf`): the owner already has it — one of their live eBay
//   listings is among its listings, a listing Liston made came from it, it
//   was hunted (and where that got to), or a live listing has a very similar
//   title. Hunting warns about the same things once a product is added;
//   Discover says it before anyone spends a hunt on it.
// - For you (`personalise`): a few points for a product in a category the
//   account already lists in and at the prices it usually sells at, so two
//   accounts on the same site see the same pool in their own order.
// - Crowded (`personalise`): other Liston sellers hunted it lately — only
//   how many, never who — and it loses a few points, since they may list it
//   too.

const { titleSimilarity, stem, SIMILAR_AT } = require('../hunting/hunt-duplicates');
const { wordsOf } = require('../research/research-analysis');
const { money } = require('./discover-products');

const CATEGORY_POINTS = 5;
const PRICE_POINTS = 3;
const CROWD_FROM = 2; // other sellers hunting it before it counts as crowded
const CROWD_POINTS_EACH = 2;
const CROWD_POINTS_MAX = 10;
const CROWD_DAYS = 14;
const SIMILAR_SHARED = 4; // stems a live title must share before its similarity is worked out

const bandOf = (score) => (score >= 65 ? 'strong' : score >= 45 ? 'fair' : 'weak');

// Where a hunted product got to, in the owner's words.
const HUNT_TEXT = {
  listed: (a) => `Listed on ${a} from a hunt`,
  drafted: (a) => `Drafted on ${a}`,
  approved: (a) => `Hunted and approved on ${a}`,
  pending: (a) => `Hunted on ${a}, waiting for review`,
  sent_back: (a) => `Hunted on ${a}, sent back`,
  rejected: (a) => `Rejected before on ${a}`,
};
// Most certain first: which one a product says when several apply.
const RANK = ['selling', 'listed', 'drafted', 'hunted', 'rejected', 'similar'];

/**
 * The owner's things to match products against, built once: `live` (every
 * account's live eBay listings: { itemId, title, account }), `hunts`
 * ({ itemId: the competitor listing, stage, account }) and `listings`
 * (Liston drafts and listings: { itemId: the competitor listing they came
 * from, status, account }).
 */
function ownedIndex({ live = [], hunts = [], listings = [] } = {}) {
  const byItem = new Map();
  const put = (id, entry) => {
    if (!id) return;
    const key = String(id);
    const had = byItem.get(key);
    if (!had || RANK.indexOf(entry.kind) < RANK.indexOf(had.kind)) byItem.set(key, entry);
  };
  for (const l of live) put(l.itemId, { kind: 'selling', text: `You sell it on ${l.account}`, account: l.account });
  for (const l of listings) put(l.itemId, l.status === 'published' ? { kind: 'listed', text: `Listed on ${l.account}`, account: l.account } : { kind: 'drafted', text: `Drafted on ${l.account}`, account: l.account });
  for (const h of hunts) {
    const kind = h.stage === 'listed' ? 'listed' : h.stage === 'drafted' ? 'drafted' : h.stage === 'rejected' ? 'rejected' : 'hunted';
    put(h.itemId, { kind, text: (HUNT_TEXT[h.stage] || HUNT_TEXT.pending)(h.account), account: h.account });
  }
  // Live titles by their words, so a product is only compared with titles that share enough of them.
  const titles = live.map((l) => ({ title: l.title || '', account: l.account }));
  const byStem = new Map();
  titles.forEach((t, i) => {
    for (const s of new Set(wordsOf(t.title).map(stem))) {
      if (!byStem.has(s)) byStem.set(s, []);
      byStem.get(s).push(i);
    }
  });
  return { byItem, titles, byStem };
}

/** What the owner already has of a product ({ kind, text }), or null. */
function ownedOf(product, index) {
  if (!index) return null;
  let best = null;
  for (const id of product.itemIds || []) {
    const hit = index.byItem.get(String(id));
    if (hit && (!best || RANK.indexOf(hit.kind) < RANK.indexOf(best.kind))) best = hit;
  }
  if (best) return { kind: best.kind, text: best.text };
  const hits = new Map();
  for (const s of new Set(wordsOf(product.name || '').map(stem))) for (const i of index.byStem.get(s) || []) hits.set(i, (hits.get(i) || 0) + 1);
  let similar = null;
  for (const [i, shared] of hits) {
    if (shared < SIMILAR_SHARED) continue;
    const score = titleSimilarity(product.name, index.titles[i].title);
    if (score >= SIMILAR_AT && (!similar || score > similar.score)) similar = { score, account: index.titles[i].account };
  }
  return similar ? { kind: 'similar', text: `Like your listing on ${similar.account}` } : null;
}

/**
 * The account's taste: the categories it lists in (`categoryIds`) and the
 * middle 80% of its live prices (`prices`; five at least, else no band).
 */
function tasteOf({ categoryIds = [], prices = [] } = {}) {
  const sorted = prices.filter((p) => Number(p) > 0).map(Number).sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  return { categories: new Set(categoryIds.map(String)), band: sorted.length >= 5 ? { low: at(0.1), high: at(0.9) } : null };
}

/**
 * A product scored for this account: `taste` (tasteOf) adds points for a
 * category it lists in and its usual prices; `crowd` (other Liston sellers
 * who hunted it lately) takes some away. Says why in its reasons; the
 * market's own score stays in `parts`.
 */
function personalise(product, { taste = null, crowd = 0, currency = 'GBP' } = {}) {
  const reasons = [...product.reasons];
  let forYou = 0;
  if (taste?.categories.has(String(product.categoryId || ''))) {
    forYou += CATEGORY_POINTS;
    reasons.push({ good: true, text: 'In a category you already list in' });
  }
  const mid = product.price?.median;
  if (taste?.band && mid && mid >= taste.band.low && mid <= taste.band.high) {
    forYou += PRICE_POINTS;
    reasons.push({ good: true, text: `At ${money(mid, currency)}, priced like what you already sell` });
  }
  const crowded = crowd >= CROWD_FROM ? Math.min(CROWD_POINTS_MAX, crowd * CROWD_POINTS_EACH) : 0;
  if (crowded) reasons.push({ good: false, text: `Hunted by ${crowd} other Liston sellers in the last ${CROWD_DAYS} days: they may list it too` });
  if (!forYou && !crowded) return { ...product, crowd: 0 };
  const score = Math.max(0, Math.min(100, product.score + forYou - crowded));
  return { ...product, score, band: bandOf(score), parts: { ...product.parts, forYou, crowd: -crowded }, reasons, crowd: crowded ? crowd : 0 };
}

/** How many other sellers hunted each product: `huntsByItem` maps a listing id to the owners who hunted it. */
function crowdOf(product, huntsByItem) {
  const owners = new Set();
  for (const id of product.itemIds || []) for (const o of huntsByItem.get(String(id)) || []) owners.add(o);
  return owners.size;
}

module.exports = { ownedIndex, ownedOf, tasteOf, personalise, crowdOf, CROWD_DAYS };
