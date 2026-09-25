const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const sharp = require('sharp');

const imageOps = require('../../src/modules/ai-generation/image-pipeline/image.ops');
const gates = require('../../src/modules/ai-generation/image-pipeline/gates');
const eps = require('../../src/modules/ai-generation/image-pipeline/eps');
const slotPlan = require('../../src/modules/ai-generation/image-pipeline/slot-plan');
const imagePipeline = require('../../src/modules/ai-generation/image-pipeline');

eps.setRetryDelay(0);

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

// eBay's picture service answers some uploads with "Internal error to the
// application" and takes the same picture on the next try.
function epsFailure(message = 'Internal error to the application.') {
  return `<UploadSiteHostedPicturesResponse><Ack>Failure</Ack><Errors><LongMessage>${message}</LongMessage></Errors></UploadSiteHostedPicturesResponse>`;
}

test('upload tries again when eBay has an internal error, then a clean JPEG', async () => {
  const answers = [epsFailure(), epsFailure(), epsResponse('https://i.ebayimg.com/00/s/third.jpg')];
  const sent = [];
  mock.method(global, 'fetch', async (url, options) => {
    sent.push(options.body.toString('latin1'));
    return { ok: true, status: 200, text: async () => answers.shift() };
  });

  const url = await eps.upload('token', await makeImage(600, 600, 'png'));
  assert.strictEqual(url, 'https://i.ebayimg.com/00/s/third.jpg');
  assert.strictEqual(sent.length, 3);
  // The PNG goes as a PNG twice, then re-encoded as a JPEG.
  assert.match(sent[0], /filename="image\.png"[\s\S]*Content-Type: image\/png/);
  assert.match(sent[2], /filename="image\.jpg"[\s\S]*Content-Type: image\/jpeg/);
});

test('upload sends a WEBP as a JPEG, never mislabelled', async () => {
  const sent = [];
  mock.method(global, 'fetch', async (url, options) => {
    sent.push(options.body.toString('latin1'));
    return { ok: true, status: 200, text: async () => epsResponse('https://i.ebayimg.com/00/s/w.jpg') };
  });

  await eps.upload('token', await makeImage(600, 600, 'webp'));
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /filename="image\.jpg"/);
  assert.doesNotMatch(sent[0], /WEBP/);
});

test('upload gives up with eBay’s reason when every try fails', async () => {
  const calls = mock.method(global, 'fetch', async () => ({ ok: true, status: 200, text: async () => epsFailure('Picture too large') }));
  await assert.rejects(eps.upload('token', await makeImage(600, 600)), /Picture too large/);
  assert.strictEqual(calls.mock.calls.length, 3);
});

test('isEbayHosted knows eBay picture URLs from supplier ones', () => {
  assert.strictEqual(eps.isEbayHosted('https://i.ebayimg.com/00/s/MTYwMA==/z/abc/$_57.JPG'), true);
  assert.strictEqual(eps.isEbayHosted('https://ae01.alicdn.com/kf/S8afe.jpg'), false);
  assert.strictEqual(eps.isEbayHosted('https://ebayimg.com.evil.example/a.jpg'), false);
  assert.strictEqual(eps.isEbayHosted('not a url'), false);
});

// --- publishing: every photo on eBay -----------------------------------------

test('hostDraftImages puts supplier photos on eBay, in the gallery and on variations', async () => {
  const image = await makeImage(600, 600);
  let uploads = 0;
  mock.method(global, 'fetch', async (url) => {
    if (String(url).includes('alicdn')) return { ok: true, status: 200, arrayBuffer: async () => image };
    uploads += 1;
    return { ok: true, status: 200, text: async () => epsResponse('https://i.ebayimg.com/00/s/hosted.jpg') };
  });
  const draft = {
    imageUrls: ['https://i.ebayimg.com/main.jpg', 'https://ae01.alicdn.com/kf/a.jpg'],
    variants: [{ imageUrls: ['https://ae01.alicdn.com/kf/a.jpg'] }, { imageUrls: ['https://i.ebayimg.com/b.jpg'] }],
  };

  assert.deepStrictEqual(imagePipeline.unhostedImages(draft), ['https://ae01.alicdn.com/kf/a.jpg']);
  const result = await imagePipeline.hostDraftImages(draft, { accessToken: 't', marketplaceId: 'EBAY_GB' });

  assert.strictEqual(uploads, 1, 'the same photo is uploaded once');
  assert.deepStrictEqual(result.draft.imageUrls, ['https://i.ebayimg.com/main.jpg', 'https://i.ebayimg.com/00/s/hosted.jpg']);
  assert.deepStrictEqual(result.draft.variants[0].imageUrls, ['https://i.ebayimg.com/00/s/hosted.jpg']);
  assert.deepStrictEqual([result.ok, result.changed, result.dropped], [true, true, []]);
});

