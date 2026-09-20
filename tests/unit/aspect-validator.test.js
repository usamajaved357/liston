const test = require('node:test');
const assert = require('node:assert');

const { validateAspects, describeSchemaForPrompt, matchAllowedValue } = require('../../src/modules/ai-generation/aspect-validator');

// Shaped like ebay.taxonomy.summarizeAspects() output. Values here mirror a
// real EBAY_GB "Night Lights" (20702) schema read live during implementation:
// exactly one required aspect (Type), a free-text Brand, and fixed-list
// aspects alongside it.
const SCHEMA = [
  { name: 'Type', required: true, selectionOnly: false, multiValue: false, allowedValues: [], hasMoreValues: false },
  { name: 'Brand', required: false, selectionOnly: false, multiValue: false, allowedValues: [], hasMoreValues: false },
  {
    name: 'Colour',
    required: false,
    selectionOnly: true,
    multiValue: false,
    allowedValues: ['White', 'Black', 'Silver'],
    hasMoreValues: false,
  },
  {
    name: 'Features',
    required: false,
    selectionOnly: true,
    multiValue: true,
    allowedValues: ['Dimmable', 'Motion Sensor', 'Rechargeable'],
    hasMoreValues: false,
  },
];

test('validateAspects passes input straight through when no schema is available', () => {
  const input = { Anything: ['goes'] };
  const result = validateAspects(input, null);
  assert.deepStrictEqual(result.aspects, input);
  assert.deepStrictEqual(result.warnings, []);
});

test('validateAspects corrects aspect-name casing to eBay spelling', () => {
  const result = validateAspects({ type: ['Night light'], brand: ['Acme'] }, SCHEMA);
  assert.deepStrictEqual(result.aspects, { Type: ['Night light'], Brand: ['Acme'] });
});

// eBay accepts seller-defined specifics beyond the category schema, and a
// competitor's extra specifics are what buyers filter on — so they're kept as
// custom specifics (one value, tidied) rather than dropped.
test('validateAspects keeps an aspect eBay does not list as a custom specific', () => {
  const result = validateAspects({ Type: ['Lamp'], 'Battery life:': ['365 days', '1 year'] }, SCHEMA);
  assert.deepStrictEqual(result.aspects['Battery life'], ['365 days']);
  assert.ok(!result.warnings.some((w) => /Battery life/.test(w)), 'kept silently — the table shows it');
});

test('validateAspects keeps only one value for a single-value aspect', () => {
  const result = validateAspects({ Type: ['Lamp'], Colour: ['White', 'Black'] }, SCHEMA);
  assert.deepStrictEqual(result.aspects.Colour, ['White']);
  assert.match(result.warnings.join(' '), /only accepts one value/);
});

test('validateAspects keeps every value for a multi-value aspect', () => {
  const result = validateAspects({ Type: ['Lamp'], Features: ['Dimmable', 'Rechargeable'] }, SCHEMA);
  assert.deepStrictEqual(result.aspects.Features, ['Dimmable', 'Rechargeable']);
});

test('validateAspects matches fixed-list values loosely but emits eBay exact spelling', () => {
  const result = validateAspects({ Type: ['Lamp'], Colour: ['  white '] }, SCHEMA);
  assert.deepStrictEqual(result.aspects.Colour, ['White']);
});

test('validateAspects drops a fixed-list value eBay would reject', () => {
  const result = validateAspects({ Type: ['Lamp'], Colour: ['Neon Pink'] }, SCHEMA);
  assert.ok(!('Colour' in result.aspects));
  assert.match(result.warnings.join(' '), /only accepts specific values/);
});

test('validateAspects leaves a fixed-list aspect alone when eBay has more values than we were shown', () => {
  // With a truncated value list, an unmatched value may still be perfectly
  // valid — dropping it would lose a correct aspect.
  const truncated = [{ ...SCHEMA[2], hasMoreValues: true }];
  const result = validateAspects({ Colour: ['Rose Gold'] }, truncated);
  assert.deepStrictEqual(result.aspects.Colour, ['Rose Gold']);
});

