const test = require('node:test');
const assert = require('node:assert');
const rules = require('../../src/modules/inbox/inbox-rules');

test("eBay's HTML notices become readable text, their links buttons; plain text stays as it is", () => {
  const html = '<html><head><style>p{color:red}</style></head><body><p>Hi walexo,</p><p>Your case <b>5123</b> is closed.&nbsp;Thanks &amp; regards</p><ul><li>One</li><li>Two</li></ul><a href="https://www.ebay.co.uk/sh/case/5123">View case</a> <a href="javascript:alert(1)">Bad</a><script>x()</script></body></html>';
  assert.strictEqual(rules.htmlToText(html), 'Hi walexo,\n\nYour case 5123 is closed. Thanks & regards\n\n• One\n• Two\nView case Bad');
  assert.deepStrictEqual(rules.linksIn(html), [{ text: 'View case', url: 'https://www.ebay.co.uk/sh/case/5123' }], 'http(s) only');
  assert.strictEqual(rules.htmlToText("Still not arrived & it's for tomorrow\r\nThanks"), "Still not arrived & it's for tomorrow\nThanks");
  assert.strictEqual(rules.htmlToText('Price &pound;8.49 &#8212; ok'), 'Price £8.49 — ok');
  assert.strictEqual(rules.previewOf('x'.repeat(300)).length, 158);
});

test('who a conversation is with, which messages are the seller\'s, and whether a buyer is waiting', () => {
  const c = (sender, recipient, type = 'FROM_MEMBERS') => ({ type, latestMessage: { sender, recipient } });
  assert.strictEqual(rules.otherPartyOf(c('buyer1', 'Walexo_Shop'), 'walexo_shop'), 'buyer1');
  assert.strictEqual(rules.otherPartyOf(c('walexo_shop', 'buyer2'), 'walexo_shop'), 'buyer2');
  assert.strictEqual(rules.otherPartyOf(c('eBay', 'walexo_shop', 'FROM_EBAY'), 'walexo_shop'), 'eBay');
  assert.strictEqual(rules.fromSeller({ sender: 'WALEXO_SHOP' }, 'walexo_shop'), true);
  assert.strictEqual(rules.waitingSince({ type: 'FROM_MEMBERS', latest_from_seller: false, latest_at: '2026-09-30T10:00:00Z' }), '2026-09-30T10:00:00Z');
  assert.strictEqual(rules.waitingSince({ type: 'FROM_MEMBERS', latest_from_seller: true, latest_at: '2026-09-30T10:00:00Z' }), null);
  assert.strictEqual(rules.waitingSince({ type: 'FROM_EBAY', latest_from_seller: false, latest_at: '2026-09-30T10:00:00Z' }), null);
});
