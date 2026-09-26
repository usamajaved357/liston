// The same product elsewhere on the owner's accounts, as warnings. Pure.
//
// A team may list the same product on several accounts, or twice on one:
// nothing here stops that. It says where the product already is (hunted,
// drafted, live from the same supplier product), when the competitor
// listing is one of the owner's own, and which live listings have a very
// similar title, so nobody finds out after the fact.

const { wordsOf } = require('../research/research-analysis');

const SIMILAR_AT = 0.55;
const SIMILAR_MAX = 3;

const nameOf = (name, email) => name || (email ? String(email).split('@')[0] : null);

function sameOf(supplier, competitor) {
  if (supplier && competitor) return 'both';
  return supplier ? 'supplier' : 'competitor';
}

/** How alike two titles are: shared words over all words (0–1). */
function titleSimilarity(a, b) {
  const wa = new Set(wordsOf(a));
  const wb = new Set(wordsOf(b));
  if (wa.size < 3 || wb.size < 3) return 0;
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / new Set([...wa, ...wb]).size;
}

/**
 * Every match, most certain first: hunted products (`hunts`, repository
 * rows with stage), drafts and Liston listings (`listings`), live listings
 * with the supplier product in their custom label or that ARE the
 * competitor (`live`), then live listings with a similar title
 * (`allLive`). Each { type, account, connectionId, sameAccount, title, … }.
 */
function describe({ hunts = [], listings = [], live = [], allLive = [] }, { productId, itemId, title, connectionId }) {
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
      same: sameOf(h.source_product_id === productId, h.competitor_item_id === itemId),
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
    const isCompetitor = String(item.itemId) === String(itemId);
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
    .map((item) => ({ item, score: titleSimilarity(title, item.title) }))
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

module.exports = { describe, titleSimilarity, SIMILAR_AT };
