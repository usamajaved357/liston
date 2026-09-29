const compliance = require('../discover/discover-compliance');
const { titleSimilarity, SIMILAR_AT } = require('../hunting/hunt-duplicates');

// What to know before listing like each live listing in a search, the same
// way Discover judges its products (discover-compliance): a violation (a
// restricted item, or a VeRO brand named as the product), a brand its title
// names, a word eBay's hazardous-materials filter blocks, the owner's own
// history (eBay refused a draft like it, the team rejected one for brand
// risk), and whether eBay removed a listing like it in the last 90 days.
// Pure: titles in, marks out. Research listings carry no Brand specific, so
// brands are read from titles.

/**
 * The names a search's titles are judged against: `vero`, the brands the
 * AI's reading says take listings down (with Liston's own VeRO list,
 * always), and `brands`, every brand on 5% or more of the search's listings.
 */
function brandNamesOf({ advice = null, breakdown = null, total = 0 } = {}) {
  const vero = advice?.brandRisk && advice.brandRisk.level !== 'none' ? (advice.brandRisk.brands || []).filter(Boolean) : [];
  const all = breakdown?.brands || [];
  const counted = all.reduce((sum, b) => sum + (b.count || 0), 0) || total || 1;
  const brands = all.filter((b) => !b.unbranded && (b.count || 0) / counted >= 0.05).map((b) => b.name);
  return { vero, brands };
}

/** The brand a title names (a VeRO one first), or null. */
function brandIn(title, names) {
  return compliance.flagOf(title, [...names.vero, ...names.brands])?.brand || null;
}

/**
 * One listing's marks, or null when there's nothing to say: { violation:
 * { kind: 'restricted' | 'brand', label, prohibited? }, brand, hazmat,
 * risk: { kind, level, text }, removedLike: { title } }.
 */
function marksOf(item, { names, refusals = [], rejected = [], removed = [] }) {
  const title = item.title || '';
  const violation = compliance.violationOf(title, names.vero, item.category || '');
  const flag = compliance.flagOf(title, [...names.vero, ...names.brands]);
  const risk = compliance.productRisk({ brand: null, name: title, itemIds: [item.legacyItemId].filter(Boolean) }, { refusals, rejected });
  const like = removed.find((r) => r.title && titleSimilarity(r.title, title) >= SIMILAR_AT);
  const marks = {
    violation,
    brand: flag?.brand || null,
    hazmat: flag?.hazmat || null,
    risk,
    removedLike: like ? { title: like.title } : null,
  };
  return marks.violation || marks.brand || marks.hazmat || marks.risk || marks.removedLike ? marks : null;
}

/** Every listing marked: the items with `marks` (null when clear). */
function markItems(items, context) {
  return items.map((item) => ({ ...item, marks: marksOf(item, context) }));
}

module.exports = { brandNamesOf, brandIn, marksOf, markItems };
