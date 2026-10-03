const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { addMember } = require('../helpers/members');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');

// Deleting a workspace from Workspace settings: its owner only, typing its
// name. Everything in it goes, and the member logins in no other workspace;
// the owner's login goes too unless they're in another workspace, where it
// carries on as a member's.

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

async function request(method, url, body, token, team = null) {
  const res = await fetch(`${baseUrl}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(team ? { 'X-Liston-Workspace': team } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const PASSWORD = 'testpassword123';
const login = (email) => request('POST', '/api/auth/login', { email, password: PASSWORD });

async function owner(name, teamName) {
  const email = `ws-delete-${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: PASSWORD, name, ...(teamName ? { teamName } : {}) });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  return { id: data.user.id, email, token: data.token };
}

async function member(ownerToken, name, email = `ws-delete-${name.toLowerCase()}-${crypto.randomUUID()}@example.com`) {
  const added = await addMember(baseUrl, ownerToken, { email, name, password: PASSWORD });
  assert.strictEqual(added.status, 201, JSON.stringify(added.data));
  return { id: added.data.member.id, email };
}

const account = (ownerId) =>
  connectionService.createConnection(ownerId, {
    platformKey: 'ebay',
    label: 'Walexo',
    credentials: { accessToken: 'token', refreshToken: 'refresh', accessTokenExpiresAt: Date.now() + 3600e3, marketplaceId: 'EBAY_GB' },
  });

const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;

test('only the workspace owner deletes it, and only by typing its name', async () => {
  const usama = await owner('Usama', 'Walexo Group');
  const bilal = await member(usama.token, 'Bilal');
  await request('PUT', `/api/team/members/${bilal.id}/owner-access`, { ownerAccess: true }, usama.token);
  const bilalLogin = await login(bilal.email);

  const byCoManager = await request('DELETE', '/api/team/workspace', { name: 'Walexo Group' }, bilalLogin.data.token);
  assert.strictEqual(byCoManager.status, 403);

  const wrongName = await request('DELETE', '/api/team/workspace', { name: 'Walexo' }, usama.token);
  assert.strictEqual(wrongName.status, 400);
  assert.match(wrongName.data.error, /Walexo Group/);

  assert.strictEqual(await count('SELECT count(*)::int AS n FROM workspaces WHERE owner_user_id = $1', [usama.id]), 1);
});

test("an owner in no other workspace: the workspace, its accounts and its members' logins go, and their own login with it", async () => {
  const usama = await owner('Usama', 'Walexo Group');
  const talha = await owner('Talha');
  const connection = await account(usama.id);
  const sara = await member(usama.token, 'Sara');
  // Bilal is in Talha's workspace too, so his login stays.
  const bilal = await member(talha.token, 'Bilal');
  await member(usama.token, 'Bilal', bilal.email);

  const res = await request('DELETE', '/api/team/workspace', { name: '  walexo group ' }, usama.token);
  assert.strictEqual(res.status, 200, JSON.stringify(res.data));
  assert.deepStrictEqual(res.data, { loginKept: false });

  assert.strictEqual((await login(usama.email)).status, 401);
  assert.strictEqual((await login(sara.email)).status, 401);
  assert.strictEqual(await count('SELECT count(*)::int AS n FROM connections WHERE id = $1', [connection.id]), 0);

  const bilalNow = await login(bilal.email);
  assert.strictEqual(bilalNow.status, 200);
  assert.strictEqual(bilalNow.data.user.team.id, talha.id);
  const me = await request('GET', '/api/users/me', null, bilalNow.data.token);
  assert.deepStrictEqual(me.data.user.teams.map((t) => t.id), [talha.id]);
});

test("an owner who's in another workspace keeps their login there, a member's from then on", async () => {
  const usama = await owner('Usama', 'Walexo Group');
  const talha = await owner('Talha');
  const connection = await account(usama.id);
  await member(talha.token, 'Usama', usama.email);

  // Joining opened Talha's workspace for them; this is their own.
  const res = await request('DELETE', '/api/team/workspace', { name: 'Walexo Group' }, usama.token, usama.id);
  assert.strictEqual(res.status, 200, JSON.stringify(res.data));
  assert.deepStrictEqual(res.data, { loginKept: true });

  assert.strictEqual(await count('SELECT count(*)::int AS n FROM workspaces WHERE owner_user_id = $1', [usama.id]), 0);
  assert.strictEqual(await count('SELECT count(*)::int AS n FROM connections WHERE id = $1', [connection.id]), 0);

  const again = await login(usama.email);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.data.user.team.id, talha.id);
  assert.strictEqual(again.data.user.role, 'member');
  const me = await request('GET', '/api/users/me', null, again.data.token);
  assert.deepStrictEqual(me.data.user.teams.map((t) => [t.id, t.role]), [[talha.id, 'member']]);
  assert.strictEqual(me.data.user.owns_team, false);

  // Talha's workspace is untouched.
  assert.strictEqual(await count('SELECT count(*)::int AS n FROM workspaces WHERE owner_user_id = $1', [talha.id]), 1);
});
