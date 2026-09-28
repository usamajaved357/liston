const { HAZMAT_TRIGGERS, REPLACEMENTS } = require('../listings/policy-words');
const { aboutProduct, refusalKind } = require('../research/research-analysis');
const { titleSimilarity, SIMILAR_AT } = require('../hunting/hunt-duplicates');

// Whether a category or keyword is safe to hunt in, before anyone spends
// time on it. Pure: names, titles, eBay's brand split and (when there is
// one) the AI's brand/VeRO and restricted-product reading in, flags out.
//
//   - eBay's automated hazardous-materials filter (listings/policy-words):
//     a word match over the listing, whatever the product; each word with
//     the wording Liston writes instead.
//   - Prohibited and restricted items on eBay that dropshippers run into,
//     by the words that name them (below). A guide, not eBay's rules: eBay
//     decides, and some need approval rather than being banned.
//   - Brands: how much of the category eBay lists under a brand; the AI
//     names the ones whose owners take listings down through VeRO, and a
//     short list below of the brands known to (eBay publishes no list).
//
// A listing that names a restricted item or a VeRO brand as the product is
// a violation: Discover hides it (partition) rather than pointing anyone at
// it, and says how many it hid. A brand mentioned as what the product fits
// ("case for iPhone 15") is allowed on eBay and isn't a violation.

const RESTRICTED = [
  { key: 'replica', kind: 'prohibited', label: 'Replicas and counterfeits', words: ['replica', 'replicas', 'counterfeit', 'fake', 'knockoff', 'knock-off', 'knock off'] },
  { key: 'weapons', kind: 'restricted', label: 'Weapons and knives', words: ['knife', 'knives', 'dagger', 'daggers', 'sword', 'swords', 'machete', 'butterfly knife', 'flick knife', 'knuckle duster', 'knuckleduster', 'taser', 'stun gun', 'pepper spray', 'crossbow', 'catapult', 'slingshot', 'air rifle', 'bb gun', 'firearm', 'firearms', 'baton', 'nunchucks'] },
  { key: 'vapes', kind: 'restricted', label: 'Vapes, tobacco and nicotine', words: ['vape', 'vapes', 'vaping', 'e-cigarette', 'e-cigarettes', 'e-cig', 'e-cigs', 'ecig', 'e-liquid', 'e-liquids', 'eliquid', 'nicotine', 'nic salt', 'nic salts', 'tobacco', 'cigarette', 'cigarettes', 'shisha', 'hookah', 'electronic smoking', 'smoking', 'puffs', 'refill pods', 'pod kit', 'prefilled pods', 'disposable vape', 'rolling tobacco'] },
  { key: 'medical', kind: 'restricted', label: 'Medicines, medical devices and health claims', words: ['prescription', 'medicine', 'medicines', 'medical device', 'pharmaceutical', 'antibiotic', 'antibiotics', 'hearing aid', 'hearing aids', 'contact lens', 'contact lenses', 'blood pressure monitor', 'covid', 'cure', 'cures'] },
  { key: 'supplements', kind: 'restricted', label: 'Supplements, CBD and drugs', words: ['cbd', 'thc', 'cannabis', 'kratom', 'steroid', 'steroids', 'diet pills', 'weight loss pills', 'poppers', 'nitrous'] },
  { key: 'paraphernalia', kind: 'prohibited', label: 'Drug paraphernalia', words: ['bong', 'bongs', 'dab rig', 'rolling papers'] },
  { key: 'surveillance', kind: 'restricted', label: 'Spy devices and signal jammers', words: ['spy camera', 'hidden camera', 'signal jammer', 'jammer', 'jammers', 'gps jammer'] },
  { key: 'lasers', kind: 'restricted', label: 'Laser pointers', words: ['laser pointer', 'laser pointers', 'laser pen'] },
  { key: 'wildlife', kind: 'prohibited', label: 'Wildlife and animal parts', words: ['ivory', 'taxidermy', 'rhino horn', 'tortoiseshell'] },
  { key: 'adult', kind: 'restricted', label: 'Adult items', words: ['sex toy', 'sex toys', 'adult toy', 'adult toys'] },
  { key: 'vehicle', kind: 'restricted', label: 'Emissions and safety defeat devices', words: ['dpf delete', 'egr delete', 'adblue emulator', 'speed limiter removal'] },
  { key: 'hazardous', kind: 'restricted', label: 'Hazardous goods', words: ['fire extinguisher', 'fire extinguishers', 'drain unblocker', 'drain cleaner', 'caustic soda', 'sulphuric acid', 'hydrochloric acid', 'lighter fluid', 'lighter refill', 'lighter refills'] },
];