test('validateAspects reports a missing required aspect instead of inventing one', () => {
  const result = validateAspects({ Brand: ['Acme'] }, SCHEMA);
  assert.deepStrictEqual(result.missingRequired, ['Type']);
  assert.match(result.warnings.join(' '), /still empty: Type/);
  // Crucially it does NOT fabricate a value to clear the gap.
  assert.ok(!('Type' in result.aspects));
});

test('validateAspects ignores empty value arrays', () => {
  const result = validateAspects({ Type: ['Lamp'], Brand: [] }, SCHEMA);
  assert.ok(!('Brand' in result.aspects));
});

test('describeSchemaForPrompt lists required aspects first and names allowed values', () => {
  const text = describeSchemaForPrompt(SCHEMA);
  assert.match(text.split('\n')[0], /^- Type \(REQUIRED\)/);
  assert.match(text, /must be one of: White, Black, Silver/);
  assert.match(text, /accepts multiple values/);
});

test('describeSchemaForPrompt returns null when there is no schema', () => {
  assert.strictEqual(describeSchemaForPrompt(null), null);
  assert.strictEqual(describeSchemaForPrompt([]), null);
});

test('matchAllowedValue is case and whitespace insensitive', () => {
  assert.strictEqual(matchAllowedValue(' BLACK ', ['White', 'Black']), 'Black');
  assert.strictEqual(matchAllowedValue('green', ['White', 'Black']), null);
});

// --- readiness for eBay ------------------------------------------------------

const { prepareAspectsForEbay } = require('../../src/modules/ai-generation/aspect-validator');

test('prepareAspectsForEbay drops a variation attribute from the shared specifics', () => {
  const schema = [{ name: 'Colour', required: true, variation: true }, { name: 'Brand', required: true }];
  const { aspects, removedAxes, missing } = prepareAspectsForEbay({ Colour: ['Black'], colour: ['Red'], Brand: ['Acme'] }, schema, ['Colour']);
  assert.deepStrictEqual(aspects, { Brand: ['Acme'] });
  assert.deepStrictEqual(removedAxes, ['Colour', 'colour']);
  assert.deepStrictEqual(missing, [], 'an axis satisfies its own required aspect');
});

test('prepareAspectsForEbay fills a missing required identifier with eBay\'s "Does Not Apply", nothing else', () => {
  const schema = [
    { name: 'Manufacturer Part Number', required: true },
    { name: 'UPC', required: true },
    { name: 'Brand', required: true },
    { name: 'Material', required: false },
  ];
  const { aspects, filled, missing } = prepareAspectsForEbay({ Material: ['Steel'] }, schema, []);
  assert.deepStrictEqual(aspects, { Material: ['Steel'], 'Manufacturer Part Number': ['Does Not Apply'], UPC: ['Does not apply'] });
  assert.deepStrictEqual(filled, ['Manufacturer Part Number', 'UPC']);
  assert.deepStrictEqual(missing, ['Brand'], 'a required non-identifier is reported, never invented');
});

test('prepareAspectsForEbay keeps a seller-entered identifier and tidies empty values', () => {
  const schema = [{ name: 'Manufacturer Part Number', required: true }];
  const { aspects, filled } = prepareAspectsForEbay({ 'Manufacturer Part Number': ['AB-123'], Notes: [''] }, schema, []);
  assert.deepStrictEqual(aspects, { 'Manufacturer Part Number': ['AB-123'] });
  assert.deepStrictEqual(filled, []);
});

test('prepareAspectsForEbay without a schema still applies the axis rule', () => {
  const { aspects, missing } = prepareAspectsForEbay({ Size: ['M'], Brand: ['Acme'] }, null, ['Size']);
  assert.deepStrictEqual(aspects, { Brand: ['Acme'] });
  assert.deepStrictEqual(missing, []);
});

// ---------------------------------------------------------------------------
// Variation option values. The Size list mirrors EBAY_GB "Men's Trousers"
// (57989) read live: eBay's Taxonomy API still called it FREE_TEXT while
// publish refused "XXL" with "no longer support custom values for Size".
const { sizeAliases, canonicalAxisValue, canonicalizeVariationValues } = require('../../src/modules/ai-generation/aspect-validator');

