// Renders a listing description as branded HTML in the seller's own store
// template — header, trust strip, delivery, returns, a carousel of the
// account's OTHER live listings, footer — with the AI-drafted copy in the
// middle. eBay accepts HTML descriptions; this is what "use a template" on
// eBay's own listing form does, done per account.
//
// Nothing in here is hardcoded to a store. Every value comes from that
// connection's template settings, and the "You may also like" cards come
// from that account's live listings at render time. Two sellers on the same
// Liston install get two different descriptions from the same draft.

const marketplaces = require('../ebay/marketplaces');
const showcase = require('./description-showcase');

// Tagline, warehouse note and carrier default to the account's own market
// (see templateWithDefaults); the values here are the UK ones.
// Typefaces a seller can pick for their template. eBay strips external
// stylesheets from a description, so every option is a stack of fonts
// buyers already have: it renders the same on eBay as in the preview.
const FONTS = [
  { id: 'modern', name: 'Modern Sans', stack: "Nunito,'Segoe UI',Helvetica,Arial,sans-serif" },
  { id: 'classic', name: 'Classic Sans', stack: "'Helvetica Neue',Helvetica,Arial,sans-serif" },
  { id: 'humanist', name: 'Humanist', stack: "Verdana,Tahoma,'Segoe UI',sans-serif" },
  { id: 'geometric', name: 'Geometric', stack: "'Trebuchet MS','Gill Sans','Century Gothic',sans-serif" },
  { id: 'rounded', name: 'Rounded', stack: "'Avenir Next Rounded','Arial Rounded MT Bold','Nunito',sans-serif" },
  { id: 'system', name: 'System', stack: "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" },
  { id: 'serif', name: 'Classic Serif', stack: "Georgia,'Times New Roman',Times,serif" },
  { id: 'elegant', name: 'Elegant Serif', stack: "'Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif" },
];
const fontStack = (id) => (FONTS.find((f) => f.id === id) || FONTS[0]).stack;

// Built-in layouts an account picks from. 'classic': the store header, one
// description block, trust badges, delivery and returns (below). The rest
// are card layouts (description-showcase.js): the description split into a
// gallery, a features grid, specifications, steps and notes, each with its
// own look.
const LAYOUTS = [
  { id: 'classic', name: 'Classic', blurb: 'Store header, one description block, trust badges, delivery and returns.' },
  { id: 'showcase', name: 'Showcase', blurb: 'Product first: photo gallery, features grid, specifications, how to use, why choose us.' },
  { id: 'minimal', name: 'Minimal', blurb: 'Clean white, thin lines and small accent headings. Lets the product speak.' },
  { id: 'bold', name: 'Bold', blurb: 'Dark hero banner, feature cards with icon circles, strong contrast.' },
  { id: 'boutique', name: 'Boutique', blurb: 'Warm cream, serif headings, centred sections. Suits home, fashion and gifts.' },
];

const DEFAULT_TEMPLATE = {
  layout: 'classic',
  // The Showcase layout's star line.
  bannerText: 'Top Quality • Fast Dispatch',
  storeName: '',
  tagline: 'Official UK Store',
  logoUrl: '',
  accentColor: '#FF6B2B',
  darkColor: '#1E1E2E',
  fontFamily: 'modern',
  feedbackPercent: '',
  dispatchTime: '1–2 Business Days',
  dispatchNote: 'From our UK warehouse',
  carrier: 'Royal Mail / Evri',
  deliveryTime: '2–4 Business Days',
  freePostage: true,
  returnsDays: 30,
  recommendedCount: 12,
  // Only genuine reviews the seller has entered are shown. A section of
  // fabricated five-star quotes is the kind of thing that gets a listing
  // removed; the section is simply omitted when there are none.
  reviews: [],
  responseTime: '24 hours',
  // The seller's own HTML for the whole description, with {{placeholders}}
  // (see PLACEHOLDERS). Empty means Liston's built-in layout.
  customHtml: '',
};

// Market-specific defaults win over the UK ones, and an explicitly saved
// value wins over both. A UK-default value saved on a US account (from
// before defaults were per market) is treated as unset.
function templateWithDefaults(template = {}, marketplaceId) {
  const copy = marketplaces.templateCopy(marketplaceId);
  const local = { tagline: copy.tagline, dispatchNote: copy.warehouse, carrier: copy.carrier };
  const cleaned = { ...template };
  for (const key of Object.keys(local)) {
    if (cleaned[key] === DEFAULT_TEMPLATE[key] && marketplaceId && marketplaceId !== marketplaces.DEFAULT_ID) delete cleaned[key];
  }
  return { ...DEFAULT_TEMPLATE, ...local, ...cleaned };
}