// Brands whose owners are known to take listings down through VeRO, and
// that a dropshipper's supplier can't legitimately provide. The AI adds the
// ones a subject turns up.
const VERO_BRANDS = [
  'apple', 'iphone', 'ipad', 'airpods', 'macbook', 'apple watch', 'samsung', 'sony', 'bose', 'jbl', 'gopro', 'dji', 'fitbit', 'garmin', 'dyson',
  'nike', 'adidas', 'puma', 'reebok', 'under armour', 'new balance', 'the north face', 'north face', 'canada goose', 'ugg', 'crocs', 'birkenstock', 'lululemon', 'gymshark',
  'gucci', 'louis vuitton', 'chanel', 'prada', 'dior', 'burberry', 'hermes', 'hermès', 'versace', 'balenciaga', 'fendi', 'rolex', 'cartier', 'tiffany', 'swarovski', 'pandora', 'michael kors', 'ray-ban', 'ray ban', 'oakley',
  'disney', 'marvel', 'pokemon', 'pokémon', 'nintendo', 'playstation', 'xbox', 'lego', 'barbie', 'hot wheels', 'hello kitty', 'harry potter', 'star wars', 'peppa pig', 'paw patrol', 'bluey', 'squishmallows', 'funko',
  'longchamp', 'labubu', 'pop mart', 'jellycat', 'sonny angel', 'kpop demon hunters', 'k-pop demon hunters',
  'stanley', 'yeti', 'hydro flask', 'oral-b', 'gillette', 'olaplex', 'kylie', 'charlotte tilbury', 'estee lauder', 'estée lauder', 'mac cosmetics', 'nespresso', 'kitchenaid', 'le creuset', 'tefal', 'thermomix',
];
// A brand right after one of these is what the product fits, not the product.
const COMPATIBILITY = /(?:\bfor|\bfits?|\bfitting|\bcompatible(?:\s+with)?|\bsuits?|\bsuitable\s+for|\breplacement\s+for|\bto\s+fit)\s+(?:\w+\s+){0,2}$/i;

const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = (words) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(${[...words].sort((a, b) => b.length - a.length).map(escape).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'giu');
const HAZMAT = pattern(HAZMAT_TRIGGERS);
const RESTRICTED_PATTERNS = RESTRICTED.map((r) => ({ ...r, re: pattern(r.words) }));

function matches(re, text) {
  const found = new Set();
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(String(text || '').toLowerCase()))) found.add(m[1]);
  return [...found];
}

/** The filtered and restricted words in a piece of text: { hazmat: [word], restricted: [{ key, kind, label, words }] }. */
function termsIn(text) {
  const restricted = RESTRICTED_PATTERNS.map((r) => ({ key: r.key, kind: r.kind, label: r.label, words: matches(r.re, text) })).filter((r) => r.words.length);
  return { hazmat: matches(HAZMAT, text), restricted };
}

/**
 * The brand a title names as its product, or null: the known VeRO brands
 * and `brandNames` (the AI's), except where the brand is what the product
 * fits ("cover for iPad", "compatible with Samsung Galaxy").
 */
