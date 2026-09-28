// Finding a supplier for an eBay listing by itself, from Discover's Hunt.
// Pure: the words to search AliExpress with, which of the products found to
// check, and whether a checked one will do.
//
// Only products that look like the same thing are checked: most of the
// listing's title words in theirs, and the same size where both give one
// (a listing without variations is otherwise matched on two shared words,
// far too loose to pick a supplier by itself).
//
// A supplier will do when its product is rated 4.0 stars or more on
// AliExpress, it sells what the eBay listing sells (hunt-profit.matchCheck:
// every variation that has sold), something is in stock, and it earns the
// account's target return (Settings → Pricing) at the competitor's price,
// judged on the listing's best-selling variation where it has one, and it
// posts for free (or free over an amount, AliExpress's Choice offer).
// The best of those is the one with the highest return.

const MIN_RATING = 4.0;
// A return past this is more likely another product (an accessory, a fake) than a bargain: left to a person.
const MAX_ROI = 400;
const CHECK_MAX = 8; // products checked in full (an AliExpress read each)
const LEAD_WORDS = 10; // an eBay title says what the product is first; the rest is keywords

// Words that say nothing about what the product is.
const NOISE = new Set([
  'new', 'uk', 'free', 'fast', 'post', 'postage', 'delivery', 'dispatch', 'seller', 'stock', 'sale', 'hot', 'best', 'quality', 'premium', 'genuine',
  'brand', 'latest', 'top', 'item', 'items', 'pack', 'set', 'with', 'for', 'and', 'the', 'of', 'in', 'to', 'a', 'an', 'x', 'pcs', 'pc',
]);

/** Up to seven words of an eBay title that name the product, for AliExpress's text search. */
function searchWords(title, max = 7) {
  const words = String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !NOISE.has(w) && !/^\d{1,2}$/.test(w));
  return [...new Set(words)].slice(0, max).join(' ');
}

/** eBay's photo at a size worth searching with (its thumbnails are 225px). */
function searchImage(url) {
  return url ? String(url).replace(/\/s-l\d+\.(jpg|jpeg|png|webp)(\?.*)?$/i, '/s-l500.$1') : null;
}

// ---- is it the same product? -----------------------------------------------------------

const stem = (w) => w.replace(/(?<=\w{3})(es|s)$/, '');
const wordSet = (title) => new Set(searchWords(title, 30).split(' ').filter(Boolean).map(stem));

// Lengths and volumes in a title, in cm and ml: "4ft" 122, "120cm" 120, "1.2m" 120, "2L" 2000.
const SIZE = /(\d+(?:\.\d+)?)\s?(ft|feet|foot|cm|mm|m|inch|inches|in|l|litre|liter|ml)\b/gi;
function sizesIn(title) {
  const lengths = [];
  const volumes = [];
  for (const m of String(title || '').matchAll(SIZE)) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (['ft', 'feet', 'foot'].includes(unit)) lengths.push(n * 30.48);
    else if (unit === 'cm') lengths.push(n);
    else if (unit === 'mm') lengths.push(n / 10);
    else if (unit === 'm') lengths.push(n * 100);
    else if (['inch', 'inches', 'in'].includes(unit)) lengths.push(n * 2.54);
    else if (['l', 'litre', 'liter'].includes(unit)) volumes.push(n * 1000);
    else if (unit === 'ml') volumes.push(n);
  }
  return { lengths, volumes };
}
// Both name a size of a kind, and none of the candidate's is within 10% of the listing's: another product.
const sizeClash = (mine, theirs) => mine.length > 0 && theirs.length > 0 && !theirs.some((t) => mine.some((m) => Math.abs(t - m) <= m * 0.1));

const WORDS_TEXT = 0.5; // of the listing's leading words a text match must share
const WORDS_IMAGE = 0.35; // a photo match looks alike already, so fewer

/**
 * Whether an AliExpress product looks like the same thing as the eBay
 * listing, from the titles: { same, share, why }. Half the listing's
 * leading words (where an eBay title says what the product is, before its
 * keywords; 35% for a photo match) must be in the supplier's title, and
 * where both give a length or volume they must agree ("2FT 60CM" isn't a
 * 4ft batten).
 */
function sameProduct(listingTitle, candidate) {
  const mine = new Set(searchWords(listingTitle, LEAD_WORDS).split(' ').filter(Boolean).map(stem));
  const theirs = wordSet(candidate.title);
  if (!mine.size) return { same: false, share: 0, why: 'The eBay title has no words to compare' };
  const share = [...mine].filter((w) => theirs.has(w)).length / mine.size;
  const need = candidate.via === 'image' ? WORDS_IMAGE : WORDS_TEXT;
  if (share < need) return { same: false, share, why: `Shares only ${Math.round(share * 100)}% of the eBay title's words` };
  const a = sizesIn(listingTitle);
  const b = sizesIn(candidate.title);
  if (sizeClash(a.lengths, b.lengths) || sizeClash(a.volumes, b.volumes)) return { same: false, share, why: 'A different size from the eBay listing' };
  return { same: true, share, why: null };
}

/**
 * The products to check, in turn from each search (the photo's best match
 * first), each once: only ones that look like the same product
 * (sameProduct), and a text result rated under 4.0 stars isn't worth a read.
 * `skipped`: the rest, with why.
 */
