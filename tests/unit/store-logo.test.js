const test = require('node:test');
const assert = require('node:assert');
const { smallLogo } = require('../../src/modules/connections/connection.service');

// The rail's store logos: eBay's 140px copy of the picture, not the full upload.
test("a store logo becomes eBay's 140px copy of the same picture", () => {
  assert.strictEqual(smallLogo('https://i.ebayimg.com/00/s/MTI1NFgxMjU0/z/JbMAAeSw-~pqbgS2/$_57.PNG?set_id=880000500F'), 'https://i.ebayimg.com/images/g/JbMAAeSw-~pqbgS2/s-l140.png');
  assert.strictEqual(smallLogo('https://i.ebayimg.com/00/s/MzAwWDMwMA==/z/DsgAAeSwFbNp~KeX/$_1.JPG'), 'https://i.ebayimg.com/images/g/DsgAAeSwFbNp~KeX/s-l140.jpg');
  assert.strictEqual(smallLogo('https://i.ebayimg.com/images/g/abcAAOSw123/s-l1600.webp'), 'https://i.ebayimg.com/images/g/abcAAOSw123/s-l140.webp');
});

test('anything else is left as it is, and no logo stays none', () => {
  assert.strictEqual(smallLogo('https://example.com/logo.png'), 'https://example.com/logo.png');
  assert.strictEqual(smallLogo(null), null);
  assert.strictEqual(smallLogo(''), null);
});
