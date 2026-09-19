// Files a draft under the seller's own eBay Shop departments. Shop
// categories are the seller's, not eBay's, so there is no schema to ask —
// the best we can do is match a department's name against what the listing
// is. When nothing matches, a "New in" / "New arrivals" department (the
// usual catch-all on an eBay Shop) is used if the seller has one.

const STOP = new Set(['and', 'the', 'for', 'with', 'other', 'all', 'more', 'misc', 'items', 'item', 'products', 'product', 'accessories']);

// Department names use shop words where eBay's tree uses catalogue words:
// "Auto" for car parts, "Tech" for electronics. Both sides are widened to
// the same root so they meet.
const SYNONYMS = {
  auto: 'car', automotive: 'car', vehicle: 'car', motor: 'car', motoring: 'car',
  tech: 'electronic', technology: 'electronic', gadget: 'electronic', gadgets: 'electronic',
  phone: 'mobile', phones: 'mobile', smartphone: 'mobile', cellphone: 'mobile',
  home: 'household', house: 'household', homeware: 'household',
  garden: 'outdoor', gardening: 'outdoor',
  fashion: 'clothing', apparel: 'clothing', clothes: 'clothing', wear: 'clothing',
  beauty: 'cosmetic', makeup: 'cosmetic',
  jewellery: 'jewelry', jewelery: 'jewelry',
  diy: 'tool', tools: 'tool', hardware: 'tool',
  kid: 'child', kids: 'child', children: 'child', baby: 'child', toy: 'child', toys: 'child',
  pet: 'animal', pets: 'animal', dog: 'animal', cat: 'animal',
  audio: 'sound', headphone: 'sound', headphones: 'sound', speaker: 'sound', speakers: 'sound',
  lighting: 'light', lamp: 'light', lamps: 'light', led: 'light',
  fitness: 'sport', gym: 'sport', sporting: 'sport', sports: 'sport', cycling: 'sport', bike: 'sport',
};

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t))
    .map((t) => SYNONYMS[t] || t.replace(/(ies)$/, 'y').replace(/(s|es)$/, ''));
}

// Every department as "/Parent/Child", the form an offer's
// storeCategoryNames takes.
function flatten(categories, prefix = '') {
  return (categories || []).flatMap((c) => {
    const path = `${prefix}/${c.name}`;
    return [{ path, name: c.name, own: tokens(c.name), all: [...tokens(prefix.replace(/\//g, ' ')), ...tokens(c.name)] }, ...flatten(c.children, path)];
  });
}

/**
 * @param categories  the Shop's category tree (getStoreCategories)
 * @param listing     { title, categoryPath, specifics }
 * @returns { names: string[], matched: boolean } — up to one department path
 */
function suggestStoreCategories(categories, { title, categoryPath = [], specifics = {} } = {}) {
  const departments = flatten(categories).filter((d) => d.own.length);
  if (!departments.length) return { names: [], matched: false };

  const text = new Set([...tokens(title), ...tokens(categoryPath.join(' ')), ...tokens(Object.values(specifics).flat().join(' '))]);
  let best = null;
  for (const d of departments) {
    const ownHits = d.own.filter((t) => text.has(t)).length;
    if (!ownHits) continue;
    const allHits = d.all.filter((t) => text.has(t)).length;
    // A department whose whole name is in the listing beats a partial hit;
    // a matching parent breaks ties; deeper wins over shallower.
    const score = ownHits / d.own.length + allHits * 0.1 + d.path.split('/').length * 0.01;
    if (!best || score > best.score) best = { ...d, score };
  }
  if (best) return { names: [best.path], matched: true };

  const fallback = departments.find((d) => /^new(\s+(in|arrivals?|stock))?$/i.test(d.name.trim()));
  return { names: fallback ? [fallback.path] : [], matched: false };
}

module.exports = { suggestStoreCategories, flatten, tokens };
