// The "Showcase" description layout: product first, the way the best UK
// dropshipping listings present it. A star line and the product's name with
// its benefit and feature pills; a photo gallery (thumbnails switch the big
// photo, a click zooms — pure CSS, since eBay allows no scripts); then the
// description split into cards: the introduction, Key Features as a grid,
// the item specifics as a table, Perfect For, How To Use as numbered steps,
// Package Includes beside the Important notes, the store's promises, more
// from the store, and a thank-you.
//
// The description is the same plain text the editor holds (see
// ai-generation/description-format.js); it's read into sections here, so a
// seller's edits in the editor show up in the right card. Nothing about a
// store is hardcoded: colours, copy and cards come from the account.

// Headings, lower-cased, to the card they fill.
const SECTION_OF = [
  [/^(key )?features?$|^highlights?$|^why you.?ll love it$/, 'features'],
  [/^available /, 'options'],
  [/^(suitable|perfect|ideal) for$|^compatible with$|^great for$/, 'perfectFor'],
  [/^package (includes|contents)$|^what.?s included$|^in the box$/, 'includes'],
  [/^how to (use|fit|install|set up)$|^instructions$|^how it works$|^setup$/, 'steps'],
  [/^specifications?$|^specs$|^product details$|^details$/, 'specs'],
];
const sectionOf = (heading) => (SECTION_OF.find(([re]) => re.test(heading.toLowerCase().trim())) || [null, 'other'])[1];

