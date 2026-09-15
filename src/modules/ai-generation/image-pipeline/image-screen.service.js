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

const MODEL = 'claude-haiku-4-5-20251001';
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
          required: ['index', 'hasTextOrGraphics', 'isCollage', 'kind', 'showsWholeProduct'],
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
          `These are candidate photos for an eBay listing, in order. eBay prohibits overlaid text, callouts, ` +
          `arrows, badges, watermarks and multi-photo collages on listing images and demotes listings that use ` +
          `them, so identify which of these are clean single photographs and which are marketing graphics. ` +
          `Report on every image.`,
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

// A collage is rejected for the same reason a text slide is: it's a marketing
// composite rather than a photograph. It also wastes the frame — seven photos
// tiled into one 1600² image renders the product too small to judge, and eBay
// disallows collage borders outright. Confirmed live: the same night-light
// gallery served a seven-panel grid of customer shots, which passed the
// text check because it carried no text at all.
function isRejected(screen) {
  return Boolean(screen && (screen.hasTextOrGraphics || screen.isCollage));
}

// Clean photographs first, marketing composites excluded entirely. Among the
// clean ones, images showing the whole product lead — the first image becomes
// the thumbnail buyers actually see in search results.
function rankScreened(screened) {
  const usable = screened.filter((image) => !isRejected(image.screen));
  const rejected = screened.filter((image) => isRejected(image.screen));

  const score = (image) => {
    if (!image.screen) return 1;
    if (image.screen.kind === 'product_photo' && image.screen.showsWholeProduct) return 0;
    if (image.screen.kind === 'product_photo') return 1;
    if (image.screen.kind === 'lifestyle_photo') return 2;
    return 3;
  };

  return { usable: [...usable].sort((a, b) => score(a) - score(b)), rejected };
}

module.exports = { screenImages, rankScreened, isRejected, SCREEN_TOOL };
