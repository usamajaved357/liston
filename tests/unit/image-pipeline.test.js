const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const sharp = require('sharp');

const imageOps = require('../../src/modules/ai-generation/image-pipeline/image.ops');
const gates = require('../../src/modules/ai-generation/image-pipeline/gates');
const eps = require('../../src/modules/ai-generation/image-pipeline/eps');
const slotPlan = require('../../src/modules/ai-generation/image-pipeline/slot-plan');

function makeImage(width, height, format = 'jpeg') {
  return sharp({ create: { width, height, channels: 3, background: '#3355ff' } })[format]().toBuffer();
}

test.afterEach(() => {
  mock.restoreAll();
  eps.resetUploadCache();
});

// --- image.ops -------------------------------------------------------------

test('padToSquare produces a square 1600px JPEG without stretching', async () => {
  const wide = await makeImage(800, 400);
  const squared = await imageOps.padToSquare(wide);
  const meta = await imageOps.describe(squared);

  assert.strictEqual(meta.width, 1600);
  assert.strictEqual(meta.height, 1600);
  assert.strictEqual(meta.format, 'jpeg');
});

test('padToSquare pads a transparent PNG onto white, not black', async () => {
  const transparent = await sharp({
    create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();

  const squared = await imageOps.padToSquare(transparent);
  // Sample a corner: a flattened-to-white cutout reads near 255 on all
  // channels. Without the explicit flatten, a transparent PNG goes black.
  const { data } = await sharp(squared).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 240 && data[1] > 240 && data[2] > 240, 'corner should be white');
});

test('validate rejects an image below eBay’s 500px hard minimum', async () => {
  const tiny = await imageOps.padToSquare(await makeImage(120, 120), 300);
  const result = await imageOps.validate(tiny);

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.join(' '), /at least 500px/);
});

test('validate warns, but does not fail, between 500px and 1600px', async () => {
  const medium = await imageOps.padToSquare(await makeImage(900, 900), 900);
  const result = await imageOps.validate(medium);

  assert.strictEqual(result.ok, true);
  assert.match(result.warnings.join(' '), /zoom/);
});

test('validate accepts a normalized 1600px square with no warnings', async () => {
  const good = await imageOps.padToSquare(await makeImage(2000, 1200));
  const result = await imageOps.validate(good);

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.warnings, []);
});

test('validate reports unreadable data rather than throwing', async () => {
  const result = await imageOps.validate(Buffer.from('this is not an image'));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.meta, null);
});

test('prepare returns null instead of throwing when an image cannot be downloaded', async () => {
  mock.method(global, 'fetch', async () => ({ ok: false, status: 404 }));
  // One unusable photo out of eight must not cost the seller the whole draft.
  assert.strictEqual(await imageOps.prepare('https://example.com/missing.jpg'), null);
});

test('prepare downloads, normalizes and validates in one step', async () => {
  const source = await makeImage(1000, 700);
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200, arrayBuffer: async () => source }));

  const prepared = await imageOps.prepare('https://example.com/a.jpg');

  assert.strictEqual(prepared.meta.width, 1600);
  assert.strictEqual(prepared.meta.height, 1600);
  assert.strictEqual(prepared.sourceUrl, 'https://example.com/a.jpg');
});

// --- eps -------------------------------------------------------------------

function epsResponse(url) {
  return `<?xml version="1.0"?><UploadSiteHostedPicturesResponse><Ack>Success</Ack>
    <SiteHostedPictureDetails><FullURL>${url}</FullURL></SiteHostedPictureDetails>
    </UploadSiteHostedPicturesResponse>`;
}

test('upload returns the permanent eBay-hosted URL', async () => {
  mock.method(global, 'fetch', async () => ({
    ok: true,
    status: 200,
    text: async () => epsResponse('https://i.ebayimg.com/00/s/hosted.jpg'),
  }));

  const url = await eps.upload('token', await makeImage(600, 600));
  assert.strictEqual(url, 'https://i.ebayimg.com/00/s/hosted.jpg');
});

