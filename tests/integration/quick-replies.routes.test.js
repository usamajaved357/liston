const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');
const quickRepliesRepository = require('../../src/modules/inbox/quick-replies.repository');
const rules = require('../../src/modules/inbox/quick-replies');

// Quick replies: an account starts with Liston's set once (deleted ones
// never come back on their own), the owner adds, edits and deletes them,
// anyone with the account's Inbox reads them for the reply box but can't
// change them, and nobody else sees them. Also the sidebar's unread count,
// read without asking eBay.

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

async function owner(label = 'Walexo') {
  const email = `quick-replies-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  const connection = await connectionService.createConnection(data.user.id, {
    platformKey: 'ebay',
    label,
    credentials: { accessToken: 'token', refreshToken: 'refresh', accessTokenExpiresAt: Date.now() + 3600e3, scopes: [], marketplaceId: 'EBAY_GB' },
  });
  return { id: data.user.id, token: data.token, connection, base: `/api/connections/${connection.id}/inbox` };
}

async function member(o, features) {
  const email = `quick-replies-member-${crypto.randomUUID()}@example.com`;
  const added = await request('POST', '/api/team/members', { email, password: 'memberpassword123', name: 'Sara' }, o.token);
  await request('PUT', `/api/team/members/${added.data.id || added.data.member?.id}/permissions`, { permissions: features.map((feature) => ({ connectionId: o.connection.id, feature, allowed: true })) }, o.token);
  return (await request('POST', '/api/auth/login', { email, password: 'memberpassword123' })).data.token;
}

test("an account starts with Liston's quick replies once, and the owner adds, edits and deletes their own", async () => {
  const o = await owner();
  const first = await request('GET', `${o.base}/quick-replies`, undefined, o.token);
  assert.strictEqual(first.status, 200, JSON.stringify(first.data));
  assert.deepStrictEqual(first.data.replies.map((r) => r.name), rules.STARTERS.map((r) => r.name), "Liston's set, in its order");
  assert.match(first.data.replies[0].body, /^Hi \{buyer\},/);
  assert.deepStrictEqual(first.data.tokens.map((t) => t.key), ['buyer', 'username', 'item', 'order', 'carrier', 'tracking', 'delivery']);
  assert.strictEqual(first.data.canEdit, true);
  assert.strictEqual((await request('GET', `${o.base}/quick-replies`, undefined, o.token)).data.replies.length, rules.STARTERS.length, 'given once, not again');

  // A new one goes at the end; its name and text are tidied.
  const added = await request('POST', `${o.base}/quick-replies`, { name: '  Out   of stock ', body: 'Hi {buyer},\r\n\r\nSorry, {item} is out of stock.   \r\n' }, o.token);
  assert.strictEqual(added.status, 201, JSON.stringify(added.data));
  assert.deepStrictEqual([added.data.name, added.data.body], ['Out of stock', 'Hi {buyer},\n\nSorry, {item} is out of stock.']);
  const listed = (await request('GET', `${o.base}/quick-replies`, undefined, o.token)).data.replies;
  assert.strictEqual(listed[listed.length - 1].id, added.data.id);

  // Edited; a name and a message are both needed.
  const saved = await request('PUT', `${o.base}/quick-replies/${added.data.id}`, { name: 'Back soon', body: 'Hi {buyer}, {item} is back next week (order {order}).' }, o.token);
  assert.deepStrictEqual([saved.status, saved.data.name], [200, 'Back soon']);
  assert.strictEqual((await request('PUT', `${o.base}/quick-replies/${added.data.id}`, { name: ' ', body: 'x' }, o.token)).status, 400);
  assert.strictEqual((await request('POST', `${o.base}/quick-replies`, { name: 'Empty', body: '   ' }, o.token)).status, 400);
  assert.strictEqual((await request('PUT', `${o.base}/quick-replies/${crypto.randomUUID()}`, { name: 'x', body: 'y' }, o.token)).status, 404);
  assert.strictEqual((await request('DELETE', `${o.base}/quick-replies/not-an-id`, undefined, o.token)).status, 404);

  // Every one deleted: the list stays empty (Liston's set doesn't come back by itself).
  for (const r of (await request('GET', `${o.base}/quick-replies`, undefined, o.token)).data.replies) {
    assert.strictEqual((await request('DELETE', `${o.base}/quick-replies/${r.id}`, undefined, o.token)).status, 200);
  }
  assert.deepStrictEqual((await request('GET', `${o.base}/quick-replies`, undefined, o.token)).data.replies, []);

  // Up to 100 an account.
  await quickRepliesRepository.add(o.connection.id, Array.from({ length: rules.MAX_PER_ACCOUNT }, (_, i) => ({ name: `Reply ${i}`, body: 'Hi' })));
  const over = await request('POST', `${o.base}/quick-replies`, { name: 'One more', body: 'Hi' }, o.token);
  assert.strictEqual(over.status, 400);
  assert.match(over.data.error, /up to 100/);
});

test("a member with the account's Inbox uses the quick replies but can't change them; others can't see them", async () => {
  const o = await owner();
  const sara = await member(o, ['inbox']);
  const read = await request('GET', `${o.base}/quick-replies`, undefined, sara);
  assert.strictEqual(read.status, 200, JSON.stringify(read.data));
  assert.strictEqual(read.data.canEdit, false);
  assert.strictEqual(read.data.replies.length, rules.STARTERS.length);
  assert.strictEqual((await request('POST', `${o.base}/quick-replies`, { name: 'Mine', body: 'Hi' }, sara)).status, 403);
  assert.strictEqual((await request('PUT', `${o.base}/quick-replies/${read.data.replies[0].id}`, { name: 'Mine', body: 'Hi' }, sara)).status, 403);
  assert.strictEqual((await request('DELETE', `${o.base}/quick-replies/${read.data.replies[0].id}`, undefined, sara)).status, 403);

  const tom = await member(o, ['orders']);
  assert.strictEqual((await request('GET', `${o.base}/quick-replies`, undefined, tom)).status, 403, 'no Inbox on the account');

  const stranger = await owner('Elsewhere');
  assert.strictEqual((await request('GET', `${o.base}/quick-replies`, undefined, stranger.token)).status, 403, "another owner's account");
  assert.strictEqual((await request('DELETE', `${o.base}/quick-replies/${read.data.replies[0].id}`, undefined, stranger.token)).status, 403);
  // An owner's reply id on their own account never reaches another account's reply.
  assert.strictEqual((await request('DELETE', `${stranger.base}/quick-replies/${read.data.replies[0].id}`, undefined, stranger.token)).status, 404);
});

test("the sidebar's unread count: the buyers' and eBay's unread conversations, read without asking eBay", async () => {
  const o = await owner();
  const row = (id, type, unread, status = 'ACTIVE') =>
    pool.query(`INSERT INTO ebay_conversations (connection_id, conversation_id, type, status, other_party, unread_count, latest_at) VALUES ($1, $2, $3, $4, 'buyer', $5, now())`, [o.connection.id, id, type, status, unread]);
  await row('a', 'FROM_MEMBERS', 2);
  await row('b', 'FROM_MEMBERS', 0);
  await row('c', 'FROM_EBAY', 1);
  await row('d', 'FROM_MEMBERS', 3, 'ARCHIVE');
  const got = await request('GET', `${o.base}/unread`, undefined, o.token);
  assert.deepStrictEqual([got.status, got.data], [200, { unread: 2 }], 'conversations, not messages; the archive left out');
  const tom = await member(o, ['orders']);
  assert.strictEqual((await request('GET', `${o.base}/unread`, undefined, tom)).status, 403);
});
