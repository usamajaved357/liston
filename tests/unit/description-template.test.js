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
  assert.strictEqual(textToHtml('**Key Features:**\n• A'), '<p class="eb-h"><strong>Key Features</strong></p><ul><li>A</li></ul>');
});

// The editor's bullet library and numbering keep the seller's own marker,
// rendered as a real list with a hanging indent; plain "•" stays a plain <ul>.
test('textToHtml renders styled bullets and numbering as lists that keep their marker', () => {
  const { textToHtml } = require('../../src/modules/listings/description-template');
  assert.strictEqual(
    textToHtml('✓ **Steel** strap\n✓ Fits 20mm'),
    '<ul class="eb-list"><li><span class="eb-b">✓</span><strong>Steel</strong> strap</li><li><span class="eb-b">✓</span>Fits 20mm</li></ul>'
  );
  assert.strictEqual(
    textToHtml('1. Open\n2) Fit'),
    '<ul class="eb-list eb-num"><li><span class="eb-b">1.</span>Open</li><li><span class="eb-b">2)</span>Fit</li></ul>'
  );
});

test('textToHtml keeps mixed lines in order, one list per kind of marker', () => {
  const { textToHtml } = require('../../src/modules/listings/description-template');
  const html = textToHtml('Specs:\n• A\n★ B\n1. C\nAfter');
  assert.strictEqual(
    html,
    '<p>Specs:</p><ul><li>A</li></ul><ul class="eb-list"><li><span class="eb-b">★</span>B</li></ul>' +
      '<ul class="eb-list eb-num"><li><span class="eb-b">1.</span>C</li></ul><p>After</p>'
  );
});

test('textToHtml does not mistake ordinary lines for lists', () => {
  const { textToHtml } = require('../../src/modules/listings/description-template');
  assert.strictEqual(textToHtml('1x Strap\n**Bold** start\n2024 model'), '<p>1x Strap<br/><strong>Bold</strong> start<br/>2024 model</p>');
});

