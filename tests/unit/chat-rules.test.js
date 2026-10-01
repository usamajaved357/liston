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

test('a voice note: audio only, its length kept (up to ten minutes) and its shape as bars from 0 to 1; its preview says how long', () => {
  const file = { id: 'f1', mime: 'audio/mp4' };
  assert.deepStrictEqual(rules.voiceOf({ fileId: 'f1', durationMs: 2499.6, peaks: [0.333, 1.7, -1, 'x'] }, file), { fileId: 'f1', durationMs: 2500, peaks: [0.33, 1, 0, 0] });
  assert.strictEqual(rules.voiceOf({ fileId: 'f1', durationMs: 99 * 60 * 1000, peaks: [] }, file).durationMs, rules.VOICE_MAX_MS);
  assert.strictEqual(rules.voiceOf({ fileId: 'f1', durationMs: 1000 }, { id: 'f1', mime: 'image/png' }), null, 'not audio');
  assert.strictEqual(rules.voiceOf({ fileId: 'f2', durationMs: 1000 }, file), null, 'another file');
  assert.strictEqual(rules.voiceOf({ fileId: 'f1', durationMs: 0 }, file), null, 'no length');
  assert.strictEqual(rules.voiceOf({ fileId: 'f1', durationMs: 1000, peaks: Array(200).fill(0.5) }, file).peaks.length, rules.VOICE_BARS);
  assert.strictEqual(rules.previewOf({ body: '', fileCount: 1, voiceMs: 65000 }), 'Voice message (1:05)');
  assert.strictEqual(rules.previewOf({ body: 'hi', voiceMs: 65000 }), 'hi', 'text first');
});

test('a thread reply pushes its followers and whoever it mentions, never the author, a muted conversation or "none"', () => {
  const message = { author_user_id: 'a', mentions: ['m'], mention_all: false };
  const member = (id, notify = 'all') => ({ user_id: id, notify });
  assert.strictEqual(rules.wantsThreadPush({ member: member('f'), follower: true, settings: null, message }), true);
  assert.strictEqual(rules.wantsThreadPush({ member: member('f'), follower: true, settings: { chat: 'mentions' }, message }), true, 'following counts as being spoken to');
  assert.strictEqual(rules.wantsThreadPush({ member: member('x'), follower: false, settings: null, message }), false, 'not following, not mentioned');
  assert.strictEqual(rules.wantsThreadPush({ member: member('m'), follower: false, settings: null, message }), true, 'mentioned');
  assert.strictEqual(rules.wantsThreadPush({ member: member('a'), follower: true, settings: null, message }), false, 'their own');
  assert.strictEqual(rules.wantsThreadPush({ member: member('f', 'none'), follower: true, settings: null, message }), false, 'muted');
  assert.strictEqual(rules.wantsThreadPush({ member: member('f'), follower: true, settings: { chat: 'none' }, message }), false);
});

test("a preview drops the formatting marks but keeps words with underscores", () => {
  assert.strictEqual(rules.previewOf({ body: 'Who has the **refund** on _FlipX_? ~old~ `SKU-1` snake_case_name' }), 'Who has the refund on FlipX? old SKU-1 snake_case_name');
});
