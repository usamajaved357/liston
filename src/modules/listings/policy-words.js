// eBay's hazardous-materials block is an automated word match over the
// title, description, item specifics and variation names — it doesn't read
// the product. A carp rig described as "pairs with lead clips" is refused
// under the same rule as a can of petrol (seen live, rule 1122718). These
// are the words the filter is known to react to; the drafting model is told
// to write around them and a draft is scanned for them before it is
// published, so the seller hears about it here rather than from eBay.

const HAZMAT_TRIGGERS = [
  'lead', 'leadcore', 'lead-free', 'mercury', 'lithium', 'li-ion', 'battery', 'batteries', 'aerosol', 'flammable', 'explosive',
  'fireworks', 'gas', 'propane', 'butane', 'lighter', 'fuel', 'petrol', 'gasoline', 'diesel', 'paint', 'spray', 'solvent', 'thinner',
  'glue', 'adhesive', 'epoxy', 'resin', 'acid', 'bleach', 'chemical', 'pesticide', 'poison', 'toxic', 'corrosive', 'radioactive',
  'asbestos', 'magnet', 'magnets', 'neodymium', 'airbag', 'ammunition', 'gunpowder', 'charcoal', 'alcohol', 'ethanol', 'nitro',
  'oxidiser', 'oxidizer', 'peroxide', 'ammonia', 'chlorine', 'dry ice', 'compressed', 'pressurised', 'pressurized',
  'fluorocarbon', 'hydrofluorocarbon', 'refrigerant', 'r134a', 'r410a', 'freon', 'teflon', 'ptfe', 'lead core', 'sinker', 'sinkers',
  'solder', 'flux', 'kerosene', 'paraffin', 'turpentine', 'acetone', 'nail polish', 'perfume', 'cologne', 'hairspray', 'deodorant',
];
// Longer phrases first, so "lead-free" is seen as itself and not as "lead".
const HAZMAT_PATTERN = new RegExp(`\\b(${[...HAZMAT_TRIGGERS].sort((a, b) => b.length - a.length).map((w) => w.replace(/[-.]/g, '\\$&')).join('|')})\\b`, 'gi');

// Safer wording the model is pointed at for the words that come up most.
const SAFER_WORDING = {
  lead: 'weight (e.g. "weight clip", "eco-friendly" instead of "lead-free")',
  battery: 'only when the product genuinely is or contains one; otherwise "power", "rechargeable", "USB-powered"',
  gas: '"pressure", "air" or the specific medium',
  glue: '"fixing", "attachment"; "adhesive" only if the product is one',
  paint: '"finish", "coating", "colour"',
  spray: '"mist", "nozzle", "dispenser"',
  magnet: '"magnetic" (an adjective passes; the noun "magnet" is flagged)',
  chemical: '"formula", "treatment"',
};

function hazmatTriggersIn(draft) {
  const found = new Map();
  const scan = (where, text) => {
    for (const match of String(text || '').matchAll(HAZMAT_PATTERN)) {
      const word = match[1].toLowerCase();
      if (!found.has(word)) found.set(word, new Set());
      found.get(word).add(where);
    }
  };
  scan('the title', draft.commonTitle || draft.title);
  scan('the description', draft.commonDescription || draft.description);
  const aspects = Array.isArray(draft.variants) && draft.variants.length ? draft.variesBy?.aspects : draft.aspects;
  for (const [name, values] of Object.entries(aspects || {})) scan(`item specific "${name}"`, (values || []).join(' '));
  for (const spec of draft.variesBy?.specifications || []) scan(`the ${spec.name} options`, (spec.values || []).join(' '));
  return [...found].map(([word, places]) => `"${word}" in ${[...places].join(', ')}`);
}

// The rule as the drafting, refit and revision prompts state it.
const PROMPT_GUIDANCE =
  `eBay runs an automated hazardous-materials filter over listing text and refuses any listing containing these ` +
  `words, whatever the product: ${HAZMAT_TRIGGERS.join(', ')}. Never use any of them in the title, description, ` +
  `item specifics or option names unless the product genuinely IS that thing (a real battery, real glue). ` +
  `Write around them: ${Object.entries(SAFER_WORDING)
    .map(([word, safer]) => `${word} → ${safer}`)
    .join('; ')}.\n`;