// How many of the store's listings a description shows: the Theme setting,
// 0 for none, 12 when it was never set. Every layout reads it the same way.
function listingCount(t) {
  const n = Number(t?.recommendedCount);
  return t?.recommendedCount === undefined || t?.recommendedCount === null || t?.recommendedCount === '' || !Number.isFinite(n) ? 12 : Math.max(0, n);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Inline formatting the seller (or the model) can use inside the plain-text
// description. Escaped first, then the markers become tags, so nothing but
// these exact patterns can produce HTML:
//   **bold**              → <strong>
//   ==highlight==         → <mark>
//   [color=#rrggbb]…[/color]  → coloured text (hex only)
//   [size=lg]…[/size]     → larger text (sm | lg | xl)
// A stray "**" that isn't closed is left as-is.
const SIZE_PX = { sm: '12px', lg: '18px', xl: '22px' };
function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/==([^=\n]+?)==/g, '<mark style="background:#fff59d;padding:0 2px;border-radius:2px">$1</mark>')
    .replace(/\[color=(#[0-9a-fA-F]{6})\]([\s\S]+?)\[\/color\]/g, '<span style="color:$1">$2</span>')
    .replace(/\[size=(sm|lg|xl)\]([\s\S]+?)\[\/size\]/g, (_, size, inner) => `<span style="font-size:${SIZE_PX[size]}">${inner}</span>`);
}

// A list line starts with a marker and a space. "•", "-" and "*" are the
// model's plain bullets and render as an ordinary <ul>; the editor's bullet
// library (○ ▪ ◆ ➤ ✓ ✔ ★ –), numbering (1. / 1)) and the emoji that lead each
// Key Features line (❄️ 🐶 …) keep the seller's exact marker, with a hanging
// indent (symbols and numbers in the store's accent colour). © ® ™ are not
// markers. The editor (frontend/components/RichTextEditor.tsx) uses the same
// pattern.
const EMOJI = '(?![©®™])\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?(?:\\u200D\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?)*';
const LIST_ITEM = new RegExp(`^([•●○◦▪■◆◇➤►▸→✓✔☑★☆–\\-*]|\\d{1,3}[.)]|${EMOJI})[ \\u00a0]+(.*)$`, 'u');

function listItem(line) {
  const m = line.match(LIST_ITEM);
  if (!m) return null;
  const marker = m[1];
  const kind = /^[•\-*]$/.test(marker) ? 'plain' : /\d/.test(marker) ? 'num' : 'sym';
  return { kind, marker, body: m[2] };
}

function listHtml(kind, items) {
  if (kind === 'plain') return `<ul>${items.map((it) => `<li>${inline(it.body)}</li>`).join('')}</ul>`;
  const cls = kind === 'num' ? 'eb-list eb-num' : 'eb-list';
  return `<ul class="${cls}">${items.map((it) => `<li><span class="eb-b">${escapeHtml(it.marker)}</span>${inline(it.body)}</li>`).join('')}</ul>`;
}

// A note the buyer must not miss ("**Important:** …", "Note: …", "Warning: …")
// renders as a highlighted callout, whoever wrote it. The editor highlights
// the same lines (frontend/components/RichTextEditor.tsx, NOTE_RE).
const NOTE_LINE = /^(?:\*\*)?(?:important|please note|note|warning|caution|attention)(?:\s*:\s*\*\*|\s*\*\*\s*:|\s*:)/i;
const isNoteLine = (line) => NOTE_LINE.test(line);

// A line written to the SELLER, not the buyer: the model sometimes turns
// what it couldn't tell from the product data into a reminder ("Important:
// Please confirm exact contents before publishing: add any additional units
// or accessories included in the pack."), and it went live on eBay. Buyers
// must never see those. Any line about publishing or a placeholder goes; a
// note line (Important:, Note: …) also goes when it tells someone to edit,
// update or add to the listing. A buyer's caution ("Please check your model
// before ordering") stays, and so does a book's "Published by …".
const SELLER_LINE =
  /\b(?:before|when|after) (?:you )?(?:publishing|listing)\b|\bpublish(?:ing)? (?:this|the) listing\b|\bplaceholder\b|\bTODO\b|\[(?:insert|add|enter|your|product|brand|model|x{2,})\b[^\]]*\]/i;
const SELLER_NOTE =
  /\bseller\b|\badd any (?:additional|extra|other)\b|\b(?:update|edit|amend|replace|adjust) (?:this|the) (?:description|listing|text|section)\b|\bconfirm (?:the )?exact (?:contents|quantity|quantities|items)\b|\bincluded in the pack\b/i;

/** The description without lines meant for the seller (see SELLER_LINE). */
function dropSellerNotes(text) {
  if (typeof text !== 'string' || !text) return text;
  const kept = text.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (SELLER_LINE.test(trimmed)) return false;
    return !(isNoteLine(trimmed) && SELLER_NOTE.test(trimmed));
  });
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The model writes plain text — paragraphs separated by blank lines, bullet
// lines starting with "•" or "-", and short ALL-CAPS lines as headings.
// Turned into the HTML the template's styles expect, with everything escaped.
function textToHtml(text) {
  const blocks = String(text || '').split(/\n\s*\n/);
  // "**Key Features:**" — a bold-only line — is a heading too.
  const isHeading = (line) => /^[A-Z0-9 &:\-–]{4,60}:?$/.test(line) || /^\*\*[^*]{2,90}\*\*:?$/.test(line);
  const headingHtml = (line) => `<p class="eb-h"><strong>${inline(line.replace(/^\*\*|\*\*:?$/g, '').replace(/:$/, ''))}</strong></p>`;
  return blocks
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return '';
      // Runs of consecutive lines: list items of one kind become one list;
      // other lines become a paragraph — or a heading when a lone line looks
      // like one ("KEY FEATURES:" straight into its list is how the model
      // writes it).
      const runs = [];
      for (const line of lines) {
        const item = listItem(line);
        const kind = item ? item.kind : isNoteLine(line) ? 'note' : 'text';
        const last = runs[runs.length - 1];
        if (last && last.kind === kind) last.items.push(item || line);
        else runs.push({ kind, items: [item || line] });
      }
      return runs
        .map((run) => {
          if (run.kind === 'note') return `<p class="eb-note">${run.items.map(inline).join('<br/>')}</p>`;
          if (run.kind !== 'text') return listHtml(run.kind, run.items);
          // A heading line with its section's content straight below it
          // ("**Suitable For**" then "Dogs", "Cats") renders as a heading
          // followed by that content.
          const [first, ...rest] = run.items;
          if (!isHeading(first)) return `<p>${run.items.map(inline).join('<br/>')}</p>`;
          return headingHtml(first) + (rest.length ? `<p>${rest.map(inline).join('<br/>')}</p>` : '');
        })
        .join('');
    })
    .join('');
}

