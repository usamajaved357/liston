// Holds the model's item specifics to eBay's published schema for the target
// category, rather than trusting them and finding out at publish time.
//
// Deliberately forgiving in one direction and strict in the other: we drop or
// correct what eBay would reject, but we never invent a value to fill a
// required aspect — a fabricated "Brand: Unbranded" on a branded item is
// worse than a flagged gap the seller can see on the review page.

function normalizeForCompare(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

// eBay's SELECTION aspects accept only their own listed values, but the model
// (and the supplier's spec sheet) routinely differ by case or spacing —
// "cold white" vs "Cold White". Match loosely, then emit eBay's exact spelling.
function matchAllowedValue(value, allowedValues) {
  const target = normalizeForCompare(value);
  return allowedValues.find((allowed) => normalizeForCompare(allowed) === target) || null;
}

/**
 * @param aspects  the model's output, { aspectName: [value, ...] }
 * @param schema   summarizeAspects() output, or null when unavailable
 * @returns { aspects, warnings } — corrected aspects plus human-readable
 *          notes for the review page. With no schema, input passes through.
 */
function validateAspects(aspects, schema) {
  if (!schema) return { aspects: aspects || {}, warnings: [] };

  const byName = new Map(schema.map((entry) => [normalizeForCompare(entry.name), entry]));
  const validated = {};
  const warnings = [];
  const custom = [];

  for (const [name, rawValues] of Object.entries(aspects || {})) {
    const entry = byName.get(normalizeForCompare(name));
    if (!entry) {
      // Not in eBay's schema, but eBay accepts seller-defined item specifics
      // beyond it — a live competitor in "Other GPS & Sat Nav Devices" carries
      // 25 of them (Battery life, Compatible Devices…). Dropping these threw
      // away exactly the spec parity the seller asked for, and they're what
      // buyers filter on. Kept as custom specifics, tidied to eBay's limits:
      // one value, name and value each ≤65 characters, no trailing colon.
      const customName = String(name).replace(/\s*:\s*$/, '').trim().slice(0, 65);
      const customValues = (Array.isArray(rawValues) ? rawValues : [rawValues]).map((v) => String(v).trim().slice(0, 65)).filter(Boolean);
      if (customName && customValues.length) {
        validated[customName] = [customValues[0]];
        custom.push(customName);
      }
      continue;
    }

    const values = (Array.isArray(rawValues) ? rawValues : [rawValues]).map(String).filter(Boolean);
    if (!values.length) continue;

    let finalValues = values;

    if (entry.selectionOnly && entry.allowedValues.length && !entry.hasMoreValues) {
      const matched = values.map((value) => matchAllowedValue(value, entry.allowedValues)).filter(Boolean);
      if (!matched.length) {
        warnings.push(
          `Dropped "${entry.name}" — eBay only accepts specific values here and "${values[0]}" isn't one of them.`
        );
        continue;
      }
      if (matched.length < values.length) {
        warnings.push(`Some "${entry.name}" values weren't accepted by eBay and were removed.`);
      }
      finalValues = matched;
    }

    // A single-value aspect given several values is rejected outright, so
    // keep the first rather than losing the aspect entirely.
    if (!entry.multiValue && finalValues.length > 1) {
      warnings.push(`"${entry.name}" only accepts one value on eBay. Kept "${finalValues[0]}".`);
      finalValues = [finalValues[0]];
    }

    validated[entry.name] = finalValues;
  }

  const missingRequired = schema
    .filter((entry) => entry.required && !(entry.name in validated))
    .map((entry) => entry.name);

  if (missingRequired.length) {
    warnings.push(
      `eBay requires ${missingRequired.length === 1 ? 'this item specific' : 'these item specifics'} for this ` +
        `category and ${missingRequired.length === 1 ? 'it is' : 'they are'} still empty: ${missingRequired.join(', ')}.`
    );
  }

  return { aspects: validated, warnings, missingRequired };
}

// The prompt-side half: a compact rendering of the schema the model must
// fill. Required aspects first, since those are the ones that block a publish.
function describeSchemaForPrompt(schema) {
  if (!schema || !schema.length) return null;

  const ordered = [...schema].sort((a, b) => Number(b.required) - Number(a.required));
  const lines = ordered.slice(0, 40).map((entry) => {
    const parts = [entry.required ? 'REQUIRED' : 'optional'];
    if (entry.multiValue) parts.push('accepts multiple values');
    if (entry.selectionOnly) {
      parts.push(
        entry.allowedValues.length
          ? `must be one of: ${entry.allowedValues.join(', ')}${entry.hasMoreValues ? ', …' : ''}`
          : 'must be one of eBay’s listed values'
      );
    }
    return `- ${entry.name} (${parts.join('; ')})`;
  });

  return lines.join('\n');
}

// Product identifiers eBay marks required in many categories but accepts
// an explicit "not applicable" for — its own sanctioned value, not an
// invented one. Anything else that's required and missing is a real gap
// the seller has to fill.
const NOT_APPLICABLE = {
  'manufacturer part number': 'Does Not Apply',
  mpn: 'Does Not Apply',
  upc: 'Does not apply',
  ean: 'Does not apply',
  isbn: 'Does not apply',
  gtin: 'Does not apply',
};

/**
 * Readies a draft's item specifics for eBay:
 *  - a variation listing's shared specifics must not repeat a variation
 *    attribute (eBay: "Variation Specifics and Item Specifics ... should be
 *    different"), so any axis name is removed from the shared set;
 *  - a required identifier with no value gets eBay's "Does Not Apply".
 * Returns the corrected specifics and the names of required aspects that
 * are still empty (an axis counts as filled).
 */
function prepareAspectsForEbay(aspects, schema, variationAxes = []) {
  const axes = new Set(variationAxes.map(normalizeForCompare));
  const prepared = {};
  const removedAxes = [];
  for (const [name, values] of Object.entries(aspects || {})) {
    if (axes.has(normalizeForCompare(name))) {
      removedAxes.push(name);
      continue;
    }
    const list = (Array.isArray(values) ? values : [values]).map((v) => String(v ?? '').trim()).filter(Boolean);
    if (list.length) prepared[name] = list;
  }

  const filled = [];
  const missing = [];
  for (const entry of schema || []) {
    if (!entry.required) continue;
    const key = normalizeForCompare(entry.name);
    if (axes.has(key)) continue;
    const has = Object.keys(prepared).some((name) => normalizeForCompare(name) === key);
    if (has) continue;
    if (NOT_APPLICABLE[key]) {
      prepared[entry.name] = [NOT_APPLICABLE[key]];
      filled.push(entry.name);
    } else {
      missing.push(entry.name);
    }
  }
  return { aspects: prepared, removedAxes, filled, missing };
}

// ---------------------------------------------------------------------------
// Variation option values.
//
// eBay has started refusing custom values on aspects its Taxonomy API still
// reports as FREE_TEXT: Men's Trousers rejected "XXL" at publish ("no longer
// support custom values for Size") while listing the size as "2XL". So the
// schema's `selectionOnly` flag can't be trusted to say when a value must be
// eBay's own; whenever eBay publishes a value list for an axis, an option
// that plainly means one of them is sent under eBay's spelling.

const SIZE_WORDS = new Map([
  ['extra extra small', '2XS'],
  ['extra small', 'XS'],
  ['small', 'S'],
  ['medium', 'M'],
  ['large', 'L'],
  ['extra large', 'XL'],
  ['extra extra large', '2XL'],
  ['one size', 'One Size'],
  ['one size fits all', 'One Size'],
  ['free size', 'One Size'],
  ['os', 'One Size'],
]);

// Other spellings of the same size, most likely first: "XXL" -> ["2XL"],
// "2XL" -> ["XXL"], "XX-Large" -> ["2XL", "XXL"], "Extra Large" -> ["XL"].
function sizeAliases(value) {
  const raw = String(value ?? '').trim();
  const out = [];
  const add = (v) => {
    if (v && normalizeForCompare(v) !== normalizeForCompare(raw) && !out.includes(v)) out.push(v);
  };
  const word = SIZE_WORDS.get(normalizeForCompare(raw).replace(/[-_]/g, ' ').replace(/\s+/g, ' '));
  if (word) add(word);

  // "XX-Large" / "3X Large" / "xxlarge" -> a letter form first.
  const compact = raw.replace(/[\s_-]+/g, '').toUpperCase();
  let letters = compact;
  const worded = /^(\d*)(X*)(LARGE|SMALL)$/.exec(compact);
  if (worded) letters = `${worded[1]}${worded[2]}${worded[3][0]}`;

  // A run of X's <-> a count: XXL <-> 2XL.
  let m = /^(X{2,})(L|S)$/.exec(letters);
  if (m) add(`${m[1].length}X${m[2]}`);
  m = /^(\d+)X(L|S)$/.exec(letters);
  if (m && Number(m[1]) >= 2 && Number(m[1]) <= 10) add('X'.repeat(Number(m[1])) + m[2]);
  if (letters !== compact) add(letters);
  return out;
}

// eBay's spelling of an option value, or null when nothing on its list
// plainly means the same thing.
function canonicalAxisValue(value, allowedValues) {
  if (!Array.isArray(allowedValues) || !allowedValues.length) return null;
  const direct = matchAllowedValue(value, allowedValues);
  if (direct) return direct;
  for (const alias of sizeAliases(value)) {
    const hit = matchAllowedValue(alias, allowedValues);
    if (hit) return hit;
  }
  return null;
}

/**
 * Rewrites a variation draft's option values to eBay's own spelling where
 * eBay lists values for that axis. Works on copies; the stored draft is the
 * caller's business.
 * @returns { specifications, variants, renamed: [{ axis, from, to }],
 *            unmatched: [{ axis, value, allowedValues, selectionOnly }] }
 *          `unmatched` names values eBay lists nothing for; with a full
 *          selection-only list that is a certain rejection, otherwise eBay
 *          may or may not accept it.
 */
function canonicalizeVariationValues({ specifications = [], variants = [] }, schema) {
  const renamed = [];
  const unmatched = [];
  if (!schema || !specifications.length) return { specifications, variants, renamed, unmatched };

  const byName = new Map(schema.map((entry) => [normalizeForCompare(entry.name), entry]));
  const renames = new Map(); // axis -> Map(from -> to)

  for (const spec of specifications) {
    const entry = byName.get(normalizeForCompare(spec.name));
    if (!entry || !entry.allowedValues?.length) continue;
    const taken = new Set((spec.values || []).map(normalizeForCompare));
    const map = new Map();
    for (const value of spec.values || []) {
      const to = canonicalAxisValue(value, entry.allowedValues);
      if (!to) {
        if (!entry.hasMoreValues) unmatched.push({ axis: spec.name, value, allowedValues: entry.allowedValues, selectionOnly: entry.selectionOnly });
        continue;
      }
      if (to === value) continue;
      // "XXL" and "2XL" both present would collapse into one option; leave
      // that for the duplicate check to report rather than silently merge.
      if (normalizeForCompare(to) !== normalizeForCompare(value) && taken.has(normalizeForCompare(to))) continue;
      map.set(value, to);
      renamed.push({ axis: spec.name, from: value, to });
    }
    if (map.size) renames.set(spec.name, map);
  }

  if (!renames.size) return { specifications, variants, renamed, unmatched };

  const outSpecs = specifications.map((spec) => {
    const map = renames.get(spec.name);
    return map ? { ...spec, values: spec.values.map((v) => map.get(v) ?? v) } : spec;
  });
  const outVariants = variants.map((variant) => {
    let aspects = variant.aspects;
    for (const [axis, map] of renames) {
      const current = aspects?.[axis]?.[0];
      if (current !== undefined && map.has(current)) aspects = { ...aspects, [axis]: [map.get(current)] };
    }
    return aspects === variant.aspects ? variant : { ...variant, aspects };
  });
  return { specifications: outSpecs, variants: outVariants, renamed, unmatched };
}

module.exports = {
  validateAspects,
  describeSchemaForPrompt,
  matchAllowedValue,
  prepareAspectsForEbay,
  sizeAliases,
  canonicalAxisValue,
  canonicalizeVariationValues,
};