test('upload caches by content hash so identical bytes upload only once', async () => {
  const fetchMock = mock.method(global, 'fetch', async () => ({
    ok: true,
    status: 200,
    text: async () => epsResponse('https://i.ebayimg.com/00/s/hosted.jpg'),
  }));
  const buffer = await makeImage(600, 600);

  await eps.upload('token', buffer);
  await eps.upload('token', Buffer.from(buffer)); // same bytes, different object

  assert.strictEqual(fetchMock.mock.calls.length, 1);
});

test('upload surfaces an eBay rejection', async () => {
  mock.method(global, 'fetch', async () => ({
    ok: true,
    status: 200,
    text: async () =>
      `<UploadSiteHostedPicturesResponse><Ack>Failure</Ack><Errors><LongMessage>Picture too large</LongMessage></Errors></UploadSiteHostedPicturesResponse>`,
  }));

  await assert.rejects(eps.upload('token', await makeImage(600, 600)), /Picture too large/);
});

test('uploadAll falls back to the source URL for an image eBay rejects', async () => {
  mock.method(global, 'fetch', async () => {
    throw new Error('network down');
  });

  const urls = await eps.uploadAll('token', [
    { buffer: await makeImage(600, 600), sourceUrl: 'https://example.com/a.jpg' },
  ]);

  // A reachable original beats a hole in the gallery.
  assert.deepStrictEqual(urls, ['https://example.com/a.jpg']);
});

test('siteIdFor maps marketplaces to Trading API site ids', () => {
  assert.strictEqual(eps.siteIdFor('EBAY_GB'), '3');
  assert.strictEqual(eps.siteIdFor('EBAY_US'), '0');
  assert.strictEqual(eps.siteIdFor('EBAY_NOWHERE'), '0');
});

test('buildMultipartBody carries the XML payload and the raw image bytes', async () => {
  const image = await makeImage(600, 600);
  const body = eps.buildMultipartBody(image, 'BOUNDARY', 'Test picture');
  const text = body.toString('latin1');

  assert.match(text, /name="XML Payload"/);
  assert.match(text, /UploadSiteHostedPicturesRequest/);
  assert.match(text, /name="image"; filename="image\.jpg"/);
  assert.match(text, /--BOUNDARY--/);
  assert.ok(body.includes(image), 'the raw image bytes must be present');
});

// --- gates -----------------------------------------------------------------

test('checkDraftImages blocks a listing with no images at all', () => {
  const result = gates.checkDraftImages({ imageUrls: [] });
  assert.strictEqual(result.ok, false);
  assert.match(result.errors.join(' '), /no images/);
});

test('checkDraftImages blocks any variation left without an image', () => {
  // eBay refuses the whole item group with "imageUrls cannot be null or
  // empty" — confirmed live, it killed a real draft. The orchestrator fills
  // gaps before sending, so this is the backstop.
  const result = gates.checkDraftImages({
    imageUrls: ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg', 'https://i.ebayimg.com/c.jpg'],
    variants: [{ imageUrls: ['https://i.ebayimg.com/black.jpg'] }, { imageUrls: [] }],
  });

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.join(' '), /1 of 2 variations have no image/);
});

test('checkDraftImages passes a complete variation listing', () => {
  const result = gates.checkDraftImages({
    imageUrls: ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg', 'https://i.ebayimg.com/c.jpg'],
    variants: [{ imageUrls: ['https://i.ebayimg.com/black.jpg'] }, { imageUrls: ['https://i.ebayimg.com/red.jpg'] }],
  });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.errors, []);
});

