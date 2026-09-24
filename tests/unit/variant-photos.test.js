const test = require('node:test');
const assert = require('node:assert');

const { photoAxis, alignVariantPhotos } = require('../../src/modules/listings/variant-photos');

// A Colour × Size draft: Red comes in S and M, Blue in S.
function colourBySize({ imageAxis = [], red = ['https://i.ebayimg.com/red.jpg'], redM = red, blue = ['https://i.ebayimg.com/blue.jpg'] } = {}) {
  return {
    variesBy: {
      aspectsImageVariesBy: imageAxis,
      specifications: [
        { name: 'Size', values: ['S', 'M'] },
        { name: 'Colour', values: ['Red', 'Blue'] },
      ],
    },
    variants: [
      { aspects: { Size: ['S'], Colour: ['Red'] }, imageUrls: red },
      { aspects: { Size: ['M'], Colour: ['Red'] }, imageUrls: redM },
      { aspects: { Size: ['S'], Colour: ['Blue'] }, imageUrls: blue },
    ],
  };
}

test('photos follow the attribute the draft names, else a colour-like one, else the only one', () => {
  assert.strictEqual(photoAxis(colourBySize({ imageAxis: ['Size'] })), 'Size');
  assert.strictEqual(photoAxis(colourBySize()), 'Colour');
  assert.strictEqual(photoAxis({ variesBy: { specifications: [{ name: 'Size', values: ['S'] }] } }), 'Size');
  assert.strictEqual(photoAxis({ variesBy: { specifications: [{ name: 'Model', values: ['A'] }, { name: 'Length', values: ['1m'] }] } }), 'Model');
  assert.strictEqual(photoAxis({}), null);
});

test('a photo set on one row goes to every row of that colour, and eBay is told photos follow Colour', () => {
  const draft = colourBySize({ redM: ['https://i.ebayimg.com/new-red.jpg'] });
  const aligned = alignVariantPhotos(draft, ['1']);

  assert.deepStrictEqual(
    aligned.variants.map((v) => v.imageUrls[0]),
    ['https://i.ebayimg.com/new-red.jpg', 'https://i.ebayimg.com/new-red.jpg', 'https://i.ebayimg.com/blue.jpg']
  );
  assert.deepStrictEqual(aligned.variesBy.aspectsImageVariesBy, ['Colour']);
  // The draft passed in is left as it was.
  assert.strictEqual(draft.variants[0].imageUrls[0], 'https://i.ebayimg.com/red.jpg');
});

test('with no row just changed, each colour takes the photo of its first row', () => {
  const aligned = alignVariantPhotos(colourBySize({ imageAxis: ['Colour'], redM: ['https://i.ebayimg.com/other.jpg'] }));
  assert.deepStrictEqual(aligned.variants.map((v) => v.imageUrls[0]), ['https://i.ebayimg.com/red.jpg', 'https://i.ebayimg.com/red.jpg', 'https://i.ebayimg.com/blue.jpg']);
});

test('a draft whose photos already line up comes back as the same object', () => {
  const draft = colourBySize({ imageAxis: ['Colour'] });
  assert.strictEqual(alignVariantPhotos(draft), draft);
  // Every option on the one shared photo: nothing to name either.
  const shared = colourBySize({ red: ['https://i.ebayimg.com/main.jpg'], blue: ['https://i.ebayimg.com/main.jpg'] });
  assert.strictEqual(alignVariantPhotos(shared), shared);
  assert.strictEqual(alignVariantPhotos({ title: 'single' }).title, 'single');
});
