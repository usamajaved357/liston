const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');
const logger = require('../../utils/logger');
const aiUsage = require('./ai-usage');

// The judgement calls in product research that numbers can't make: is this
// a brand that has eBay take listings down (VeRO), is the product restricted
// or regulated on the site, and what title would a buyer's search find —
// read from the listings that actually sell. One small model call per
// search, kept a day; research works without it (no key, or it fails).

const TTL_MS = 24 * 60 * 60 * 1000;
const copies = new Map(); // key -> { at, value }
const TITLE_MAX = 80;

const LEVEL = { type: 'string', enum: ['none', 'low', 'high'] };
const TOOL = {
  name: 'research_advice',
  description: 'Advice for a seller deciding whether and how to list this product on eBay.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: `A title for a new listing of this product, at most ${TITLE_MAX} characters, built from the words buyers search and the selling titles use. Never any brand, trademark or licence you name in brandRisk (write the generic word instead, e.g. "magnetic" for MagSafe); no hazardous-material words, no ALL CAPS, no symbols.` },
      keywords: { type: 'array', items: { type: 'string' }, description: 'Up to 12 search terms buyers use for this product, most important first.' },
      brandRisk: {
        type: 'object',
        properties: {
          level: { ...LEVEL, description: 'high: the product is (or the leading listings sell) a trademarked brand, character or licence whose owner takes listings down through eBay VeRO, or that dropshipped copies infringe. low: some listings name a brand, but a generic version is fine. none: a generic product.' },
          brands: { type: 'array', items: { type: 'string' }, description: 'The brands or licences that carry the risk.' },
          reason: { type: 'string', description: 'One sentence the seller can act on.' },
        },
        required: ['level', 'brands', 'reason'],
      },
      safetyRisk: {
        type: 'object',
        properties: {
          level: { ...LEVEL, description: `high: prohibited or restricted on this eBay site, or needs approval/certification the seller likely lacks (medical devices and health claims, weapons and knives, supplements, cosmetics, food, children's toys without marking, electrical goods without the local plug and safety marking, hazardous materials). low: allowed but regulated (needs safety info, age marking, or careful wording). none: nothing to worry about.` },
          reason: { type: 'string', description: 'One sentence the seller can act on.' },
        },
        required: ['level', 'reason'],
      },
      summary: { type: 'string', description: 'Two sentences at most: what the listings that sell have in common (price point, pack size, angle) and how to stand out.' },
    },
    required: ['title', 'keywords', 'brandRisk', 'safetyRisk', 'summary'],
  },
};

function prompt({ query, market, currency, items, breakdown, keywords }) {
  const selling = items
    .filter((i) => (i.sold || 0) > 0)
    .sort((a, b) => (b.soldPerMonth || 0) - (a.soldPerMonth || 0))
    .slice(0, 20);
  const others = items.filter((i) => !selling.includes(i)).slice(0, Math.max(0, 25 - selling.length));
  const line = (i) =>
    `- ${i.title} | ${i.price?.value ?? '?'} ${currency}${i.shipping?.free ? ' free post' : ''}${i.sold !== null && i.sold !== undefined ? ` | ${i.sold} sold, ${i.soldPerMonth ?? 0}/mo` : ''}${i.location?.country ? ` | ships from ${i.location.country}` : ''}`;
  const brands = (breakdown?.brands || []).slice(0, 10).map((b) => `${b.name} (${b.count})`).join(', ');
  const categories = (breakdown?.categories || []).slice(0, 3).map((c) => `${c.name} (${c.count})`).join(', ');
  return [
    `A dropshipper is researching "${query}" on eBay ${market} (prices in ${currency}). They buy from suppliers like AliExpress and list under their own shop.`,
    selling.length ? `Listings that sell, best first:\n${selling.map(line).join('\n')}` : 'No sold counts were read.',
    others.length ? `Other leading listings:\n${others.map(line).join('\n')}` : null,
    brands ? `Brand item specific across all listings (listing counts): ${brands}` : null,
    categories ? `Categories: ${categories}` : null,
    keywords?.length ? `Words most used by the selling titles: ${keywords.slice(0, 15).map((k) => k.term).join(', ')}` : null,
    `Judge the brand/VeRO risk and the restricted/regulated risk for THIS eBay site, write the title, and list the keywords. Be concrete and brief.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// A title cut at a word, never past eBay's 80 characters.
function fitTitle(title) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= TITLE_MAX) return clean;
  const cut = clean.slice(0, TITLE_MAX + 1);
  return cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : TITLE_MAX).trim();
}

// The model sometimes names a brand as a risk and then uses it anyway: the
// title never carries a brand it flagged.
function withoutBrands(title, brands) {
  let out = title;
  for (const brand of brands || []) {
    const name = String(brand).trim();
    if (name.length < 2) continue;
    out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'giu'), '$1');
  }
  return out.replace(/\s+/g, ' ').trim();
}

const levelOf = (v) => (['none', 'low', 'high'].includes(v) ? v : 'low');

/** The day's copy of a search's advice, or null. */
function keptAdvice(key) {
  const hit = copies.get(key);
  return hit && Date.now() - hit.at < TTL_MS ? hit.value : null;
}

/**
 * { title, keywords, brandRisk: { level, brands, reason }, safetyRisk:
 * { level, reason }, summary } for a search, or null when AI isn't set up
 * or didn't answer. `key` identifies the search for the day's copy.
 */
async function advise(key, input) {
  const hit = keptAdvice(key);
  if (hit) return hit;
  if (!config.anthropicApiKey) return null;
  try {
    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey, timeout: 30 * 1000 });
    const response = await anthropic.messages.create({
      model: config.aiModel,
      max_tokens: 1024,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: prompt(input) }],
    });
    aiUsage.record('research', response);
    const out = response.content.find((c) => c.type === 'tool_use')?.input;
    if (!out) return null;
    const flagged = out.brandRisk?.level === 'none' ? [] : out.brandRisk?.brands;
    const value = {
      title: fitTitle(withoutBrands(out.title, flagged)),
      keywords: (out.keywords || []).map((k) => String(k).trim()).filter(Boolean).slice(0, 12),
      brandRisk: { level: levelOf(out.brandRisk?.level), brands: (out.brandRisk?.brands || []).map(String).slice(0, 6), reason: String(out.brandRisk?.reason || '') },
      safetyRisk: { level: levelOf(out.safetyRisk?.level), reason: String(out.safetyRisk?.reason || '') },
      summary: String(out.summary || ''),
    };
    copies.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    logger.warn('Research advice not written', { error: err.message });
    return null;
  }
}

/** Test hook. */
function forget() {
  copies.clear();
}

module.exports = { advise, keptAdvice, fitTitle, withoutBrands, prompt, forget, TOOL, TITLE_MAX };
