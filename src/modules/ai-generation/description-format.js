// The layout every AI-written description follows. It is plain text in the
// editor's own terms, so the seller can edit it and the eBay template can
// render it (listings/description-template.js):
//   **Heading**                  a bold-only line → a section heading
//   ❄️ Name: sentence            an emoji-led line → a list item with a hanging indent
//   ✓ Dogs / • 1 × Mat           the editor's bullet library, used by default for
//                                Suitable For / Compatible With and Package Includes
//   **Important:** …             a note line → a highlighted callout
//   blank line                   → a new section
// Sections that depend on facts (sizes, compatibility, a caution) are left
// out rather than invented. No dashes as punctuation: the seller doesn't
// want them, so the model is told and cleanDashes removes any that slip in.

const { listItem } = require('../listings/description-template');

const PROMPT_GUIDANCE =
  `\nDESCRIPTION FORMAT: write the description as plain text in exactly this layout. Put ONE blank line ` +
  `between sections. A section heading is its own line wrapped in double asterisks (**Key Features**) with ` +
  `its content on the lines directly below it. No other markdown: no "#", no "-" bullets, no tables, no ` +
  `HTML, and no line markers other than the ones this layout gives each section.\n` +
  `NO DASHES: never use a dash as punctuation anywhere in the description (no "–", no "—", no " - "). Use a ` +
  `colon or a comma instead, and "to" for ranges (2 to 4 days). Hyphenated words such as wall-mounted or ` +
  `5-tier are fine.\n` +
  `1. Headline: one bold line, the product name and its main benefit in Title Case, joined with ": " ` +
  `(e.g. **Pet Cooling Mat For Dogs & Cats: Summer Heat Relief**).\n` +
  `2. Introduction: one or two sentences on what the product is, who it is for and the main reason to buy it. No heading.\n` +
  `3. **Key Features**: 5 to 7 lines. Each line is ONE emoji that fits that feature, a space, a short Title ` +
  `Case feature name, ": ", then one sentence (e.g. ❄️ Cooling Comfort: Helps provide a cool resting ` +
  `surface during warm weather.). A different emoji on every line.\n` +
  `4. **Available Sizes**: ONLY for a listing with variations; name the heading after the variation axis ` +
  `(**Available Sizes**, **Available Colours**, **Available Models** …). One line with every option, using ` +
  `exactly the option names you give the variations, separated by " / ". Then a blank line and: "Please ` +
  `select your required size from the available options before placing your order." (the axis word in ` +
  `lower case: size, colour, model …). Leave this section out entirely for a single-item listing.\n` +
  `5. **Suitable For**: 3 to 8 short lines, one per line, each starting with "✓ " (a check mark and a ` +
  `space, no emoji): the pets, people, rooms, uses or occasions it suits. For a part or accessory made to ` +
  `fit particular products, use the heading **Compatible With** and list those products the same way. ` +
  `Leave out if nothing genuine can be listed.\n` +
  `6. **Package Includes**: one line per item, each starting with "• " (a bullet and a space) in the form ` +
  `"• 1 × Pet Cooling Mat" (use "×"). Use the real contents from the product data; if they aren't given, ` +
  `write "• 1 × " followed by the product name.\n` +
  `7. Important note: ONLY when buyers genuinely need a caution (checking size measurements, checking ` +
  `compatibility with their model): one line starting "**Important:** ". The store template highlights it; ` +
  `add no colour or highlight markers yourself. Otherwise leave it out.\n` +
  `8. Closing: one short sentence on the benefit of owning it. No heading.\n` +
  `Only state features, materials, measurements and contents the product data supports; never invent ` +
  `them. No emoji anywhere except the start of each Key Features line (✓ and • are not emoji). No prices, ` +
  `postage, returns or seller name in the description (the store template shows those).\n` +
  `Example of the layout (for structure only; write your own words for this product):\n` +
  `**Pet Cooling Mat For Dogs & Cats: Summer Heat Relief**\n` +
  `Keep your pet cool and comfortable during warm weather with this Pet Cooling Mat, designed for dogs and cats.\n\n` +
  `**Key Features**\n` +
  `❄️ Cooling Comfort: Helps provide a cool resting surface during warm weather.\n` +
  `🐶 Suitable For Dogs & Cats: Ideal for pets of different sizes.\n` +
  `🧼 Easy To Clean: Simply wipe the surface clean when needed.\n\n` +
  `**Available Sizes**\n` +
  `XS / S / M / L / XL / 2XL\n\n` +
  `Please select your required size from the available options before placing your order.\n\n` +
  `**Suitable For**\n` +
  `✓ Dogs\n✓ Cats\n✓ Indoor use\n✓ Travel\n\n` +
  `**Package Includes**\n` +
  `• 1 × Pet Cooling Mat\n\n` +
  `**Important:** Please check the size measurements carefully before ordering to ensure you select the correct size for your pet.\n\n` +
  `Give your pet a comfortable place to relax and stay cool throughout the warmer months.\n`;

// The bullet each list section takes by default (the editor's Check and Dot
// styles). The model is asked for them; this puts back any it leaves off, so
// a fresh draft always has them. Lines that already carry a marker — any
// bullet, number or emoji the seller or model chose — are left alone.
const SECTION_BULLETS = {
  'suitable for': '✓',
  'compatible with': '✓',
  'package includes': '•',
  'package contents': '•',
  "what's included": '•',
  'what’s included': '•',
  'in the box': '•',
};

function applyDefaultBullets(text) {
  if (typeof text !== 'string' || !text) return text;
  let bullet = null;
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        bullet = null; // a blank line ends the section
        return line;
      }
      const heading = trimmed.match(/^\*\*([^*]{2,90})\*\*:?$/);
      if (heading) {
        bullet = SECTION_BULLETS[heading[1].replace(/:$/, '').trim().toLowerCase()] || null;
        return line;
      }
      if (!bullet || listItem(trimmed)) return line;
      return `${bullet} ${trimmed}`;
    })
    .join('\n');
}

// Dashes used as punctuation, rewritten the way the prompt asks:
//   "2–4 days"                       → "2 to 4 days"
//   "Name – sentence" on a heading or list line (the first one) → "Name: sentence"
//   any other "a – b" / "a—b"        → "a, b"
//   a dash left dangling at a line end → removed
// A list line's own "–" bullet marker and hyphenated words (wall-mounted,
// 5-tier) are not punctuation and stay.
const SPACED_DASH = /\s+[–—]\s*|\s*[–—]\s+|\s+-\s+/;
function cleanDashes(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .split('\n')
    .map((line) => {
      const item = listItem(line.trim());
      const lead = item ? line.slice(0, line.indexOf(item.body)) : '';
      let body = item ? item.body : line;
      body = body.replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2');
      body = body.replace(/\s*[–—-]+\s*$/, '');
      const labelled = item || /^\*\*[^*]+\*\*:?$/.test(body.trim());
      if (labelled) body = body.replace(SPACED_DASH, (m, offset) => (offset > 0 ? ': ' : m));
      body = body.replace(new RegExp(SPACED_DASH.source, 'g'), ', ').replace(/[–—]/g, ', ');
      // "**Name – Benefit**" became "**Name: Benefit**"; a comma or colon
      // can't be left at the very start of the line.
      body = body.replace(/^[,:]\s*/, '');
      return lead + body;
    })
    .join('\n');
}

module.exports = { PROMPT_GUIDANCE, applyDefaultBullets, cleanDashes };