// Replacement wording for the words that come up, used when the model
// leaves one in place. Anything not listed is simply taken out.
const REPLACEMENTS = {
  lead: 'weight',
  'lead-free': 'eco-friendly',
  leadcore: 'weighted core',
  'lead core': 'weighted core',
  sinker: 'weight',
  sinkers: 'weights',
  fluorocarbon: 'low-visibility',
  hydrofluorocarbon: 'low-visibility',
  ptfe: 'non-stick',
  teflon: 'non-stick',
  battery: 'power cell',
  batteries: 'power cells',
  lithium: 'rechargeable',
  'li-ion': 'rechargeable',
  magnet: 'magnetic clasp',
  magnets: 'magnetic clasps',
  neodymium: 'strong magnetic',
  glue: 'fixing',
  adhesive: 'self-fixing',
  epoxy: 'hard-set',
  resin: 'composite',
  paint: 'finish',
  spray: 'mist',
  gas: 'air',
  fuel: 'energy',
  chemical: 'formula',
  solvent: 'cleaner',
  acid: 'cleaning agent',
  alcohol: 'sanitiser',
  ethanol: 'sanitiser',
  charcoal: 'carbon',
  compressed: 'packed',
  pressurised: 'sealed',
  pressurized: 'sealed',
  lighter: 'igniter',
  flammable: 'heat-sensitive',
  toxic: 'harsh',
  poison: 'harmful',
  corrosive: 'harsh',
  perfume: 'fragrance',
  cologne: 'fragrance',
  deodorant: 'body care',
  hairspray: 'hair styling',
};

function replaceWord(text, word) {
  const replacement = REPLACEMENTS[word.toLowerCase()];
  const pattern = new RegExp(`\\b${word.replace(/[-.]/g, '\\$&')}\\b`, 'gi');
  const swapped = String(text).replace(pattern, (match) => {
    if (replacement === undefined) return '';
    // Keep the casing the word had.
    if (match === match.toUpperCase() && match.length > 1) return replacement.toUpperCase();
    if (match[0] === match[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
    return replacement;
  });
  return swapped.replace(/[ \t]{2,}/g, ' ').replace(/ ([,.;:])/g, '$1').trim();
}

// Every trigger word swapped for safe wording (or dropped) across a draft's
// title, description, item specifics and option names. Returns the new
// values only where something changed.
function scrubDraft(draft) {
  const words = [...new Set([...String(`${draft.commonTitle || draft.title || ''} ${draft.commonDescription || draft.description || ''}`).matchAll(HAZMAT_PATTERN)].map((m) => m[1].toLowerCase()))];
  const scrub = (text) => {
    let out = String(text ?? '');
    // One pass over the words present up front: a replacement is never
    // itself re-scanned, so "eco-friendly" for "lead-free" stays put.
    for (const m of new Set([...out.matchAll(HAZMAT_PATTERN)].map((x) => x[1].toLowerCase()))) out = replaceWord(out, m);
    return out;
  };
  const isVariation = Array.isArray(draft.variants) && draft.variants.length > 0;
  const changes = {};
  const titleKey = isVariation ? 'commonTitle' : 'title';
  const descKey = isVariation ? 'commonDescription' : 'description';
  const title = scrub(draft[titleKey]);
  if (title !== (draft[titleKey] || '')) changes[titleKey] = title.slice(0, 80);
  const description = scrub(draft[descKey]);
  if (description !== (draft[descKey] || '')) changes[descKey] = description;
  const aspects = isVariation ? draft.variesBy?.aspects : draft.aspects;
  if (aspects) {
    let touched = false;
    const next = {};
    for (const [name, values] of Object.entries(aspects)) {
      const scrubbed = (values || []).map((v) => scrub(v)).filter(Boolean);
      if (scrubbed.join('\u0000') !== (values || []).join('\u0000')) touched = true;
      if (scrubbed.length) next[name] = scrubbed;
    }
    if (touched) changes.aspects = next;
  }
  const renames = [];
  for (const spec of draft.variesBy?.specifications || []) {
    for (const value of spec.values || []) {
      const to = scrub(value);
      if (to && to !== value) renames.push({ axis: spec.name, from: value, to: to.slice(0, 50) });
    }
  }
  if (renames.length) changes.renameAxisValues = renames;
  return { changes, words };
}

module.exports = { HAZMAT_TRIGGERS, hazmatTriggersIn, PROMPT_GUIDANCE, REPLACEMENTS, replaceWord, scrubDraft };