test('checkDraftImages warns when every variation shows the same photo', () => {
  const result = gates.checkDraftImages({
    imageUrls: ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg', 'https://i.ebayimg.com/c.jpg'],
    variants: [{ imageUrls: ['https://i.ebayimg.com/same.jpg'] }, { imageUrls: ['https://i.ebayimg.com/same.jpg'] }],
  });

  assert.strictEqual(result.ok, true);
  assert.match(result.warnings.join(' '), /same photo/);
});

test('checkDraftImages warns about a thin gallery without blocking it', () => {
  const result = gates.checkDraftImages({ imageUrls: ['https://i.ebayimg.com/a.jpg'] });
  assert.strictEqual(result.ok, true);
  assert.match(result.warnings.join(' '), /tend to sell better/);
});

// --- slot plan -------------------------------------------------------------

test('the default slot plan makes the hero per-variation and forbids image text', () => {
  const plan = slotPlan.planForCategory('20702');
  const hero = plan.slots.find((slot) => slot.key === 'hero');

  assert.strictEqual(hero.perVariation, true);
  assert.strictEqual(hero.required, true);
  // eBay suppresses listings whose images carry text/watermarks — the
  // opposite of Amazon's conventions.
  assert.strictEqual(plan.textAllowedOnImage, false);
});

test('compositeSlotCount limits how many paid AI treatments a draft pays for', () => {
  assert.strictEqual(slotPlan.compositeSlotCount(slotPlan.DEFAULT_PLAN), 2);
});

// --- image screening -------------------------------------------------------

const imageScreen = require('../../src/modules/ai-generation/image-pipeline/image-screen.service');

function screened(overrides) {
  return {
    sourceUrl: overrides.sourceUrl || 'https://example.com/a.jpg',
    screen: {
      hasTextOrGraphics: false,
      overlayTextLanguage: 'none',
      hasSupplierBranding: false,
      isCollage: false,
      kind: 'product_photo',
      showsWholeProduct: true,
      ...overrides,
    },
  };
}

test('rankScreened keeps supplier feature shots with English text, but never first', () => {
  // Competitor listings carry these as secondary images and buyers use them.
  // A rule that dropped every image with text left a listing with 2 of 6
  // photos. They stay — ranked after the clean photography.
  const { usable, rejected } = imageScreen.rankScreened([
    screened({ sourceUrl: 'infographic.jpg', hasTextOrGraphics: true, overlayTextLanguage: 'english', kind: 'product_photo' }),
    screened({ sourceUrl: 'clean.jpg' }),
  ]);

  assert.deepStrictEqual(usable.map((i) => i.sourceUrl), ['clean.jpg', 'infographic.jpg']);
  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(imageScreen.isHeroEligible(usable[0].screen), true);
  assert.strictEqual(imageScreen.isHeroEligible(usable[1].screen), false);
});

test('rankScreened rejects supplier branding, non-English text and size charts outright', () => {
  const { usable, rejected } = imageScreen.rankScreened([
    screened({ sourceUrl: 'clean.jpg' }),
    screened({ sourceUrl: 'watermark.jpg', hasSupplierBranding: true }),
    screened({ sourceUrl: 'chinese.jpg', hasTextOrGraphics: true, overlayTextLanguage: 'other' }),
    screened({ sourceUrl: 'sizes.jpg', kind: 'size_chart' }),
  ]);

  assert.deepStrictEqual(usable.map((i) => i.sourceUrl), ['clean.jpg']);
  assert.deepStrictEqual(rejected.map((i) => i.sourceUrl), ['watermark.jpg', 'chinese.jpg', 'sizes.jpg']);
});

test('rankScreened keeps a collage but ranks it last and never as the hero', () => {
  const { usable } = imageScreen.rankScreened([
    screened({ sourceUrl: 'grid.jpg', isCollage: true, kind: 'lifestyle_photo' }),
    screened({ sourceUrl: 'clean.jpg' }),
  ]);
  assert.deepStrictEqual(usable.map((i) => i.sourceUrl), ['clean.jpg', 'grid.jpg']);
  assert.strictEqual(imageScreen.isHeroEligible(usable[1].screen), false);
});

