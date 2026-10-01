const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { mock } = require('node:test');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');
const connectionRepository = require('../../src/modules/connections/connection.repository');
const ebayMessage = require('../../src/modules/ebay/api/ebay.message');
const ebayPush = require('../../src/modules/ebay/ebay-push');
const inboxService = require('../../src/modules/inbox/inbox.service');
const userEvents = require('../../src/modules/realtime/user-events');

// The eBay Inbox as team work, with eBay's Message API stood in for (no
// real message reaches a buyer): giving a conversation to someone, Open /
// Waiting / Done, notes only the team sees, eBay's NEW_MESSAGE push read
// in and told to the team's devices, "Message buyer" from an order, each
// member's Inbox figures on their Team page, and their time in Liston.

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
test.afterEach(() => mock.restoreAll());

async function request(method, url, body, token) {
  const res = await fetch(`${baseUrl}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const ago = (m) => new Date(Date.now() - m * 60000).toISOString();

// An owner, an eBay account (its own seller name, so no other test's pushes reach it), Sara with the Inbox there and Tom without.
async function setup() {
  const email = `inbox-team-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  const seller = `seller-${crypto.randomUUID().slice(0, 12)}`;
  const connection = await connectionService.createConnection(data.user.id, {
    platformKey: 'ebay',
    label: 'Walexo',
    credentials: { accessToken: 'token', refreshToken: 'refresh', accessTokenExpiresAt: Date.now() + 3600e3, scopes: [inboxService.SCOPE], marketplaceId: 'EBAY_GB' },
  });
  await connectionRepository.mergeEbaySettings(connection.id, { username: seller, marketplaceId: 'EBAY_GB' });
  const member = async (name, inbox) => {
    const memberEmail = `inbox-team-${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
    const added = await request('POST', '/api/team/members', { email: memberEmail, name, password: 'memberpassword123' }, data.token);
    assert.strictEqual(added.status, 201, JSON.stringify(added.data));
    if (inbox) await request('PUT', `/api/team/members/${added.data.member.id}/permissions`, { permissions: [{ connectionId: connection.id, feature: 'inbox', allowed: true }] }, data.token);
    const login = await request('POST', '/api/auth/login', { email: memberEmail, password: 'memberpassword123' });
    return { id: added.data.member.id, token: login.data.token };
  };
  return { owner: { id: data.user.id, token: data.token }, connection, seller, sara: await member('Sara', true), tom: await member('Tom', false) };
}

const conv = (id, seller, { type = 'FROM_MEMBERS', buyer = 'and_630713', fromSeller = false, text = 'Where is my parcel?', item = '358376442432', at = ago(10), messageId = `${id}-last` } = {}) => ({
  conversationId: id,
  type,
  status: 'ACTIVE',
  title: 'Coconut Oil Squishy Stress Ball',
  referenceId: type === 'FROM_EBAY' ? null : item,
  referenceType: type === 'FROM_EBAY' ? null : 'LISTING',
  unreadCount: fromSeller ? 0 : 1,
  createdAt: ago(5000),
  latestMessage: { messageId, body: text, sender: type === 'FROM_EBAY' ? 'eBay' : fromSeller ? seller : buyer, recipient: fromSeller ? buyer : seller, createdAt: at, media: [] },
});

// eBay's side, changeable as the test goes: `state.buyers` / `state.ebay` / `state.threads`.
function stubEbay(state) {
  const calls = { list: 0, thread: 0, sent: [] };
  mock.method(ebayMessage, 'getConversations', async (token, { type, status }) => {
    calls.list += 1;
    const all = status === 'ARCHIVE' ? [] : type === 'FROM_EBAY' ? state.ebay || [] : state.buyers || [];
    return { conversations: all, total: all.length };
  });
  mock.method(ebayMessage, 'getConversation', async (token, id) => {
    calls.thread += 1;
    const messages = (state.threads || {})[id] || [];
    return { messages, total: messages.length };
  });
  mock.method(ebayMessage, 'updateConversation', async () => {});
  mock.method(ebayMessage, 'sendMessage', async (token, body) => {
    calls.sent.push(body);
    return { messageId: `m-sent-${calls.sent.length}`, conversationId: body.conversationId || state.startedId || null };
  });
  return calls;
}

const notificationsOf = async (userId, kind) => (await pool.query('SELECT title, body, url, subject_id FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY created_at', [userId, kind])).rows;
const activityOf = async (actorId, kind) => (await pool.query('SELECT subject_type, subject_id, title, detail FROM member_activity WHERE actor_user_id = $1 AND kind = $2 ORDER BY created_at', [actorId, kind])).rows;

test('a buyer conversation carries notes only the team sees, and answering it is on the doer\'s record with how long the buyer waited', async () => {
  const t = await setup();
  const state = { buyers: [conv('c1', t.seller)], ebay: [conv('e1', t.seller, { type: 'FROM_EBAY', text: 'Notice' })], threads: { c1: [{ messageId: 'c1-last', body: 'Where is my parcel?', sender: 'and_630713', recipient: t.seller, createdAt: ago(10), media: [] }] } };
  const calls = stubEbay(state);
  const base = `/api/connections/${t.connection.id}/inbox`;
  await inboxService.sync(t.connection.id, t.owner.id);

  const opened = await request('GET', `${base}/c1`, undefined, t.sara.token);
  assert.strictEqual(opened.status, 200, JSON.stringify(opened.data));
  assert.deepStrictEqual(opened.data.notes, []);
  assert.strictEqual((await request('POST', `${base}/c1/assign`, { userId: t.sara.id }, t.owner.token)).status, 404, 'no giving conversations to people');
  assert.strictEqual((await request('POST', `${base}/c1/work`, { status: 'done' }, t.owner.token)).status, 404, 'no Open / Waiting / Done');
  assert.strictEqual((await request('POST', `${base}/e1/notes`, { body: 'x' }, t.owner.token)).status, 400, "eBay's own messages take no notes");

  // Notes: the team's only; its writer or the owner deletes one.
  const note = await request('POST', `${base}/c1/notes`, { body: 'Supplier says it ships Friday' }, t.sara.token);
  assert.strictEqual(note.status, 201, JSON.stringify(note.data));
  assert.deepStrictEqual([note.data.note.body, note.data.note.author.name, note.data.note.mine], ['Supplier says it ships Friday', 'Sara', true]);
  const ownersView = await request('GET', `${base}/c1`, undefined, t.owner.token);
  assert.deepStrictEqual(ownersView.data.notes.map((n) => [n.body, n.mine]), [['Supplier says it ships Friday', false]]);
  assert.strictEqual((await request('POST', `${base}/c1/notes`, { body: 'x' }, t.tom.token)).status, 403, 'no Inbox, no notes');
  const ownerNote = await request('POST', `${base}/c1/notes`, { body: 'Refund if not by Monday' }, t.owner.token);
  assert.strictEqual((await request('DELETE', `${base}/c1/notes/${ownerNote.data.note.id}`, undefined, t.sara.token)).status, 403, "not Sara's to delete");
  assert.strictEqual((await request('DELETE', `${base}/c1/notes/${note.data.note.id}`, undefined, t.owner.token)).status, 200, 'the owner may');
  assert.deepStrictEqual((await request('GET', `${base}/c1`, undefined, t.sara.token)).data.notes.map((n) => n.body), ['Refund if not by Monday']);
  assert.strictEqual((await request('POST', `${base}/c1/notes`, { body: '   ' }, t.sara.token)).status, 400);
  assert.strictEqual(calls.sent.length, 0, 'nothing went to the buyer');

  // Sara answers (the buyer had waited about ten minutes).
  const replied = await request('POST', `${base}/c1/messages`, { text: 'It ships Friday, sorry for the wait.' }, t.sara.token);
  assert.strictEqual(replied.status, 201, JSON.stringify(replied.data));
  const [reply] = await activityOf(t.sara.id, 'inbox.replied');
  assert.ok(reply.detail.waitedMinutes >= 9 && reply.detail.waitedMinutes <= 11, `waited ${reply.detail.waitedMinutes}`);

  // Her Team page: buyers answered, messages sent, her reply time; the log opens the chat.
  const overview = await request('GET', `/api/team/members/${t.sara.id}/overview?range=today&tz=UTC`, undefined, t.owner.token);
  assert.strictEqual(overview.status, 200, JSON.stringify(overview.data));
  assert.deepStrictEqual([overview.data.totals.inbox_answered, overview.data.totals.inbox_sent, 'inbox_resolved' in overview.data.totals], [1, 1, false]);
  assert.ok(overview.data.replyTime.median >= 9 && overview.data.replyTime.count === 1);
  const log = await request('GET', `/api/team/members/${t.sara.id}/activity?range=today&tz=UTC&kind=inbox_answered`, undefined, t.owner.token);
  assert.deepStrictEqual(log.data.items.map((i) => [i.kind, i.subjectType, i.subjectId, i.title, i.connectionId]), [['inbox.replied', 'conversation', 'c1', 'and_630713', t.connection.id]]);
});

test("eBay's push of a buyer's message: read in at once, kept so opening reads nothing, the conversation opened again, and each person's devices told by their settings", async () => {
  const t = await setup();
  const state = { buyers: [conv('c1', t.seller, { at: ago(120) })], threads: { c1: [{ messageId: 'c1-last', body: 'Where is my parcel?', sender: 'and_630713', recipient: t.seller, createdAt: ago(120), media: [] }] } };
  const calls = stubEbay(state);
  const base = `/api/connections/${t.connection.id}/inbox`;
  await inboxService.sync(t.connection.id, t.owner.id);
  assert.strictEqual((await notificationsOf(t.owner.id, 'inbox.message')).length, 0, 'the first read is history, not news');
  await request('GET', `${base}/c1`, undefined, t.owner.token);

  // The buyer writes again; Sara is reading that conversation; the owner turned eBay pushes off.
  await pool.query(`INSERT INTO notification_settings (user_id, ebay) VALUES ($1, 'none')`, [t.owner.id]);
  userEvents.setView(String(t.sara.id), 'tab-1', { view: `ebay:${t.connection.id}:c1`, focused: true });
  const at = new Date().toISOString();
  state.buyers = [conv('c1', t.seller, { text: 'Any news?', at, messageId: 'm-2' })];
  const out = await ebayPush.handle({
    metadata: { topic: 'NEW_MESSAGE', schemaVersion: '1.0' },
    notification: { notificationId: 'n-1', publishAttemptCount: 1, data: { messageId: 'm-2', conversationType: 'FROM_MEMBERS', conversationId: 'c1', messageBody: 'Any news?', senderUserName: 'and_630713', recipientUserName: t.seller, createdDate: at } },
  });
  assert.deepStrictEqual([out.handled, out.topic, out.accounts, out.conversationId], [true, 'NEW_MESSAGE', 1, 'c1']);
  await inboxService._flushPushed();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(await notificationsOf(t.owner.id, 'inbox.message'), [], 'eBay pushes off');
  assert.deepStrictEqual(await notificationsOf(t.sara.id, 'inbox.message'), [], 'she was reading it');
  assert.deepStrictEqual(await notificationsOf(t.tom.id, 'inbox.message'), [], 'no Inbox here');

  // Sara stops reading; the buyer writes once more: she's told, with the account and the buyer.
  userEvents.setView(String(t.sara.id), 'tab-1', { view: null });
  const later = new Date(Date.now() + 1000).toISOString();
  state.buyers = [conv('c1', t.seller, { text: 'Hello?', at: later, messageId: 'm-3' })];
  await ebayPush.handle({ metadata: { topic: 'NEW_MESSAGE' }, notification: { notificationId: 'n-2', data: { messageId: 'm-3', conversationType: 'FROM_MEMBERS', conversationId: 'c1', messageBody: 'Hello?', senderUserName: 'and_630713', recipientUserName: t.seller, createdDate: later } } });
  await inboxService._flushPushed();
  await new Promise((r) => setTimeout(r, 50));
  const told = await notificationsOf(t.sara.id, 'inbox.message');
  assert.deepStrictEqual(told.map((n) => [n.title, n.body, n.subject_id]), [['Walexo · and_630713', 'Hello?', `${t.connection.id}:c1`]]);
  assert.strictEqual(told[0].url, `/accounts/${t.connection.id}/inbox?e=${t.connection.id}~c1`);

  const reopened = await request('GET', `${base}/c1`, undefined, t.sara.token);
  assert.deepStrictEqual(reopened.data.messages.map((m) => m.id), ['c1-last', 'm-2', 'm-3'], 'the pushed messages were kept');
  assert.strictEqual(calls.thread, 1, 'opening it read nothing more from eBay');
  const readNow = await pool.query(`SELECT read_at FROM notifications WHERE user_id = $1 AND kind = 'inbox.message'`, [t.sara.id]);
  assert.ok(readNow.rows[0].read_at, 'opening it reads the bell too');
});

test('"Message buyer" from an order: warnings first, then to the order\'s buyer about its item, in the Inbox and on the sender\'s record', async () => {
  const t = await setup();
  const orderId = '20-15161-78659';
  await pool.query(`INSERT INTO ebay_orders (connection_id, order_id, created_at, data) VALUES ($1, $2, now(), $3)`, [
    t.connection.id,
    orderId,
    JSON.stringify({ orderId, buyerUserId: 'and_630713', lineItems: [{ itemId: '358376442432', title: 'Coconut Oil Squishy' }] }),
  ]);
  const state = { buyers: [], startedId: null };
  const calls = stubEbay(state);
  const base = `/api/connections/${t.connection.id}/inbox`;

  const warned = await request('POST', `${base}/message-buyer`, { orderId, text: 'Email me at a@b.com' }, t.sara.token);
  assert.deepStrictEqual([warned.status, warned.data.sent, warned.data.warnings.length > 0, calls.sent.length], [200, false, true, 0]);
  assert.strictEqual((await request('POST', `${base}/message-buyer`, { orderId: '99-99999-99999', text: 'Hi' }, t.sara.token)).status, 404);
  assert.strictEqual((await request('POST', `${base}/message-buyer`, { orderId, text: 'Hi' }, t.tom.token)).status, 403);

  // eBay makes a conversation for it; the next read finds it.
  state.startedId = 'c-new';
  state.buyers = [conv('c-new', t.seller, { fromSeller: true, text: 'Your parcel left today.', at: new Date().toISOString(), messageId: 'm-sent-1' })];
  const sent = await request('POST', `${base}/message-buyer`, { orderId, text: 'Your parcel left today.' }, t.sara.token);
  assert.strictEqual(sent.status, 201, JSON.stringify(sent.data));
  assert.deepStrictEqual([sent.data.sent, sent.data.conversationId, sent.data.buyer], [true, 'c-new', 'and_630713']);
  assert.deepStrictEqual(calls.sent[0], { buyerUsername: 'and_630713', itemId: '358376442432', text: 'Your parcel left today.' });
  const [record] = await activityOf(t.sara.id, 'inbox.messaged');
  assert.deepStrictEqual([record.subject_type, record.subject_id, record.detail.orderId], ['conversation', 'c-new', orderId]);
});

test("a member's time in Liston: one row a minute (working wins over idle), members only, by day and area on the owner's Team page with what they did", async () => {
  const t = await setup();
  const clock = (token, body) => request('POST', '/api/team/clock', body, token);
  assert.strictEqual((await clock(t.sara.token, { working: false, area: 'orders', connectionId: t.connection.id })).status, 204);
  await clock(t.sara.token, { working: true, area: 'inbox', connectionId: t.connection.id });
  await clock(t.sara.token, { working: false, area: 'listings' });
  const kept = await pool.query(`SELECT working, area, connection_id FROM member_minutes WHERE user_id = $1`, [t.sara.id]);
  assert.deepStrictEqual(kept.rows, [{ working: true, area: 'inbox', connection_id: t.connection.id }], 'two tabs in one minute: one row, working, where she worked');
  await clock(t.owner.token, { working: true, area: 'inbox' });
  assert.strictEqual((await pool.query(`SELECT 1 FROM member_minutes WHERE user_id = $1`, [t.owner.id])).rowCount, 0, "the owner's time isn't kept");
  await clock(t.tom.token, { working: true, area: 'hacking', connectionId: crypto.randomUUID() });
  assert.deepStrictEqual((await pool.query(`SELECT area, connection_id FROM member_minutes WHERE user_id = $1`, [t.tom.id])).rows, [{ area: 'other', connection_id: null }], 'an unknown area, and an account not the owner\'s, kept as nothing in particular');
  assert.strictEqual((await clock(t.sara.token, { working: 'yes', area: 'inbox' })).status, 400);

  // Yesterday: 09:00–10:30 UTC working in Orders with a 20-minute idle stretch, and two dispatches.
  const day = new Date(Date.now() - 24 * 3600e3).toISOString().slice(0, 10);
  const base = Date.parse(`${day}T09:00:00Z`);
  for (let i = 0; i < 90; i += 1) {
    await pool.query(`INSERT INTO member_minutes (user_id, minute, owner_user_id, working, area, connection_id) VALUES ($1, $2, $3, $4, 'orders', $5)`, [t.sara.id, new Date(base + i * 60000), t.owner.id, !(i >= 40 && i < 60), t.connection.id]);
  }
  for (const n of [1, 2]) {
    await pool.query(`INSERT INTO member_activity (owner_user_id, actor_user_id, connection_id, connection_label, kind, subject_type, subject_id, created_at) VALUES ($1, $2, $3, 'Walexo', 'order.dispatched', 'order', $4, $5)`, [t.owner.id, t.sara.id, t.connection.id, `o-${n}`, new Date(base + n * 600000)]);
  }
  const time = await request('GET', `/api/team/members/${t.sara.id}/time?range=7d&tz=UTC`, undefined, t.owner.token);
  assert.strictEqual(time.status, 200, JSON.stringify(time.data));
  assert.deepStrictEqual([time.data.totals.working, time.data.totals.idle, time.data.totals.actions, time.data.totals.daysInListon], [71, 20, 2, 2]);
  const yesterday = time.data.days.find((d) => d.day === day);
  assert.deepStrictEqual(yesterday.spans, [
    { from: 540, to: 580, working: true, area: 'orders' },
    { from: 580, to: 600, working: false, area: 'orders' },
    { from: 600, to: 630, working: true, area: 'orders' },
  ]);
  assert.deepStrictEqual([yesterday.working, yesterday.idle, yesterday.actions], [70, 20, 2]);
  assert.deepStrictEqual(time.data.areas.map((a) => [a.area, a.working, a.idle, a.actions]), [['orders', 70, 20, 2], ['inbox', 1, 0, 0]]);
  assert.strictEqual(time.data.totals.actionsPerHour, Math.round((2 / (71 / 60)) * 10) / 10);
  assert.strictEqual((await request('GET', `/api/team/members/${t.sara.id}/time`, undefined, t.sara.token)).status, 403, "the owner's to see");

  // The Team page: each member's time today, and whether they're in Liston now.
  const team = await request('GET', '/api/team/members?tz=UTC', undefined, t.owner.token);
  const sara = team.data.members.find((m) => m.id === t.sara.id);
  assert.deepStrictEqual([sara.time.working, sara.time.idle, sara.time.inListon], [1, 0, true]);
  // And on her Performance tab, the period's working and idle time.
  const overview = await request('GET', `/api/team/members/${t.sara.id}/overview?range=7d&tz=UTC`, undefined, t.owner.token);
  assert.deepStrictEqual(overview.data.time, { working: 71, idle: 20 });
});
