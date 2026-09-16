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
