// The same product elsewhere on the owner's accounts, as warnings. Pure.
//
// A team may list the same product on several accounts, or twice on one:
// nothing here stops that. It says where the product already is (hunted,
// drafted, live from the same supplier product), when the competitor
// listing is one of the owner's own, and which live listings have a very
// similar title (the same product listed from another supplier, or under a
// label without the supplier's number), so nobody finds out after the fact.

const { wordsOf } = require('../research/research-analysis');

// Similar enough to name: most of the shorter title's words (as stems) are
// in the other, at least SIMILAR_WORDS of them, and a fair share of both.
const SIMILAR_AT = 0.6;
const SIMILAR_WORDS = 4;
const SIMILAR_UNION = 0.35;
const SIMILAR_MAX = 3;

const nameOf = (name, email) => name || (email ? String(email).split('@')[0] : null);

function sameOf(supplier, competitor) {
  if (supplier && competitor) return 'both';
  return supplier ? 'supplier' : 'competitor';
}

// One form per word, so "Curlers", "Curler", "Curling" and "Curls" are the
// same word: a light stem (-ing, -er(s), plural -s), never below 3 letters.
function stem(word) {
  let w = String(word).toLowerCase();
  for (const suffix of ['ings', 'ing', 'ers', 'er', 'es', 's']) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3 && !(suffix === 's' && w.endsWith('ss'))) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}
const stemsOf = (title) => new Set(wordsOf(title).map(stem));

/**
 * How alike two titles are, 0–1: the share of the shorter title's words
 * found in the other (0 unless enough words are shared, and enough of both
 * titles, that it isn't one generic word or two).
 */
function titleSimilarity(a, b) {
  const wa = stemsOf(a);
  const wb = stemsOf(b);
  if (wa.size < 3 || wb.size < 3) return 0;
  const shared = [...wa].filter((w) => wb.has(w)).length;
  if (shared < SIMILAR_WORDS || shared / new Set([...wa, ...wb]).size < SIMILAR_UNION) return 0;
  return shared / Math.min(wa.size, wb.size);
}

/**
 * Every match, most certain first: hunted products (`hunts`, repository
 * rows with stage), drafts and Liston listings (`listings`), live listings
 * with the supplier product in their custom label or that ARE the
 * competitor (`live`), then live listings with a similar title
 * (`allLive`). Each { type, account, connectionId, sameAccount, title, … }.
 */
function describe({ hunts = [], listings = [], live = [], allLive = [] }, { productId, itemId, title, titles, connectionId }) {
  // Compared with the competitor's title and the supplier's, the closer counts.
  const against = (titles || [title]).filter(Boolean);
  const out = [];
  for (const h of hunts) {
    out.push({
      type: 'hunt',
      id: h.id,
      connectionId: h.connection_id,
      account: h.connection_label,
      sameAccount: h.connection_id === connectionId,
      title: h.title,
      stage: h.stage,
      by: nameOf(h.hunter_name, h.hunter_email),
      at: h.created_at,
      same: sameOf(h.source_product_id === productId, Boolean(itemId) && h.competitor_item_id === itemId),
    });
  }
  const seen = new Set();
  for (const l of listings) {
    if (l.external_product_id) seen.add(String(l.external_product_id));
    out.push({
      type: l.status === 'published' ? 'listing' : 'draft',
      id: l.id,
      itemId: l.external_product_id || null,
      connectionId: l.connection_id,
      account: l.account,
      sameAccount: l.connection_id === connectionId,
      title: l.title,
      at: l.created_at,
      same: sameOf(Boolean(l.same_supplier), Boolean(l.same_competitor)),
    });
  }
  for (const item of live) {
    if (seen.has(String(item.itemId))) continue;
    seen.add(String(item.itemId));
    const isCompetitor = Boolean(itemId) && String(item.itemId) === String(itemId);
    out.push({
      type: isCompetitor ? 'own_competitor' : 'live',
      itemId: item.itemId,
      connectionId: item.connectionId,
      account: item.account,
      sameAccount: item.connectionId === connectionId,
      title: item.title,
      same: isCompetitor ? 'competitor' : 'supplier',
    });
  }
  const similar = allLive
    .filter((item) => !seen.has(String(item.itemId)))
    .map((item) => ({ item, score: Math.max(0, ...against.map((t) => titleSimilarity(t, item.title))) }))
    .filter((x) => x.score >= SIMILAR_AT)
    .sort((a, b) => b.score - a.score);
  const shown = new Set();
  for (const { item, score } of similar) {
    if (shown.has(String(item.itemId)) || shown.size >= SIMILAR_MAX) continue;
    shown.add(String(item.itemId));
    out.push({ type: 'similar', itemId: item.itemId, connectionId: item.connectionId, account: item.account, sameAccount: item.connectionId === connectionId, title: item.title, similarity: Math.round(score * 100) });
  }
  return out;
}

module.exports = { describe, titleSimilarity, stem, SIMILAR_AT };
