const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { mock } = require('node:test');
require('dotenv').config();
process.env.STORAGE_DIR = path.join(os.tmpdir(), `liston-test-storage-${process.pid}`);
delete process.env.R2_ACCOUNT_ID;

const createApp = require('../../src/app');
const { addMember } = require('../helpers/members');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');
const notificationsService = require('../../src/modules/notifications/notifications.service');
const userEvents = require('../../src/modules/realtime/user-events');
const linkPreview = require('../../src/modules/chat/link-preview');

// Team chat: direct messages (one per pair), groups (3–8), channels run by
// the owner or "Manage channels"; messages with mentions, files and Liston
// cards shown as far as each person's access reaches; edits, deletes,
// reading, live events, pushes (not while reading, muted or quiet), search.

const app = createApp();
let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function request(method, url, body, token) {
  const res = await fetch(`${baseUrl}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function setup() {
  const email = `chat-owner-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  await pool.query("UPDATE users SET access_status = 'active', name = 'Owen' WHERE id = $1", [data.user.id]);
  const o = { id: data.user.id, token: data.token };
  const flipx = await connectionService.createConnection(o.id, { platformKey: 'ebay', label: 'FlipX', credentials: { accessToken: 'x' } });
  const people = {};
  for (const [name, grants] of [
    ['Sara', [{ connectionId: flipx.id, feature: 'orders', allowed: true }]],
    ['Tom', []],
    ['Ali', [{ connectionId: null, feature: 'chat_manage', allowed: true }]],
  ]) {
    const memberEmail = `chat-${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
    const added = await addMember(baseUrl, o.token, { email: memberEmail, password: 'memberpassword123', name });
    const id = added.data.id || added.data.member?.id;
    if (grants.length) await request('PUT', `/api/team/members/${id}/permissions`, { permissions: grants }, o.token);
    const login = await request('POST', '/api/auth/login', { email: memberEmail, password: 'memberpassword123' });
    people[name.toLowerCase()] = { id: login.data.user.id, token: login.data.token };
  }
  return { o, flipx, ...people };
}

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test('direct messages: one per pair, live to the other person, unread until read, "seen" once they read it', async () => {
  const t = await setup();
  const people = await request('GET', '/api/chat/people', undefined, t.sara.token);
  assert.deepStrictEqual(people.data.people.map((p) => p.name), ['Owen', 'Ali', 'Sara', 'Tom']);

  const dm = await request('POST', '/api/chat/dm', { userId: t.sara.id }, t.o.token);
  assert.strictEqual(dm.status, 200, JSON.stringify(dm.data));
  assert.deepStrictEqual([dm.data.kind, dm.data.title], ['dm', 'Sara']);
  assert.strictEqual((await request('POST', '/api/chat/dm', { userId: t.o.id }, t.sara.token)).data.id, dm.data.id, 'the same conversation from either side');

  const events = [];
  const stop = userEvents.subscribe(t.sara.id, (e) => events.push(e));
  const sent = await request('POST', `/api/chat/conversations/${dm.data.id}/messages`, { body: 'Hi Sara, can you check the FlipX orders?' }, t.o.token);
  assert.strictEqual(sent.status, 201, JSON.stringify(sent.data));
  assert.deepStrictEqual([sent.data.author.name, sent.data.body], ['Owen', 'Hi Sara, can you check the FlipX orders?']);
  assert.ok(await until(() => events.some((e) => e.type === 'chat.message' && e.message.id === sent.data.id)), 'Sara sees it at once');
  stop();

  const list = await request('GET', '/api/chat/conversations', undefined, t.sara.token);
  const row = list.data.conversations.find((c) => c.id === dm.data.id);
  assert.deepStrictEqual([row.title, row.unread, row.lastMessage.text], ['Owen', 1, 'Hi Sara, can you check the FlipX orders?']);
  assert.deepStrictEqual(list.data.unread, { unread: 1, mentions: 1, threads: 0 }, 'a direct message counts as a mention');
  assert.strictEqual((await request('GET', '/api/chat/conversations', undefined, t.o.token)).data.conversations.find((c) => c.id === dm.data.id).unread, 0, 'your own message is read');

  const read = await request('POST', `/api/chat/conversations/${dm.data.id}/read`, {}, t.sara.token);
  assert.deepStrictEqual(read.data.unread, { unread: 0, mentions: 0, threads: 0 });
  const seen = await request('GET', `/api/chat/conversations/${dm.data.id}`, undefined, t.o.token);
  assert.ok(new Date(seen.data.members.find((m) => m.id === t.sara.id).lastReadAt) >= new Date(sent.data.createdAt), 'seen by Sara');

  // Read up to a message (what the thread sends): that message is read, even at a time finer than a millisecond.
  const next = await request('POST', `/api/chat/conversations/${dm.data.id}/messages`, { body: 'And the refunds.' }, t.o.token);
  await pool.query(`UPDATE chat_messages SET created_at = now() + interval '1 second' + interval '123 microseconds' WHERE id = $1`, [next.data.id]);
  assert.strictEqual((await request('GET', '/api/chat/conversations', undefined, t.sara.token)).data.conversations.find((c) => c.id === dm.data.id).unread, 1);
  const upTo = await request('POST', `/api/chat/conversations/${dm.data.id}/read`, { messageId: next.data.id }, t.sara.token);
  assert.deepStrictEqual(upTo.data.unread, { unread: 0, mentions: 0, threads: 0 }, 'read up to that very message');
  assert.strictEqual((await request('GET', '/api/chat/conversations', undefined, t.sara.token)).data.conversations.find((c) => c.id === dm.data.id).unread, 0);

  // Someone outside the conversation can't read or write in it.
  assert.strictEqual((await request('GET', `/api/chat/conversations/${dm.data.id}/messages`, undefined, t.tom.token)).status, 404);
  assert.strictEqual((await request('POST', `/api/chat/conversations/${dm.data.id}/messages`, { body: 'x' }, t.tom.token)).status, 404);
  assert.strictEqual((await request('POST', '/api/chat/dm', { userId: crypto.randomUUID() }, t.o.token)).status, 400, 'only people in the team');
});

test('groups and channels: groups of 3 to 8 anyone starts; channels only by the owner or Manage channels; public ones open to join, private ones hidden', async () => {
  const t = await setup();
  assert.strictEqual((await request('POST', '/api/chat/groups', { userIds: [t.sara.id] }, t.tom.token)).status, 400, 'one other person is a direct message');
  const group = await request('POST', '/api/chat/groups', { userIds: [t.sara.id, t.o.id] }, t.tom.token);
  assert.strictEqual(group.status, 201);
  assert.deepStrictEqual([group.data.kind, group.data.title], ['group', 'Sara, Owen']);

  assert.strictEqual((await request('POST', '/api/chat/channels', { name: 'orders' }, t.tom.token)).status, 403, 'a member without Manage channels');
  const channel = await request('POST', '/api/chat/channels', { name: '#FlipX Orders', topic: 'Everything about FlipX orders', connectionId: t.flipx.id, userIds: [t.sara.id] }, t.o.token);
  assert.strictEqual(channel.status, 201, JSON.stringify(channel.data));
  assert.deepStrictEqual([channel.data.name, channel.data.title, channel.data.account.label, channel.data.members.length], ['flipx-orders', '#flipx-orders', 'FlipX', 2]);
  assert.strictEqual((await request('POST', '/api/chat/channels', { name: 'flipx-orders' }, t.ali.token)).status, 409, 'one channel per name');
  const secret = await request('POST', '/api/chat/channels', { name: 'managers', private: true }, t.ali.token);
  assert.strictEqual(secret.status, 201, 'Manage channels makes channels too');

  const tomList = await request('GET', '/api/chat/conversations', undefined, t.tom.token);
  assert.deepStrictEqual(tomList.data.openChannels.map((c) => c.name), ['flipx-orders'], 'the private one is hidden');
  assert.strictEqual((await request('GET', `/api/chat/conversations/${channel.data.id}/messages`, undefined, t.tom.token)).status, 403);
  const joined = await request('POST', `/api/chat/conversations/${channel.data.id}/join`, {}, t.tom.token);
  assert.strictEqual(joined.data.members.length, 3);
  assert.strictEqual((await request('POST', `/api/chat/conversations/${secret.data.id}/join`, {}, t.tom.token)).status, 404);

  // Running a channel: rename, topic, people; members without Manage channels can only leave.
  assert.strictEqual((await request('PATCH', `/api/chat/conversations/${channel.data.id}`, { name: 'x' }, t.tom.token)).status, 403);
  const renamed = await request('PATCH', `/api/chat/conversations/${channel.data.id}`, { name: 'flipx-support', topic: 'Buyers and orders' }, t.ali.token);
  assert.deepStrictEqual([renamed.status, renamed.data.name ?? renamed.data.title], [200, 'flipx-support']);
  const history = await request('GET', `/api/chat/conversations/${channel.data.id}/messages`, undefined, t.o.token);
  assert.deepStrictEqual(history.data.messages.filter((m) => m.kind === 'system').map((m) => m.detail.action), ['created_channel', 'joined', 'renamed', 'topic']);
  assert.strictEqual((await request('DELETE', `/api/chat/conversations/${channel.data.id}/people/${t.sara.id}`, undefined, t.tom.token)).status, 403);
  assert.strictEqual((await request('DELETE', `/api/chat/conversations/${channel.data.id}/people/${t.tom.id}`, undefined, t.tom.token)).status, 204, 'anyone may leave');
  assert.strictEqual((await request('POST', `/api/chat/conversations/${channel.data.id}/people`, { userIds: [t.tom.id] }, t.o.token)).status, 200);

  // Archived: read-only; deleted: gone for everyone.
  await request('PATCH', `/api/chat/conversations/${channel.data.id}`, { archived: true }, t.o.token);
  assert.strictEqual((await request('POST', `/api/chat/conversations/${channel.data.id}/messages`, { body: 'hello?' }, t.sara.token)).status, 400);
  assert.strictEqual((await request('DELETE', `/api/chat/conversations/${channel.data.id}`, undefined, t.sara.token)).status, 403);
  assert.strictEqual((await request('DELETE', `/api/chat/conversations/${channel.data.id}`, undefined, t.o.token)).status, 204);
  assert.strictEqual((await request('GET', `/api/chat/conversations/${channel.data.id}`, undefined, t.sara.token)).status, 404);
  assert.strictEqual((await request('DELETE', `/api/chat/conversations/${group.data.id}`, undefined, t.o.token)).status, 400, 'only channels are deleted');
});

test('messages: cards as far as each person can see, own files only, mentions of people in it, edits by the author, deletes by the author or the owner, search', async () => {
  const t = await setup();
  const orderId = `${crypto.randomInt(10, 99)}-${crypto.randomInt(10000, 99999)}-${crypto.randomInt(10000, 99999)}`;
  await pool.query(`INSERT INTO ebay_orders (connection_id, order_id, created_at, data) VALUES ($1, $2, now(), $3)`, [
    t.flipx.id,
    orderId,
    JSON.stringify({ orderId, checkoutStatus: 'Complete', cancelStatus: 'NotApplicable', total: { amount: 9.5, currency: 'GBP' }, buyerUserId: 'bob', lineItems: [{ itemId: '1', title: 'Blue lamp' }] }),
  ]);
  const group = (await request('POST', '/api/chat/groups', { userIds: [t.sara.id, t.tom.id] }, t.o.token)).data;

  // The owner shares an order: Sara (Orders on FlipX) sees it; Tom sees it's there, nothing more.
  const shared = await request('POST', `/api/chat/conversations/${group.id}/messages`, { body: `@Sara look at ${orderId} please`, mentions: [t.sara.id, crypto.randomUUID()] }, t.o.token);
  assert.strictEqual(shared.status, 201, JSON.stringify(shared.data));
  assert.deepStrictEqual([shared.data.cards[0].kind, shared.data.cards[0].account.label, shared.data.mentions], ['order', 'FlipX', [t.sara.id]], 'only people in it are mentioned');
  const saraView = (await request('GET', `/api/chat/conversations/${group.id}/messages`, undefined, t.sara.token)).data.messages.find((m) => m.id === shared.data.id);
  assert.strictEqual(saraView.cards[0].url, `/accounts/${t.flipx.id}/orders/${orderId}`);
  const tomView = (await request('GET', `/api/chat/conversations/${group.id}/messages`, undefined, t.tom.token)).data.messages.find((m) => m.id === shared.data.id);
  assert.deepStrictEqual(tomView.cards[0], { kind: 'order', id: orderId, key: `order:locked:${orderId}`, locked: true });
  // Tom can't attach what he can't see: it's left off his message.
  const tomSends = await request('POST', `/api/chat/conversations/${group.id}/messages`, { body: 'ok', refs: [{ kind: 'order', id: orderId }] }, t.tom.token);
  assert.deepStrictEqual(tomSends.data.cards, []);

  // Files: your own uploads only.
  const up = await fetch(`${baseUrl}/api/files?purpose=chat`, { method: 'POST', headers: { Authorization: `Bearer ${t.sara.token}`, 'Content-Type': 'text/plain', 'X-File-Name': 'notes.txt' }, body: 'hello' });
  const file = await up.json();
  assert.strictEqual((await request('POST', `/api/chat/conversations/${group.id}/messages`, { fileIds: [file.id] }, t.o.token)).status, 400, "someone else's file");
  const withFile = await request('POST', `/api/chat/conversations/${group.id}/messages`, { fileIds: [file.id], replyToId: shared.data.id }, t.sara.token);
  assert.strictEqual(withFile.status, 201, JSON.stringify(withFile.data));
  assert.deepStrictEqual([withFile.data.files[0].name, withFile.data.replyTo.author.name], ['notes.txt', 'Owen']);
  assert.strictEqual((await request('POST', `/api/chat/conversations/${group.id}/messages`, { body: '   ' }, t.sara.token)).status, 400, 'nothing to send');

  // Edits by the author; the owner may delete anyone's message.
  assert.strictEqual((await request('PATCH', `/api/chat/messages/${shared.data.id}`, { body: 'changed' }, t.sara.token)).status, 403);
  const edited = await request('PATCH', `/api/chat/messages/${shared.data.id}`, { body: 'Actually, nothing to check' }, t.o.token);
  assert.deepStrictEqual([edited.data.body, Boolean(edited.data.editedAt), edited.data.cards], ['Actually, nothing to check', true, []], 'its cards follow the new text');
  assert.strictEqual((await request('DELETE', `/api/chat/messages/${withFile.data.id}`, undefined, t.tom.token)).status, 403);
  assert.strictEqual((await request('DELETE', `/api/chat/messages/${withFile.data.id}`, undefined, t.o.token)).status, 204);
  const after = (await request('GET', `/api/chat/conversations/${group.id}/messages`, undefined, t.tom.token)).data.messages.find((m) => m.id === withFile.data.id);
  assert.deepStrictEqual([after.deleted, after.body, after.files], [true, '', []]);

  // Older pages, and search across your conversations (a file's name too).
  const page = await request('GET', `/api/chat/conversations/${group.id}/messages?limit=2`, undefined, t.o.token);
  assert.deepStrictEqual([page.data.messages.length, page.data.hasMore], [2, true]);
  const older = await request('GET', `/api/chat/conversations/${group.id}/messages?before=${page.data.messages[0].id}&limit=50`, undefined, t.o.token);
  assert.ok(older.data.messages.every((m) => new Date(m.createdAt) <= new Date(page.data.messages[0].createdAt)));
  assert.deepStrictEqual((await request('GET', '/api/chat/search?q=nothing%20to%20check', undefined, t.tom.token)).data.results.map((r) => r.message.id), [shared.data.id]);
  assert.deepStrictEqual((await request('GET', '/api/chat/search?q=nothing', undefined, t.ali.token)).data.results, [], "Ali isn't in that group");
});

test('pushes: everyone in it but the sender, not while reading it, never when muted, mentions-only when asked, the bell keeping one line per conversation, silent in quiet hours', async () => {
  const t = await setup();
  const calls = [];
  const real = notificationsService.notifyGrouped;
  mock.method(notificationsService, 'notifyGrouped', async (input) => {
    calls.push(input);
    return real({ ...input, push: null });
  });
  try {
    const channel = (await request('POST', '/api/chat/channels', { name: `team-${crypto.randomInt(1e6)}`, userIds: [t.sara.id, t.tom.id, t.ali.id] }, t.o.token)).data;
    // Tom is reading it; Ali muted it; Sara wants mentions only (in her settings).
    await request('POST', '/api/me/presence', { tabId: 'tom-tab', view: `chat:${channel.id}`, focused: true }, t.tom.token);
    await request('PUT', `/api/chat/conversations/${channel.id}/notify`, { notify: 'none' }, t.ali.token);
    await request('PUT', '/api/chat/settings', { chat: 'mentions' }, t.sara.token);

    await request('POST', `/api/chat/conversations/${channel.id}/messages`, { body: 'Morning all' }, t.o.token);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(calls, [], 'nobody: Tom is reading, Ali muted it, Sara only wants mentions');

    // Her open bell hears each change on her live stream: a line added, a line read.
    const bellEvents = [];
    const stopBell = userEvents.subscribe(t.sara.id, (e) => e.type === 'notifications.changed' && bellEvents.push(e));
    const look = (await request('POST', `/api/chat/conversations/${channel.id}/messages`, { body: '@Sara can you look?', mentions: [t.sara.id] }, t.o.token)).data;
    assert.ok(await until(() => calls.length === 1));
    assert.ok(await until(() => bellEvents.length === 1), 'the bell is told a line was added');
    // Named in it: says so, and opens the conversation at that message.
    assert.deepStrictEqual(
      [calls[0].userId, calls[0].title, calls[0].body, calls[0].url, calls[0].push.tag],
      [t.sara.id, `Owen mentioned you in #${channel.name}`, '@Sara can you look?', `/inbox?c=${channel.id}&m=${look.id}`, `chat-${channel.id}`]
    );

    // Her lock screen shows no text once she hides it; quiet hours keep the bell but send nothing.
    await request('PUT', '/api/chat/settings', { chat: 'all', hideText: true, quietFrom: 0, quietTo: 1439, timeZone: 'Europe/London' }, t.sara.token);
    const settings = (await request('GET', '/api/chat/settings', undefined, t.sara.token)).data;
    assert.deepStrictEqual([settings.chat, settings.hideText, settings.quietFrom], ['all', true, 0]);
    await request('POST', `/api/chat/conversations/${channel.id}/messages`, { body: 'Second one' }, t.o.token);
    assert.ok(await until(() => calls.length === 2));
    assert.deepStrictEqual([calls[1].body, calls[1].push], ['New message from Owen', null]);
    // One bell line for the conversation, counting up; read when she opens it.
    const { rows } = await pool.query(`SELECT detail, read_at FROM notifications WHERE user_id = $1 AND kind = 'chat.message'`, [t.sara.id]);
    assert.deepStrictEqual([rows.length, rows[0].detail.count], [1, 2]);
    const beforeRead = bellEvents.length;
    await request('POST', `/api/chat/conversations/${channel.id}/read`, {}, t.sara.token);
    assert.ok((await pool.query(`SELECT read_at FROM notifications WHERE user_id = $1 AND kind = 'chat.message'`, [t.sara.id])).rows[0].read_at);
    assert.strictEqual(bellEvents.length, beforeRead + 1, 'and told when it was read');
    stopBell();
    assert.strictEqual((await request('PUT', '/api/chat/settings', { quietFrom: 60, quietTo: null }, t.sara.token)).status, 400);
  } finally {
    mock.restoreAll();
  }
});