function veroBrandIn(text, brandNames = []) {
  const lower = ` ${String(text || '').toLowerCase().replace(/[^\p{L}\p{N}'-]+/gu, ' ')} `;
  // Each brand as it was given (the AI's casing), by its lower-case form.
  const names = new Map();
  for (const b of [...brandNames.map((x) => String(x || '')), ...VERO_BRANDS]) if (b.length > 2 && !names.has(b.toLowerCase())) names.set(b.toLowerCase(), b);
  for (const b of [...names.keys()].sort((x, y) => y.length - x.length)) {
    let at = lower.indexOf(` ${b} `);
    while (at !== -1) {
      if (!COMPATIBILITY.test(lower.slice(0, at + 1))) return names.get(b);
      at = lower.indexOf(` ${b} `, at + 1);
    }
  }
  return null;
}

/** A short flag for a keyword, a category name or a listing title, or null. */
function flagOf(text, brandNames = []) {
  const { hazmat, restricted } = termsIn(text);
  const lower = ` ${String(text || '').toLowerCase()} `;
  const brand = veroBrandIn(text, brandNames) || brandNames.find((b) => b && b.length > 2 && lower.includes(` ${b.toLowerCase()} `)) || null;
  if (!hazmat.length && !restricted.length && !brand) return null;
  return {
    restricted: restricted[0] ? { kind: restricted[0].kind, label: restricted[0].label } : null,
    hazmat: hazmat[0] || null,
    brand,
  };
}

/**
 * Why a listing can't be pointed at, or null: it (or its eBay category)
 * names a restricted or prohibited item ({ kind: 'restricted', label }) or a VeRO brand as the
 * product ({ kind: 'brand', label: the brand }). eBay's word filter isn't a
 * violation of the product, only of its wording, so it doesn't hide one.
 */
function violationOf(title, brandNames = [], category = '') {
  const { restricted } = termsIn(`${title} ${category || ''}`);
  if (restricted[0]) return { kind: 'restricted', label: restricted[0].label, prohibited: restricted[0].kind === 'prohibited' };
  const brand = veroBrandIn(title, brandNames);
  return brand ? { kind: 'brand', label: brand } : null;
}

/**
 * The listings Discover may show and the ones it hides:
 * { kept, hidden: { count, restricted, brand, brands: [name] } }.
 */
function partition(listings, brandNames = []) {
  const kept = [];
  const hidden = { count: 0, restricted: 0, brand: 0, brands: [] };
  const brands = new Map();
  for (const l of listings) {
    const v = violationOf(l.title, brandNames, l.category);
    if (!v) {
      kept.push(l);
      continue;
    }
    hidden.count += 1;
    if (v.kind === 'restricted') hidden.restricted += 1;
    else {
      hidden.brand += 1;
      brands.set(v.label, (brands.get(v.label) || 0) + 1);
    }
  }
  hidden.brands = [...brands].sort((a, b) => b[1] - a[1]).map(([name]) => name).slice(0, 6);
  return { kept, hidden };
}

/**
 * A subject's checks: its own name, its leading listings' titles, eBay's
 * brand split, and the AI's reading when there is one.
 * { level: 'clear' | 'check' | 'risky', subject, titles, brands, ai }.
 */
