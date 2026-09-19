const test = require('node:test');
const assert = require('node:assert');
const { planVariationAxes } = require('../../src/modules/ai-generation/variation-plan');

// The endoscope that went wrong: the supplier varies by Color (one option),
// Cable Length (five) and Voltage/Plug Type (one); the competitor is live in
// Endoscopes varying by "size" (1, 1.5, 2); eBay lets that category vary by
// View Angle, Endoscope Length and MPN.
const source = {
  variantAxes: [
    { name: 'Color', values: ['Type-C 7mm'], hasImages: true },
    { name: 'Cable Length', values: ['1m', '1.5m', '2m', '3m', '5m'], hasImages: false },
    { name: 'Voltage/Plug Type', values: ['USB Type-C'], hasImages: false },
  ],
  variants: ['1m', '1.5m', '2m', '3m', '5m'].map((len) => ({ attributes: { Color: 'Type-C 7mm', 'Cable Length': len, 'Voltage/Plug Type': 'USB Type-C' }, imageUrl: 'https://x/a.jpg' })),
};
const competitor = { variants: ['1', '2', '1.5'].map((size) => ({ attributes: { size } })) };
const allowed = ['View Angle', 'Endoscope Length', 'MPN'];

test('single-option axes become fixed attributes; the real choice is renamed to what eBay allows', () => {
  const plan = planVariationAxes({ source, competitor, allowedAxes: allowed });
  assert.deepStrictEqual(plan.fixed, { Color: 'Type-C 7mm', 'Voltage/Plug Type': 'USB Type-C' });
  assert.strictEqual(plan.axes.length, 1);
  assert.deepStrictEqual({ name: plan.axes[0].name, ebayName: plan.axes[0].ebayName, via: plan.axes[0].via }, { name: 'Cable Length', ebayName: 'Endoscope Length', via: 'synonym' });
  assert.deepStrictEqual(plan.axes[0].values, ['1m', '1.5m', '2m', '3m', '5m']);
});

test('the competitor’s axis name is used when eBay allows it in the category', () => {
  const plan = planVariationAxes({ source, competitor, allowedAxes: ['Size', 'Colour', 'MPN'] });
  assert.deepStrictEqual(plan.axes.map((a) => [a.ebayName, a.via]), [['Size', 'competitor']]);
  assert.ok(plan.warnings[0].includes('as the competitor does'));
});

test('an exact allowed name wins over the competitor’s', () => {
  const plan = planVariationAxes({ source, competitor, allowedAxes: ['Cable Length', 'Size'] });
  assert.deepStrictEqual(plan.axes.map((a) => [a.ebayName, a.via]), [['Cable Length', 'exact']]);
});

test('with no competitor and no allowed list, the supplier’s names stand', () => {
  const plan = planVariationAxes({ source, competitor: null, allowedAxes: [] });
  assert.deepStrictEqual(plan.axes.map((a) => [a.ebayName, a.via]), [['Cable Length', 'source']]);
  assert.deepStrictEqual(plan.warnings, []);
});

test('a name eBay does not list is kept as the seller’s own attribute, with a note', () => {
  const plan = planVariationAxes({ source, competitor: null, allowedAxes: ['View Angle', 'MPN'] });
  assert.deepStrictEqual(plan.axes.map((a) => [a.ebayName, a.via]), [['Cable Length', 'custom']]);
  assert.match(plan.warnings[0], /isn't one of the attributes eBay suggests/);
});

test('an item specific eBay refuses to vary by is kept and the gap is reported for the editor to resolve', () => {
  const plan = planVariationAxes({ source, competitor: null, allowedAxes: ['View Angle', 'MPN'], blockedAxes: ['Cable Length', 'Unit Quantity'] });
  assert.deepStrictEqual(plan.axes.map((a) => [a.ebayName, a.via]), [['Cable Length', 'unresolved']]);
  assert.match(plan.warnings[0], /doesn't allow "Cable Length"/);
});

test('two axes never resolve to the same eBay name, and the seller’s selection shapes the plan', () => {
  const src = {
    variantAxes: [
      { name: 'Color', values: ['Black', 'Red'] },
      { name: 'Shade', values: ['Matte', 'Gloss'] },
    ],
    variants: [
      { attributes: { Color: 'Black', Shade: 'Matte' } },
      { attributes: { Color: 'Black', Shade: 'Gloss' } },
      { attributes: { Color: 'Red', Shade: 'Matte' } },
    ],
  };
  const plan = planVariationAxes({ source: src, competitor: null, allowedAxes: ['Colour', 'Finish'], blockedAxes: ['Shade'] });
  assert.deepStrictEqual(plan.axes.map((a) => [a.name, a.ebayName, a.via]), [['Color', 'Colour', 'synonym'], ['Shade', 'Shade', 'unresolved']]);

  // After the seller keeps only Black, Color has one option left: fixed.
  const selected = { ...src, variants: src.variants.filter((v) => v.attributes.Color === 'Black') };
  const plan2 = planVariationAxes({ source: selected, competitor: null, allowedAxes: ['Colour', 'Finish'] });
  assert.deepStrictEqual(plan2.fixed, { Color: 'Black' });
  assert.deepStrictEqual(plan2.axes.map((a) => a.name), ['Shade']);
});
