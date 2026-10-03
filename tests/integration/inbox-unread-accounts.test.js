const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { addMember } = require('../helpers/members');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');

// The account rail's counts: each eBay account's unread conversations in
// one read, only for the accounts whose messages the person may read, and
// only in the team they're working in.

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

async function owner() {
  const email = `rail-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  return { id: data.user.id, token: data.token };
}

const account = (ownerId, label) =>
  connectionService.createConnection(ownerId, {
    platformKey: 'ebay',
    label,
    credentials: { accessToken: 'token', refreshToken: 'refresh', accessTokenExpiresAt: Date.now() + 3600e3, marketplaceId: 'EBAY_GB' },
  });

async function conversation(connectionId, { type = 'FROM_MEMBERS', status = 'ACTIVE', unread = 1 } = {}) {
  await pool.query(`INSERT INTO ebay_conversations (connection_id, conversation_id, type, status, unread_count) VALUES ($1, $2, $3, $4, $5)`, [connectionId, crypto.randomUUID(), type, status, unread]);
}

test('each account counts its unread buyer and eBay conversations, archived and read ones left out', async () => {
  const usama = await owner();
  const walexo = await account(usama.id, 'Walexo');
  const minsu = await account(usama.id, 'Minsu');
  const quiet = await account(usama.id, 'Quiet');
  await conversation(walexo.id);
  await conversation(walexo.id, { type: 'FROM_EBAY' });
  await conversation(walexo.id, { unread: 0 });
  await conversation(walexo.id, { status: 'ARCHIVE' });
  await conversation(minsu.id, { unread: 4 });
  await conversation(quiet.id, { unread: 0 });

  const res = await request('GET', '/api/inbox/unread', null, usama.token);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.data.accounts, { [walexo.id]: 2, [minsu.id]: 1 });
});

test("a member sees counts only where they have the Inbox, and never another owner's accounts", async () => {
  const usama = await owner();
  const talha = await owner();
  const walexo = await account(usama.id, 'Walexo');
  const minsu = await account(usama.id, 'Minsu');
  const talhas = await account(talha.id, 'Talha store');
  await conversation(walexo.id);
  await conversation(minsu.id);
  await conversation(talhas.id);

  const email = `rail-bilal-${crypto.randomUUID()}@example.com`;
  const added = await addMember(baseUrl, usama.token, { email, name: 'Bilal', password: 'memberpassword123' });
  assert.strictEqual(added.status, 201, JSON.stringify(added.data));
  await request('PUT', `/api/team/members/${added.data.member.id}/permissions`, { permissions: [{ connectionId: walexo.id, feature: 'inbox', allowed: true }] }, usama.token);
  const login = await request('POST', '/api/auth/login', { email, password: 'memberpassword123' });

  const bilal = await request('GET', '/api/inbox/unread', null, login.data.token);
  assert.strictEqual(bilal.status, 200);
  assert.deepStrictEqual(bilal.data.accounts, { [walexo.id]: 1 });

  const others = await request('GET', '/api/inbox/unread', null, talha.token);
  assert.deepStrictEqual(others.data.accounts, { [talhas.id]: 1 });
});
