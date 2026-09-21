const test = require('node:test');
const assert = require('node:assert');

const { applyDefaultBullets, cleanDashes, PROMPT_GUIDANCE } = require('../../src/modules/ai-generation/description-format');

// A fresh draft's list sections carry the editor's Check / Dot bullets even
// when the model leaves them off.
test('applyDefaultBullets adds ✓ to Suitable For and • to Package Includes', () => {
  const text =
    '**Rack – Kitchen Storage**\nIntro.\n\n**Key Features**\n📦 5 Tier – Holds lids.\n\n' +
    '**Suitable For**\nSmall kitchens\nCompact apartments\n\n' +
    '**Package Includes**\n1 × Rack\n1 × Fixings\n\n**Important:** Check your wall.\n\nClosing line.';
  assert.strictEqual(
    applyDefaultBullets(text),
    '**Rack – Kitchen Storage**\nIntro.\n\n**Key Features**\n📦 5 Tier – Holds lids.\n\n' +
      '**Suitable For**\n✓ Small kitchens\n✓ Compact apartments\n\n' +
      '**Package Includes**\n• 1 × Rack\n• 1 × Fixings\n\n**Important:** Check your wall.\n\nClosing line.'
  );
});

test('applyDefaultBullets keeps any marker already there and leaves other sections alone', () => {
  const text = '**Compatible With:**\n★ iPhone 15\nGalaxy S24\n2. Pixel 8\n\n**Available Sizes**\nS / M / L\n\nPlain paragraph.';
  assert.strictEqual(
    applyDefaultBullets(text),
    '**Compatible With:**\n★ iPhone 15\n✓ Galaxy S24\n2. Pixel 8\n\n**Available Sizes**\nS / M / L\n\nPlain paragraph.'
  );
});

test('applyDefaultBullets is a no-op on already-bulleted text and on empty input', () => {
  const done = '**Suitable For**\n✓ Dogs\n\n**Package Includes**\n• 1 × Mat';
  assert.strictEqual(applyDefaultBullets(done), done);
  assert.strictEqual(applyDefaultBullets(''), '');
  assert.strictEqual(applyDefaultBullets(undefined), undefined);
});

test('the layout asks for ✓ and • bullets in the list sections', () => {
  assert.match(PROMPT_GUIDANCE, /\*\*Suitable For\*\*: [^\n]*"✓ "/);
  assert.match(PROMPT_GUIDANCE, /\*\*Package Includes\*\*: [^\n]*"• "/);
  assert.match(PROMPT_GUIDANCE, /✓ Dogs\n✓ Cats/);
  assert.match(PROMPT_GUIDANCE, /• 1 × Pet Cooling Mat/);
});

// The seller wants no dashes as punctuation: separators become colons,
// other dashes commas, ranges "to". Hyphenated words and a chosen "–"
// bullet stay.
test('cleanDashes turns separator dashes into colons and the rest into commas', () => {
  const text =
    '**Pot Lid Rack – Smart Kitchen Organisation**\nA 5-tier wall-mounted rack — perfect for lids.\n\n' +
    '**Key Features**\n📐 Vertical Space Saver – Maximises space.\n〰️ Wavy Tiers — 6cm spacing.\n⏱️ Easy Install - Fixings provided.\n\n' +
    'Arrives in 2–4 days\nEnds with a dash –\n– A dash bullet the seller chose';
  assert.strictEqual(
    cleanDashes(text),
    '**Pot Lid Rack: Smart Kitchen Organisation**\nA 5-tier wall-mounted rack, perfect for lids.\n\n' +
      '**Key Features**\n📐 Vertical Space Saver: Maximises space.\n〰️ Wavy Tiers: 6cm spacing.\n⏱️ Easy Install: Fixings provided.\n\n' +
      'Arrives in 2 to 4 days\nEnds with a dash\n– A dash bullet the seller chose'
  );
});

test('cleanDashes leaves dash-free text and empty input untouched', () => {
  const clean = '**Key Features**\n📐 Saver: Maximises space.\n\n✓ Wall-mounted\n• 1 × Rack';
  assert.strictEqual(cleanDashes(clean), clean);
  assert.strictEqual(cleanDashes(''), '');
  assert.strictEqual(cleanDashes(null), null);
});

test('the layout forbids dashes and uses colons in its own examples', () => {
  assert.match(PROMPT_GUIDANCE, /NO DASHES/);
  assert.match(PROMPT_GUIDANCE, /❄️ Cooling Comfort: Helps/);
  assert.match(PROMPT_GUIDANCE, /\*\*Pet Cooling Mat For Dogs & Cats: Summer Heat Relief\*\*/);
  const example = PROMPT_GUIDANCE.slice(PROMPT_GUIDANCE.indexOf('Example of the layout'));
  assert.doesNotMatch(example.split('\n').slice(1).join('\n'), /[–—]| - /, 'the example itself has no dashes');
});
