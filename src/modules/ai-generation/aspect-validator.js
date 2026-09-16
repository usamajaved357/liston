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
      warnings.push(`"${entry.name}" only accepts one value on eBay — kept "${finalValues[0]}".`);
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

module.exports = { validateAspects, describeSchemaForPrompt, matchAllowedValue };