const HEADING = (line) => /^\*\*[^*]{2,90}\*\*:?$/.test(line) || /^[A-Z0-9 &:\-–']{4,60}:?$/.test(line);
const headingText = (line) => line.replace(/^\*\*|\*\*:?$/g, '').replace(/:$/, '').trim();
const stripMarker = (line, h) => h.listItem(line)?.body ?? line;

/**
 * The description read into sections: { title, subtitle, intro[], features
 * [{ icon, name, text }], options { heading, values[], note }, perfectFor[],
 * includes[], steps[], specs[[name, value]], notes[], other [{ heading,
 * lines }], closing[] }.
 */
function readSections(text, h) {
  const out = { title: null, subtitle: null, intro: [], features: [], options: null, perfectFor: [], perfectForHeading: null, includes: [], steps: [], specs: [], notes: [], other: [], closing: [] };
  const blocks = String(text || '')
    .split(/\n\s*\n/)
    .map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((b) => b.length);
  let current = null; // the section later blocks continue
  let sawSection = false;
  blocks.forEach((lines, index) => {
    // Note lines ("**Important:** …") go to the notes card wherever they are.
    const notes = lines.filter((l) => h.isNoteLine(l));
    notes.forEach((n) => out.notes.push(n.replace(/^\*\*(important|please note|note|warning|caution|attention)\s*:?\s*\*\*\s*:?\s*/i, '').replace(/^(important|please note|note|warning|caution|attention)\s*:\s*/i, '')));
    const rest = lines.filter((l) => !h.isNoteLine(l));
    if (!rest.length) return;

    // The headline: the first line, bold, and not a section heading. The
    // introduction often follows it in the same block.
    if (index === 0 && /^\*\*[^*]+\*\*$/.test(rest[0]) && sectionOf(headingText(rest[0])) === 'other') {
      const [name, ...benefit] = headingText(rest[0]).split(/:\s+/);
      out.title = name.trim();
      out.subtitle = benefit.join(': ').trim() || null;
      out.intro.push(...rest.slice(1));
      return;
    }

    let body = rest;
    if (HEADING(rest[0])) {
      const heading = headingText(rest[0]);
      const kind = sectionOf(heading);
      current = { kind, heading };
      sawSection = true;
      if (kind === 'other') out.other.push({ heading, lines: [] });
      if (kind === 'options') out.options = { heading, values: [], note: null };
      if (kind === 'perfectFor') out.perfectForHeading = heading;
      body = rest.slice(1);
      if (!body.length) return;
    } else if (!sawSection) {
      out.intro.push(...rest);
      return;
    } else if (current && !['options', 'other'].includes(current.kind) && rest.every((l) => !h.listItem(l))) {
      // A plain paragraph after a list section: the listing's closing words.
      current = null;
    }

    if (!current) {
      out.closing.push(...body);
      return;
    }
    switch (current.kind) {
      case 'features':
        for (const line of body) {
          const item = h.listItem(line);
          const [name, ...more] = (item ? item.body : line).split(/:\s+/);
          out.features.push({ icon: item && item.kind === 'sym' ? item.marker : null, name: name.replace(/\*\*/g, '').trim(), text: more.join(': ').trim() });
        }
        break;
      case 'options':
        if (!out.options.values.length && body.length === 1 && / \/ /.test(body[0])) out.options.values = body[0].split(' / ').map((v) => v.trim()).filter(Boolean);
        else out.options.note = [out.options.note, ...body].filter(Boolean).join(' ');
        break;
      case 'perfectFor':
        out.perfectFor.push(...body.map((l) => stripMarker(l, h)));
        break;
      case 'includes':
        out.includes.push(...body.map((l) => stripMarker(l, h)));
        break;
      case 'steps':
        out.steps.push(...body.map((l) => stripMarker(l, h)));
        break;
      case 'specs':
        for (const line of body) {
          const [name, ...value] = stripMarker(line, h).split(/:\s+/);
          if (value.length) out.specs.push([name.trim(), value.join(': ').trim()]);
        }
        break;
      default:
        out.other[out.other.length - 1].lines.push(...body);
    }
  });
  return out;
}

// A colour mixed toward white: pale fills and borders from the accent.
function tint(hex, amount) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (Number.isNaN(n)) return '#f4f4f6';
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// The card layouts share one structure; each is a skin over it.
const VARIANTS = ['showcase', 'minimal', 'bold', 'boutique'];

function variantStyles(variant, t) {
  const a = t.accentColor;
  const d = t.darkColor;
  const pale = tint(a, 0.9);
  const soft = tint(a, 0.72);
  if (variant === 'minimal') {
    return `
.sx{background:#fff;padding:24px 20px}
.sx-top{border-bottom:1px solid #e7e7ea;text-align:left;padding:4px 0 22px}
.sx-stars{color:#8a8a94;letter-spacing:1.5px}
.sx-title{font-size:32px;font-weight:700;letter-spacing:-.5px}
.sx-pill{background:transparent;border:1px solid #dcdce2;border-radius:20px;font-weight:600;color:#44444c}
.sx-card{border:0;border-radius:0;border-bottom:1px solid #eeeef1;margin-bottom:6px}
.sx-head,.sx-head.sx-dark{background:transparent;color:${a};font-size:12px;letter-spacing:2px;padding:18px 0 6px}
.sx-body{padding:6px 0 18px}
.sx-gl{flex-direction:column;max-width:680px}
.sx-tw{position:static;width:100%;flex:none}
.sx-thumbs{position:static;display:flex;flex-wrap:wrap;gap:8px;justify-content:center;overflow:visible}
.sx-thumbs label{width:76px;height:76px;border-width:1px;border-color:#e3e3e8}
.sx-feat{border-bottom:0;padding:8px 10px}
.sx-feat b:before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:${a};margin-right:8px;vertical-align:middle}
.sx-fi{display:none}
.sx-table td{border-bottom:1px solid #f1f1f4}
.sx-list li{border-bottom:0}
.sx-inc,.sx-notes{background:#fafafb;border:1px solid #ececf0}
.sx-notes h3{color:${d}}
.sx-notes p{color:#44444c}
.sx-tile{background:transparent;border:0;border-top:2px solid ${a};border-radius:0}
.sx-prod{border-color:#ececf0}
.sx-thanks{background:transparent;color:#6b6b78;border-top:1px solid #eeeef1;border-radius:0}
.sx-deliv div,.sx-rev{background:#fafafb;border:1px solid #ececf0;border-bottom:2px solid ${a}}
.sx-rev{border-bottom:1px solid #ececf0;border-top:2px solid ${a}}
.sx-fb{background:transparent;border-color:#dcdce2}
.sx-thanks strong{color:${d}}`;
  }
  if (variant === 'bold') {
    return `
.sx{background:#f3f3f5}
.sx-top{background:${d};border:0;border-radius:14px;padding:28px 20px 24px;margin-bottom:16px}
.sx-stars{color:${soft}}
.sx-title{color:#fff;font-size:34px;font-weight:900;text-transform:uppercase;letter-spacing:-.3px}
.sx-sub{color:${soft};font-size:16px}
.sx-pill{background:${a};border-color:${a};color:#fff;border-radius:30px}
.sx-card{border:0;border-left:6px solid ${a};border-radius:10px}
.sx-head,.sx-head.sx-dark{background:#fff;color:${d};font-size:20px;font-weight:900;padding:16px 18px 4px}
.sx-feat{width:33.33%;border:0;padding:10px}
.sx-feat b{font-size:15px}
.sx-fi{display:block;width:40px;height:40px;border-radius:50%;background:${a};color:#fff;text-align:center;line-height:40px;font-size:19px;margin:0 0 8px}
.sx-n{flex-basis:34px;height:34px;line-height:34px;font-size:16px;border-radius:8px;background:${d}}
.sx-list li:before{border-radius:2px;background:${d}}
.sx-tile{background:${d};border:0}
.sx-tile b{color:#fff}
.sx-tile span{color:${soft}}
.sx-btn{background:${d}}
.sx-btn.sx-dark{background:${a}}
.sx-thanks{background:${a}}
@media(max-width:640px){.sx-feat{width:50%}.sx-title{font-size:25px}}`;
  }
  if (variant === 'boutique') {
    return `
.sx{background:#faf7f2;color:#3b3530}
.sx-top{border-bottom:0;padding:18px 12px 8px}
.sx-stars{color:#b08d57;letter-spacing:3px}
.sx-title{font-family:Georgia,'Palatino Linotype',serif;font-weight:400;font-size:34px;color:${d}}
.sx-sub{font-style:italic}
.sx-pill{background:#fff;border:1px solid #e6dccb;border-radius:30px;font-weight:600;color:#6d5a44}
.sx-card{background:#fff;border:1px solid #eee5d6;border-radius:18px}
.sx-head,.sx-head.sx-dark{background:transparent;color:${d};text-align:center;font-family:Georgia,'Palatino Linotype',serif;font-weight:400;font-size:21px;text-transform:none;letter-spacing:.5px;padding:18px 18px 0}
.sx-head:before,.sx-head:after{content:'';display:inline-block;width:36px;height:1px;background:#c9ae82;vertical-align:middle;margin:0 12px}
.sx-feat{width:33.33%;text-align:center;border:0;padding:14px 10px}
.sx-fi{display:block;font-size:26px;margin:0 0 6px}
.sx-intro{text-align:center;font-style:italic}
.sx-list{text-align:center}
.sx-list li{padding-left:0;border-bottom:1px dashed #eee5d6}
.sx-list li:before{display:none}
.sx-n{background:#c9ae82}
.sx-inc,.sx-notes{background:#fff;border:1px solid #eee5d6;border-radius:18px}
.sx-notes h3,.sx-inc h3{font-family:Georgia,serif;font-weight:400;text-transform:none;font-size:18px;color:${d}}
.sx-notes p{color:#6d4a2c}
.sx-tile{background:#fff;border:1px solid #eee5d6;border-radius:18px}
.sx-prod{border-color:#eee5d6;border-radius:14px}
.sx-btn{background:#c9ae82}
.sx-btn.sx-dark{background:${d}}
.sx-thanks{background:transparent;color:#6d5a44;font-family:Georgia,serif;font-style:italic;font-size:16px}
.sx-deliv div,.sx-rev{background:#fff;border:1px solid #eee5d6;border-radius:14px}
.sx-deliv div{border-bottom:2px solid #c9ae82}
.sx-rev{border-top:2px solid #c9ae82}
.sx-rstars{color:#b08d57}
.sx-fb{background:#fff;border-color:#e6dccb;color:#6d5a44}
.sx-bname b{font-family:Georgia,serif;font-weight:400}
.sx-thanks strong{color:${d}}
@media(max-width:640px){.sx-feat{width:50%}.sx-title{font-size:26px}}`;
  }
  void pale;
  return '';
}

function styles(t, fontStack, images, variant = 'showcase') {
  const a = t.accentColor;
  const d = t.darkColor;
  const pale = tint(a, 0.9);
  const soft = tint(a, 0.72);
  const slides = images
    .map((_, i) => `#sxg${i + 1}:checked~.sx-gl .sx-s${i + 1}{display:block}#sxg${i + 1}:checked~.sx-gl .sx-t${i + 1}{border-color:${a};box-shadow:0 0 0 2px ${soft}}#sxz${i + 1}:checked~.sx-gl .sx-s${i + 1} img{transform:scale(2.2)}#sxz${i + 1}:checked~.sx-gl .sx-s${i + 1} .sx-zoom{cursor:zoom-out}`)
    .join('');
  return `<style>
.sx{max-width:1100px;margin:0 auto;font-family:${fontStack};color:#2b2b33;background:${tint(a, 0.965)};padding:18px;line-height:1.6}
.sx *{box-sizing:border-box}
.sx-top{text-align:center;padding:10px 12px 20px;border-bottom:3px solid ${a};margin-bottom:16px}
.sx-stars{font-size:12px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${a}}
.sx-title{font-size:30px;font-weight:800;color:${d};margin:8px 0 4px;line-height:1.25}
.sx-sub{font-size:15px;color:#6b6b78;margin:0}
.sx-pills{margin-top:14px}
.sx-pill{display:inline-block;margin:4px;padding:6px 14px;border-radius:8px;background:${pale};border:1px solid ${soft};color:${d};font-size:13px;font-weight:700}
.sx-card{background:#fff;border:1px solid ${soft};border-radius:12px;margin-bottom:16px;overflow:hidden}
.sx-head{background:${a};color:#fff;font-size:17px;font-weight:800;padding:12px 18px;letter-spacing:.3px;text-transform:uppercase}
.sx-head.sx-dark{background:${d};text-transform:none}
.sx-body{padding:16px 18px}
.sx-intro{font-size:15px;color:#3a3a44}
.sx-intro p{margin:0 0 8px}
.sx-r{display:none}
.sx-slide{display:none}
.sx-gl{display:flex;gap:10px;align-items:stretch;max-width:860px;margin:0 auto}
.sx-stage{flex:1;min-width:0}
.sx-zoom{display:block;position:relative;width:100%;height:560px;overflow:hidden;border-radius:10px;background:#fff;cursor:zoom-in}
@supports (aspect-ratio:1/1){.sx-zoom{height:auto;aspect-ratio:1/1;max-height:680px}}
.sx-fill{position:absolute;top:-24px;right:-24px;bottom:-24px;left:-24px;background-size:cover;background-position:center;filter:blur(22px);opacity:.38}
.sx-zoom img{position:relative;display:block;width:100%;height:100%;object-fit:contain;transition:transform .35s ease}
.sx-zb{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.62);color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px;white-space:nowrap}
.sx-tw{position:relative;flex:0 0 96px;width:96px}
.sx-thumbs{position:absolute;top:0;right:0;bottom:0;left:0;overflow-y:auto;display:grid;grid-template-columns:1fr;grid-auto-rows:96px;gap:8px;align-content:start;scrollbar-width:thin}
.sx-thumbs label{display:block;border:2px solid ${soft};border-radius:8px;padding:3px;margin:0;background:#fff;cursor:pointer;overflow:hidden}
.sx-thumbs img{display:block;width:100%;height:100%;object-fit:contain}
${slides}
.sx-grid{display:flex;flex-wrap:wrap}
.sx-feat{width:50%;padding:12px 10px;border-bottom:1px solid ${pale}}
.sx-feat b{display:block;color:${d};font-size:15px}
.sx-feat span{font-size:14px;color:#55555f}
.sx-fi{font-size:18px;margin-right:6px}
.sx-table{width:100%;border-collapse:collapse;font-size:14px}
.sx-table td{padding:10px 8px;border-bottom:1px solid ${pale};vertical-align:top}
.sx-table td:first-child{font-weight:700;color:${d};width:38%}
.sx-list{list-style:none;margin:0;padding:0}
.sx-list li{padding:8px 0 8px 22px;border-bottom:1px solid ${pale};position:relative;font-size:14.5px}
.sx-list li:before{content:'';position:absolute;left:4px;top:15px;width:8px;height:8px;border-radius:50%;background:${a}}
.sx-steps{list-style:none;margin:0;padding:0}
.sx-steps li{display:flex;gap:12px;align-items:flex-start;padding:7px 0;font-size:14.5px}
.sx-n{flex:0 0 26px;height:26px;border-radius:50%;background:${a};color:#fff;font-weight:800;font-size:13px;text-align:center;line-height:26px}
.sx-chips span{display:inline-block;margin:3px;padding:5px 12px;border-radius:20px;border:1px solid ${soft};background:${pale};font-size:13px;font-weight:700;color:${d}}
.sx-pair{display:flex;gap:16px;margin-bottom:16px}
.sx-pair>div{flex:1;min-width:0;border-radius:12px;padding:16px 18px}
.sx-inc{background:#fff;border:1px solid ${soft}}
.sx-notes{background:#fff6ee;border:1px solid #f4cfae}
.sx-pair h3{margin:0 0 10px;font-size:15px;font-weight:800;letter-spacing:.3px;text-transform:uppercase;color:${d}}
.sx-notes h3{color:#9a3412}
.sx-pair p{margin:0 0 6px;font-size:14px}
.sx-notes p{color:#7c2d12}
.sx-tiles{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}
.sx-tile{flex:1;min-width:170px;max-width:240px;background:${pale};border:1px solid ${soft};border-radius:10px;padding:16px 12px;text-align:center}
.sx-tile i{font-style:normal;font-size:24px;display:block}
.sx-tile b{display:block;color:${d};margin-top:6px;font-size:14.5px}
.sx-tile span{font-size:12.5px;color:#6b6b78}
.sx-shop{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.sx-prod{display:block;min-width:0;border:1px solid ${soft};border-radius:10px;padding:10px;text-align:center;background:#fff;text-decoration:none;color:${d}}
.sx-prod img{width:100%;height:160px;object-fit:contain;display:block}
.sx-prod b{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;font-size:13px;line-height:1.35;margin:8px 0;min-height:2.7em;overflow:hidden}
.sx-btn{display:inline-block;background:${a};color:#fff;border-radius:6px;padding:7px 14px;font-size:13px;font-weight:800;text-decoration:none}
.sx-btn.sx-dark{background:${d};padding:10px 22px;font-size:14px}
.sx-center{text-align:center;margin-top:14px}
.sx-thanks{background:${d};color:#fff;text-align:center;border-radius:12px;padding:16px;font-size:14px}
.sx-thanks span{display:block;margin-top:6px;font-size:12.5px;opacity:.85}
.sx-brand{display:flex;align-items:center;gap:12px;padding:4px 4px 14px}
.sx-logo{width:46px;height:46px;flex:0 0 46px;border-radius:10px;overflow:hidden;background:${a};border:2px solid ${a};display:flex;align-items:center;justify-content:center}
.sx-logo img{width:100%;height:100%;object-fit:cover;display:block}
.sx-logo span{color:#fff;font-weight:800;font-size:19px}
.sx-bname{flex:1;min-width:0}
.sx-bname b{display:block;font-size:18px;color:${d};line-height:1.2}
.sx-bname span{display:block;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#8a8a94}
.sx-fb{flex:0 0 auto;font-size:12.5px;font-weight:700;color:${d};background:${pale};border:1px solid ${soft};border-radius:20px;padding:5px 12px}
.sx-deliv{display:flex;flex-wrap:wrap;gap:10px}
.sx-deliv div{flex:1;min-width:140px;background:${pale};border:1px solid ${soft};border-bottom:3px solid ${a};border-radius:10px;padding:12px 14px}
.sx-deliv small{display:block;font-size:10.5px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:#8a8a94}
.sx-deliv b{display:block;font-size:15px;color:${d};margin-top:4px}
.sx-deliv span{display:block;font-size:12px;color:#8a8a94}
.sx-ret{font-size:14.5px;margin:14px 0 4px}
.sx-retn{font-size:12.5px;color:#8a8a94;margin:0}
.sx-revs{display:flex;gap:12px;overflow-x:auto;padding-bottom:6px}
.sx-rev{flex:0 0 250px;background:${pale};border:1px solid ${soft};border-top:3px solid ${a};border-radius:10px;padding:14px}
.sx-rstars{color:${a};letter-spacing:1px}
.sx-rev p{font-size:13px;font-style:italic;margin:8px 0}
.sx-rev b{display:block;font-size:12px;color:${d}}
.sx-rev span{font-size:11px;color:#8a8a94}
.sx-prod em{display:block;font-style:normal;font-size:13px;font-weight:800;color:${a};margin:-4px 0 8px}
.sx-closing{text-align:center;font-size:15px;color:#3a3a44;margin:0 0 16px}
@media(max-width:640px){.sx{padding:10px}.sx-title{font-size:23px}.sx-gl{display:block}.sx-tw{position:static;width:100%}.sx-thumbs{position:static;display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;overflow:visible}.sx-thumbs label{width:18%;height:64px}.sx-feat{width:100%}.sx-pair{display:block}.sx-pair>div{margin-bottom:12px}.sx-shop{grid-template-columns:repeat(2,minmax(0,1fr))}}
${variantStyles(variant, t)}
</style>`;
}

/**
 * The Showcase description.
 * @param ctx { t (template with defaults), copy (market copy), productName,
 *   description (plain text, seller notes dropped), images [url], specifics
 *   { name: [values] }, recommended [{ url, imageUrl, name, price }],
 *   storeUrl, condition, storeName (escaped) }
 * @param h   helpers from description-template: { escapeHtml, inline,
 *   listItem, isNoteLine, fontStack }
 */
function renderShowcase(ctx, h, variant = 'showcase') {
  const { t, copy, productName, description, images = [], specifics = {}, recommended = [], storeUrl, condition, storeName, feedback } = ctx;
  const e = h.escapeHtml;
  const s = readSections(description, h);
  const photos = images.filter(Boolean).slice(0, 8);
  const title = s.title || productName;
  const pills = (s.features.length ? s.features.map((f) => f.name) : [condition, t.freePostage ? `Free ${copy.postageWord}` : null]).filter(Boolean).slice(0, 4);

  const card = (head, body, { dark = false } = {}) =>
    `<div class="sx-card"><div class="sx-head${dark ? ' sx-dark' : ''}">${head}</div><div class="sx-body">${body}</div></div>`;

  const parts = [];
  // The store's own header, from the Theme settings as in Classic: logo,
  // name, tagline and feedback.
  const logo = t.logoUrl ? `<img src="${e(t.logoUrl)}" alt="${storeName}"/>` : `<span>${e((t.storeName || 'S').slice(0, 1).toUpperCase())}</span>`;
  parts.push(`<div class="sx-brand"><div class="sx-logo">${logo}</div><div class="sx-bname"><b>${storeName}</b>${t.tagline ? `<span>${e(t.tagline)}</span>` : ''}</div>${feedback ? `<div class="sx-fb">⭐ ${e(feedback)}</div>` : ''}</div>`);
  parts.push(`<div class="sx-top">
  <div class="sx-stars">⭐⭐⭐⭐⭐ ${e(t.bannerText || 'Top Quality • Fast Dispatch')}</div>
  <div class="sx-title">${h.inline(title)}</div>
  ${s.subtitle ? `<p class="sx-sub">${h.inline(s.subtitle)}</p>` : ''}
  ${pills.length ? `<div class="sx-pills">${pills.map((p) => `<span class="sx-pill">${e(p)}</span>`).join('')}</div>` : ''}
</div>`);

  if (photos.length) {
    const radios = photos.map((_, i) => `<input type="radio" name="sxg" id="sxg${i + 1}" class="sx-r"${i === 0 ? ' checked' : ''}/><input type="checkbox" id="sxz${i + 1}" class="sx-r"/>`).join('');
    const slides = photos
      .map((url, i) => `<div class="sx-slide sx-s${i + 1}"><label for="sxz${i + 1}" class="sx-zoom"><span class="sx-fill" style="background-image:url('${e(url)}')"></span><img src="${e(url)}" alt="${e(title)} photo ${i + 1}"/><span class="sx-zb">🔍 Click to zoom</span></label></div>`)
      .join('');
    // A slim column of thumbnails beside the photo, exactly as tall as the
    // photo's square frame (it scrolls when there are more): the photo gets
    // all the width the column doesn't need.
    const thumbs = photos.length > 1 ? `<div class="sx-tw"><div class="sx-thumbs">${photos.map((url, i) => `<label for="sxg${i + 1}" class="sx-t${i + 1}"><img src="${e(url)}" alt=""/></label>`).join('')}</div></div>` : '';
    parts.push(card('📸 Product Gallery', `${radios}<div class="sx-gl"><div class="sx-stage">${slides}</div>${thumbs}</div>`, { dark: true }));
  }

  if (s.intro.length) parts.push(`<div class="sx-card"><div class="sx-body sx-intro">${s.intro.map((p) => `<p>${h.inline(p)}</p>`).join('')}</div></div>`);

  if (s.features.length) {
    parts.push(
      card(
        'Key Features',
        `<div class="sx-grid">${s.features
          .map((f) => `<div class="sx-feat"><b>${f.icon ? `<span class="sx-fi">${e(f.icon)}</span>` : ''}${h.inline(f.name)}</b>${f.text ? `<span>${h.inline(f.text)}</span>` : ''}</div>`)
          .join('')}</div>`
      )
    );
  }

  if (s.options && (s.options.values.length || s.options.note)) {
    parts.push(
      card(
        e(s.options.heading),
        `${s.options.values.length ? `<div class="sx-chips">${s.options.values.map((v) => `<span>${e(v)}</span>`).join('')}</div>` : ''}${s.options.note ? `<p style="margin:10px 0 0;font-size:14px">${h.inline(s.options.note)}</p>` : ''}`
      )
    );
  }

  // The item specifics as the listing states them, then any the text adds.
  const specRows = [];
  const seen = new Set();
  for (const [name, values] of Object.entries(specifics || {})) {
    const value = (values || []).filter((v) => v && !/^does not apply$/i.test(String(v))).join(', ');
    if (!value || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    specRows.push([name, value]);
  }
  for (const [name, value] of s.specs) if (!seen.has(name.toLowerCase())) specRows.push([name, value]);
  if (specRows.length) {
    parts.push(card('Specifications', `<table class="sx-table">${specRows.slice(0, 16).map(([n, v]) => `<tr><td>${e(n)}</td><td>${e(v)}</td></tr>`).join('')}</table>`));
  }

  if (s.perfectFor.length) parts.push(card(e(s.perfectForHeading || 'Perfect For'), `<ul class="sx-list">${s.perfectFor.map((l) => `<li>${h.inline(l)}</li>`).join('')}</ul>`));
  if (s.steps.length) {
    parts.push(card('How To Use', `<ol class="sx-steps">${s.steps.map((l, i) => `<li><span class="sx-n">${i + 1}</span><span>${h.inline(l)}</span></li>`).join('')}</ol>`));
  }
  for (const section of s.other) {
    if (!section.lines.length) continue;
    const items = section.lines.map((l) => h.listItem(l));
    const body = items.every(Boolean) ? `<ul class="sx-list">${items.map((it) => `<li>${h.inline(it.body)}</li>`).join('')}</ul>` : section.lines.map((l) => `<p style="margin:0 0 8px">${h.inline(stripMarker(l, h))}</p>`).join('');
    parts.push(card(e(section.heading), body));
  }

  if (s.includes.length || s.notes.length) {
    parts.push(`<div class="sx-pair">
  ${s.includes.length ? `<div class="sx-inc"><h3>Package Includes</h3>${s.includes.map((l) => `<p>✔️ ${h.inline(l)}</p>`).join('')}</div>` : ''}
  ${s.notes.length ? `<div class="sx-notes"><h3>Important Notes</h3>${s.notes.map((l) => `<p>• ${h.inline(l)}</p>`).join('')}</div>` : ''}
</div>`);
  }

  if (s.closing.length) parts.push(`<p class="sx-closing">${s.closing.map((l) => h.inline(l)).join('<br/>')}</p>`);

  const returnsDays = Number(t.returnsDays) || 0;
  const postage = t.freePostage ? `Free ${copy.postageWord}` : `Tracked ${copy.postageWord}`;
  const promises = [
    ['🚚', 'Fast Dispatch', `Dispatched within ${t.dispatchTime}${t.freePostage ? `, free ${copy.postageWord.toLowerCase()}` : ''}`],
    ['✅', 'Quality Checked', /NEW/i.test(String(condition)) ? 'Every item is brand new and checked before dispatch' : 'Every item is checked before dispatch'],
    returnsDays ? ['↩️', 'Easy Returns', `${returnsDays}-day returns, so you can buy with confidence`] : null,
    ['💬', 'Friendly Support', `Quick replies through eBay messages, usually within ${t.responseTime}`],
  ].filter(Boolean);
  parts.push(card('💎 Why Choose Us', `<div class="sx-tiles">${promises.map(([i, b, sub]) => `<div class="sx-tile"><i>${i}</i><b>${b}</b><span>${e(sub)}</span></div>`).join('')}</div>`));

  // Delivery and returns, from the Theme settings as in Classic.
  const delivery = [
    ['Dispatch', t.dispatchTime, t.dispatchNote],
    ['Carrier', t.carrier, 'Tracked service'],
    ['Delivery', t.deliveryTime, 'After dispatch'],
    ['Postage', postage, copy.addresses],
  ];
  parts.push(
    card(
      '📦 Delivery &amp; Returns',
      `<div class="sx-deliv">${delivery.map(([label, value, note]) => `<div><small>${label}</small><b>${e(value)}</b><span>${e(note || '')}</span></div>`).join('')}</div>${
        returnsDays
          ? `<p class="sx-ret">We offer a <strong>${returnsDays}-day hassle-free return policy</strong> on all items. Not completely satisfied? Message us through eBay and we'll sort it immediately.</p><p class="sx-retn">Items must be returned in original condition and packaging. Buyer pays return postage unless the item is faulty or not as described. Refunds processed within 2 business days of receiving the return.</p>`
          : ''
      }`
    )
  );

  // Genuine reviews the seller entered in Settings (never invented); the
  // section is left out when there are none, as in Classic.
  const reviews = (t.reviews || []).filter((r) => r && r.text).slice(0, 10);
  if (reviews.length) {
    parts.push(
      card(
        '⭐ What Customers Say',
        `<div class="sx-revs">${reviews
          .map(
            (r) =>
              `<div class="sx-rev"><div class="sx-rstars">${'★'.repeat(Math.min(5, Math.max(1, Number(r.stars) || 5)))}</div><p>"${e(r.text)}"</p><b>${e(r.buyer || 'eBay buyer')}</b><span>${e(r.date || '')}${r.date ? ' · ' : ''}Verified Purchase</span></div>`
          )
          .join('')}</div>`
      )
    );
  }

  // As many of the store's listings as Settings asks for (0 hides them).
  const more = recommended.slice(0, h.listingCount(t));
  if (more.length) {
    parts.push(
      card(
        '🛍️ More From Our Store',
        `<div class="sx-shop">${more
          .map(
            (item) =>
              `<a class="sx-prod" href="${e(item.url)}" target="_blank" rel="noopener">${item.imageUrl ? `<img src="${e(item.imageUrl)}" alt="${e(item.name)}"/>` : ''}<b>${e(item.name)}</b>${
                item.price ? `<em>${item.sold > 1 ? `${e(String(item.sold))} sold · ` : ''}${e(item.price)}</em>` : ''
              }<span class="sx-btn">View Item ➜</span></a>`
          )
          .join('')}</div>${storeUrl ? `<div class="sx-center"><a class="sx-btn sx-dark" href="${e(storeUrl)}" target="_blank" rel="noopener">🏬 Visit Our eBay Store ➜</a></div>` : ''}`,
        { dark: true }
      )
    );
  }

  parts.push(`<div class="sx-thanks">🌸 Thank you for shopping with <strong>${storeName}</strong>. Check our other listings for more great deals!
  <span>Questions? <strong>Message us on eBay</strong>. We respond within ${e(t.responseTime)}.</span>
  <span>⭐ Love ${storeName}? Click "Save seller" to never miss a new listing or deal · © ${storeName} · ${e(copy.business)}</span></div>`);

  return `${styles(t, h.fontStack(t.fontFamily), photos, VARIANTS.includes(variant) ? variant : 'showcase')}
<div class="sx">
${parts.join('\n')}
</div>`;
}

module.exports = { renderShowcase, readSections, tint, VARIANTS };