const TROUSERS = [
  {
    name: 'Size',
    required: true,
    selectionOnly: false,
    variation: true,
    allowedValues: ['2XS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '30', '32', 'One Size'],
    hasMoreValues: false,
  },
  { name: 'Colour', required: true, selectionOnly: false, variation: true, allowedValues: ['Black', 'Blue', 'Grey'], hasMoreValues: false },
];

test('sizeAliases spells a size the other ways eBay might list it', () => {
  assert.deepStrictEqual(sizeAliases('XXL'), ['2XL']);
  assert.deepStrictEqual(sizeAliases('xxxl'), ['3XL']);
  assert.deepStrictEqual(sizeAliases('2XL'), ['XXL']);
  assert.deepStrictEqual(sizeAliases('XX-Large'), ['2XL', 'XXL']);
  assert.deepStrictEqual(sizeAliases('Extra Large'), ['XL']);
  assert.deepStrictEqual(sizeAliases('One size fits all'), ['One Size']);
  assert.deepStrictEqual(sizeAliases('M'), []);
  assert.deepStrictEqual(sizeAliases('32'), []);
});

test('canonicalAxisValue prefers eBay spelling, exact first, then a size alias', () => {
  assert.strictEqual(canonicalAxisValue('m', TROUSERS[0].allowedValues), 'M');
  assert.strictEqual(canonicalAxisValue('XXL', TROUSERS[0].allowedValues), '2XL');
  assert.strictEqual(canonicalAxisValue('XXXXL', TROUSERS[0].allowedValues), '4XL');
  assert.strictEqual(canonicalAxisValue('Extra Large', TROUSERS[0].allowedValues), 'XL');
  assert.strictEqual(canonicalAxisValue('Petite', TROUSERS[0].allowedValues), null);
  assert.strictEqual(canonicalAxisValue('XXL', []), null);
});

test('canonicalizeVariationValues renames options and every variant using them', () => {
  const draft = {
    specifications: [
      { name: 'Colour', values: ['Grey', 'Navy'] },
      { name: 'Size', values: ['S', 'M', 'L', 'XL', 'XXL'] },
    ],
    variants: [
      { aspects: { Colour: ['Grey'], Size: ['XL'] } },
      { aspects: { Colour: ['Grey'], Size: ['XXL'] } },
      { aspects: { Colour: ['Navy'], Size: ['XXL'] } },
    ],
  };
  const out = canonicalizeVariationValues(draft, TROUSERS);
  assert.deepStrictEqual(out.specifications[1].values, ['S', 'M', 'L', 'XL', '2XL']);
  assert.deepStrictEqual(out.variants.map((v) => v.aspects.Size[0]), ['XL', '2XL', '2XL']);
  assert.deepStrictEqual(out.renamed, [{ axis: 'Size', from: 'XXL', to: '2XL' }]);
  // Navy isn't on eBay's Colour list; on a free-text axis that's reported,
  // not refused, and left as the seller wrote it.
  assert.deepStrictEqual(out.specifications[0].values, ['Grey', 'Navy']);
  assert.deepStrictEqual(out.unmatched.map((u) => [u.axis, u.value, u.selectionOnly]), [['Colour', 'Navy', false]]);
  // Inputs untouched.
  assert.deepStrictEqual(draft.specifications[1].values, ['S', 'M', 'L', 'XL', 'XXL']);
  assert.deepStrictEqual(draft.variants[1].aspects.Size, ['XXL']);
});

test('canonicalizeVariationValues never merges two options into one', () => {
  const out = canonicalizeVariationValues(
    {
      specifications: [{ name: 'Size', values: ['2XL', 'XXL'] }],
      variants: [{ aspects: { Size: ['2XL'] } }, { aspects: { Size: ['XXL'] } }],
    },
    TROUSERS
  );
  assert.deepStrictEqual(out.specifications[0].values, ['2XL', 'XXL']);
  assert.deepStrictEqual(out.renamed, []);
});

test('canonicalizeVariationValues passes through without a schema or a value list', () => {
  const draft = { specifications: [{ name: 'Model', values: ['iPhone 15'] }], variants: [{ aspects: { Model: ['iPhone 15'] } }] };
  assert.deepStrictEqual(canonicalizeVariationValues(draft, null), { ...draft, renamed: [], unmatched: [] });
  assert.deepStrictEqual(canonicalizeVariationValues(draft, [{ name: 'Model', allowedValues: [] }]), { ...draft, renamed: [], unmatched: [] });
});