test("threads, as Slack's: replies beside the conversation (one can also go to it), the first message's count and who replied, followers told and their Threads view, read and unfollowed", async () => {
  const t = await setup();
  const calls = [];
  const real = notificationsService.notifyGrouped;
  mock.method(notificationsService, 'notifyGrouped', async (input) => {
    calls.push(input);
    return real({ ...input, push: null });
  });
  try {
    const channel = (await request('POST', '/api/chat/channels', { name: `refunds-${crypto.randomInt(1e6)}`, userIds: [t.sara.id, t.tom.id] }, t.o.token)).data;
    const base = `/api/chat/conversations/${channel.id}`;
    const root = (await request('POST', `${base}/messages`, { body: 'Who handles the FlipX refunds?' }, t.o.token)).data;
    await until(() => calls.length >= 2);
    calls.length = 0;

    // Sara answers in the thread: not in the conversation, its first message now says one reply, by her.
    const reply = await request('POST', `${base}/messages`, { body: 'I do, every morning', threadId: root.id }, t.sara.token);
    assert.strictEqual(reply.status, 201, JSON.stringify(reply.data));
    assert.deepStrictEqual([reply.data.threadId, reply.data.alsoInConversation], [root.id, false]);
    const timeline = (await request('GET', `${base}/messages`, undefined, t.tom.token)).data.messages;
    assert.ok(!timeline.some((m) => m.id === reply.data.id), 'a thread reply stays out of the conversation');
    const first = timeline.find((m) => m.id === root.id);
    assert.deepStrictEqual([first.thread.replyCount, first.thread.people.map((p) => p.name)], [1, ['Sara']]);
    const tomList = (await request('GET', '/api/chat/conversations', undefined, t.tom.token)).data;
    assert.strictEqual(tomList.conversations.find((c) => c.id === channel.id).unread, 1, "Tom's count is the first message only");
    assert.strictEqual(tomList.unread.threads, 0, "he doesn't follow it");

    // The owner started it, so follows it: told (the thread's own link), and it's under his Threads.
    assert.ok(await until(() => calls.length === 1));
    assert.deepStrictEqual(
      [calls[0].userId, calls[0].title, calls[0].url, calls[0].subjectId],
      [t.o.id, `Sara replied in a thread in #${channel.name}`, `/inbox?c=${channel.id}&t=${root.id}&m=${reply.data.id}`, `thread:${root.id}`]
    );
    const mine = (await request('GET', '/api/chat/threads', undefined, t.o.token)).data;
    assert.deepStrictEqual([mine.threads.length, mine.threads[0].root.id, mine.threads[0].unread, mine.threads[0].latest.map((m) => m.body), mine.unread.threads], [1, root.id, 1, ['I do, every morning'], 1]);

    // A reply also sent to the conversation, mentioning Tom: everyone sees it there, and Tom follows the thread now.
    calls.length = 0;
    const loud = await request('POST', `${base}/messages`, { body: '@Tom can you cover Friday?', mentions: [t.tom.id], threadId: root.id, alsoInConversation: true }, t.sara.token);
    assert.strictEqual(loud.status, 201);
    // Tom's notification says he was mentioned in a thread and opens the thread at that reply, though it's in the conversation too.
    assert.ok(await until(() => calls.some((c) => c.userId === t.tom.id)));
    const toTom = calls.find((c) => c.userId === t.tom.id);
    assert.deepStrictEqual([toTom.title, toTom.url], [`Sara mentioned you in a thread in #${channel.name}`, `/inbox?c=${channel.id}&t=${root.id}&m=${loud.data.id}`]);
    assert.ok((await request('GET', `${base}/messages`, undefined, t.tom.token)).data.messages.some((m) => m.id === loud.data.id && m.alsoInConversation));
    const tomThreads = (await request('GET', '/api/chat/threads', undefined, t.tom.token)).data;
    assert.deepStrictEqual([tomThreads.threads.length, tomThreads.threads[0].unread], [1, 2]);

    // The whole thread; read; a reply can't start a thread of its own; outsiders see nothing.
    const whole = (await request('GET', `/api/chat/threads/${root.id}`, undefined, t.o.token)).data;
    assert.deepStrictEqual([whole.root.id, whole.replies.map((m) => m.id), whole.following], [root.id, [reply.data.id, loud.data.id], true]);
    const read = await request('POST', `/api/chat/threads/${root.id}/read`, {}, t.o.token);
    assert.strictEqual(read.data.unread.threads, 0);
    assert.strictEqual((await request('POST', `${base}/messages`, { body: 'nested', threadId: reply.data.id }, t.sara.token)).status, 400);
    const group = (await request('POST', '/api/chat/groups', { userIds: [t.sara.id, t.tom.id] }, t.o.token)).data;
    const private_ = (await request('POST', `/api/chat/conversations/${group.id}/messages`, { body: 'just us' }, t.o.token)).data;
    assert.strictEqual((await request('GET', `/api/chat/threads/${private_.id}`, undefined, t.ali.token)).status, 404);

    // The conversation's own Threads (its header): every thread in it, followed or not, the latest reply first.
    const second = (await request('POST', `${base}/messages`, { body: 'Packing tape order?' }, t.o.token)).data;
    await request('POST', `${base}/messages`, { body: 'Ordered', threadId: second.id }, t.tom.token);
    const inChannel = (await request('GET', `${base}/threads`, undefined, t.tom.token)).data;
    assert.deepStrictEqual(
      inChannel.threads.map((x) => [x.root.id, x.root.thread.replyCount, x.following, x.unread]),
      [
        [second.id, 1, true, 0],
        [root.id, 2, true, 2],
      ],
      'his own reply is no news to him; the other has two he has not read'
    );
    const aliView = await request('GET', `${base}/threads`, undefined, t.ali.token);
    assert.strictEqual(aliView.status, 403, 'not in the channel (a public one: join it first), so no threads');
    assert.deepStrictEqual((await request('GET', `/api/chat/conversations/${group.id}/threads`, undefined, t.o.token)).data.threads, [], 'a conversation without threads');

    // Tom stops following: off his Threads (the one he replied to stays), no more counts.
    await request('PUT', `/api/chat/threads/${root.id}/follow`, { following: false }, t.tom.token);
    const after = (await request('GET', '/api/chat/threads', undefined, t.tom.token)).data;
    assert.deepStrictEqual([after.threads.map((x) => x.root.id), after.unread.threads], [[second.id], 0]);
    const unfollowed = (await request('GET', `${base}/threads`, undefined, t.tom.token)).data.threads.find((x) => x.root.id === root.id);
    assert.deepStrictEqual([unfollowed.following, unfollowed.unread], [false, 0], 'still listed in the channel, just not followed');
  } finally {
    mock.restoreAll();
  }
});