function styles(t) {
  const a = t.accentColor;
  const d = t.darkColor;
  return `<style>
.eb{max-width:1400px;width:100%;margin:0 auto;font-family:${fontStack(t.fontFamily)};color:#1C1C1C;background:#fff;border:1px solid #E0E0E0;overflow-x:hidden}
.eb *{box-sizing:border-box}
.eb-header{background:${d};padding:0;overflow:hidden}
.eb-header-top{padding:18px 28px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.eb-logo-wrap{display:flex;align-items:center;gap:11px}
.eb-logo-img{width:52px;height:52px;border-radius:10px;overflow:hidden;flex-shrink:0;border:2px solid ${a};background:${a}}
.eb-logo-img img{width:100%;height:100%;object-fit:cover;display:block}
.eb-logo-fallback{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:20px}
.eb-logo-name{font-size:26px;font-weight:800;color:#fff;letter-spacing:-0.5px;line-height:1}
.eb-logo-tag{font-size:10px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#7A7A9A;margin-top:3px}
.eb-header-badges{display:flex;gap:7px;flex-shrink:0}
.eb-hbadge{background:rgba(255,255,255,0.08);border:1px solid ${a}59;border-radius:20px;padding:6px 14px;font-size:12px;color:${a};font-weight:700;white-space:nowrap}
.eb-header-bar{background:${a};padding:9px 28px;display:flex;gap:20px;align-items:center;overflow:hidden}
.eb-bar-item{font-size:12px;font-weight:700;color:#fff;letter-spacing:0.8px;text-transform:uppercase;white-space:nowrap}
.eb-bar-dot{color:rgba(255,255,255,0.4);font-size:12px}
.eb-hero{background:#F7F7FA;padding:26px 28px;border-left:5px solid ${a}}
.eb-pname{font-size:26px;font-weight:800;color:${d};line-height:1.4}
.eb-pill-row{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
.eb-pill{background:${a};color:#fff;font-size:12px;font-weight:700;padding:5px 13px;border-radius:20px;letter-spacing:0.5px}
.eb-pill.outline{background:transparent;color:${a};border:1.5px solid ${a}}
.eb-sec{padding:24px 28px;border-bottom:1px solid #EBEBEB}
.eb-stitle{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:${a};margin-bottom:14px;display:flex;align-items:center;gap:8px}
.eb-stitle::after{content:'';flex:1;height:1.5px;background:#F0F0F0}
.eb-desc{font-size:16px;color:#2D2D2D;line-height:1.8}
.eb-desc p{margin:0 0 10px}
.eb-desc p.eb-h{font-size:18px;margin:18px 0 6px}
.eb-desc p.eb-h:first-child{margin-top:0}
.eb-desc p.eb-note{background:#FFF7E6;border:1px solid #FCD9A0;border-left:4px solid #F59E0B;border-radius:8px;padding:12px 16px;margin:14px 0;color:#7C2D12;font-weight:600}
.eb-desc p.eb-note strong{color:#B45309}
.eb-desc ul{padding-left:18px;margin:0 0 10px}
.eb-desc li{margin-bottom:5px}
.eb-desc ul.eb-list{list-style:none;padding-left:0}
.eb-desc ul.eb-list li{position:relative;padding-left:1.6em}
.eb-desc ul.eb-num li{padding-left:2em}
.eb-desc .eb-b{position:absolute;left:0;top:0;color:${a};font-weight:800}
.eb-desc strong{color:${d};font-weight:700}
.eb-trust{background:${d};padding:18px 24px;display:flex;gap:6px;flex-wrap:wrap}
.eb-tbadge{flex:1;min-width:100px;background:rgba(255,255,255,0.06);border:1px solid ${a}33;border-radius:10px;padding:10px 8px;text-align:center}
.eb-ticon{font-size:22px;display:block}
.eb-ttitle{color:#fff;font-size:13px;font-weight:700;display:block;margin-top:5px}
.eb-tsub{color:#7A7A9A;font-size:11px;display:block;margin-top:2px}
.eb-drow{display:flex;gap:10px;flex-wrap:wrap}
.eb-ditem{flex:1;min-width:120px;background:#F7F7FA;border:1px solid #E8E8E8;border-radius:10px;padding:13px 14px;border-bottom:3px solid ${a}}
.eb-dlbl{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:#9090A0}
.eb-dval{font-size:15px;font-weight:800;color:${d};margin-top:5px}
.eb-dnote{font-size:12px;color:#9090A0;margin-top:2px}
.eb-policy{font-size:15px;line-height:1.8;color:#3D3D3D;margin:0}
.eb-policy strong{color:${d}}
.eb-policy-note{font-size:12px;color:#9090A0;margin:8px 0 0;line-height:1.6}
.eb-fgrid{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;padding:4px 2px 14px;scrollbar-width:thin;scrollbar-color:${a} #F0F0F0}
.eb-fgrid::-webkit-scrollbar{height:8px}
.eb-fgrid::-webkit-scrollbar-track{background:#F0F0F0;border-radius:8px}
.eb-fgrid::-webkit-scrollbar-thumb{background:${a};border-radius:8px}
.eb-fcard{flex:0 0 260px;width:260px;scroll-snap-align:start;background:#F7F7FA;border:1px solid #E8E8E8;border-radius:10px;padding:14px;border-top:3px solid ${a}}
.eb-fstars{color:${a};font-size:14px;letter-spacing:1px}
.eb-ftext{font-size:12px;color:#3D3D3D;line-height:1.65;margin-top:8px;font-style:italic}
.eb-fname{font-size:11px;font-weight:700;color:${d};margin-top:10px}
.eb-fdate{font-size:10px;color:#9090A0;margin-top:2px}
.eb-rgrid{display:flex;gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;padding:4px 2px 14px;scrollbar-width:thin;scrollbar-color:${a} #F0F0F0}
.eb-rgrid::-webkit-scrollbar{height:8px}
.eb-rgrid::-webkit-scrollbar-track{background:#F0F0F0;border-radius:8px}
.eb-rgrid::-webkit-scrollbar-thumb{background:${a};border-radius:8px}
.eb-rcard{flex:0 0 200px;width:200px;scroll-snap-align:start;border:1.5px solid #E8E8E8;border-radius:12px;overflow:hidden;text-decoration:none;display:block;background:#fff}
.eb-rimg{width:100%;height:200px;object-fit:cover;background:#F7F7FA;display:block}
.eb-rinfo{padding:10px 12px;border-top:2px solid ${a}}
.eb-rname{font-size:13px;font-weight:700;color:${d};line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.eb-rfrom{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#9090A0;display:block;margin-top:6px}
.eb-rprice{font-size:16px;font-weight:800;color:${a}}
.eb-rhint{font-size:11px;color:#9090A0;margin:0 0 10px}
.eb-footer{background:${d};padding:18px 28px;text-align:center;border-top:3px solid ${a}}
.eb-footer p{font-size:13px;color:#7A7A9A;margin:0}
.eb-footer strong{color:#fff}
.eb-save{font-size:13px;color:${a};margin-top:5px;display:block;font-weight:700}
@media(max-width:480px){.eb-header-badges{display:none}.eb-fcard{flex-basis:220px;width:220px}.eb-rcard{flex-basis:150px;width:150px}.eb-rimg{height:150px}.eb-pname{font-size:20px}.eb-sec{padding:18px}}
</style>`;
}

