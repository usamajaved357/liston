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
const HAZMAT_PATTERN = new RegExp(`\\b(${HAZMAT_TRIGGERS.map((w) => w.replace(/[-.]/g, '\\$&')).join('|')})\\b`, 'gi');

// Safer wording the model is pointed at for the words that come up most.
const SAFER_WORDING = {
  lead: 'weight (e.g. "weight clip", "non-toxic" instead of "lead-free")',
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

module.exports = { HAZMAT_TRIGGERS, hazmatTriggersIn, PROMPT_GUIDANCE };