test('voice notes: an audio file with its length and the shape of its sound, played in the bubble rather than listed; anything else refused', async () => {
  const t = await setup();
  const dm = (await request('POST', '/api/chat/dm', { userId: t.sara.id }, t.o.token)).data;
  const upload = async (type, name) =>
    (await fetch(`${baseUrl}/api/files?purpose=chat`, { method: 'POST', headers: { Authorization: `Bearer ${t.o.token}`, 'Content-Type': type, 'X-File-Name': name }, body: crypto.randomBytes(2048) })).json();
  const audio = await upload('audio/webm', 'Voice message.webm');
  assert.strictEqual(audio.mime, 'audio/webm');
  const sent = await request('POST', `/api/chat/conversations/${dm.id}/messages`, { fileIds: [audio.id], voice: { fileId: audio.id, durationMs: 4200, peaks: [0.1, 0.8, 1.4, -2] } }, t.o.token);
  assert.strictEqual(sent.status, 201, JSON.stringify(sent.data));
  assert.deepStrictEqual([sent.data.voice.durationMs, sent.data.voice.peaks, sent.data.voice.mime, Boolean(sent.data.voice.url), sent.data.files], [4200, [0.1, 0.8, 1, 0], 'audio/webm', true, []]);
  const list = (await request('GET', '/api/chat/conversations', undefined, t.sara.token)).data;
  assert.strictEqual(list.conversations.find((c) => c.id === dm.id).lastMessage.text, 'Voice message (0:04)');
  // Played in the page: a range of it at a time (Safari asks for one before it plays anything).
  const link = new URL(sent.data.voice.url);
  const part = await fetch(`${baseUrl}${link.pathname}${link.search}`, { headers: { Range: 'bytes=0-9' } });
  assert.deepStrictEqual([part.status, part.headers.get('content-range'), (await part.arrayBuffer()).byteLength], [206, 'bytes 0-9/2048', 10]);
  const text = await upload('text/plain', 'notes.txt');
  assert.strictEqual((await request('POST', `/api/chat/conversations/${dm.id}/messages`, { fileIds: [text.id], voice: { fileId: text.id, durationMs: 1000, peaks: [] } }, t.o.token)).status, 400, 'not audio');
});