/**
 * @param template     the connection's template settings (partial ok)
 * @param productName  the listing title
 * @param description  the AI-drafted plain-text description
 * @param recommended  [{ url, imageUrl, name, price }] — the account's own
 *                     live listings, fetched by the caller
 * @param condition    'NEW' etc.
 */
// The values a seller's own template HTML can use, and what each becomes.
const PLACEHOLDERS = [
  ['productName', 'The listing title'],
  ['description', 'The description as HTML paragraphs'],
  ['storeName', 'Store name'],
  ['tagline', 'The line under the store name'],
  ['logoUrl', 'Logo image URL'],
  ['feedback', 'e.g. "99.8% Positive", empty when unknown'],
  ['accentColor', 'Accent colour hex'],
  ['darkColor', 'Header colour hex'],
  ['fontFamily', 'The chosen font stack, for a CSS font-family'],
  ['condition', 'e.g. New'],
  ['dispatchTime', 'Dispatch time'],
  ['deliveryTime', 'Delivery time'],
  ['carrier', 'Carrier'],
  ['returnsDays', 'Returns period in days'],
  ['recommended', 'The "More from our store" cards as HTML'],
  ['reviews', 'The reviews section as HTML'],
];

function fillPlaceholders(html, values) {
  return String(html).replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

// images: the listing's photos; specifics: its item specifics; storeUrl:
// the seller's other items on eBay — all used by the Showcase layout.
function renderDescription({ template, marketplaceId, productName, description, descriptionHtml, recommended = [], condition = 'NEW', images = [], specifics = {}, storeUrl = null }) {
  const t = templateWithDefaults(template, marketplaceId);
  const copy = marketplaces.templateCopy(marketplaceId);
  const storeName = escapeHtml(t.storeName || 'Our Store');
  const feedback = t.feedbackPercent ? `${escapeHtml(String(t.feedbackPercent).replace('%', ''))}% Positive` : null;
  const postageWord = escapeHtml(copy.postageWord);
  const postage = t.freePostage ? `Free ${postageWord}` : `Tracked ${postageWord}`;
  const returns = Number(t.returnsDays) > 0 ? `${Number(t.returnsDays)}-Day Returns` : null;
  // A seller's reminder left in the text never reaches buyers, even on a
  // draft written before the model was told not to.
  const descHtml = descriptionHtml !== undefined ? descriptionHtml : textToHtml(dropSellerNotes(description));
  const conditionLabel = escapeHtml(String(condition).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));

  const reviews = (t.reviews || []).filter((r) => r && r.text).slice(0, 10);
  const reviewsHtml = reviews.length
    ? `<div class="eb-sec">
    <div class="eb-stitle">What Customers Say</div>
    <p class="eb-rhint">Scroll to see more →</p>
    <div class="eb-fgrid">${reviews
      .map(
        (r) => `<div class="eb-fcard"><div class="eb-fstars">${'★'.repeat(Math.min(5, Math.max(1, Number(r.stars) || 5)))}</div><div class="eb-ftext">"${escapeHtml(r.text)}"</div><div class="eb-fname">${escapeHtml(r.buyer || 'eBay buyer')}</div><div class="eb-fdate">${escapeHtml(r.date || '')}${r.date ? ' · ' : ''}Verified Purchase</div></div>`
      )
      .join('')}</div>
  </div>`
    : '';
  const recommendedHtml = recommended.length
    ? `<div class="eb-sec">
    <div class="eb-stitle">Best Sellers From Our Store</div>
    <p class="eb-rhint">Scroll to see more →</p>
    <div class="eb-rgrid">${recommended
      .slice(0, listingCount(t))
      .map(
        (item) => `<a href="${escapeHtml(item.url)}" class="eb-rcard" target="_blank" rel="noopener">${
          item.imageUrl ? `<img class="eb-rimg" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" />` : '<div class="eb-rimg"></div>'
        }<div class="eb-rinfo"><div class="eb-rname">${escapeHtml(item.name)}</div>${
          item.price ? `<span class="eb-rfrom">${item.sold > 1 ? `${escapeHtml(String(item.sold))} sold` : 'From'}</span><div class="eb-rprice">${escapeHtml(item.price)}</div>` : ''
        }</div></a>`
      )
      .join('')}</div>
  </div>`
    : '';

  // The seller's own layout, if they wrote one.
  if (t.customHtml && t.customHtml.trim()) {
    return fillPlaceholders(t.customHtml, {
      productName: escapeHtml(productName),
      description: descHtml,
      storeName,
      tagline: escapeHtml(t.tagline),
      logoUrl: escapeHtml(t.logoUrl || ''),
      feedback: feedback || '',
      accentColor: escapeHtml(t.accentColor),
      darkColor: escapeHtml(t.darkColor),
      fontFamily: escapeHtml(fontStack(t.fontFamily)),
      condition: conditionLabel,
      dispatchTime: escapeHtml(t.dispatchTime),
      deliveryTime: escapeHtml(t.deliveryTime),
      carrier: escapeHtml(t.carrier),
      returnsDays: String(Number(t.returnsDays) || 0),
      recommended: recommendedHtml,
      reviews: reviewsHtml,
    });
  }

  if (showcase.VARIANTS.includes(t.layout) && descriptionHtml === undefined) {
    return showcase.renderShowcase(
      { t, copy, productName, description: dropSellerNotes(description), images, specifics, recommended, storeUrl, condition: conditionLabel, storeName, feedback },
      { escapeHtml, inline, listItem, isNoteLine, fontStack, listingCount },
      t.layout
    );
  }

  const logo = t.logoUrl
    ? `<img src="${escapeHtml(t.logoUrl)}" alt="${storeName}" />`
    : `<div class="eb-logo-fallback">${escapeHtml((t.storeName || 'S').slice(0, 1).toUpperCase())}</div>`;

  const barItems = [
    `${copy.flag} ${escapeHtml(copy.based)}`,
    '⚡ Fast Dispatch',
    `📦 ${postage}`,
    returns ? `↩ ${returns}` : null,
    feedback ? `⭐ ${feedback.replace(' Positive', ' Feedback')}` : null,
  ].filter(Boolean);

  const trust = [
    [copy.flag, escapeHtml(copy.based), 'Local dispatch'],
    ['⚡', 'Fast Dispatch', escapeHtml(t.dispatchTime)],
    returns ? ['↩', returns, 'Hassle-free'] : null,
    ['📦', postage, escapeHtml(copy.orders)],
    feedback ? ['⭐', feedback, 'Verified feedback'] : null,
  ].filter(Boolean);

  return `${styles(t)}
<div class="eb">
  <div class="eb-header">
    <div class="eb-header-top">
      <div class="eb-logo-wrap">
        <div class="eb-logo-img">${logo}</div>
        <div>
          <div class="eb-logo-name">${storeName}</div>
          <div class="eb-logo-tag">${escapeHtml(t.tagline)}</div>
        </div>
      </div>
      <div class="eb-header-badges">
        ${feedback ? `<span class="eb-hbadge">${feedback}</span>` : ''}
        <span class="eb-hbadge">${postage}</span>
      </div>
    </div>
    <div class="eb-header-bar">${barItems.map((i) => `<span class="eb-bar-item">${i}</span>`).join('<span class="eb-bar-dot">·</span>')}</div>
  </div>

  <div class="eb-hero">
    <div class="eb-pname">${escapeHtml(productName)}</div>
    <div class="eb-pill-row">
      <span class="eb-pill">${conditionLabel}</span>
      <span class="eb-pill outline">${escapeHtml(copy.stock)}</span>
      <span class="eb-pill outline">${postage}</span>
    </div>
  </div>

  <div class="eb-sec">
    <div class="eb-stitle">Description</div>
    <div class="eb-desc">${descHtml}</div>
  </div>

  <div class="eb-trust">${trust
    .map(([icon, title, sub]) => `<div class="eb-tbadge"><span class="eb-ticon">${icon}</span><span class="eb-ttitle">${title}</span><span class="eb-tsub">${sub}</span></div>`)
    .join('')}</div>

  <div class="eb-sec">
    <div class="eb-stitle">Delivery &amp; Dispatch</div>
    <div class="eb-drow">
      <div class="eb-ditem"><div class="eb-dlbl">Dispatch</div><div class="eb-dval">${escapeHtml(t.dispatchTime)}</div><div class="eb-dnote">${escapeHtml(t.dispatchNote)}</div></div>
      <div class="eb-ditem"><div class="eb-dlbl">Carrier</div><div class="eb-dval">${escapeHtml(t.carrier)}</div><div class="eb-dnote">Tracked service</div></div>
      <div class="eb-ditem"><div class="eb-dlbl">Delivery</div><div class="eb-dval">${escapeHtml(t.deliveryTime)}</div><div class="eb-dnote">After dispatch</div></div>
      <div class="eb-ditem"><div class="eb-dlbl">Postage</div><div class="eb-dval">${postage}</div><div class="eb-dnote">${escapeHtml(copy.addresses)}</div></div>
    </div>
  </div>

  ${
    returns
      ? `<div class="eb-sec">
    <div class="eb-stitle">Returns Policy</div>
    <p class="eb-policy">We offer a <strong>${Number(t.returnsDays)}-day hassle-free return policy</strong> on all items. Not completely satisfied? Message us through eBay and we'll sort it immediately. No fuss, no stress, guaranteed.</p>
    <p class="eb-policy-note">Items must be returned in original condition and packaging. Buyer pays return postage unless the item is faulty or not as described. Refunds processed within 2 business days of receiving the return.</p>
  </div>`
      : ''
  }

  ${reviewsHtml}

  ${recommendedHtml}

  <div class="eb-footer">
    <p>© <strong>${storeName}</strong> &nbsp;·&nbsp; ${escapeHtml(copy.business)} &nbsp;·&nbsp; All items sold new &amp; unused</p>
    <p style="margin-top:4px;">Questions? <strong>Message us on eBay</strong>. We respond within ${escapeHtml(t.responseTime)}.</p>
    <span class="eb-save">⭐ Love ${storeName}? Click "Save seller" to never miss a new listing or deal</span>
  </div>
</div>`;
}

