const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');

const huntPhotos = require('../../src/modules/hunting/hunt-photos');

// Shaded like a product photo (a flat-colour drawing isn't: its hash is noise wherever it's flat).
const picture = (shapes) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fafafa"/><stop offset="1" stop-color="#9a9a9a"/></linearGradient>` +
        `<radialGradient id="r"><stop offset="0" stop-color="#eee"/><stop offset="1" stop-color="#222"/></radialGradient></defs><rect width="400" height="400" fill="url(#g)"/>${shapes}</svg>`
    )
  )
    .png()
    .toBuffer();
const LAMP = '<circle cx="140" cy="200" r="90" fill="url(#r)"/><rect x="250" y="80" width="90" height="240" fill="url(#r)"/>';
const BOX = '<rect x="60" y="60" width="120" height="120" fill="url(#r)"/><circle cx="280" cy="290" r="70" fill="url(#r)"/>';
const MUG = '<rect x="120" y="100" width="160" height="220" fill="url(#r)"/><circle cx="300" cy="200" r="40" fill="url(#r)"/>';

test("a seller's copy of a photo (smaller, a JPEG, framed in white) is the same picture; another photo isn't", async () => {
  const lamp = await picture(LAMP);
  const copy = await sharp(lamp).resize(300).jpeg({ quality: 70 }).toBuffer();
  const framed = await sharp(lamp).extend({ top: 40, bottom: 40, left: 40, right: 40, background: '#ffffff' }).jpeg().toBuffer();
  const [a, b, c, d] = await Promise.all([lamp, copy, framed, await picture(BOX)].map(huntPhotos.fingerprint));
  assert.strictEqual(a.length, 256);
  assert.ok(huntPhotos.distance(a, b) <= huntPhotos.SAME_PHOTO_BITS, `copy ${huntPhotos.distance(a, b)}`);
  assert.ok(huntPhotos.distance(a, c) <= huntPhotos.SAME_PHOTO_BITS, `framed ${huntPhotos.distance(a, c)}`);
  assert.ok(huntPhotos.distance(a, d) > 64, `another photo ${huntPhotos.distance(a, d)}`);
  assert.strictEqual(await huntPhotos.fingerprint(Buffer.from('not an image')), null);
  assert.strictEqual(await huntPhotos.fingerprint(null), null);
});

test('two of the listing\'s photos among the supplier\'s make it the same product; one alone could be a stock picture', async () => {
  const [lamp, box, mug] = await Promise.all([LAMP, BOX, MUG].map(picture));
  const copies = await Promise.all([lamp, box].map((p) => sharp(p).resize(320).jpeg({ quality: 75 }).toBuffer()));
  const [fl, fb, fm, cl, cb] = await Promise.all([lamp, box, mug, ...copies].map(huntPhotos.fingerprint));
  const both = huntPhotos.compare([fl, fb, fm], [cb, cl, null]);
  assert.deepStrictEqual([both.shared, both.samePhotos], [2, true]);
  const one = huntPhotos.compare([fl, fm], [cl]);
  assert.deepStrictEqual([one.shared, one.samePhotos], [1, false]);
  assert.deepStrictEqual(huntPhotos.compare([null], [cl]), { bits: null, shared: 0, samePhotos: false });
});
