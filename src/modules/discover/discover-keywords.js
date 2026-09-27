const { wordsOf } = require('../research/research-analysis');
const { soldPerMonth } = require('../research/research-stats');

// The keywords worth hunting with. Pure.
//
// From a scan: the words and phrases in the titles of the listings that
// sell, each with its share of the sales (by how many each listing sells a
// month) next to its share of the listings — a phrase that carries far more
// of the sales than of the listings is one buyers pick.
//
// From the account's own traffic: which words in its own titles bring
// impressions, clicks (views) and sales, and how well they convert.

const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

function termsOf(title) {
  const words = wordsOf(title);
  const terms = new Set(words);
  for (let i = 0; i < words.length - 1; i += 1) terms.add(`${words[i]} ${words[i + 1]}`);
  for (let i = 0; i < words.length - 2; i += 1) terms.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return terms;
}

/**
 * Keywords from a scan's listings: [{ term, words, listings, selling,
 * listingShare, salesShare, lift, perMonth, sold (eBay's total, the
 * listings read) }], strongest first. Only
 * listings whose sold count was read carry sales; every listing counts for
 * how common a term is. Left out: words of the subject itself (its name or
 * search), words nearly every title has (they don't set a listing apart), a
 * term fewer than three listings use or that one listing's sales carry,
 * and a shorter term inside a longer one with nearly the same sales (the
 * longer phrase says more).
 */
function fromListings(listings, { query = '', limit = 24, now = Date.now() } = {}) {
  // Singular or plural, a word of the subject is the subject's ("light" in Fairy Lights).
  const stem = (w) => w.replace(/(?<=\w{3})s$/, '');
  const inQuery = new Set(wordsOf(query).map(stem));
  const terms = new Map();
  let salesTotal = 0;
  let read = 0;
  listings.forEach((l, index) => {
    const pace = soldPerMonth(l, now) || 0;
    salesTotal += pace;
    if (soldPerMonth(l, now) !== null) read += 1;
    for (const term of termsOf(l.title || '')) {
      const t = terms.get(term) || { listings: 0, selling: 0, sales: 0, sold: 0, top: 0, sellers: new Set() };
      t.listings += 1;
      t.sold += Number(l.sold) || 0;
      if (pace >= 1) {
        t.selling += 1;
        t.sellers.add(index);
      }
      t.sales += pace;
      t.top = Math.max(t.top, pace);
      terms.set(term, t);
    }
  });
  if (!salesTotal || !listings.length) return [];
  // Enough selling listings to call it the market's word, not one seller's.
  const minSelling = read >= 15 ? 3 : 2;
  const ranked = [...terms]
    .map(([term, t]) => {
      const listingShare = pct(t.listings, listings.length);
      const salesShare = pct(t.sales, salesTotal);
      return {
        term,
        words: term.split(' ').length,
        listings: t.listings,
        selling: t.selling,
        listingShare,
        salesShare,
        lift: listingShare ? Math.round((salesShare / listingShare) * 10) / 10 : null,
        perMonth: Math.round(t.sales * 10) / 10,
        sold: t.sold,
        oneListing: t.sales ? t.top / t.sales : 1,
        sellers: t.sellers,
        inQuery: term.split(' ').every((w) => inQuery.has(stem(w))),
      };
    })
    // A lone word earns its place only by selling better than the average title.
    .filter((t) => t.words > 1 || (t.lift ?? 0) >= 1)
    .filter((t) => t.salesShare >= 3 && t.listings >= 3 && t.selling >= minSelling && t.oneListing <= 0.6 && t.listingShare < 60 && !t.inQuery)
    .sort((a, b) => b.salesShare - a.salesShare || b.words - a.words || a.term.localeCompare(b.term));
  // How much a term's words set its listings apart: words in fewer titles
  // ("motion sensor") say more than ones in nearly all ("light plug").
  const wordShare = (w) => (terms.get(w)?.listings || 0) / listings.length;
  const distinct = (t) => t.term.split(' ').reduce((sum, w) => sum + (1 - wordShare(w)), 0) / t.words;
  // A longer phrase with nearly the same sales says more than a word inside
  // it, when what it adds sets listings apart ("fairy string lights" over
  // "string"; not "plug motion sensor" over "motion sensor" when every title
  // says plug).
  const within = (short, long) => {
    if (long.words <= short.words || !` ${long.term} `.includes(` ${short.term} `) || long.salesShare < short.salesShare * 0.85) return false;
    const extra = long.term.split(' ').filter((w) => !short.term.split(' ').includes(w));
    return extra.some((w) => wordShare(w) < 0.6);
  };
  const specific = ranked.filter((t) => !ranked.some((k) => within(t, k)));
  const kept = [];
  for (const t of specific) {
    // The same selling listings under another wording ("rgb colour
    // changing", "colour changing tape"): one is enough, the one that says more.
    const twin = kept.findIndex((k) => overlap(k.sellers, t.sellers) >= 0.8 && Math.abs(k.salesShare - t.salesShare) <= Math.max(3, k.salesShare * 0.15));
    if (twin === -1) kept.push(t);
    else if (distinct(t) > distinct(kept[twin]) + 0.1) kept[twin] = t;
    if (kept.length >= limit) break;
  }
  return kept.map(({ oneListing, inQuery, sellers, ...t }) => t);
}