test('a photo eBay still won’t take is left out, and a variation that loses it shows the main photo', async () => {
  mock.method(global, 'fetch', async () => ({ ok: false, status: 403 }));
  const draft = {
    imageUrls: ['https://i.ebayimg.com/main.jpg', 'https://ae01.alicdn.com/kf/gone.jpg'],
    variants: [{ imageUrls: ['https://ae01.alicdn.com/kf/gone.jpg'] }],
  };

  const result = await imagePipeline.hostDraftImages(draft, { accessToken: 't' });
  assert.deepStrictEqual(result.draft.imageUrls, ['https://i.ebayimg.com/main.jpg']);
  assert.deepStrictEqual(result.draft.variants[0].imageUrls, ['https://i.ebayimg.com/main.jpg']);
  assert.deepStrictEqual(result.dropped, ['https://ae01.alicdn.com/kf/gone.jpg']);
  assert.strictEqual(result.ok, true);

  const nothingLeft = await imagePipeline.hostDraftImages({ imageUrls: ['https://ae01.alicdn.com/kf/gone.jpg'] }, { accessToken: 't' });
  assert.strictEqual(nothingLeft.ok, false);
});

test('a draft already all on eBay is returned untouched', async () => {
  const fetchMock = mock.method(global, 'fetch', async () => {
    throw new Error('nothing to upload');
  });
  const draft = { imageUrls: ['https://i.ebayimg.com/a.jpg'] };
  const result = await imagePipeline.hostDraftImages(draft, { accessToken: 't' });
  assert.strictEqual(result.draft, draft);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(fetchMock.mock.calls.length, 0);
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

// --- gallery assembly (no generator) --------------------------------------

const pipeline = require('../../src/modules/ai-generation/image-pipeline');
const heroBadges = require('../../src/modules/ai-generation/image-pipeline/hero-badges');
const config = require('../../src/config');

test('the gallery is the supplier photos exactly as they are — no retouching, no badges by default', async () => {
  const source = await makeImage(900, 700);
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200, arrayBuffer: async () => source }));
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

test("every photo the seller kept is used, in the seller's order, with no AI photo check", async () => {
  const source = await makeImage(900, 900);
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200, arrayBuffer: async () => source }));
  const Anthropic = require('@anthropic-ai/sdk');
  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'test-key' }).messages);
  const claude = mock.method(messagesProto, 'create', async () => {
    throw new Error('no Claude call expected');
  });
  mock.method(eps, 'uploadAll', async (token, prepared) => prepared.map((p) => p.sourceUrl));

  const order = ['https://example.com/slide1.jpg', 'https://example.com/a.jpg', 'https://example.com/slide2.jpg', 'https://example.com/b.jpg'];
  const { imageUrls, warnings } = await pipeline.buildGalleryImages({ sourceImageUrls: order, accessToken: 't', marketplaceId: 'EBAY_GB', categoryId: '20349' });
  assert.deepStrictEqual(imageUrls, order, 'none left out, none reordered');
  assert.strictEqual(claude.mock.callCount(), 0);
  assert.doesNotMatch(warnings.join(' '), /text|branding/);
});

test('a photo just under eBay\'s 500px minimum is enlarged rather than lost; a thumbnail is still skipped', async () => {
  const small = await makeImage(400, 300);
  const thumb = await makeImage(48, 48);
  mock.method(global, 'fetch', async (url) => ({ ok: true, status: 200, arrayBuffer: async () => (/thumb/.test(String(url)) ? thumb : small) }));
  let uploaded = [];
  mock.method(eps, 'uploadAll', async (token, prepared) => {
    uploaded = prepared;
    return prepared.map((p) => p.sourceUrl);
  });
  const { imageUrls, warnings } = await pipeline.buildGalleryImages({
    sourceImageUrls: ['https://example.com/small.jpg', 'https://example.com/thumb.jpg'],
    accessToken: 't',
    marketplaceId: 'EBAY_GB',
    categoryId: '20349',
  });
  assert.deepStrictEqual(imageUrls, ['https://example.com/small.jpg']);
  const meta = await sharp(uploaded[0].buffer).metadata();
  assert.strictEqual(Math.max(meta.width, meta.height), 800);
  assert.match(warnings.join(' '), /1 small photo was enlarged/);
  assert.match(warnings.join(' '), /1 of the supplier's 2 photos couldn't be used/);
});

test('an AliExpress image is asked for as the product page would, and a failed download is tried once more', async () => {
  const source = await makeImage(900, 900);
  let calls = 0;
  const seen = [];
  mock.method(global, 'fetch', async (url, init) => {
    calls += 1;
    seen.push(init.headers);
    if (calls === 1) throw new Error('socket hang up');
    return { ok: true, status: 200, arrayBuffer: async () => source };
  });
  const buffer = await imageOps.download('https://ae01.alicdn.com/kf/S1.jpg');
  assert.ok(buffer.length > 0);
  assert.strictEqual(calls, 2);
  assert.strictEqual(seen[1].Referer, 'https://www.aliexpress.com/');
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

test('a seller\'s photo is taken by its content: JPG/PNG/GIF as they are, WebP/TIFF as a JPEG, anything else refused', async () => {
  const png = await sharp({ create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  assert.strictEqual(await imageOps.toUploadable(png), png, 'PNG untouched');
  for (const make of [(s) => s.webp(), (s) => s.tiff()]) {
    const odd = await make(sharp({ create: { width: 600, height: 400, channels: 3, background: '#336699' } })).toBuffer();
    const out = await imageOps.toUploadable(odd);
    const meta = await sharp(out).metadata();
    assert.strictEqual(meta.format, 'jpeg');
    assert.deepStrictEqual([meta.width, meta.height], [600, 400]);
  }
  await assert.rejects(imageOps.toUploadable(Buffer.from('not a picture at all')));
});