test('the template styles the marker lists in the accent colour', () => {
  const html = renderDescription({ template: base, productName: 'P', description: '✓ A' });
  assert.match(html, /\.eb-desc ul\.eb-list\{list-style:none/);
  assert.match(html, /\.eb-desc \.eb-b\{[^}]*color:/);
  assert.match(html, /<span class="eb-b">✓<\/span>A/);
});

// The AI's description layout: **Heading** lines over their content, emoji-
// led Key Features lines, blank lines between sections.
const LAYOUT =
  '**Pet Cooling Mat For Dogs & Cats – Summer Heat Relief**\nKeep your pet cool.\n\n' +
  '**Key Features**\n❄️ Cooling Comfort – Helps.\n🛏️ Comfortable Resting Area – Beds.\n\n' +
  '**Available Sizes**\nXS / S / M\n\nPlease select your required size.\n\n' +
  '**Suitable For**\nDogs\nCats\n\n**Package Includes**\n1 × Pet Cooling Mat\n\n' +
  '**Important:** Check sizes.\n\nGive your pet a cool place.';

test('textToHtml renders the description layout: headings, emoji features, sections', () => {
  const { textToHtml } = require('../../src/modules/listings/description-template');
  assert.strictEqual(
    textToHtml(LAYOUT),
    '<p class="eb-h"><strong>Pet Cooling Mat For Dogs &amp; Cats – Summer Heat Relief</strong></p><p>Keep your pet cool.</p>' +
      '<p class="eb-h"><strong>Key Features</strong></p><ul class="eb-list"><li><span class="eb-b">❄️</span>Cooling Comfort – Helps.</li>' +
      '<li><span class="eb-b">🛏️</span>Comfortable Resting Area – Beds.</li></ul>' +
      '<p class="eb-h"><strong>Available Sizes</strong></p><p>XS / S / M</p><p>Please select your required size.</p>' +
      '<p class="eb-h"><strong>Suitable For</strong></p><p>Dogs<br/>Cats</p>' +
      '<p class="eb-h"><strong>Package Includes</strong></p><p>1 × Pet Cooling Mat</p>' +
      '<p class="eb-note"><strong>Important:</strong> Check sizes.</p><p>Give your pet a cool place.</p>'
  );
});

test('textToHtml takes emoji sequences as one marker, and never © ® ™', () => {
  const { textToHtml } = require('../../src/modules/listings/description-template');
  assert.strictEqual(textToHtml('👩‍⚕️ Vet approved'), '<ul class="eb-list"><li><span class="eb-b">👩‍⚕️</span>Vet approved</li></ul>');
  assert.strictEqual(textToHtml('© 2026 Brand\n® Mark'), '<p>© 2026 Brand<br/>® Mark</p>');
});

test('htmlToText reads the description layout back exactly as it was written', () => {
  const { htmlToText } = require('../../src/modules/listings/listing.service');
  const { textToHtml } = require('../../src/modules/listings/description-template');
  assert.strictEqual(htmlToText(`<div class="eb-desc">${textToHtml(LAYOUT)}</div>\n  </div>`), LAYOUT);
});

// "Important:", "Note:", "Warning:" … lines stand out as a highlighted
// callout on eBay, whoever wrote them; look-alikes and list items don't.
test('textToHtml renders note lines as a highlighted callout', () => {
  const { textToHtml } = require('../../src/modules/listings/description-template');
  assert.strictEqual(
    textToHtml('Closing.\n**Important:** Measure first.\n\nNote: fragile\nNotebook sleeve fits\n\n✓ Note: a list item'),
    '<p>Closing.</p><p class="eb-note"><strong>Important:</strong> Measure first.</p><p class="eb-note">Note: fragile</p>' +
      '<p>Notebook sleeve fits</p><ul class="eb-list"><li><span class="eb-b">✓</span>Note: a list item</li></ul>'
  );
  for (const label of ['**Please note:**', '**Warning**:', 'Caution:', 'ATTENTION:']) {
    assert.match(textToHtml(`${label} x`), /^<p class="eb-note">/, label);
  }
});

test('the template styles the note callout', () => {
  const html = renderDescription({ template: base, productName: 'P', description: '**Important:** Check.' });
  assert.match(html, /\.eb-desc p\.eb-note\{background:#FFF7E6;[^}]*border-left:4px solid #F59E0B/);
  assert.match(html, /<p class="eb-note"><strong>Important:<\/strong> Check\.<\/p>/);
});

// Reading a live listing back into the editor keeps the styled markers.
test('htmlToText keeps a styled list marker instead of a plain bullet', () => {
  const { htmlToText } = require('../../src/modules/listings/listing.service');
  const { textToHtml } = require('../../src/modules/listings/description-template');
  const text = htmlToText(`<div class="eb-desc">${textToHtml('✓ Steel\n✓ Light\n\n1. Open\n2. Fit\n\n• Plain')}</div>\n  </div>`);
  assert.strictEqual(text, '✓ Steel\n✓ Light\n\n1. Open\n2. Fit\n\n• Plain');
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

// ---- the card layouts -------------------------------------------------------------

const { readSections } = require('../../src/modules/listings/description-showcase');
const { LAYOUTS, listItem } = require('../../src/modules/listings/description-template');

const DRAFTED =
  '**Shockproof Magnetic iPhone Case: MagSafe Charging Rugged Cover**\n' +
  'Get a distinctive metallic look without the weight of real metal.\n\n' +
  '**Key Features**\n✨ Metallic Paint Finish: Plated look without the weight.\n🧲 MagSafe Compatible: Aligns with MagSafe chargers.\n\n' +
  '**Available Models**\niPhone 15 / iPhone 16\n\nPlease select your required model before placing your order.\n\n' +
  '**Perfect For**\n✓ MagSafe users\n✓ Everyday protection\n\n' +
  '**How To Use**\n1. Select your model\n2. Fit the case\n\n' +
  '**Package Includes**\n• 1 × Magnetic Case\n\n' +
  '**Important:** This is a back case only.\n\n' +
  'A smart way to protect your phone.';

test("a drafted description is read into the card layouts' sections", () => {
  const s = readSections(DRAFTED, { listItem, isNoteLine: (l) => /^\*\*important/i.test(l) });
  assert.strictEqual(s.title, 'Shockproof Magnetic iPhone Case');
  assert.strictEqual(s.subtitle, 'MagSafe Charging Rugged Cover');
  assert.deepStrictEqual(s.intro, ['Get a distinctive metallic look without the weight of real metal.']);
  assert.deepStrictEqual(s.features[0], { icon: '✨', name: 'Metallic Paint Finish', text: 'Plated look without the weight.' });
  assert.deepStrictEqual(s.options, { heading: 'Available Models', values: ['iPhone 15', 'iPhone 16'], note: 'Please select your required model before placing your order.' });
  assert.deepStrictEqual(s.perfectFor, ['MagSafe users', 'Everyday protection']);
  assert.deepStrictEqual(s.steps, ['Select your model', 'Fit the case']);
  assert.deepStrictEqual(s.includes, ['1 × Magnetic Case']);
  assert.deepStrictEqual(s.notes, ['This is a back case only.']);
  assert.deepStrictEqual(s.closing, ['A smart way to protect your phone.']);
});

test('every layout renders; the card layouts show the photos as a working gallery, the specifics as a table, and the store link', () => {
  assert.deepStrictEqual(LAYOUTS.map((l) => l.id), ['classic', 'showcase', 'minimal', 'bold', 'boutique']);
  const images = ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg'];
  const specifics = { Brand: ['Unbranded'], Material: ['PC'], MPN: ['Does not apply'] };
  for (const { id } of LAYOUTS) {
    const html = renderDescription({ template: { ...base, layout: id }, marketplaceId: 'EBAY_GB', productName: 'Case', description: DRAFTED, images, specifics, storeUrl: 'https://www.ebay.co.uk/sch/i.html?_ssn=walexo', recommended: [{ url: 'https://www.ebay.co.uk/itm/1', imageUrl: 'https://i.ebayimg.com/c.jpg', name: 'Other' }] });
    assert.ok(html.includes('Shockproof Magnetic iPhone Case'), id);
    assert.doesNotMatch(html, /<script/i, `${id}: no scripts, eBay refuses them`);
    if (id === 'classic') {
      assert.match(html, /class="eb"/);
      continue;
    }
    assert.match(html, /id="sxg1" class="sx-r" checked/, `${id}: gallery radios`);
    assert.match(html, /label for="sxg2"/, `${id}: a thumbnail switches the photo`);
    assert.match(html, /<td>Material<\/td><td>PC<\/td>/, `${id}: specifics table`);
    assert.doesNotMatch(html, /MPN/, `${id}: "Does not apply" is left out`);
    assert.match(html, /_ssn=walexo/, `${id}: visit the store`);
    assert.match(html, /sx-steps/, `${id}: how to use`);
    assert.match(html, /Thank you for shopping with <strong>Walexo<\/strong>/);
  }
  // The skins differ.
  const css = (id) => renderDescription({ template: { ...base, layout: id }, marketplaceId: 'EBAY_GB', productName: 'Case', description: DRAFTED }).split('</style>')[0];
  assert.notStrictEqual(css('bold'), css('boutique'));
  assert.notStrictEqual(css('minimal'), css('showcase'));
});

test('without a layout saved an account keeps the Classic layout', () => {
  assert.match(renderDescription({ template: base, marketplaceId: 'EBAY_GB', productName: 'Case', description: DRAFTED }), /class="eb"/);
});

test('every layout takes the same data from the Theme settings as Classic: store, feedback, delivery, returns, reviews, how many store listings, response time', () => {
  const template = {
    storeName: 'Walexo',
    tagline: 'Official UK Store',
    logoUrl: 'https://i.ebayimg.com/logo.jpg',
    feedbackPercent: '99.4',
    dispatchTime: 'Same Day Dispatch',
    dispatchNote: 'From our Leeds warehouse',
    carrier: 'Royal Mail Tracked 48',
    deliveryTime: '2 to 3 Business Days',
    freePostage: true,
    returnsDays: 60,
    responseTime: '6 hours',
    recommendedCount: 6,
    reviews: [{ stars: 5, text: 'Arrived next day, great quality', buyer: 'j***n', date: 'Aug 2026' }],
  };
  const recommended = Array.from({ length: 10 }, (_, i) => ({ url: `https://www.ebay.co.uk/itm/${i}`, imageUrl: `https://i.ebayimg.com/${i}.jpg`, name: `Item ${i}`, price: '£9.99', sold: 12 }));
  for (const { id } of LAYOUTS) {
    const html = renderDescription({ template: { ...template, layout: id }, marketplaceId: 'EBAY_GB', productName: 'Case', description: DRAFTED, recommended });
    for (const value of ['Walexo', 'Official UK Store', 'https://i.ebayimg.com/logo.jpg', '99.4% Positive', 'Same Day Dispatch', 'From our Leeds warehouse', 'Royal Mail Tracked 48', '2 to 3 Business Days', '60-day hassle-free return policy', '6 hours', 'Arrived next day, great quality', 'j***n']) {
      assert.ok(html.includes(value), `${id} shows "${value}"`);
    }
    const cards = (html.match(/https:\/\/www\.ebay\.co\.uk\/itm\/\d/g) || []).length;
    assert.strictEqual(cards, 6, `${id}: the ${template.recommendedCount} store listings Settings asks for`);
    assert.ok(html.includes('£9.99'), `${id}: store listing prices`);
  }
  for (const { id } of LAYOUTS) {
    const none = renderDescription({ template: { ...template, layout: id, reviews: [], recommendedCount: 0, returnsDays: 0 }, marketplaceId: 'EBAY_GB', productName: 'Case', description: DRAFTED, recommended });
    assert.doesNotMatch(none, /What Customers Say/, `${id}: no reviews, no section`);
    assert.doesNotMatch(none, /itm\/\d/, `${id}: 0 store listings hides them`);
    assert.doesNotMatch(none, /return policy/, `${id}: no returns, no returns text`);
  }
});

test("every link in every layout opens outside eBay's description frame, and the store's listings sit four to a row", () => {
  const recommended = Array.from({ length: 8 }, (_, i) => ({ url: `https://www.ebay.co.uk/itm/${i}`, imageUrl: `https://i.ebayimg.com/${i}.jpg`, name: `Item ${i}`, price: '£5' }));
  for (const { id } of LAYOUTS) {
    const html = renderDescription({ template: { ...base, layout: id, recommendedCount: 8 }, marketplaceId: 'EBAY_GB', productName: 'Case', description: DRAFTED, recommended, storeUrl: 'https://www.ebay.co.uk/str/walexo' });
    const links = html.match(/<a [^>]*>/g) || [];
    assert.ok(links.length >= 8, `${id}: links rendered`);
    for (const link of links) assert.match(link, /target="_blank" rel="noopener"/, `${id}: ${link}`);
    if (id !== 'classic') {
      assert.match(html, /href="https:\/\/www\.ebay\.co\.uk\/str\/walexo"/, `${id}: visit the store`);
      assert.match(html, /\.sx-shop\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/, `${id}: four to a row`);
    }
  }
});

test('the card layouts show each store listing as a card with its price and a View item button, and the store as one banner link, even with no listings shown', () => {
  const recommended = [{ url: 'https://www.ebay.co.uk/itm/1', imageUrl: 'https://i.ebayimg.com/1.jpg', name: 'Lamp', price: '£12.99', sold: 40 }];
  for (const id of ['showcase', 'minimal', 'bold', 'boutique']) {
    const html = renderDescription({ template: { ...base, layout: id, recommendedCount: 4 }, marketplaceId: 'EBAY_GB', productName: 'Case', description: DRAFTED, recommended, storeUrl: 'https://www.ebay.co.uk/str/walexo' });
    assert.match(html, /<a class="sx-prod" href="https:\/\/www\.ebay\.co\.uk\/itm\/1"[^>]*><span class="sx-pimg"><img [^>]*\/><span class="sx-sold">40 sold<\/span><\/span><span class="sx-pinfo"><b>Lamp<\/b><em>£12\.99<\/em><span class="sx-view">View item/, id);
    assert.match(html, /<a class="sx-cta" href="https:\/\/www\.ebay\.co\.uk\/str\/walexo" target="_blank" rel="noopener">.*Visit our eBay store/, id);
    const none = renderDescription({ template: { ...base, layout: id, recommendedCount: 0 }, marketplaceId: 'EBAY_GB', productName: 'Case', description: DRAFTED, recommended, storeUrl: 'https://www.ebay.co.uk/str/walexo' });
    assert.match(none, /<a class="sx-cta sx-alone" href="https:\/\/www\.ebay\.co\.uk\/str\/walexo"/, `${id}: the store banner without listings`);
    assert.doesNotMatch(none, /sx-prod"/, id);
  }
});

test('four features sit two to a row in the three-column layouts', () => {
  const html = renderDescription({ template: { ...base, layout: 'bold' }, marketplaceId: 'EBAY_GB', productName: 'Case', description: '**Case**\n\n**Key Features**\n• A: a\n• B: b\n• C: c\n• D: d' });
  assert.match(html, /class="sx-grid sx-even"/);
  const three = renderDescription({ template: { ...base, layout: 'bold' }, marketplaceId: 'EBAY_GB', productName: 'Case', description: '**Case**\n\n**Key Features**\n• A: a\n• B: b\n• C: c' });
  assert.match(three, /class="sx-grid"/);
});

test('the card layouts carry no emoji, not even the ones the drafted features lead with', () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B50}\u{2B06}\u{21A9}]/u;
  const recommended = [{ url: 'https://www.ebay.co.uk/itm/1', imageUrl: 'https://i.ebayimg.com/1.jpg', name: 'Lamp', price: '£12.99', sold: 40 }];
  const template = { ...base, feedbackPercent: '99.4', returnsDays: 30, reviews: [{ stars: 5, text: 'Great', buyer: 'j***n' }] };
  for (const id of ['showcase', 'minimal', 'bold', 'boutique']) {
    const html = renderDescription({ template: { ...template, layout: id }, marketplaceId: 'EBAY_GB', productName: 'Case', description: DRAFTED, images: ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg'], recommended, storeUrl: 'https://www.ebay.co.uk/str/walexo' });
    const found = html.replace(/★/g, '').match(emoji); // ★ is the rating star, a text glyph
    assert.strictEqual(found, null, `${id}: ${found && html.slice(Math.max(0, found.index - 60), found.index + 20)}`);
    assert.match(html, /Metallic Paint Finish/, `${id}: the feature itself stays`);
  }
});