function candidatesToCheck({ image = [], text = [] }, listingTitle, max = CHECK_MAX) {
  const out = [];
  const seen = new Set();
  const skipped = [];
  const alike = (c) => {
    const s = sameProduct(listingTitle, c);
    if (!s.same) skipped.push({ ...c, why: s.why });
    return s.same;
  };
  const imageOk = image.filter(alike);
  const textOk = text.filter((c) => {
    // AliExpress gives 0 for a product nobody has rated.
    if (c.rating === 0) {
      skipped.push({ ...c, why: 'No rating on AliExpress yet' });
      return false;
    }
    if (c.rating !== null && c.rating !== undefined && c.rating < MIN_RATING) {
      skipped.push({ ...c, why: `Rated ${c.rating} stars, under ${MIN_RATING}` });
      return false;
    }
    return alike(c);
  });
  for (let i = 0; out.length < max && (i < imageOk.length || i < textOk.length); i += 1) {
    for (const c of [imageOk[i], textOk[i]]) {
      if (c && !seen.has(c.productId) && out.length < max) {
        seen.add(c.productId);
        out.push(c);
      }
    }
  }
  return { check: out, skipped };
}

/**
 * The figure a supplier is judged on: the listing's best-selling variation's
 * option where the listing has variations (the check's headline); for a
 * listing without variations, a typical option — the lower middle of the
 * in-stock options by return — so a cheap extra ("filter sponge 4 pcs")
 * priced at the listing's price can't make the product look profitable.
 * { profit, roi, basis }.
 */
function judgedOn(result) {
  const head = result?.summary?.headline || {};
  const top = result?.summary?.bestSeller;
  if ((top && top.label) || head.basis === 'best_seller') return { profit: head.profit ?? null, roi: head.roi ?? null, basis: 'best_seller' };
  const rows = (result?.options || []).filter((r) => r.stock !== 0 && r.roi !== null && r.roi !== undefined).sort((x, y) => x.roi - y.roi);
  if (rows.length > 1) {
    const typical = rows[Math.floor((rows.length - 1) / 2)];
    return { profit: typical.profit, roi: typical.roi, basis: 'typical' };
  }
  return { profit: head.profit ?? null, roi: head.roi ?? null, basis: head.basis || null };
}

/**
 * Whether a checked supplier will do: { ok, why, profit, roi } (why: in the
 * seller's words, when it won't; the figures judgedOn gives), belowTarget
 * when it matches and earns but under the account's target return.
 */
function judge(result) {
  const supplier = result?.source?.supplier || {};
  const target = Number(result?.targetRoiPercent) || 0;
  const on = judgedOn(result);
  const no = (why) => ({ ok: false, why, profit: on.profit, roi: on.roi });
  if (supplier.onSale === false) return no('No longer on sale');
  // AliExpress gives 0 for a product nobody has rated.
  if (supplier.rating === null || supplier.rating === undefined || supplier.rating <= 0) return no('No rating on AliExpress yet');
  if (supplier.rating < MIN_RATING) return no(`Rated ${supplier.rating} stars, under ${MIN_RATING}`);
  if (result.mismatch) return no(result.mismatch.reason);
  if (!(result.summary?.inStock > 0)) return no('Out of stock');
  // Free postage, or free over an amount (AliExpress's Choice offer): nothing added to each sale for it.
  const ship = result.shipping || {};
  if (ship.basis !== 'aliexpress') return no("AliExpress didn't quote postage for it");
  if (!(ship.cost === 0 || (ship.freeOver !== null && ship.freeOver !== undefined))) return no(`Postage isn't free (${ship.cost} a parcel)`);
  // The listing's best-selling variation must be among the supplier's options and be what earns: a
  // supplier judged on some other option at the listing's lowest price isn't one to pick by itself.
  const top = result.summary?.bestSeller;
  if (top && top.label && top.sold > 0 && result.summary?.headline?.basis !== 'best_seller') return no(`The listing's best seller (${top.label}) isn't among its options`);
  // Only its closest option (an "Adapter" for a memory card): a person should judge that, not Liston.
  if (top && top.label && top.quality === 'close') return no(`Its option for the listing's best seller (${top.label}) is only a close match`);
  if (on.profit === null || on.profit === undefined) return no('No profit could be worked out');
  if (!(on.profit > 0)) return no("Loses money at the competitor's price");
  // Matches in every way and earns, just less than the account aims for: kept as a match (belowTarget),
  // shown with its figures for a person to add, never added by Liston by itself. Only a loss rules it out.
  if (on.roi < target) return { ok: false, belowTarget: true, why: `${on.roi}% return, under your ${target}% target`, profit: on.profit, roi: on.roi };
  if (on.roi > MAX_ROI) return no(`${on.roi}% return: too cheap to be sure it's the same product, check it by hand`);
  return { ok: true, why: null, profit: on.profit, roi: on.roi };
}

/**
 * The best of the suppliers that will do: the highest return, then profit,
 * then rating; alike on all three, a photo match (it looks the same), then
 * the one found first (`order`), so the pick never depends on which check
 * answered first. `belowTarget`: matches under the target return count too.
 */
function best(checked, { belowTarget = false } = {}) {
  // The figures it was judged on (judge), else the check's headline.
  const roi = (c) => c.verdict.roi ?? c.result.summary.headline.roi;
  const profit = (c) => c.verdict.profit ?? c.result.summary.headline.profit;
  return (
    checked
      .filter((c) => c.verdict.ok || (belowTarget && c.verdict.belowTarget))
      .sort(
        (a, b) =>
          roi(b) - roi(a) ||
          profit(b) - profit(a) ||
          b.result.source.supplier.rating - a.result.source.supplier.rating ||
          Number(b.candidate?.via === 'image') - Number(a.candidate?.via === 'image') ||
          (a.order ?? 0) - (b.order ?? 0)
      )[0] || null
  );
}

module.exports = { searchWords, searchImage, sameProduct, sizesIn, candidatesToCheck, judgedOn, judge, best, MIN_RATING, MAX_ROI, CHECK_MAX };