test('rankScreened puts the best whole-product shot first', () => {
  // The first image becomes the search thumbnail, so ordering is not cosmetic.
  const { usable } = imageScreen.rankScreened([
    screened({ sourceUrl: 'lifestyle.jpg', kind: 'lifestyle_photo', showsWholeProduct: false }),
    screened({ sourceUrl: 'packaging.jpg', kind: 'packaging', showsWholeProduct: false }),
    screened({ sourceUrl: 'hero.jpg', kind: 'product_photo', showsWholeProduct: true }),
  ]);

  assert.strictEqual(usable[0].sourceUrl, 'hero.jpg');
  assert.strictEqual(usable[1].sourceUrl, 'lifestyle.jpg');
});

test('rankScreened keeps unscreened images rather than discarding them', () => {
  // When screening is unavailable the gallery still has to work.
  const { usable, rejected } = imageScreen.rankScreened([{ sourceUrl: 'a.jpg', screen: null }]);
  assert.strictEqual(usable.length, 1);
  assert.strictEqual(rejected.length, 0);
});

test('screenImages returns images unchanged when no AI key is configured', async () => {
  const original = require('../../src/config');
  const previous = original.anthropicApiKey;
  original.anthropicApiKey = null;
  try {
    const input = [{ buffer: await makeImage(600, 600), sourceUrl: 'a.jpg' }];
    assert.strictEqual(await imageScreen.screenImages(input), input);
  } finally {
    original.anthropicApiKey = previous;
  }
});

test('the screen tool requires a verdict on text and collage for every image', () => {
  const required = imageScreen.SCREEN_TOOL.input_schema.properties.images.items.required;
  assert.ok(required.includes('hasTextOrGraphics'));
  assert.ok(required.includes('isCollage'));
});

// --- gallery assembly (no generator) --------------------------------------

const pipeline = require('../../src/modules/ai-generation/image-pipeline');
const heroBadges = require('../../src/modules/ai-generation/image-pipeline/hero-badges');
const config = require('../../src/config');

test('the gallery is the supplier photos exactly as they are — no retouching, no badges by default', async () => {
  const source = await makeImage(900, 700);
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200, arrayBuffer: async () => source }));
  const screen = require('../../src/modules/ai-generation/image-pipeline/image-screen.service');
  mock.method(screen, 'screenImages', async (images) => images.map((i) => ({ ...i, screen: null })));
  const enhanceMock = mock.method(imageOps, 'enhance', async (b) => b);
  const badgeMock = mock.method(heroBadges, 'brandHero', async (b) => b);
  let uploaded = [];
  mock.method(eps, 'uploadAll', async (token, prepared) => {
    uploaded = prepared;
    return prepared.map((p) => p.sourceUrl);
  });

  const { imageUrls } = await pipeline.buildGalleryImages({
    sourceImageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg', 'https://example.com/c.jpg'],
    accessToken: 't',
    marketplaceId: 'EBAY_GB',
    categoryId: '20349',
  });

  assert.strictEqual(imageUrls.length, 3);
  assert.strictEqual(enhanceMock.mock.callCount(), 0, 'nothing is retouched');
  assert.strictEqual(badgeMock.mock.callCount(), 0, 'badges are off by default');
  // The original bytes go up — not a padded square.
  const meta = await sharp(uploaded[0].buffer).metadata();
  assert.deepStrictEqual([meta.width, meta.height], [900, 700]);
});

