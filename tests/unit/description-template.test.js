const test = require('node:test');
const assert = require('node:assert');

const { renderDescription, textToHtml } = require('../../src/modules/listings/description-template');

const base = { storeName: 'Walexo', feedbackPercent: '99.4' };

test('renderDescription brands the description with the account, not a fixed store', () => {
  const a = renderDescription({ template: { storeName: 'Walexo' }, productName: 'P', description: 'd' });
  const b = renderDescription({ template: { storeName: 'FlipX', accentColor: '#112233' }, productName: 'P', description: 'd' });

  assert.ok(a.includes('Walexo') && !a.includes('FlipX'));
  assert.ok(b.includes('FlipX') && !b.includes('Walexo'));
  assert.ok(b.includes('#112233'));
});

test('renderDescription never invents reviews', () => {
  const html = renderDescription({ template: base, productName: 'P', description: 'd' });
  assert.ok(!html.includes('What Customers Say'));
  assert.ok(!html.includes('Paste real customer review'));
});

test('renderDescription shows real reviews the seller entered', () => {
  const html = renderDescription({
    template: { ...base, reviews: [{ stars: 5, text: 'Great gloves', buyer: 'a***b', date: 'Jan 2026' }] },
    productName: 'P',
    description: 'd',
  });
  assert.ok(html.includes('What Customers Say'));
  assert.ok(html.includes('Great gloves'));
  assert.ok(html.includes('★★★★★'));
});

test('renderDescription lists the account’s own live listings and nothing else', () => {
  const html = renderDescription({
    template: base,
    productName: 'P',
    description: 'd',
    recommended: [{ url: 'https://www.ebay.co.uk/itm/1', imageUrl: 'https://i/a.jpg', name: 'Other', price: '£4.99' }],
  });
  assert.ok(html.includes('Best Sellers From Our Store'));
  assert.ok(html.includes('https://www.ebay.co.uk/itm/1'));
  assert.ok(html.includes('£4.99'));
});

test('renderDescription omits the carousel when there is nothing to recommend', () => {
  const html = renderDescription({ template: base, productName: 'P', description: 'd', recommended: [] });
  assert.ok(!html.includes('Best Sellers From Our Store'));
});

test('renderDescription hides the feedback badge rather than guessing a number', () => {
  const html = renderDescription({ template: { storeName: 'S' }, productName: 'P', description: 'd' });
  assert.ok(!html.includes('% Positive'));
});

test('renderDescription escapes seller-controlled text', () => {
  const html = renderDescription({ template: { storeName: '<script>x</script>' }, productName: '<b>P</b>', description: 'd' });
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;b&gt;P&lt;/b&gt;'));
});

test('textToHtml turns the model’s plain text into paragraphs, headings and lists', () => {
  const html = textToHtml('Stay warm.\n\nKEY FEATURES:\n• Heated\n- Touchscreen\n\nSecond para.');
  assert.ok(html.includes('<p>Stay warm.</p>'));
  assert.ok(html.includes('<strong>KEY FEATURES</strong>'));
  assert.ok(html.includes('<li>Heated</li>'));
  assert.ok(html.includes('<li>Touchscreen</li>'));
  assert.ok(html.includes('<p>Second para.</p>'));
});

test('textToHtml escapes markup inside the description', () => {
  assert.ok(textToHtml('<img src=x onerror=alert(1)>').includes('&lt;img'));
});

// The model writes **bold** markdown and sellers want highlight/colour/size
// controls; the description stays plain text with these markers and the
// template renders them. Anything else is escaped, never HTML.
test('textToHtml renders inline formatting markers and nothing else', () => {
  const { textToHtml } = require('../../src/modules/listings/description-template');
  const html = textToHtml('A **bold** ==hi== [color=#ff0000]red[/color] [size=lg]big[/size] <b>x</b> [color=red]no[/color]');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<mark[^>]*>hi<\/mark>/);
  assert.match(html, /<span style="color:#ff0000">red<\/span>/);
  assert.match(html, /font-size:18px">big<\/span>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/, 'raw HTML is escaped');
  assert.match(html, /\[color=red\]no\[\/color\]/, 'non-hex colour is left as text');
});

test('textToHtml treats a bold-only line as a heading without doubling the tags', () => {
  const { textToHtml } = require('../../src/modules/listings/description-template');
  assert.strictEqual(textToHtml('**Key Features:**\n• A'), '<p><strong>Key Features</strong></p><ul><li>A</li></ul>');
});

// A chosen typeface reaches the CSS as a stack of fonts buyers already have
// (eBay strips external stylesheets); an unknown id falls back to the default.
test('renderDescription sets the template font, and {{fontFamily}} is available to custom HTML', () => {
  const { FONTS, renderTemplateSource } = require('../../src/modules/listings/description-template');
  assert.ok(FONTS.length >= 6);
  const serif = renderDescription({ template: { ...base, fontFamily: 'serif' }, productName: 'P', description: 'd' });
  assert.ok(serif.includes("font-family:Georgia,'Times New Roman',Times,serif"));
  const fallback = renderDescription({ template: { ...base, fontFamily: 'nope' }, productName: 'P', description: 'd' });
  assert.ok(fallback.includes("font-family:Nunito,'Segoe UI'"));
  assert.ok(typeof renderTemplateSource === 'function');
  const custom = renderDescription({ template: { ...base, fontFamily: 'elegant', customHtml: '<div style="font-family:{{fontFamily}}">{{productName}}</div>' }, productName: 'P', description: 'd' });
  assert.ok(custom.includes("font-family:&#39;Palatino Linotype&#39;") || custom.includes("font-family:'Palatino Linotype'"));
});