// How much two sets of listings are the same ones (0–1).
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both += 1;
  return both / Math.min(a.size, b.size);
}

/**
 * Keywords from the account's own listings (the Analytics rows: title,
 * impressions, views, sold): [{ term, words, listings, measured,
 * impressions, views, sold, ctr, conversion }], by sales then views. Sales
 * count every listing (they come from orders); impressions, views, click
 * rate and conversion only the listings eBay measured traffic for. A term
 * needs two listings (one listing's figures are the listing's, not the word's).
 */
function fromTraffic(rows, { limit = 30 } = {}) {
  const terms = new Map();
  for (const r of rows) {
    const measured = r.impressions !== null && r.impressions !== undefined;
    for (const term of termsOf(r.title || '')) {
      const t = terms.get(term) || { listings: 0, measured: 0, impressions: 0, views: 0, sold: 0, measuredSold: 0 };
      t.listings += 1;
      t.sold += Number(r.sold) || 0;
      if (measured) {
        t.measured += 1;
        t.impressions += Number(r.impressions) || 0;
        t.views += Number(r.views) || 0;
        t.measuredSold += Number(r.sold) || 0;
      }
      terms.set(term, t);
    }
  }
  return [...terms]
    .filter(([, t]) => t.listings >= 2 && (t.impressions > 0 || t.sold > 0))
    .map(([term, { measuredSold, ...t }]) => ({
      term,
      words: term.split(' ').length,
      ...t,
      ctr: t.impressions ? Math.round((t.views / t.impressions) * 10000) / 100 : null,
      conversion: t.views ? Math.round((measuredSold / t.views) * 10000) / 100 : null,
    }))
    .sort((a, b) => b.sold - a.sold || b.views - a.views || b.impressions - a.impressions || b.words - a.words)
    .slice(0, limit);
}

/**
 * The account's own traffic and sales on one keyword: its listings whose
 * titles have every word of it (singular or plural), added up — sales from
 * all of them, impressions and views from the measured ones. Null when
 * none of its listings has the keyword.
 */
function trafficFor(rows, keyword) {
  const stem = (w) => w.replace(/(?<=\w{3})s$/, '');
  const wanted = [...new Set(wordsOf(keyword).map(stem))];
  if (!wanted.length) return null;
  const t = { listings: 0, measured: 0, impressions: 0, views: 0, sold: 0, measuredSold: 0 };
  for (const r of rows) {
    const have = new Set(wordsOf(r.title || '').map(stem));
    if (!wanted.every((w) => have.has(w))) continue;
    t.listings += 1;
    t.sold += Number(r.sold) || 0;
    if (r.impressions !== null && r.impressions !== undefined) {
      t.measured += 1;
      t.impressions += Number(r.impressions) || 0;
      t.views += Number(r.views) || 0;
      t.measuredSold += Number(r.sold) || 0;
    }
  }
  if (!t.listings) return null;
  const { measuredSold, ...out } = t;
  return {
    ...out,
    ctr: t.impressions ? Math.round((t.views / t.impressions) * 10000) / 100 : null,
    conversion: t.views ? Math.round((measuredSold / t.views) * 10000) / 100 : null,
  };
}

module.exports = { fromListings, fromTraffic, trafficFor, termsOf };
