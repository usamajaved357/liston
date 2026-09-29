const { landedPrice } = require('../research/research-stats');
const delivery = require('../research/delivery');

// "Load more products" with the hunter's filters: which listings are worth a
// sold-count read. Pure. A subject's first reads are its leading listings in
// eBay's order (its figures need them as they are); after that, only the
// listings that can pass the filters are read, so each load adds products the
// hunter would keep, and when the leading listings run out of those, eBay is
// searched again with the filters applied there (price, brand) for more.
//
// Judged before a read: words in the title, what a buyer pays (price and
// postage), delivery against the account's, the seller's feedback and size,
// how new the listing is, and a known brand named in the title. Sales and
// eBay's own Brand specific only come with the read, so they're left to the
// page's filters afterwards.

const SELLER_SIZES = { small: [0, 1000], medium: [1000, 10000], large: [10000, Infinity] };
const RATINGS = { top: (p) => p >= 99, good: (p) => p >= 98, weak: (p) => p < 98 };
// A price filter at eBay is on the item price alone: a little under the landed minimum, so a listing
// whose postage lifts it over isn't missed (the landed price is checked again here).
const PRICE_ROOM = 0.85;

/** The filters that decide what's read, from the page's query; null when none narrows anything. */
function focusOf(input = {}) {
  const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));
  const focus = {
    q: String(input.fq || '').trim().toLowerCase().slice(0, 100),
    priceMin: num(input.priceMin),
    priceMax: num(input.priceMax),
    fit: input.fit === true || input.fit === 'true' || input.fit === '1',
    brand: ['unbranded', 'branded'].includes(input.brand) ? input.brand : 'any',
    rating: Object.keys(RATINGS).includes(input.rating) ? input.rating : 'any',
    size: Object.keys(SELLER_SIZES).includes(input.size) ? input.size : 'any',
    listedWithin: num(input.listedWithin) || null,
  };
  const narrows = focus.q || focus.priceMin !== null || focus.priceMax !== null || focus.fit || focus.brand !== 'any' || focus.rating !== 'any' || focus.size !== 'any' || focus.listedWithin;
  return narrows ? focus : null;
}

/** The same filters, the same key (for the work under way and the searches kept). */
const signature = (focus) => (focus ? JSON.stringify([focus.q, focus.priceMin, focus.priceMax, focus.fit, focus.brand, focus.rating, focus.size, focus.listedWithin]) : '');

/**
 * Whether a listing can pass the filters before its sold count is read.
 * `account`: the account's delivery window ({ min, max } working days);
 * `brands`: brand names to keep out of an unbranded search (the VeRO ones
 * and those on many listings); `takenAt`: when the listing was read from
 * eBay (its delivery dates are from then).
 */
function passes(listing, focus, { account = null, brands = [], takenAt = Date.now(), now = Date.now() } = {}) {
  if (!focus) return true;
  const title = String(listing.title || '').toLowerCase();
  if (focus.q && !focus.q.split(/\s+/).filter((w) => w.length > 1).every((w) => title.includes(w))) return false;
  const landed = listing.price ? landedPrice(listing) : null;
  if (focus.priceMin !== null && !(landed !== null && landed >= focus.priceMin)) return false;
  if (focus.priceMax !== null && !(landed !== null && landed <= focus.priceMax)) return false;
  // Delivery like the account's: a listing delivering slower isn't one it can match (not known: kept).
  if (focus.fit && account && delivery.compare(delivery.listingWindow(listing, takenAt), account) === 'slower') return false;
  const percentage = listing.seller?.feedbackPercentage;
  if (focus.rating !== 'any' && !(percentage !== null && percentage !== undefined && RATINGS[focus.rating](Number(percentage)))) return false;
  const score = listing.seller?.feedbackScore;
  if (focus.size !== 'any') {
    const [lo, hi] = SELLER_SIZES[focus.size];
    if (!(score !== null && score !== undefined && score >= lo && score < hi)) return false;
  }
  if (focus.listedWithin && listing.createdAt && (now - new Date(listing.createdAt).getTime()) / 86400000 > focus.listedWithin) return false;
  if (focus.brand === 'unbranded' && brands.some((b) => b && new RegExp(`\\b${escape(String(b).toLowerCase())}\\b`).test(title))) return false;
  return true;
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The eBay search for more listings passing the filters: { q, filter,
 * aspectFilter } for Browse. The subject's words and the filter's; the
 * price at eBay; an unbranded search in a category asks eBay for listings
 * whose Brand says so (a keyword has no category to ask in).
 */
function searchOf(subject, focus, { currency }) {
  const words = [subject.q, focus.q].filter(Boolean).join(' ').trim() || undefined;
  const parts = ['buyingOptions:{FIXED_PRICE}'];
  if (focus.priceMin !== null || focus.priceMax !== null) {
    const lo = focus.priceMin !== null ? Math.floor(focus.priceMin * PRICE_ROOM * 100) / 100 : '';
    const hi = focus.priceMax !== null ? focus.priceMax : '';
    parts.push(`price:[${lo}..${hi}]`, `priceCurrency:${currency}`);
  }
  const aspectFilter = focus.brand === 'unbranded' && subject.categoryId ? `categoryId:${subject.categoryId},Brand:{Unbranded|Unbranded/Generic|Generic|Does not apply}` : undefined;
  return { q: words, filter: parts.join(','), aspectFilter };
}

module.exports = { focusOf, signature, passes, searchOf, SELLER_SIZES };