test('links to other sites get a preview after sending, shown to everyone in it; eBay links never fetched', async () => {
  const t = await setup();
  mock.method(linkPreview, 'previewsFor', async (body) => (/example\.com/.test(body) ? [{ url: 'https://example.com/guide', title: 'Packing guide', description: 'How to pack it', image: null, site: 'example.com' }] : []));
  try {
    const dm = (await request('POST', '/api/chat/dm', { userId: t.sara.id }, t.o.token)).data;
    const sent = (await request('POST', `/api/chat/conversations/${dm.id}/messages`, { body: 'Read https://example.com/guide first' }, t.o.token)).data;
    let shown = null;
    assert.ok(
      await (async () => {
        const end = Date.now() + 3000;
        while (Date.now() < end) {
          shown = (await request('GET', `/api/chat/conversations/${dm.id}/messages`, undefined, t.sara.token)).data.messages.find((m) => m.id === sent.id);
          if (shown?.links?.length) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      })()
    );
    assert.deepStrictEqual(shown.links.map((l) => [l.title, l.site]), [['Packing guide', 'example.com']]);

    // "Files and links": what was shared, newest first (a file, then the link), not a voice note or plain words; members only.
    const upload = async (type, name) =>
      (await fetch(`${baseUrl}/api/files?purpose=chat`, { method: 'POST', headers: { Authorization: `Bearer ${t.o.token}`, 'Content-Type': type, 'X-File-Name': name }, body: crypto.randomBytes(1024) })).json();
    const doc = await upload('application/pdf', 'Invoice.pdf');
    const withFile = (await request('POST', `/api/chat/conversations/${dm.id}/messages`, { body: 'The invoice', fileIds: [doc.id] }, t.o.token)).data;
    const audio = await upload('audio/webm', 'Voice message.webm');
    await request('POST', `/api/chat/conversations/${dm.id}/messages`, { fileIds: [audio.id], voice: { fileId: audio.id, durationMs: 2000, peaks: [0.5] } }, t.o.token);
    await request('POST', `/api/chat/conversations/${dm.id}/messages`, { body: 'Just words' }, t.o.token);
    const shared = await request('GET', `/api/chat/conversations/${dm.id}/files`, undefined, t.sara.token);
    assert.strictEqual(shared.status, 200);
    assert.deepStrictEqual(
      shared.data.messages.map((m) => [m.id, m.files.map((f) => f.name), m.links.length]),
      [
        [withFile.id, ['Invoice.pdf'], 0],
        [sent.id, [], 1],
      ]
    );
    assert.strictEqual((await request('GET', `/api/chat/conversations/${dm.id}/files`, undefined, t.ali.token)).status, 404, 'not in it, nothing shown');
  } finally {
    mock.restoreAll();
  }
  assert.deepStrictEqual(linkPreview.linksIn('https://www.ebay.co.uk/itm/123456789012 and https://example.com/x and http://localhost:3001/inbox and http://10.0.0.1/a'), ['https://example.com/x']);
});

test('"Discuss with team": a buyer\'s eBay conversation as a card, opening it in that account\'s Inbox for people with the Inbox there, locked for others', async () => {
  const t = await setup();
  await pool.query(
    `INSERT INTO ebay_conversations (connection_id, conversation_id, type, other_party, title, reference_id, latest_preview, latest_at)
     VALUES ($1, 'c-777', 'FROM_MEMBERS', 'and_630713', 'Blue lamp', '358376442432', 'Where is my parcel?', now())`,
    [t.flipx.id]
  );
  const dm = (await request('POST', '/api/chat/dm', { userId: t.sara.id }, t.o.token)).data;
  const sent = await request('POST', `/api/chat/conversations/${dm.id}/messages`, { body: 'Can you take this one?', refs: [{ kind: 'conversation', id: 'c-777', connectionId: t.flipx.id }] }, t.o.token);
  assert.strictEqual(sent.status, 201, JSON.stringify(sent.data));
  const card = sent.data.cards[0];
  assert.deepStrictEqual([card.kind, card.title, card.url, card.account.label], ['conversation', 'Conversation with and_630713', `/accounts/${t.flipx.id}/inbox?e=${t.flipx.id}~c-777`, 'FlipX']);
  const saraSees = (await request('GET', `/api/chat/conversations/${dm.id}/messages`, undefined, t.sara.token)).data.messages.find((m) => m.id === sent.data.id);
  assert.strictEqual(saraSees.cards[0].locked, true, 'Sara has no Inbox on FlipX');
  // A link to it in the text is the same card.
  const linked = await request('POST', `/api/chat/conversations/${dm.id}/messages`, { body: `http://localhost:3001/accounts/${t.flipx.id}/inbox?e=${t.flipx.id}~c-777` }, t.o.token);
  assert.strictEqual(linked.data.cards[0].kind, 'conversation');
});

test("each push says when its line last moved, so an open tab knows a conversation's next message from the one before", async () => {
  const t = await setup();
  const push = require('../../src/modules/notifications/push');
  const sent = [];
  mock.method(push, 'configured', () => true);
  mock.method(push, 'send', async (subscription, payload) => {
    sent.push(payload);
    return { sent: true };
  });
  try {
    await pool.query(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES ($1, $2, 'k', 'a')`, [`https://push.example.com/${crypto.randomUUID()}`, t.o.id]);
    const channel = (await request('POST', '/api/chat/channels', { name: `moves-${crypto.randomInt(1e6)}`, userIds: [t.sara.id] }, t.o.token)).data;
    await request('POST', `/api/chat/conversations/${channel.id}/messages`, { body: 'First' }, t.sara.token);
    assert.ok(await until(() => sent.length === 1));
    await new Promise((r) => setTimeout(r, 20));
    await request('POST', `/api/chat/conversations/${channel.id}/messages`, { body: 'Second' }, t.sara.token);
    assert.ok(await until(() => sent.length === 2));

    const [first, second] = sent.map((p) => (typeof p === 'string' ? JSON.parse(p) : p));
    assert.strictEqual(second.id, first.id, 'one line in the bell for the conversation');
    assert.ok(first.at && second.at && new Date(second.at) > new Date(first.at), 'but it moved: the second message is new to an open tab');
    assert.deepStrictEqual([first.body, second.body], ['First', 'Second']);
  } finally {
    mock.restoreAll();
  }
});

test("a voice note that didn't play gets a fresh link for anyone in its conversation, with what the browser said logged", async () => {
  const t = await setup();
  const logger = require('../../src/utils/logger');
  const logged = [];
  mock.method(logger, 'warn', (message, meta) => logged.push([message, meta]));
  try {
    const dm = (await request('POST', '/api/chat/dm', { userId: t.sara.id }, t.o.token)).data;
    const audio = await (await fetch(`${baseUrl}/api/files?purpose=chat`, { method: 'POST', headers: { Authorization: `Bearer ${t.o.token}`, 'Content-Type': 'audio/mp4', 'X-File-Name': 'Voice message.m4a' }, body: crypto.randomBytes(2048) })).json();
    const sent = (await request('POST', `/api/chat/conversations/${dm.id}/messages`, { fileIds: [audio.id], voice: { fileId: audio.id, durationMs: 3000, peaks: [0.5] } }, t.o.token)).data;

    const res = await fetch(`${baseUrl}/api/chat/messages/${sent.id}/voice?error=${encodeURIComponent('4: DEMUXER_ERROR_COULD_NOT_OPEN')}`, {
      headers: { Authorization: `Bearer ${t.sara.token}`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36' },
    });
    const fresh = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(fresh));
    // The fresh link plays: the note's bytes, as audio.
    const link = new URL(fresh.url);
    const bytes = await fetch(`${baseUrl}${link.pathname}${link.search}`);
    assert.deepStrictEqual([bytes.status, bytes.headers.get('content-type'), (await bytes.arrayBuffer()).byteLength], [200, 'audio/mp4', 2048]);
    assert.deepStrictEqual(
      logged.find(([m]) => m.startsWith('Chat: a voice message')),
      ["Chat: a voice message didn't play, fresh link given", { messageId: sent.id, mime: 'audio/mp4', error: '4: DEMUXER_ERROR_COULD_NOT_OPEN', browser: 'Chrome 143 on Windows' }]
    );
    // When the fresh one didn't play either, that's logged too.
    await request('GET', `/api/chat/messages/${sent.id}/voice?error=3&again=1`, undefined, t.sara.token);
    assert.ok(logged.some(([m, meta]) => m === "Chat: a voice message still didn't play" && meta.error === '3'));

    // Only for people in the conversation, and only for a voice note.
    assert.strictEqual((await request('GET', `/api/chat/messages/${sent.id}/voice?error=4`, undefined, t.tom.token)).status, 404, "Tom isn't in that DM");
    const words = (await request('POST', `/api/chat/conversations/${dm.id}/messages`, { body: 'Just words' }, t.o.token)).data;
    assert.strictEqual((await request('GET', `/api/chat/messages/${words.id}/voice?error=4`, undefined, t.sara.token)).status, 404);
    assert.strictEqual((await request('GET', '/api/chat/messages/not-an-id/voice?error=4', undefined, t.sara.token)).status, 404);
  } finally {
    mock.restoreAll();
  }
});

test("a voice note whose file is gone from the server (a redeploy emptied its disk) says so, and who to ask, instead of a link that can't play", async () => {
  const t = await setup();
  const storage = require('../../src/lib/storage');
  const dm = (await request('POST', '/api/chat/dm', { userId: t.sara.id }, t.o.token)).data;
  const audio = await (await fetch(`${baseUrl}/api/files?purpose=chat`, { method: 'POST', headers: { Authorization: `Bearer ${t.o.token}`, 'Content-Type': 'audio/mp4', 'X-File-Name': 'Voice message.m4a' }, body: crypto.randomBytes(1024) })).json();
  const sent = (await request('POST', `/api/chat/conversations/${dm.id}/messages`, { fileIds: [audio.id], voice: { fileId: audio.id, durationMs: 2000, peaks: [0.5] } }, t.o.token)).data;
  const { rows } = await pool.query('SELECT storage_key FROM files WHERE id = $1', [audio.id]);
  await storage.remove(rows[0].storage_key);

  // The link itself: gone, said plainly, not "Not found".
  const link = new URL(sent.voice.url);
  const bytes = await fetch(`${baseUrl}${link.pathname}${link.search}`);
  assert.strictEqual(bytes.status, 410);
  assert.match((await bytes.json()).error, /no longer on the server/);

  // The player's fresh-link ask: who to ask for it again.
  const fresh = await request('GET', `/api/chat/messages/${sent.id}/voice?error=4`, undefined, t.sara.token);
  assert.deepStrictEqual([fresh.status, fresh.data.error], [410, 'No longer on the server. Ask Owen to send it again.']);
});