function check({ name, listings = [], brands = [], total = 0, advice = null, hidden = null }) {
  const subject = termsIn(name);
  const hazmat = new Map();
  const restricted = new Map();
  for (const l of listings) {
    const t = termsIn(l.title);
    for (const w of t.hazmat) hazmat.set(w, (hazmat.get(w) || 0) + 1);
    for (const r of t.restricted) {
      const e = restricted.get(r.key) || { key: r.key, kind: r.kind, label: r.label, words: new Set(), listings: 0 };
      r.words.forEach((w) => e.words.add(w));
      e.listings += 1;
      restricted.set(r.key, e);
    }
  }
  const sample = listings.length || 1;
  const named = brands.filter((b) => !b.unbranded);
  const brandTotal = brands.reduce((sum, b) => sum + b.count, 0) || total || 0;
  const brandedCount = named.reduce((sum, b) => sum + b.count, 0);
  const brandInfo = {
    // No split from eBay: not known (not "0% branded").
    branded: brands.length && brandTotal ? Math.round((brandedCount / brandTotal) * 100) : null,
    top: named.slice(0, 5).map((b) => ({ name: b.name, count: b.count, share: brandTotal ? Math.round((b.count / brandTotal) * 1000) / 10 : null })),
  };
  const titles = {
    hazmat: [...hazmat]
      .map(([word, n]) => ({ word, listings: n, share: Math.round((n / sample) * 100), safer: REPLACEMENTS[word] || null }))
      .sort((a, b) => b.listings - a.listings)
      .slice(0, 6),
    restricted: [...restricted.values()].map((r) => ({ ...r, words: [...r.words], share: Math.round((r.listings / sample) * 100) })).sort((a, b) => b.listings - a.listings),
  };
  const ai = advice ? { brand: advice.brandRisk || null, safety: advice.safetyRisk || null, summary: advice.summary || null } : null;

  const risky =
    subject.restricted.length > 0 ||
    titles.restricted.some((r) => r.kind === 'prohibited' && r.share >= 20) ||
    ai?.brand?.level === 'high' ||
    ai?.safety?.level === 'high';
  const check_ =
    subject.hazmat.length > 0 ||
    titles.hazmat.some((h) => h.share >= 20) ||
    titles.restricted.some((r) => r.share >= 20) ||
    (brandInfo.branded ?? 0) >= 50 ||
    ai?.brand?.level === 'low' ||
    ai?.safety?.level === 'low';
  return { level: risky ? 'risky' : check_ ? 'check' : 'clear', subject, titles, brands: brandInfo, ai, hidden: hidden || { count: 0, restricted: 0, brand: 0, brands: [] } };
}

/**
 * A product's takedown risk for this owner, or null. Listings whose titles
 * name a VeRO brand or a restricted item are already hidden (partition);
 * this looks further, at what a title doesn't say:
 *   - its Brand item specific is a VeRO brand ('vero', bad);
 *   - eBay refused one of the owner's drafts for a product like it, for
 *     brand or intellectual-property reasons ('refused', bad) or another
 *     policy ('refused', warn) — eBay publishes no one's violation history
 *     (its Compliance API closed in March 2026), so the owner's own is it;
 *   - their team rejected a product like it for brand or VeRO risk
 *     ('rejected', warn).
 * `refusals`: listing.repository.findPolicyRefusals rows ({ title, message });
 * `rejected`: { itemId, title } of hunts rejected for brand risk.
 * { kind, level: 'bad' | 'warn', text }.
 */
function productRisk(product, { refusals = [], rejected = [] } = {}) {
  const brand = product.brand ? veroBrandIn(product.brand) : null;
  if (brand) return { kind: 'vero', level: 'bad', text: `Its listings' brand is ${brand}, whose owner takes listings down through VeRO` };
  const past = refusals.filter((r) => refusalKind(r.message) !== 'words' && aboutProduct(r.title, product.name));
  const ip = past.filter((r) => refusalKind(r.message) === 'ip');
  if (ip.length) return { kind: 'refused', level: 'bad', text: `eBay refused ${ip.length === 1 ? 'one of your drafts' : `${ip.length} of your drafts`} for a product like this, for brand or intellectual-property reasons` };
  const ids = new Set((product.itemIds || []).map(String));
  if (rejected.some((h) => (h.itemId && ids.has(String(h.itemId))) || titleSimilarity(h.title || '', product.name || '') >= SIMILAR_AT)) {
    return { kind: 'rejected', level: 'warn', text: 'Your team rejected a product like this for brand or VeRO risk' };
  }
  if (past.length) return { kind: 'refused', level: 'warn', text: `eBay refused ${past.length === 1 ? 'one of your drafts' : `${past.length} of your drafts`} for a product like this, for a listing policy` };
  return null;
}

module.exports = { check, termsIn, flagOf, violationOf, veroBrandIn, partition, productRisk, RESTRICTED, VERO_BRANDS };
