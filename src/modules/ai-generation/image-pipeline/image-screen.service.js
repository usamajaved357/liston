const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const config = require('../../../config');
const logger = require('../../../utils/logger');

// Supplier galleries are not photo sets — they're sales decks. A typical
// AliExpress listing mixes real product shots with infographic slides: text
// callouts, arrows, red crosses, feature badges, size charts.
//
// Those slides are actively harmful on eBay. eBay's picture policy prohibits
// text overlays, watermarks, logos and borders on listing images, and its
// automated systems demote listings that carry them — the opposite of
// Amazon's conventions, where infographics are normal. Confirmed live: the
// gallery for a real AliExpress night light returned a "Need 3 AAA Batteries
// / Swipe up to remove back cover" slide as its fourth image, which the
// pipeline would otherwise have published.
//
// Nothing in the image bytes distinguishes a product photo from an
// infographic, so this looks at them. One vision call screens the whole
// gallery at once, which is far cheaper than one call per image.

const MODEL = config.aiModel;
// Screening only needs to see layout and whether there's text — full
// resolution would cost many times the tokens for no extra accuracy.
const SCREEN_WIDTH = 512;

const SCREEN_TOOL = {
  name: 'report_image_screen',
  description: 'Report what each supplied product image actually shows.',
  input_schema: {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'The 0-based position of the image, as supplied.' },
            hasTextOrGraphics: {
              type: 'boolean',
              description:
                'True if the image has ANY overlaid text, captions, callouts, arrows, badges, watermarks, logos, ' +
                'price stickers, or collage borders. Text printed on the physical product itself (a brand name ' +
                'moulded into the casing, a label on the box) does NOT count.',
            },
            overlayTextLanguage: {
              type: 'string',
              enum: ['none', 'english', 'other'],
              description:
                'Language of any overlaid/added text (captions, headlines, callouts). "none" if there is no added ' +
                'text, "english" if it is all English, "other" if any of it is Chinese or another language.',
            },
            hasSupplierBranding: {
              type: 'boolean',
              description:
                'True if the image shows a store name, seller logo, watermark, website/URL, QR code, price, ' +
                'discount sticker, phone number or any marketplace branding. A brand name that is part of the ' +
                'physical product does NOT count.',
            },
            isCollage: {
              type: 'boolean',
              description:
                'True if the image is a grid/collage combining SEVERAL separate photographs into one frame ' +
                '(multiple panels, tiles, or a split layout). A single photograph that happens to show several ' +
                'units of the product together is NOT a collage.',
            },
            kind: {
              type: 'string',
              enum: ['product_photo', 'lifestyle_photo', 'infographic', 'size_chart', 'packaging', 'other'],
            },
            showsWholeProduct: {
              type: 'boolean',
              description: 'True if the main product is shown complete and clearly, suitable as a main gallery image.',
            },
          },
          required: ['index', 'hasTextOrGraphics', 'overlayTextLanguage', 'hasSupplierBranding', 'isCollage', 'kind', 'showsWholeProduct'],
        },
      },
    },
    required: ['images'],
  },
};

async function thumbnail(buffer) {
  return sharp(buffer).resize(SCREEN_WIDTH, SCREEN_WIDTH, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer();
}

/**
 * Screens prepared images in one vision call.
 *
 * @param prepared  [{ buffer, sourceUrl }]
 * @returns the same array with a `screen` field added, or unchanged when
 *          screening isn't available — an unscreened gallery is still better
 *          than no draft, so this never throws.
 */
async function screenImages(prepared) {
  if (!prepared.length) return prepared;
  if (!config.anthropicApiKey) return prepared;

  try {
    const thumbnails = await Promise.all(prepared.map((image) => thumbnail(image.buffer)));

    const content = [
      {
        type: 'text',
        text:
          `These are candidate photos for a UK eBay listing, in order. Report on every image: whether it carries ` +
          `added text (and in which language), whether it shows any supplier/store branding, watermark, price or ` +
          `URL, whether it is a multi-photo collage, what kind of image it is, and whether it shows the whole ` +
          `product clearly. Be precise about branding: a brand name printed on the product itself is not ` +
          `branding, a store logo or watermark is.`,
      },
    ];
    thumbnails.forEach((buffer, index) => {
      content.push({ type: 'text', text: `Image ${index}:` });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: buffer.toString('base64') },
      });
    });

    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      tools: [SCREEN_TOOL],
      tool_choice: { type: 'tool', name: SCREEN_TOOL.name },
      messages: [{ role: 'user', content }],
    });

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    const results = toolUse?.input?.images || [];
    const byIndex = new Map(results.map((result) => [result.index, result]));

    return prepared.map((image, index) => ({ ...image, screen: byIndex.get(index) || null }));
  } catch (err) {
    // Screening improves a gallery; it isn't worth losing a draft over.
    logger.warn('Image screening unavailable — using the gallery unscreened', { error: err.message });
    return prepared;
  }
}

// What gets dropped outright, versus what only can't be the MAIN image.
//
// eBay's picture policy is enforced on the main photo; competitor listings
// routinely carry the supplier's feature shots ("Waterproof", "Spring hinge")
// as secondary images and buyers find them useful. An earlier rule that
// rejected every image with any text left a glasses listing with 2 of its 6
// photos — worse for buyers than a headline on image four. Confirmed live.
//
// So: anything that would identify another seller or read as foreign-market
// stock is dropped (watermarks, store names, prices, Chinese text, size
// charts); everything else stays and is ranked so clean photography leads.
function isRejected(screen) {
  if (!screen) return false;
  return Boolean(screen.hasSupplierBranding || screen.overlayTextLanguage === 'other' || screen.kind === 'size_chart');
}

// Eligible to be the search thumbnail: a clean single photograph of the whole
// product. Text overlays and collages are fine further down the gallery but
// never here.
function isHeroEligible(screen) {
  if (!screen) return true;
  return !screen.hasTextOrGraphics && !screen.isCollage && screen.showsWholeProduct && screen.kind !== 'infographic';
}

// Clean photographs first, marketing composites excluded entirely. Among the
// clean ones, images showing the whole product lead — the first image becomes
// the thumbnail buyers actually see in search results.
function rankScreened(screened) {
  const usable = screened.filter((image) => !isRejected(image.screen));
  const rejected = screened.filter((image) => isRejected(image.screen));

  // Clean whole-product photo → clean product photo → clean lifestyle →
  // anything carrying text or a collage layout (still useful, never first).
  const score = (image) => {
    const screen = image.screen;
    if (!screen) return 1;
    const dirty = screen.hasTextOrGraphics || screen.isCollage;
    if (dirty) return screen.kind === 'product_photo' ? 4 : 5;
    if (screen.kind === 'product_photo' && screen.showsWholeProduct) return 0;
    if (screen.kind === 'product_photo') return 1;
    if (screen.kind === 'lifestyle_photo') return 2;
    return 3;
  };

  return { usable: [...usable].sort((a, b) => score(a) - score(b)), rejected };
}

module.exports = { screenImages, rankScreened, isRejected, isHeroEligible, SCREEN_TOOL };
