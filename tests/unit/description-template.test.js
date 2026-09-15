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
  assert.ok(html.includes('You May Also Like'));
  assert.ok(html.includes('https://www.ebay.co.uk/itm/1'));
  assert.ok(html.includes('£4.99'));
});

test('renderDescription omits the carousel when there is nothing to recommend', () => {
  const html = renderDescription({ template: base, productName: 'P', description: 'd', recommended: [] });
  assert.ok(!html.includes('You May Also Like'));
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
