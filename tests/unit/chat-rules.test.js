const test = require('node:test');
const assert = require('node:assert');
const rules = require('../../src/modules/chat/chat-rules');

test('chat names: one direct message per pair, channel names made tidy, what each person calls a conversation', () => {
  assert.strictEqual(rules.dmKey('b', 'a'), rules.dmKey('a', 'b'));
  assert.strictEqual(rules.channelName('  #FlipX Orders!! '), 'flipx-orders');
  assert.strictEqual(rules.validChannelName(rules.channelName('###')), false);
  const members = [
    { user_id: 'u1', name: 'Owen' },
    { user_id: 'u2', name: null, email: 'sara@shop.test' },
    { user_id: 'u3', name: 'Tom' },
    { user_id: 'u4', name: 'Ali' },
    { user_id: 'u5', name: 'Zed' },
  ];
  assert.strictEqual(rules.titleOf({ kind: 'channel', name: 'orders' }, members, 'u1'), '#orders');
  assert.strictEqual(rules.titleOf({ kind: 'dm' }, members.slice(0, 2), 'u1'), 'sara', 'an email stands in for a missing name');
  assert.strictEqual(rules.titleOf({ kind: 'group' }, members, 'u1'), 'sara, Tom, Ali and 1 more');
  assert.strictEqual(rules.titleOf({ kind: 'group', name: 'Weekend crew' }, members, 'u1'), 'Weekend crew');
});

test('who is pushed: never the sender or a muted conversation; "mentions" only a direct message or a mention; @channel counts for everyone', () => {
  const channel = { kind: 'channel' };
  const message = { author_user_id: 'owen', mentions: ['sara'], mention_all: false };
  const member = (user_id, notify = 'all') => ({ user_id, notify });
  assert.strictEqual(rules.wantsPush({ member: member('owen'), conversation: channel, message }), false, 'your own message');
  assert.strictEqual(rules.wantsPush({ member: member('tom', 'none'), conversation: channel, message }), false, 'muted');
  assert.strictEqual(rules.wantsPush({ member: member('tom', 'mentions'), conversation: channel, message }), false);
  assert.strictEqual(rules.wantsPush({ member: member('sara', 'mentions'), conversation: channel, message }), true, 'mentioned');
  assert.strictEqual(rules.wantsPush({ member: member('tom'), settings: { chat: 'mentions' }, conversation: { kind: 'dm' }, message }), true, 'a direct message is personal');
  assert.strictEqual(rules.wantsPush({ member: member('tom'), settings: { chat: 'none' }, conversation: { kind: 'dm' }, message }), false);
  assert.strictEqual(rules.wantsPush({ member: member('tom', 'mentions'), conversation: channel, message: { ...message, mention_all: true } }), true);
  assert.strictEqual(rules.mentionsEveryone('Heads up @channel: new rules'), true);
  assert.strictEqual(rules.mentionsEveryone('email me at team@channel.com'), false);
});

test('quiet hours in the person\'s own time zone, including ones that run past midnight', () => {
  const at = (iso) => new Date(iso);
  const night = { quiet_from: 22 * 60, quiet_to: 7 * 60, time_zone: 'Europe/London' };
  // 23:30 BST is 22:30 UTC.
  assert.strictEqual(rules.inQuietHours(night, at('2026-09-30T22:30:00Z')), true);
  assert.strictEqual(rules.inQuietHours(night, at('2026-09-30T05:30:00Z')), true, '06:30 in London');
  assert.strictEqual(rules.inQuietHours(night, at('2026-09-30T12:00:00Z')), false);
  assert.strictEqual(rules.inQuietHours({ quiet_from: 9 * 60, quiet_to: 17 * 60, time_zone: 'Asia/Karachi' }, at('2026-09-30T06:00:00Z')), true, '11:00 in Karachi');
  assert.strictEqual(rules.inQuietHours({ quiet_from: null, quiet_to: null }, at('2026-09-30T03:00:00Z')), false);
});

test('previews: the text, else what was shared', () => {
  assert.strictEqual(rules.previewOf({ body: '  hello\n\nthere ' }), 'hello there');
  assert.strictEqual(rules.previewOf({ body: 'x'.repeat(200) }).length, 138);
  assert.strictEqual(rules.previewOf({ cards: [{ kind: 'order', account: { label: 'FlipX' } }] }), 'Shared an order · FlipX');
  assert.strictEqual(rules.previewOf({ fileCount: 3, imageCount: 3 }), 'Sent 3 photos');
  assert.strictEqual(rules.previewOf({ fileCount: 2, imageCount: 1 }), 'Sent 2 files');
  assert.strictEqual(rules.previewOf({ body: 'secret', deleted: true }), 'Message deleted');
});
