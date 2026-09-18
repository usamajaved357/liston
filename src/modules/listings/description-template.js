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

// Tagline, warehouse note and carrier default to the account's own market
// (see templateWithDefaults); the values here are the UK ones.
const DEFAULT_TEMPLATE = {
  storeName: '',
  tagline: 'Official UK Store',
  logoUrl: '',
  accentColor: '#FF6B2B',
  darkColor: '#1E1E2E',
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

// The model writes plain text — paragraphs separated by blank lines, bullet
// lines starting with "•" or "-", and short ALL-CAPS lines as headings.
// Turned into the HTML the template's styles expect, with everything escaped.
function textToHtml(text) {
  const blocks = String(text || '').split(/\n\s*\n/);
  return blocks
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return '';
      const bullets = lines.filter((l) => /^[•\-*]\s+/.test(l));
      if (bullets.length === lines.length) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^[•\-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      // "**Key Features:**" — a bold-only line — is a heading too.
      const isHeading = (line) => /^[A-Z0-9 &:\-–]{4,60}:?$/.test(line) || /^\*\*[^*]{2,60}\*\*:?$/.test(line);
      const headingHtml = (line) => `<p><strong>${inline(line.replace(/^\*\*|\*\*:?$/g, '').replace(/:$/, ''))}</strong></p>`;
      if (lines.length === 1 && isHeading(lines[0])) return headingHtml(lines[0]);
      // A block mixing a lead line with bullets — "KEY FEATURES:" straight
      // into its list is how the model writes it. The lead renders as a
      // heading when it looks like one, otherwise as a paragraph.
      if (bullets.length) {
        const lead = lines.filter((l) => !/^[•\-*]\s+/.test(l));
        const leadHtml = lead.length === 1 && isHeading(lead[0]) ? headingHtml(lead[0]) : lead.length ? `<p>${lead.map(inline).join('<br/>')}</p>` : '';
        return leadHtml + `<ul>${bullets.map((l) => `<li>${inline(l.replace(/^[•\-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      return `<p>${lines.map(inline).join('<br/>')}</p>`;
    })
    .join('');
}

function styles(t) {
  const a = t.accentColor;
  const d = t.darkColor;
  return `<style>
.eb{max-width:1400px;width:100%;margin:0 auto;font-family:Nunito,'Segoe UI',Helvetica,Arial,sans-serif;color:#1C1C1C;background:#fff;border:1px solid #E0E0E0;overflow-x:hidden}
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
.eb-desc ul{padding-left:18px;margin:0 0 10px}
.eb-desc li{margin-bottom:5px}
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
.eb-fgrid{display:flex;gap:10px;flex-wrap:wrap}
.eb-fcard{flex:1;min-width:140px;background:#F7F7FA;border:1px solid #E8E8E8;border-radius:10px;padding:14px;border-top:3px solid ${a}}
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
@media(max-width:480px){.eb-header-badges{display:none}.eb-fcard{min-width:100%}.eb-rcard{flex-basis:150px;width:150px}.eb-rimg{height:150px}.eb-pname{font-size:20px}.eb-sec{padding:18px}}
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

function renderDescription({ template, marketplaceId, productName, description, descriptionHtml, recommended = [], condition = 'NEW' }) {
  const t = templateWithDefaults(template, marketplaceId);
  const copy = marketplaces.templateCopy(marketplaceId);
  const storeName = escapeHtml(t.storeName || 'Our Store');
  const feedback = t.feedbackPercent ? `${escapeHtml(String(t.feedbackPercent).replace('%', ''))}% Positive` : null;
  const postageWord = escapeHtml(copy.postageWord);
  const postage = t.freePostage ? `Free ${postageWord}` : `Tracked ${postageWord}`;
  const returns = Number(t.returnsDays) > 0 ? `${Number(t.returnsDays)}-Day Returns` : null;
  const descHtml = descriptionHtml !== undefined ? descriptionHtml : textToHtml(description);
  const conditionLabel = escapeHtml(String(condition).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));

  const reviews = (t.reviews || []).filter((r) => r && r.text).slice(0, 3);
  const reviewsHtml = reviews.length
    ? `<div class="eb-sec">
    <div class="eb-stitle">What Customers Say</div>
    <div class="eb-fgrid">${reviews
      .map(
        (r) => `<div class="eb-fcard"><div class="eb-fstars">${'★'.repeat(Math.min(5, Math.max(1, Number(r.stars) || 5)))}</div><div class="eb-ftext">"${escapeHtml(r.text)}"</div><div class="eb-fname">${escapeHtml(r.buyer || 'eBay buyer')}</div><div class="eb-fdate">${escapeHtml(r.date || '')}${r.date ? ' · ' : ''}Verified Purchase</div></div>`
      )
      .join('')}</div>
  </div>`
    : '';
  const recommendedHtml = recommended.length
    ? `<div class="eb-sec">
    <div class="eb-stitle">More From Our Store</div>
    <p class="eb-rhint">Scroll to see more →</p>
    <div class="eb-rgrid">${recommended
      .slice(0, Number(t.recommendedCount) || 12)
      .map(
        (item) => `<a href="${escapeHtml(item.url)}" class="eb-rcard">${
          item.imageUrl ? `<img class="eb-rimg" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" />` : '<div class="eb-rimg"></div>'
        }<div class="eb-rinfo"><div class="eb-rname">${escapeHtml(item.name)}</div>${
          item.price ? `<span class="eb-rfrom">From</span><div class="eb-rprice">${escapeHtml(item.price)}</div>` : ''
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
      condition: conditionLabel,
      dispatchTime: escapeHtml(t.dispatchTime),
      deliveryTime: escapeHtml(t.deliveryTime),
      carrier: escapeHtml(t.carrier),
      returnsDays: String(Number(t.returnsDays) || 0),
      recommended: recommendedHtml,
      reviews: reviewsHtml,
    });
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
  const t = { ...templateWithDefaults(template, marketplaceId), customHtml: '' };
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

module.exports = { renderDescription, renderTemplateSource, fillPlaceholders, textToHtml, templateWithDefaults, DEFAULT_TEMPLATE, PLACEHOLDERS };
