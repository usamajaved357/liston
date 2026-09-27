const { HAZMAT_TRIGGERS, REPLACEMENTS } = require('../listings/policy-words');

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
//     names the ones whose owners take listings down through VeRO.

const RESTRICTED = [
  { key: 'replica', kind: 'prohibited', label: 'Replicas and counterfeits', words: ['replica', 'replicas', 'counterfeit', 'fake', 'knockoff', 'knock-off', 'knock off'] },
  { key: 'weapons', kind: 'restricted', label: 'Weapons and knives', words: ['knife', 'knives', 'dagger', 'daggers', 'sword', 'swords', 'machete', 'butterfly knife', 'flick knife', 'knuckle duster', 'knuckleduster', 'taser', 'stun gun', 'pepper spray', 'crossbow', 'catapult', 'slingshot', 'air rifle', 'bb gun', 'firearm', 'firearms', 'baton', 'nunchucks'] },
  { key: 'vapes', kind: 'restricted', label: 'Vapes, tobacco and nicotine', words: ['vape', 'vapes', 'e-cigarette', 'e-cigarettes', 'e-liquid', 'nicotine', 'tobacco', 'cigarette', 'cigarettes', 'shisha'] },
  { key: 'medical', kind: 'restricted', label: 'Medicines, medical devices and health claims', words: ['prescription', 'medicine', 'medicines', 'medical device', 'pharmaceutical', 'antibiotic', 'antibiotics', 'hearing aid', 'hearing aids', 'contact lens', 'contact lenses', 'blood pressure monitor', 'covid', 'cure', 'cures'] },
  { key: 'supplements', kind: 'restricted', label: 'Supplements, CBD and drugs', words: ['cbd', 'thc', 'cannabis', 'kratom', 'steroid', 'steroids', 'diet pills', 'weight loss pills', 'poppers', 'nitrous'] },
  { key: 'paraphernalia', kind: 'prohibited', label: 'Drug paraphernalia', words: ['bong', 'bongs', 'dab rig', 'rolling papers'] },
  { key: 'surveillance', kind: 'restricted', label: 'Spy devices and signal jammers', words: ['spy camera', 'hidden camera', 'signal jammer', 'jammer', 'jammers', 'gps jammer'] },
  { key: 'lasers', kind: 'restricted', label: 'Laser pointers', words: ['laser pointer', 'laser pointers', 'laser pen'] },
  { key: 'wildlife', kind: 'prohibited', label: 'Wildlife and animal parts', words: ['ivory', 'taxidermy', 'rhino horn', 'tortoiseshell'] },
  { key: 'adult', kind: 'restricted', label: 'Adult items', words: ['sex toy', 'sex toys', 'adult toy', 'adult toys'] },
  { key: 'vehicle', kind: 'restricted', label: 'Emissions and safety defeat devices', words: ['dpf delete', 'egr delete', 'adblue emulator', 'speed limiter removal'] },
];

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

/** A short flag for a keyword, a category name or a listing title, or null. */
function flagOf(text, brandNames = []) {
  const { hazmat, restricted } = termsIn(text);
  const lower = ` ${String(text || '').toLowerCase()} `;
  const brand = brandNames.find((b) => b && b.length > 2 && lower.includes(` ${b.toLowerCase()} `)) || null;
  if (!hazmat.length && !restricted.length && !brand) return null;
  return {
    restricted: restricted[0] ? { kind: restricted[0].kind, label: restricted[0].label } : null,
    hazmat: hazmat[0] || null,
    brand,
  };
}

/**
 * A subject's checks: its own name, its leading listings' titles, eBay's
 * brand split, and the AI's reading when there is one.
 * { level: 'clear' | 'check' | 'risky', subject, titles, brands, ai }.
 */
function check({ name, listings = [], brands = [], total = 0, advice = null }) {
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
  return { level: risky ? 'risky' : check_ ? 'check' : 'clear', subject, titles, brands: brandInfo, ai };
}

module.exports = { check, termsIn, flagOf, RESTRICTED };
