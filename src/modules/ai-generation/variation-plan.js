// Decides how a draft's variations are shaped BEFORE anything is drafted,
// so the "choose what to list" step and the draft agree, and so the shape
// is one eBay will accept in the chosen category.
//
// The supplier's option axes are the raw material, but they are not the
// listing's. Two things are wrong with using them as-is:
//   - an axis with one option ("Color: Type-C 7mm", "Plug: USB Type-C") is
//     not something a buyer chooses — it's a property of the product, and
//     belongs in the item specifics;
//   - the axis NAME has to be one eBay lets vary in this category, and the
//     supplier's names ("Cable Length") usually aren't.
// So each axis with real choice is renamed, in order of preference, to: an
// exact allowed aspect; the name the competitor's listing uses for the same
// choice (its listing is live in this very category); a synonym eBay
// allows. When nothing fits, the supplier's name is kept and reported, and
// the editor offers the ways out.

const AXIS_SYNONYMS = [
  [/colou?r|shade/i, /^colou?r$/i],
  [/size|dimension/i, /size/i],
  [/model|compatib|device|phone/i, /model/i],
  [/style|design|pattern/i, /style|pattern/i],
  [/pack|quantity|qty|pcs|count|bundle/i, /\b(pack|packs|quantity|bundle|multipack)\b|\bnumber of (items|pieces|units|pcs)\b|\bset size\b/i],
  [/type|kind|variant/i, /^type$/i],
  [/material|fabric/i, /material/i],
  [/length/i, /length/i],
  [/capacity|storage|volume/i, /capacity|storage|volume/i],
];

function closestVariationAspect(axisName, allowed) {
  for (const [axisPattern, allowedPattern] of AXIS_SYNONYMS) {
    if (!axisPattern.test(axisName)) continue;
    const match = allowed.find((name) => allowedPattern.test(name));
    if (match) return match;
  }
  return null;
}

function deriveAxesFromVariants(variants) {
  const names = [...new Set((variants || []).flatMap((variant) => Object.keys(variant.attributes || {})))];
  return names.map((name) => ({
    name,
    values: [...new Set(variants.map((variant) => variant.attributes[name]).filter(Boolean))],
    hasImages: variants.some((variant) => Boolean(variant.imageUrl)),
  }));
}

// "1.5m" and "1.5" are the same option to a buyer; so are "Black" and "black".
function normalizeValue(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(meters?|metres?|inch(es)?|cm|mm|m|ml|l|kg|g|pcs?|pieces?|pack|x)$/i, '');
}

// Which of the competitor's axes carries the same choice as this supplier
// axis: the one sharing the most option values, or — when both listings
// vary by exactly one thing — simply the other one.
function pairWithCompetitor(axis, competitorAxes, multiCount) {
  if (!competitorAxes.length) return null;
  const mine = new Set(axis.values.map(normalizeValue));
  let best = null;
  for (const theirs of competitorAxes) {
    const overlap = theirs.values.filter((v) => mine.has(normalizeValue(v))).length;
    if (overlap && (!best || overlap > best.overlap)) best = { axis: theirs, overlap };
  }
  if (best) return best.axis;
  if (multiCount === 1 && competitorAxes.length === 1) return competitorAxes[0];
  return null;
}

/**
 * @param source     { variants, variantAxes? } after the seller's selection
 * @param competitor { variants } or null
 * @param allowedAxes aspect names eBay lets vary in the category; [] when unknown
 * @param blockedAxes item specifics of the category eBay does NOT let vary
 *   by ("Unit Quantity"); a name in neither list is the seller's own
 *   attribute, which eBay accepts
 * @returns {{ axes: {name, ebayName, values, hasImages, via}[], fixed: Record<string,string>, warnings: string[] }}
 *   `name` is the supplier's key on each variant's attributes; `ebayName`
 *   is what the listing calls it; `fixed` holds single-option axes.
 */
function planVariationAxes({ source, competitor, allowedAxes = [], blockedAxes = [] }) {
  const variants = source?.variants || [];
  const raw = source?.variantAxes?.length ? source.variantAxes : deriveAxesFromVariants(variants);
  // Values as they are after the seller's selection, not as the supplier
  // listed them.
  const sourceAxes = raw.map((axis) => ({
    ...axis,
    values: [...new Set(variants.map((v) => v.attributes?.[axis.name]).filter((v) => v !== undefined && v !== null && v !== ''))],
  }));

  const fixed = {};
  const multi = [];
  for (const axis of sourceAxes) {
    if (axis.values.length <= 1) {
      if (axis.values.length === 1) fixed[axis.name] = axis.values[0];
    } else multi.push(axis);
  }

  const competitorAxes = deriveAxesFromVariants(competitor?.variants || []).filter((a) => a.values.length > 1);
  const allowedLookup = (name) => allowedAxes.find((a) => a.toLowerCase() === String(name).toLowerCase()) || null;
  const warnings = [];
  const taken = new Set();
  const axes = multi.map((axis) => {
    const paired = pairWithCompetitor(axis, competitorAxes, multi.length);
    const candidates = allowedAxes.length
      ? [
          ['exact', allowedLookup(axis.name)],
          ['competitor', paired ? allowedLookup(paired.name) : null],
          ['synonym', closestVariationAspect(axis.name, allowedAxes)],
          ['synonym', paired ? closestVariationAspect(paired.name, allowedAxes) : null],
        ]
      : [['competitor', paired?.name || null]];
    const hit = candidates.find(([, name]) => name && !taken.has(name.toLowerCase()));
    const ebayName = hit ? hit[1] : axis.name;
    taken.add(ebayName.toLowerCase());
    const blocked = blockedAxes.some((name) => name.toLowerCase() === axis.name.toLowerCase());
    const via = hit ? hit[0] : blocked ? 'unresolved' : allowedAxes.length ? 'custom' : 'source';
    if (via === 'unresolved') {
      warnings.push(
        `eBay doesn't allow "${axis.name}" as a variation in this category. Rename the attribute to one eBay suggests here ` +
          `(${allowedAxes.slice(0, 6).join(', ')}${allowedAxes.length > 6 ? '…' : ''}) or a name of your own, change the category, or list the options separately.`
      );
    } else if (via === 'custom') {
      warnings.push(`"${axis.name}" isn't one of the attributes eBay suggests for this category; it's listed as your own variation attribute.`);
    } else if (ebayName.toLowerCase() !== axis.name.toLowerCase()) {
      warnings.push(`The supplier's "${axis.name}" options are listed under "${ebayName}"${via === 'competitor' ? ', as the competitor does' : ''}.`);
    }
    return { name: axis.name, ebayName, values: axis.values, hasImages: Boolean(axis.hasImages), via };
  });

  return { axes, fixed, warnings };
}

module.exports = { planVariationAxes, closestVariationAspect, deriveAxesFromVariants, AXIS_SYNONYMS };
