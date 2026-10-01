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

test("an eBay notice keeps its own HTML for the page to draw, trimmed of scripts, frames and Outlook-only comments; plain text has none", () => {
  const html = '<!DOCTYPE html><html><head><style>.b{color:#3665f3}</style><script>alert(1)</script></head><body style="margin:0"><!--[if mso]><table><![endif]--><table width="600"><tr><td><a class="b" href="https://www.ebay.co.uk/sh/fin">See details</a><iframe src="https://x.test"></iframe><img src="https://ir.ebaystatic.com/logo.png" alt="eBay"></td></tr></table><script src="https://x.test/a.js"></script></body></html>';
  const out = rules.noticeHtml(html);
  for (const kept of ['<style>.b{color:#3665f3}</style>', '<body style="margin:0">', '<table width="600">', 'See details</a>', 'src="https://ir.ebaystatic.com/logo.png"']) assert.ok(out.includes(kept), `keeps ${kept}`);
  assert.ok(!/script|iframe|mso|x\.test/i.test(out), 'nothing that runs or embeds');
  assert.strictEqual(rules.noticeHtml('Your case is closed.'), null);
  assert.strictEqual(rules.noticeHtml(''), null);
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

test("unread as Liston keeps it: read here up to the latest message stays read whatever eBay's list says, until the buyer writes again", () => {
  const readAt = '2026-09-30T18:23:31.000Z';
  // Never read in Liston: eBay's count.
  assert.strictEqual(rules.unreadAfterRead(1, { latestAt: '2026-09-30T18:00:00Z', latestFromSeller: false }, null), 1);
  // Read here up to that message, eBay still says 1: read.
  assert.strictEqual(rules.unreadAfterRead(1, { latestAt: '2026-09-30T18:23:31Z', latestFromSeller: false }, readAt), 0);
  // The seller had the last word since it was read here: read.
  assert.strictEqual(rules.unreadAfterRead(1, { latestAt: '2026-09-30T19:00:00Z', latestFromSeller: true }, readAt), 0);
  // The buyer wrote after it was read: eBay's count again.
  assert.strictEqual(rules.unreadAfterRead(2, { latestAt: '2026-09-30T19:00:00Z', latestFromSeller: false }, readAt), 2);
});

test("a buyer's new word is news for the team's devices: theirs, in the inbox, not the message Liston had, and recent", () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const row = { type: 'FROM_MEMBERS', status: 'ACTIVE', latestFromSeller: false, latestMessageId: 'm2', latestAt: '2026-10-01T11:58:00Z' };
  const within = 24 * 3600e3;
  assert.strictEqual(rules.isNewBuyerWord(row, { latest_message_id: 'm1' }, { within, now }), true);
  assert.strictEqual(rules.isNewBuyerWord(row, null, { within, now }), true, 'a new conversation');
  assert.strictEqual(rules.isNewBuyerWord(row, { latest_message_id: 'm2' }, { within, now }), false, 'already had it');
  assert.strictEqual(rules.isNewBuyerWord({ ...row, latestFromSeller: true }, null, { within, now }), false, 'your own reply');
  assert.strictEqual(rules.isNewBuyerWord({ ...row, type: 'FROM_EBAY' }, null, { within, now }), false, "eBay's notices");
  assert.strictEqual(rules.isNewBuyerWord({ ...row, status: 'ARCHIVE' }, null, { within, now }), false);
  assert.strictEqual(rules.isNewBuyerWord({ ...row, latestAt: '2026-09-29T11:00:00Z' }, null, { within, now }), false, 'old, found late');

  assert.strictEqual(rules.wantsEbayPush(null, 'a'), true, 'everything by default');
  assert.strictEqual(rules.wantsEbayPush({ ebay: 'none' }, 'a'), false);
  assert.strictEqual(rules.wantsEbayPush({ ebay: 'chosen', ebay_accounts: ['a'] }, 'a'), true);
  assert.strictEqual(rules.wantsEbayPush({ ebay: 'chosen', ebay_accounts: ['b'] }, 'a'), false);
});

test("the Cases view's order: the soonest eBay deadline first, then money held before the buyer's claims, then the newest", () => {
  const item = (id, kind, respondBy, latest) => ({ row: { conversation_id: id, latest_at: latest }, issue: { kind, respondBy } });
  const list = [
    item('cancel', 'cancel', null, '2026-10-01T10:00:00Z'),
    item('late-return', 'return', '2026-10-05T10:00:00Z', '2026-10-01T09:00:00Z'),
    item('dispute', 'dispute', null, '2026-09-30T10:00:00Z'),
    item('soon-inr', 'inquiry', '2026-10-02T10:00:00Z', '2026-09-29T10:00:00Z'),
    item('cancel-newer', 'cancel', null, '2026-10-01T11:00:00Z'),
  ];
  assert.deepStrictEqual(list.sort(rules.byDeadline).map((x) => x.row.conversation_id), ['soon-inr', 'late-return', 'dispute', 'cancel-newer', 'cancel']);
});