test('when every supplier photo is branded or foreign, they are still listed with a loud warning', async () => {
  const source = await makeImage(900, 900);
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200, arrayBuffer: async () => source }));
  const screen = require('../../src/modules/ai-generation/image-pipeline/image-screen.service');
  mock.method(screen, 'screenImages', async (images) =>
    images.map((i) => ({ ...i, screen: { hasTextOrGraphics: true, overlayTextLanguage: 'other', hasSupplierBranding: true, isCollage: false, kind: 'product_photo', showsWholeProduct: true } }))
  );
  mock.method(imageOps, 'enhance', async (b) => b);
  mock.method(heroBadges, 'brandHero', async (b) => b);
  mock.method(eps, 'uploadAll', async (token, prepared) => prepared.map((p) => p.sourceUrl));

  const { imageUrls, warnings } = await pipeline.buildGalleryImages({
    sourceImageUrls: ['https://example.com/a.jpg'],
    accessToken: 't',
    marketplaceId: 'EBAY_GB',
    categoryId: '20349',
  });

  assert.strictEqual(imageUrls.length, 1);
  assert.match(warnings.join(' '), /Every supplier photo carries supplier branding/);
});

test('a variant image is its own supplier photo, uploaded as-is', async () => {
  const source = await makeImage(900, 900);
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200, arrayBuffer: async () => source }));
  const enhanceMock = mock.method(imageOps, 'enhance', async (b) => b);
  mock.method(eps, 'upload', async () => 'https://i.ebayimg.com/v.jpg');

  const url = await pipeline.buildVariantImage({ sourceImageUrl: 'https://example.com/v.jpg', accessToken: 't', marketplaceId: 'EBAY_GB' });
  assert.strictEqual(url, 'https://i.ebayimg.com/v.jpg');
  assert.strictEqual(enhanceMock.mock.callCount(), 0);
});

// --- enhance + badges ------------------------------------------------------

test('enhance trims plain margins so the product fills the frame, at 1600² on white', async () => {
  // A small dark square sitting in a large white field.
  const product = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#223344' } }).png().toBuffer();
  const photo = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#ffffff' } })
    .composite([{ input: product, left: 400, top: 400 }])
    .jpeg()
    .toBuffer();

  const out = await imageOps.enhance(photo);
  const meta = await sharp(out).metadata();
  assert.strictEqual(meta.width, 1600);
  assert.strictEqual(meta.height, 1600);
  // After trimming, the product spans most of the frame: the centre pixel is
  // product-coloured and a pixel at 20% in is too (it was white before).
  const raw = await sharp(out).raw().toBuffer();
  const px = (x, y) => raw[(y * 1600 + x) * 3];
  assert.ok(px(800, 800) < 100, 'centre is product');
  assert.ok(px(320, 320) < 100, 'product now reaches 20% in — margins were trimmed');
});

test('brandHero draws the enabled badges and leaves the image alone when none are on', async () => {
  const photo = await makeImage(1600, 1600);
  const plain = await heroBadges.brandHero(photo, { addUkFlag: false, addFreeShippingLabel: false, addGlowBorder: false });
  assert.strictEqual(plain, photo);

  const branded = await heroBadges.brandHero(photo, { addUkFlag: true, addFreeShippingLabel: true, addGlowBorder: false });
  assert.notStrictEqual(branded.length, photo.length);
  // The flag sits bottom-left and the label bottom-right: pixels there no
  // longer match the photo's flat colour, while the centre is untouched.
  const before = await sharp(photo).raw().toBuffer();
  const after = await sharp(branded).raw().toBuffer();
  const at = (buf, x, y) => Array.from(buf.subarray((y * 1600 + x) * 3, (y * 1600 + x) * 3 + 3));
  assert.notDeepStrictEqual(at(after, 168, 1492), at(before, 168, 1492), 'flag drawn bottom-left');
  assert.notDeepStrictEqual(at(after, 1400, 1492), at(before, 1400, 1492), 'label drawn bottom-right');
  assert.deepStrictEqual(at(after, 800, 800).map((v) => Math.round(v / 8)), at(before, 800, 800).map((v) => Math.round(v / 8)), 'centre untouched');
  assert.deepStrictEqual(heroBadges.activeBadges({ addUkFlag: true, addFreeShippingLabel: false, addGlowBorder: true }), ['UK flag', 'border']);
});