// The built-in layout as editable source: the same HTML, with the values
// that change per listing left as {{placeholders}}. What the seller sees
// when they press "Edit code", and what they start from.
function renderTemplateSource({ template, marketplaceId }) {
  // The code a seller edits starts from the Classic layout: Showcase splits
  // the description into cards, which a single {{description}} can't.
  const t = { ...templateWithDefaults(template, marketplaceId), customHtml: '', layout: 'classic' };
  return renderDescription({
    template: t,
    marketplaceId,
    productName: '{{productName}}',
    descriptionHtml: '{{description}}',
    recommended: [{ url: '#', imageUrl: '', name: 'RECOMMENDED_PLACEHOLDER', price: '' }],
    condition: '{{condition}}',
  })
    .replace(/<div class="eb-sec">\s*<div class="eb-stitle">More From Our Store<\/div>[\s\S]*?<\/div>\s*<\/div>/, '{{recommended}}')
    // The condition label is title-cased on the way through.
    .replace(/\{\{Condition\}\}/g, '{{condition}}');
}

module.exports = { LAYOUTS, renderDescription, renderTemplateSource, fillPlaceholders, textToHtml, dropSellerNotes, listItem, templateWithDefaults, DEFAULT_TEMPLATE, PLACEHOLDERS, FONTS };
