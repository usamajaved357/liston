const test = require('node:test');
const assert = require('node:assert');
const { hazmatTriggersIn, PROMPT_GUIDANCE, HAZMAT_TRIGGERS } = require('../../src/modules/listings/policy-words');

test('hazmatTriggersIn names each trigger word once, with everywhere it appears', () => {
  const found = hazmatTriggersIn({
    commonTitle: 'Carp Hooklink Braid',
    commonDescription: 'Lead-free braid for lead clips. Magnetic keeper included.',
    variants: [{}],
    variesBy: { aspects: { Material: ['Braided Wire'] }, specifications: [{ name: 'Colour', values: ['Camo Brown', 'Lead Grey'] }] },
  });
  assert.deepStrictEqual(found, ['"lead-free" in the description', '"lead" in the description, the Colour options']);
});

test('hazmatTriggersIn matches whole words only', () => {
  assert.deepStrictEqual(hazmatTriggersIn({ title: 'Leader line for leading brands, gasket set', description: '' }), []);
});

test('the prompt guidance lists every trigger word', () => {
  for (const word of HAZMAT_TRIGGERS) assert.ok(PROMPT_GUIDANCE.includes(word), word);
});
