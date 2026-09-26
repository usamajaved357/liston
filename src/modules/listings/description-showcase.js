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

// Colours from the account's two: mixed toward white for pale fills and
// borders, toward each other for gradients, see-through for shadows.
function rgbOf(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(hex, toward, amount) {
  const from = rgbOf(hex);
  const to = rgbOf(toward);
  if (!from || !to) return '#f4f4f6';
  return `#${from.map((c, i) => Math.round(c + (to[i] - c) * amount).toString(16).padStart(2, '0')).join('')}`;
}
const tint = (hex, amount) => mix(hex, '#ffffff', amount);
function alpha(hex, opacity) {
  const rgb = rgbOf(hex) || [16, 24, 40];
  return `rgba(${rgb.join(',')},${opacity})`;
}

// The card layouts share one structure; each is a skin over it. Showcase is
// the base below; the others restyle it.
const VARIANTS = ['showcase', 'minimal', 'bold', 'boutique'];

function variantStyles(variant, t) {
  const a = t.accentColor;
  const d = t.darkColor;
  const soft = tint(a, 0.72);
  if (variant === 'minimal') {
    // Quiet and flat: white page, hairlines, type doing the work.
    return `
.sx{background:#fff;padding:24px 20px}
.sx-brand{border:0;border-bottom:1px solid #eeeef1;border-radius:0;box-shadow:none;padding:4px 0 16px}
.sx-logo{background:${d}}
.sx-top{text-align:left;padding:8px 0 22px}
.sx-top:after{width:100%;height:1px;border-radius:0;background:#e7e7ea;margin:22px 0 0}
.sx-stars{background:transparent;border:0;padding:0;color:#8a8a94}
.sx-title{font-size:32px;font-weight:700}
.sx-pill{background:#f5f5f7;border-color:#f5f5f7;box-shadow:none;color:#44444c;font-weight:600;margin:4px 8px 4px 0}
.sx-pill:before{background:#9a9aa4}
.sx-card{border:0;border-bottom:1px solid #eeeef1;border-radius:0;box-shadow:none;margin-bottom:6px;overflow:visible}
.sx-head,.sx-head.sx-dark{background:transparent;color:${a};font-size:12px;letter-spacing:2px;text-transform:uppercase;padding:20px 0 6px}
.sx-body{padding:8px 0 22px}
.sx-gl{flex-direction:column;max-width:680px}
.sx-tw{position:static;width:100%;flex:none}
.sx-thumbs{position:static;display:flex;flex-wrap:wrap;gap:8px;justify-content:center;overflow:visible}
.sx-thumbs label{width:76px;height:76px;border-width:1px;border-color:#e3e3e8}
.sx-feat{background:transparent;border:0;padding:8px 0}
.sx-fi{background:#f5f5f7;border-color:#f5f5f7}
.sx-fi:after,.sx-list li:after,.sx-tick:after{border-color:${d}}
.sx-steps li{background:transparent;padding:6px 0;margin:0}
.sx-n{background:${d}}
.sx-table{border:0;border-radius:0}
.sx-table tr:nth-child(odd) td{background:transparent}
.sx-table td{padding:11px 0;border-color:#f1f1f4}
.sx-list li:before{background:#f5f5f7}
.sx-pair>div{box-shadow:none}
.sx-inc,.sx-notes{background:#fafafb;border:1px solid #ececf0}
.sx-notes h3{color:${d}}
.sx-notes p{color:#44444c}
.sx-pair p i{background:#ececf0}
.sx-dot:after{background:#44444c}
.sx-tile{background:transparent;border:0;border-top:2px solid ${a};border-radius:0}
.sx-tile:hover{transform:none;box-shadow:none}
.sx-tile{padding:16px 4px 4px}
.sx-tile i:after{display:none}
.sx-prod{border-color:#ececf0;border-radius:10px;box-shadow:none}
.sx-prod:hover{border-color:#d6d6dc;box-shadow:0 10px 24px rgba(16,24,40,.08)}
.sx-pimg{background:#f7f7f9}
.sx-sold{box-shadow:none;border:1px solid #e7e7ea}
.sx-pinfo em{font-size:17px}
.sx-view{border:1px solid #d6d6dc;color:${d};border-radius:8px}
.sx-prod:hover .sx-view{background:${d};border-color:${d};color:#fff}
.sx-cta{background:#f7f7f9;color:${d};border:1px solid #ececf0}
.sx-ctat span{color:#6b6b78;opacity:1}
.sx-ctab{background:${d};color:#fff;border-radius:8px;box-shadow:none}
.sx-cta:hover .sx-ctab{box-shadow:0 8px 18px rgba(16,24,40,.18)}
.sx-deliv div{background:#fafafb;border:1px solid #ececf0}
.sx-deliv div:before{background:${d}}
.sx-rev{background:#fafafb;border-color:#ececf0;box-shadow:none}
.sx-rev:after{color:#ececf0}
.sx-fb{background:transparent;border-color:#dcdce2}
.sx-closing{text-align:left}
.sx-thanks{background:transparent;color:#6b6b78;border-top:1px solid #eeeef1;border-radius:0}
.sx-thanks span{opacity:1}
.sx-thanks strong{color:${d}}
.sx-thanks small{border-color:#eeeef1;opacity:1}`;
  }
  if (variant === 'bold') {
    // Loud and confident: a dark hero, heavy type, solid blocks of colour.
    return `
.sx{background:#f1f1f4}
.sx-brand{background:${d};border:0}
.sx-bname b{color:#fff}
.sx-bname span{color:${soft}}
.sx-logo{background:${a}}
.sx-fb{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.22);color:#fff}
.sx-top{background:linear-gradient(135deg,${d},${mix(d, a, 0.45)});border-radius:18px;padding:32px 22px 28px}
.sx-top:after{background:${a}}
.sx-stars{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.22);color:#fff}
.sx-title{color:#fff;font-size:36px;font-weight:900;text-transform:uppercase;letter-spacing:-.3px}
.sx-sub{color:${soft}}
.sx-pill{background:${a};border-color:${a};color:#fff;box-shadow:none}
.sx-pill:before{background:#fff}
.sx-card{border:0;border-left:6px solid ${a};border-radius:12px}
.sx-head,.sx-head.sx-dark{background:#fff;color:${d};font-size:21px;font-weight:900;text-transform:uppercase;letter-spacing:.2px;padding:18px 20px 4px}
.sx-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
.sx-grid.sx-even{grid-template-columns:repeat(2,minmax(0,1fr))}
.sx-feat{display:block;background:#f5f5f7;border:0;border-bottom:3px solid ${a}}
.sx-fi{display:block;width:40px;height:40px;background:${a};border-color:${a};margin:0 0 12px}
.sx-fi:after{left:14px;top:8px;width:8px;height:15px;border-color:#fff;border-width:0 3px 3px 0}
.sx-feat b{font-size:15.5px;font-weight:800}
.sx-n{border-radius:8px;background:${d}}
.sx-list li:before{border-radius:5px;background:${d}}
.sx-list li:after{border-color:#fff}
.sx-tile{background:${d};border:0}
.sx-tile b{color:#fff}
.sx-tile span{color:${soft}}
.sx-tile i{color:${soft}}
.sx-prod{border:0;border-radius:12px;box-shadow:0 2px 8px rgba(16,24,40,.08)}
.sx-sold{background:${a};color:#fff}
.sx-pinfo b{font-weight:700}
.sx-pinfo em{color:${a};font-size:21px;font-weight:900}
.sx-view{background:${d};border-color:${d};color:#fff;border-radius:8px;text-transform:uppercase;letter-spacing:.8px;font-size:12px;font-weight:800;padding:10px}
.sx-prod:hover .sx-view{background:${a};border-color:${a}}
.sx-cta{background:linear-gradient(135deg,${a},${mix(a, d, 0.55)})}
.sx-ctab{background:${d};color:#fff;border-radius:10px;text-transform:uppercase;letter-spacing:.8px;font-size:13px}
.sx-rev{border-top:4px solid ${a}}
.sx-thanks{background:linear-gradient(135deg,${a},${mix(a, d, 0.55)})}
@media(max-width:640px){.sx-grid,.sx-grid.sx-even{grid-template-columns:repeat(2,minmax(0,1fr))}.sx-title{font-size:26px}}`;
  }
  if (variant === 'boutique') {
    // Soft and elegant: cream, serif headings, gold hairlines.
    return `
.sx{background:#faf7f2;color:#3b3530}
.sx-brand{background:#fff;border-color:#eee5d6;box-shadow:none}
.sx-logo{background:${d}}
.sx-bname b{font-family:Georgia,serif;font-weight:400}
.sx-fb{background:#fff;border-color:#e6dccb;color:#6d5a44}
.sx-top{padding:18px 12px 12px}
.sx-top:after{width:90px;height:1px;background:#c9ae82}
.sx-stars{background:transparent;border:0;color:#b08d57;letter-spacing:3px}
.sx-st{color:#c9ae82}
.sx-title{font-family:Georgia,'Palatino Linotype',serif;font-weight:400;font-size:36px;letter-spacing:0;color:${d}}
.sx-sub{font-style:italic}
.sx-pill{background:#fff;border-color:#e6dccb;color:#6d5a44;font-weight:600;box-shadow:none}
.sx-pill:before{background:#c9ae82}
.sx-card{border-color:#eee5d6;border-radius:20px;box-shadow:0 1px 3px rgba(109,90,68,.06)}
.sx-head,.sx-head.sx-dark{background:transparent;color:${d};text-align:center;font-family:Georgia,'Palatino Linotype',serif;font-weight:400;font-size:22px;text-transform:none;letter-spacing:.5px;padding:22px 20px 0}
.sx-head:before,.sx-head:after{content:'';display:inline-block;width:36px;height:1px;background:#c9ae82;vertical-align:middle;margin:0 12px}
.sx-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
.sx-grid.sx-even{grid-template-columns:repeat(2,minmax(0,1fr))}
.sx-feat{display:block;text-align:center;background:#fbf8f3;border-color:#f1e9dc;padding:18px 12px}
.sx-fi{display:inline-block;width:40px;height:40px;border-color:#e6dccb;margin:0 0 10px}
.sx-fi:after,.sx-tick:after{border-color:#b08d57}
.sx-fi:after{left:15px;top:10px;width:7px;height:13px}
.sx-feat b{font-family:Georgia,serif;font-weight:400;font-size:16px}
.sx-intro{text-align:center;font-style:italic}
.sx-list{text-align:center}
.sx-list li{padding:9px 0;border-bottom:1px dashed #eee5d6}
.sx-list li:before,.sx-list li:after{display:none}
.sx-steps li{background:#fbf8f3}
.sx-n{background:#c9ae82}
.sx-table{border-color:#eee5d6}
.sx-table td{border-color:#f1e9dc}
.sx-table tr:nth-child(odd) td{background:#fbf8f3}
.sx-inc,.sx-notes{background:#fff;border:1px solid #eee5d6;border-radius:20px;box-shadow:none}
.sx-notes h3,.sx-inc h3{font-family:Georgia,serif;font-weight:400;text-transform:none;letter-spacing:0;font-size:19px;color:${d}}
.sx-notes p{color:#6d4a2c}
.sx-pair p i{background:#f5ede0;color:#b08d57}
.sx-tile{background:#fff;border-color:#eee5d6;border-radius:18px}
.sx-tile{text-align:center}
.sx-tile i{font-family:Georgia,serif;font-style:italic;font-weight:400;font-size:20px;letter-spacing:0;color:#b08d57}
.sx-tile i:after{width:24px;height:1px;background:#c9ae82;margin:8px auto 0}
.sx-tile b{font-family:Georgia,serif;font-weight:400;font-size:16px}
.sx-prod{border-color:#eee5d6;border-radius:18px}
.sx-prod:hover{border-color:#d9c6a5;box-shadow:0 14px 30px rgba(109,90,68,.14)}
.sx-pimg{background:#fbf8f3}
.sx-sold{color:#6d5a44}
.sx-pinfo{text-align:center}
.sx-pinfo b{font-family:Georgia,serif;font-weight:400;font-size:14.5px}
.sx-pinfo em{color:#8a6a3c;font-family:Georgia,serif;font-weight:400;font-size:19px}
.sx-view{border:1px solid #c9ae82;color:#8a6a3c;font-size:11px;letter-spacing:1.8px;text-transform:uppercase}
.sx-prod:hover .sx-view{background:#c9ae82;border-color:#c9ae82;color:#fff}
.sx-cta{background:#fff;border:1px solid #eee5d6;color:${d}}
.sx-ctat b{font-family:Georgia,serif;font-weight:400;font-size:21px}
.sx-ctat span{color:#8a7a66;opacity:1;font-style:italic}
.sx-ctab{background:${d};color:#fff;letter-spacing:1.6px;text-transform:uppercase;font-size:12px;box-shadow:none}
.sx-cta:hover .sx-ctab{box-shadow:0 8px 18px rgba(109,90,68,.22)}
.sx-deliv div{background:#fbf8f3;border-color:#eee5d6;border-radius:14px}
.sx-deliv div:before{background:#c9ae82}
.sx-rev{border-color:#eee5d6;border-radius:16px;box-shadow:none}
.sx-rev:after{color:#f1e9dc}
.sx-rstars{color:#b08d57}
.sx-closing{font-family:Georgia,serif;font-style:italic;font-weight:400}
.sx-thanks{background:transparent;color:#6d5a44;font-family:Georgia,serif;font-style:italic;font-size:16px}
.sx-thanks span{opacity:1}
.sx-thanks strong{color:${d}}
.sx-thanks b{font-weight:400}
.sx-thanks small{border-color:#eee5d6;opacity:.8}
@media(max-width:640px){.sx-grid,.sx-grid.sx-even{grid-template-columns:repeat(2,minmax(0,1fr))}.sx-title{font-size:27px}}`;
  }
  return '';
}

function styles(t, fontStack, images, variant = 'showcase') {
  const a = t.accentColor;
  const d = t.darkColor;
  const pale = tint(a, 0.9);
  const soft = tint(a, 0.72);
  const wash = tint(a, 0.965);
  const line = tint(a, 0.86);
  const shadow = `0 1px 2px rgba(16,24,40,.04),0 4px 14px ${alpha(d, 0.05)}`;
  const slides = images
    .map((_, i) => `#sxg${i + 1}:checked~.sx-gl .sx-s${i + 1}{display:block}#sxg${i + 1}:checked~.sx-gl .sx-t${i + 1}{border-color:${a};box-shadow:0 0 0 2px ${soft}}#sxz${i + 1}:checked~.sx-gl .sx-s${i + 1} img{transform:scale(2.2)}#sxz${i + 1}:checked~.sx-gl .sx-s${i + 1} .sx-zoom{cursor:zoom-out}`)
    .join('');
  return `<style>
.sx{max-width:1100px;margin:0 auto;font-family:${fontStack};color:#2b2b33;background:${tint(a, 0.955)};padding:22px;line-height:1.6;-webkit-font-smoothing:antialiased}
.sx *{box-sizing:border-box}
.sx a{text-decoration:none}
.sx-brand{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid ${line};border-radius:16px;padding:12px 16px;margin-bottom:10px;box-shadow:${shadow}}
.sx-logo{width:48px;height:48px;flex:0 0 48px;border-radius:12px;overflow:hidden;background:linear-gradient(135deg,${a},${d});display:flex;align-items:center;justify-content:center}
.sx-logo img{width:100%;height:100%;object-fit:cover;display:block;background:#fff}
.sx-logo span{color:#fff;font-weight:800;font-size:20px}
.sx-bname{flex:1;min-width:0}
.sx-bname b{display:block;font-size:18px;color:${d};line-height:1.2}
.sx-bname span{display:block;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#8a8a94;margin-top:2px}
.sx-fb{flex:0 0 auto;font-size:12.5px;font-weight:700;color:${d};background:${pale};border:1px solid ${soft};border-radius:999px;padding:6px 14px}
.sx-top{text-align:center;padding:22px 12px 24px;margin-bottom:18px}
.sx-top:after{content:'';display:block;width:64px;height:4px;border-radius:4px;background:linear-gradient(90deg,${a},${d});margin:22px auto 0}
.sx-st{color:#f59e0b;letter-spacing:1px;margin-right:8px}
.sx-stars{display:inline-block;font-size:11.5px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:${a};background:#fff;border:1px solid ${soft};border-radius:999px;padding:5px 14px}
.sx-title{font-size:34px;font-weight:800;color:${d};margin:14px 0 6px;line-height:1.2;letter-spacing:-.5px}
.sx-sub{font-size:16px;color:#5f5f6b;margin:0}
.sx-pills{margin-top:16px}
.sx-pill{display:inline-block;margin:4px;padding:7px 15px;border-radius:999px;background:#fff;border:1px solid ${soft};color:${d};font-size:13px;font-weight:700;box-shadow:0 1px 2px rgba(16,24,40,.05)}
.sx-pill:before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:${a};margin-right:8px;vertical-align:middle;position:relative;top:-1px}
.sx-card{background:#fff;border:1px solid ${line};border-radius:16px;margin-bottom:18px;overflow:hidden;box-shadow:${shadow}}
.sx-head{background:linear-gradient(135deg,${a},${mix(a, d, 0.45)});color:#fff;font-size:13.5px;font-weight:800;padding:15px 22px;letter-spacing:1.4px;text-transform:uppercase}
.sx-head.sx-dark{background:linear-gradient(135deg,${d},${mix(d, a, 0.4)})}
.sx-body{padding:18px 20px}
.sx-gcard .sx-body{padding:16px}
.sx-intro{font-size:15.5px;color:#3a3a44;line-height:1.7}
.sx-intro p{margin:0 0 8px}
.sx-intro p:last-child{margin:0}
.sx-r{display:none}
.sx-slide{display:none}
.sx-gl{display:flex;gap:10px;align-items:stretch;max-width:860px;margin:0 auto}
.sx-stage{flex:1;min-width:0}
.sx-zoom{display:block;position:relative;width:100%;height:560px;overflow:hidden;border-radius:12px;background:#fff;cursor:zoom-in}
@supports (aspect-ratio:1/1){.sx-zoom{height:auto;aspect-ratio:1/1;max-height:680px}}
.sx-fill{position:absolute;top:-24px;right:-24px;bottom:-24px;left:-24px;background-size:cover;background-position:center;filter:blur(22px);opacity:.38}
.sx-zoom img{position:relative;display:block;width:100%;height:100%;object-fit:contain;transition:transform .35s ease}
.sx-zb{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.62);color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px;white-space:nowrap}
.sx-tw{position:relative;flex:0 0 96px;width:96px}
.sx-thumbs{position:absolute;top:0;right:0;bottom:0;left:0;overflow-y:auto;display:grid;grid-template-columns:1fr;grid-auto-rows:96px;gap:8px;align-content:start;scrollbar-width:thin}
.sx-thumbs label{display:block;border:2px solid ${line};border-radius:10px;padding:3px;margin:0;background:#fff;cursor:pointer;overflow:hidden;transition:border-color .2s}
.sx-thumbs label:hover{border-color:${soft}}
.sx-thumbs img{display:block;width:100%;height:100%;object-fit:contain}
${slides}
.sx-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.sx-feat{display:flex;gap:12px;align-items:flex-start;padding:14px;border-radius:12px;background:${wash};border:1px solid ${line}}
.sx-fi{position:relative;flex:0 0 30px;width:30px;height:30px;border-radius:50%;background:#fff;border:1px solid ${soft}}
.sx-fi:after,.sx-list li:after,.sx-tick:after{content:'';position:absolute;border:solid ${a};border-width:0 2px 2px 0;transform:rotate(45deg)}
.sx-fi:after{left:11px;top:7px;width:6px;height:11px}
.sx-ft{min-width:0}
.sx-feat b{display:block;color:${d};font-size:15px;line-height:1.35}
.sx-feat p{margin:3px 0 0;font-size:13.5px;color:#55555f;line-height:1.5}
.sx-table{width:100%;border-collapse:separate;border-spacing:0;font-size:14px;border:1px solid ${line};border-radius:12px;overflow:hidden}
.sx-table td{padding:11px 14px;border-bottom:1px solid ${line};vertical-align:top}
.sx-table tr:last-child td{border-bottom:0}
.sx-table tr:nth-child(odd) td{background:${wash}}
.sx-table td:first-child{font-weight:700;color:${d};width:38%}
.sx-list{list-style:none;margin:0;padding:0}
.sx-list li{position:relative;padding:9px 0 9px 34px;border-bottom:1px solid ${tint(a, 0.93)};font-size:14.5px}
.sx-list li:last-child{border-bottom:0}
.sx-list li:before{content:'';position:absolute;left:0;top:10px;width:22px;height:22px;border-radius:50%;background:${pale}}
.sx-list li:after{left:8px;top:14px;width:5px;height:10px}
.sx-steps{list-style:none;margin:0;padding:0}
.sx-steps li{display:flex;gap:14px;align-items:center;padding:10px 12px;margin-bottom:8px;border-radius:12px;background:${wash};font-size:14.5px}
.sx-steps li:last-child{margin-bottom:0}
.sx-n{flex:0 0 30px;height:30px;border-radius:50%;background:linear-gradient(135deg,${a},${d});color:#fff;font-weight:800;font-size:14px;text-align:center;line-height:30px}
.sx-chips span{display:inline-block;margin:3px;padding:6px 14px;border-radius:999px;border:1px solid ${soft};background:${pale};font-size:13px;font-weight:700;color:${d}}
.sx-pair{display:flex;gap:18px;margin-bottom:18px}
.sx-pair>div{flex:1;min-width:0;border-radius:16px;padding:18px 20px;box-shadow:${shadow}}
.sx-inc{background:#fff;border:1px solid ${line}}
.sx-notes{background:#fff7ed;border:1px solid #fed7aa}
.sx-pair h3{margin:0 0 12px;font-size:14px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${d}}
.sx-notes h3{color:#9a3412}
.sx-pair p{display:flex;gap:10px;align-items:flex-start;margin:0 0 8px;font-size:14px}
.sx-pair p:last-child{margin:0}
.sx-pair p i{position:relative;flex:0 0 20px;height:20px;margin-top:1px;border-radius:50%;background:${pale}}
.sx-tick:after{left:7px;top:4px;width:5px;height:9px}
.sx-dot:after{content:'';position:absolute;left:7px;top:7px;width:6px;height:6px;border-radius:50%;background:#c2410c}
.sx-notes p{color:#7c2d12}
.sx-notes p i{background:#ffedd5}
.sx-closing{text-align:center;font-size:16px;font-weight:600;color:${d};margin:4px 0 18px}
.sx-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.sx-tile{background:#fff;border:1px solid ${line};border-radius:14px;padding:18px 18px 20px;transition:transform .2s ease,box-shadow .2s ease}
.sx-tile:hover{transform:translateY(-2px);box-shadow:0 10px 24px ${alpha(d, 0.08)}}
.sx-tile i{display:block;font-style:normal;font-size:13px;font-weight:800;letter-spacing:1px;color:${a}}
.sx-tile i:after{content:'';display:block;width:28px;height:2px;background:${a};margin-top:10px}
.sx-tile b{display:block;color:${d};margin-top:14px;font-size:15px}
.sx-tile span{display:block;font-size:12.5px;color:#6b6b78;margin-top:4px;line-height:1.5}
.sx-deliv{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.sx-deliv div{position:relative;overflow:hidden;background:${wash};border:1px solid ${line};border-radius:12px;padding:14px 16px 14px 18px}
.sx-deliv div:before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:${a}}
.sx-deliv small{display:block;font-size:10.5px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:#8a8a94}
.sx-deliv b{display:block;font-size:15.5px;color:${d};margin-top:4px;line-height:1.3}
.sx-deliv span{display:block;font-size:12px;color:#8a8a94;margin-top:2px}
.sx-ret{font-size:14.5px;margin:16px 0 4px}
.sx-retn{font-size:12.5px;color:#8a8a94;margin:0}
.sx-revs{display:flex;gap:12px;overflow-x:auto;padding:2px 2px 8px;scrollbar-width:thin}
.sx-rev{position:relative;flex:0 0 260px;background:#fff;border:1px solid ${line};border-radius:14px;padding:16px 18px;box-shadow:${shadow}}
.sx-rev:after{content:'\\201C';position:absolute;top:6px;right:14px;font-family:Georgia,serif;font-size:56px;line-height:1;color:${pale}}
.sx-rstars{color:#f59e0b;letter-spacing:1px;font-size:15px}
.sx-rev p{position:relative;z-index:1;font-size:13.5px;font-style:italic;margin:8px 0 10px;color:#3a3a44}
.sx-rev b{display:block;font-size:12.5px;color:${d}}
.sx-rev span{font-size:11px;color:#8a8a94}
.sx-shop{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.sx-prod{display:flex;flex-direction:column;min-width:0;background:#fff;border:1px solid ${line};border-radius:14px;overflow:hidden;color:${d};transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease}
.sx-prod:hover{transform:translateY(-4px);border-color:${soft};box-shadow:0 14px 30px ${alpha(d, 0.14)}}
.sx-pimg{position:relative;display:block;height:190px;padding:12px;background:${wash}}
@supports (aspect-ratio:1/1){.sx-pimg{height:auto;aspect-ratio:1/1}}
.sx-pimg img{display:block;width:100%;height:100%;object-fit:contain;transition:transform .3s ease}
.sx-prod:hover .sx-pimg img{transform:scale(1.05)}
.sx-sold{position:absolute;top:10px;left:10px;background:#fff;color:${d};font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;box-shadow:0 2px 6px rgba(16,24,40,.12)}
.sx-pinfo{display:flex;flex-direction:column;flex:1;padding:12px 14px 14px}
.sx-pinfo b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.8em;font-size:13.5px;font-weight:600;line-height:1.4;color:#2b2b33}
.sx-pinfo em{display:block;font-style:normal;font-size:19px;font-weight:800;letter-spacing:-.3px;color:${d};margin:8px 0 12px}
.sx-view{display:block;margin-top:auto;padding:8px 10px;border:1.5px solid ${a};border-radius:999px;color:${a};text-align:center;font-size:13px;font-weight:700;transition:background .2s ease,color .2s ease,border-color .2s ease}
.sx-prod:hover .sx-view{background:${a};color:#fff}
.sx-view i,.sx-ctab i{display:inline-block;font-style:normal;margin-left:6px;transition:transform .2s ease}
.sx-prod:hover .sx-view i,.sx-cta:hover .sx-ctab i{transform:translateX(3px)}
.sx-cta{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:18px;padding:20px 22px;border-radius:16px;background:linear-gradient(135deg,${d},${mix(d, a, 0.45)});color:#fff}
.sx-ctat{min-width:0}
.sx-ctat b{display:block;font-size:18px;line-height:1.3}
.sx-ctat span{display:block;font-size:13px;opacity:.8;margin-top:3px}
.sx-ctab{flex:0 0 auto;display:inline-block;padding:12px 24px;border-radius:999px;background:#fff;color:${d};font-size:14.5px;font-weight:800;white-space:nowrap;box-shadow:0 6px 16px rgba(0,0,0,.18);transition:transform .2s ease,box-shadow .2s ease}
.sx-cta:hover .sx-ctab{transform:translateY(-2px);box-shadow:0 10px 22px rgba(0,0,0,.24)}
.sx-alone{margin:0 0 18px}
.sx-thanks{background:linear-gradient(135deg,${d},${mix(d, a, 0.3)});color:#fff;text-align:center;border-radius:16px;padding:26px 22px 20px;font-size:14px}
.sx-thanks b{display:block;font-size:18px;font-weight:600;margin-bottom:6px}
.sx-thanks b strong{font-weight:800}
.sx-thanks span{display:block;margin-top:4px;font-size:13px;opacity:.8}
.sx-thanks small{display:block;margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.15);font-size:11.5px;letter-spacing:.3px;opacity:.6}
@media(max-width:640px){.sx{padding:12px}.sx-brand{flex-wrap:wrap}.sx-title{font-size:25px}.sx-gl{display:block}.sx-tw{position:static;width:100%}.sx-thumbs{position:static;display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;overflow:visible}.sx-thumbs label{width:18%;height:64px}.sx-grid{grid-template-columns:1fr}.sx-pair{display:block}.sx-pair>div{margin-bottom:12px}.sx-deliv{grid-template-columns:repeat(2,minmax(0,1fr))}.sx-shop{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.sx-pinfo{padding:10px}.sx-cta{display:block;text-align:center}.sx-ctab{margin-top:14px}}
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
  parts.push(`<div class="sx-brand"><div class="sx-logo">${logo}</div><div class="sx-bname"><b>${storeName}</b>${t.tagline ? `<span>${e(t.tagline)}</span>` : ''}</div>${feedback ? `<div class="sx-fb">${e(feedback)} Feedback</div>` : ''}</div>`);
  parts.push(`<div class="sx-top">
  <div class="sx-stars"><span class="sx-st">★★★★★</span>${e(t.bannerText || 'Top Quality • Fast Dispatch')}</div>
  <div class="sx-title">${h.inline(title)}</div>
  ${s.subtitle ? `<p class="sx-sub">${h.inline(s.subtitle)}</p>` : ''}
  ${pills.length ? `<div class="sx-pills">${pills.map((p) => `<span class="sx-pill">${e(p)}</span>`).join('')}</div>` : ''}
</div>`);

  if (photos.length) {
    const radios = photos.map((_, i) => `<input type="radio" name="sxg" id="sxg${i + 1}" class="sx-r"${i === 0 ? ' checked' : ''}/><input type="checkbox" id="sxz${i + 1}" class="sx-r"/>`).join('');
    const slides = photos
      .map((url, i) => `<div class="sx-slide sx-s${i + 1}"><label for="sxz${i + 1}" class="sx-zoom"><span class="sx-fill" style="background-image:url('${e(url)}')"></span><img src="${e(url)}" alt="${e(title)} photo ${i + 1}"/><span class="sx-zb">Click to zoom</span></label></div>`)
      .join('');
    // A slim column of thumbnails beside the photo, exactly as tall as the
    // photo's square frame (it scrolls when there are more): the photo gets
    // all the width the column doesn't need.
    const thumbs = photos.length > 1 ? `<div class="sx-tw"><div class="sx-thumbs">${photos.map((url, i) => `<label for="sxg${i + 1}" class="sx-t${i + 1}"><img src="${e(url)}" alt=""/></label>`).join('')}</div></div>` : '';
    parts.push(`<div class="sx-card sx-gcard"><div class="sx-body">${radios}<div class="sx-gl"><div class="sx-stage">${slides}</div>${thumbs}</div></div></div>`);
  }

  if (s.intro.length) parts.push(`<div class="sx-card"><div class="sx-body sx-intro">${s.intro.map((p) => `<p>${h.inline(p)}</p>`).join('')}</div></div>`);

  if (s.features.length) {
    parts.push(
      card(
        'Key Features',
        // Four features sit two and two rather than three and one.
        `<div class="sx-grid${s.features.length % 3 && s.features.length % 2 === 0 ? ' sx-even' : ''}">${s.features
          .map((f) => `<div class="sx-feat"><span class="sx-fi"></span><div class="sx-ft"><b>${h.inline(f.name)}</b>${f.text ? `<p>${h.inline(f.text)}</p>` : ''}</div></div>`)
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
  ${s.includes.length ? `<div class="sx-inc"><h3>Package Includes</h3>${s.includes.map((l) => `<p><i class="sx-tick"></i><span>${h.inline(l)}</span></p>`).join('')}</div>` : ''}
  ${s.notes.length ? `<div class="sx-notes"><h3>Important Notes</h3>${s.notes.map((l) => `<p><i class="sx-dot"></i><span>${h.inline(l)}</span></p>`).join('')}</div>` : ''}
</div>`);
  }

  if (s.closing.length) parts.push(`<p class="sx-closing">${s.closing.map((l) => h.inline(l)).join('<br/>')}</p>`);

  const returnsDays = Number(t.returnsDays) || 0;
  const postage = t.freePostage ? `Free ${copy.postageWord}` : `Tracked ${copy.postageWord}`;
  const promises = [
    ['Fast Dispatch', `Dispatched within ${t.dispatchTime}${t.freePostage ? `, free ${copy.postageWord.toLowerCase()}` : ''}`],
    ['Quality Checked', /NEW/i.test(String(condition)) ? 'Every item is brand new and checked before dispatch' : 'Every item is checked before dispatch'],
    returnsDays ? ['Easy Returns', `${returnsDays}-day returns, so you can buy with confidence`] : null,
    ['Friendly Support', `Quick replies through eBay messages, usually within ${t.responseTime}`],
  ].filter(Boolean);
  parts.push(card('Why Choose Us', `<div class="sx-tiles">${promises.map(([b, sub], i) => `<div class="sx-tile"><i>0${i + 1}</i><b>${b}</b><span>${e(sub)}</span></div>`).join('')}</div>`));

  // Delivery and returns, from the Theme settings as in Classic.
  const delivery = [
    ['Dispatch', t.dispatchTime, t.dispatchNote],
    ['Carrier', t.carrier, 'Tracked service'],
    ['Delivery', t.deliveryTime, 'After dispatch'],
    ['Postage', postage, copy.addresses],
  ];
  parts.push(
    card(
      'Delivery &amp; Returns',
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
        'What Customers Say',
        `<div class="sx-revs">${reviews
          .map(
            (r) =>
              `<div class="sx-rev"><div class="sx-rstars">${'★'.repeat(Math.min(5, Math.max(1, Number(r.stars) || 5)))}</div><p>"${e(r.text)}"</p><b>${e(r.buyer || 'eBay buyer')}</b><span>${e(r.date || '')}${r.date ? ' · ' : ''}Verified Purchase</span></div>`
          )
          .join('')}</div>`
      )
    );
  }

  // A banner to the seller's eBay Store: the whole banner is the link.
  const perks = [t.freePostage ? `Free ${copy.postageWord} on every order` : null, returnsDays ? `${returnsDays}-day returns` : null].filter(Boolean);
  const storeBanner = (extra = '') =>
    storeUrl
      ? `<a class="sx-cta${extra}" href="${e(storeUrl)}" target="_blank" rel="noopener"><span class="sx-ctat"><b>Discover more from ${storeName}</b><span>${['Browse all our listings', ...perks].map(e).join(' · ')}</span></span><span class="sx-ctab">Visit our eBay store<i>→</i></span></a>`
      : '';

  // As many of the store's listings as Settings asks for (0 hides them).
  const more = recommended.slice(0, h.listingCount(t));
  if (more.length) {
    parts.push(
      card(
        'More From Our Store',
        `<div class="sx-shop">${more
          .map(
            (item) =>
              `<a class="sx-prod" href="${e(item.url)}" target="_blank" rel="noopener"><span class="sx-pimg">${item.imageUrl ? `<img src="${e(item.imageUrl)}" alt="${e(item.name)}"/>` : ''}${
                item.sold > 1 ? `<span class="sx-sold">${e(String(item.sold))} sold</span>` : ''
              }</span><span class="sx-pinfo"><b>${e(item.name)}</b>${item.price ? `<em>${e(item.price)}</em>` : ''}<span class="sx-view">View item<i>→</i></span></span></a>`
          )
          .join('')}</div>${storeBanner()}`,
        { dark: true }
      )
    );
  } else if (storeUrl) {
    parts.push(storeBanner(' sx-alone'));
  }

  parts.push(`<div class="sx-thanks"><b>Thank you for shopping with <strong>${storeName}</strong></b>
  <span>Questions? <strong>Message us on eBay</strong>. We respond within ${e(t.responseTime)}.</span>
  <span>Love ${storeName}? Click "Save seller" to never miss a new listing or deal.</span>
  <small>© ${storeName} · ${e(copy.business)}</small></div>`);

  return `${styles(t, h.fontStack(t.fontFamily), photos, VARIANTS.includes(variant) ? variant : 'showcase')}
<div class="sx">
${parts.join('\n')}
</div>`;
}

module.exports = { renderShowcase, readSections, tint, VARIANTS };
