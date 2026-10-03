const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');

// One login in two workspaces, end to end: in Usama's a member with chosen
// areas on chosen accounts (Orders and Inbox on Walexo, Listings on Minsu),
// in Talha's a co-manager. Each workspace answers for itself, through the
// areas' own routes (a refusal is 403; anything else got past the check,
// eBay itself standing in with a fake token), the account rail's unread
// counts, and running the members.

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

async function request(method, path, body, token, workspace = null) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(workspace ? { 'X-Liston-Workspace': workspace } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const PASSWORD = 'scenariopassword123';
const login = (email) => request('POST', '/api/auth/login', { email, password: PASSWORD });

async function owner(name, teamName) {
  const email = `scenario-${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: PASSWORD, name, teamName });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  return { id: data.user.id, email, token: data.token };
}

const account = (ownerId, label) =>
  connectionService.createConnection(ownerId, {
    platformKey: 'ebay',
    label,
    credentials: { accessToken: 'fake', refreshToken: 'fake', accessTokenExpiresAt: Date.now() + 3600e3, marketplaceId: 'EBAY_GB' },
  });

async function unreadConversation(connectionId) {
  await pool.query(`INSERT INTO ebay_conversations (connection_id, conversation_id, type, status, unread_count) VALUES ($1, $2, 'FROM_MEMBERS', 'ACTIVE', 1)`, [connectionId, crypto.randomUUID()]);
}

// Whether an area's route let them in (403 is the only refusal; a fake eBay token may fail after it).
const allowed = (res) => res.status !== 403;

async function scenario() {
  const usama = await owner('Usama', 'Walexo Group');
  const talha = await owner('Talha', 'Talha Traders');
  const walexo = await account(usama.id, 'Walexo');
  const minsu = await account(usama.id, 'Minsu');
  const talhas = await account(talha.id, 'Talha Deals');
  for (const c of [walexo, minsu, talhas]) await unreadConversation(c.id);

  const email = `scenario-bilal-${crypto.randomUUID()}@example.com`;
  const added = await request('POST', '/api/team/members', { email, name: 'Bilal', password: PASSWORD }, usama.token);
  assert.strictEqual(added.status, 201, JSON.stringify(added.data));
  const bilalId = added.data.member.id;
  const granted = await request(
    'PUT',
    `/api/team/members/${bilalId}/permissions`,
    {
      permissions: [
        { connectionId: walexo.id, feature: 'orders', allowed: true },
        { connectionId: walexo.id, feature: 'inbox', allowed: true },
        { connectionId: minsu.id, feature: 'listings', allowed: true },
      ],
    },
    usama.token
  );
  assert.strictEqual(granted.status, 200, JSON.stringify(granted.data));

  const joined = await request('POST', '/api/team/members', { email }, talha.token);
  assert.deepStrictEqual([joined.status, joined.data.existingLogin], [201, true]);
  const coManager = await request('PUT', `/api/team/members/${bilalId}/owner-access`, { ownerAccess: true }, talha.token);
  assert.strictEqual(coManager.status, 200, JSON.stringify(coManager.data));

  const bilal = { id: bilalId, email, token: (await login(email)).data.token };
  return { usama, talha, bilal, walexo, minsu, talhas };
}

test("in one workspace a member with chosen areas on chosen accounts, in the other a co-manager", async () => {
  const { usama, talha, bilal, walexo, minsu, talhas } = await scenario();
  const inUsama = (method, path, body) => request(method, path, body, bilal.token, usama.id);
  const inTalha = (method, path, body) => request(method, path, body, bilal.token, talha.id);

  // Who they are where.
  const meUsama = (await inUsama('GET', '/api/users/me')).data.user;
  assert.deepStrictEqual([meUsama.role, meUsama.owner_access, meUsama.team.id], ['member', false, usama.id]);
  assert.deepStrictEqual(
    meUsama.teams.map((t) => [t.id, t.role]).sort(),
    [
      [usama.id, 'member'],
      [talha.id, 'owner_access'],
    ].sort()
  );
  const meTalha = (await inTalha('GET', '/api/users/me')).data.user;
  assert.deepStrictEqual([meTalha.role, meTalha.owner_access, meTalha.team.id, meTalha.owner.email], ['owner', true, talha.id, talha.email]);

  // Usama's workspace: the two accounts, each with only what was given there.
  const listed = (await inUsama('GET', '/api/connections')).data.connections;
  assert.deepStrictEqual(listed.map((c) => c.id).sort(), [walexo.id, minsu.id].sort());
  const flags = (id, feature) => listed.find((c) => c.id === id).permissions[feature];
  assert.deepStrictEqual([flags(walexo.id, 'orders'), flags(walexo.id, 'inbox'), flags(walexo.id, 'listings')], [true, true, false]);
  assert.deepStrictEqual([flags(minsu.id, 'orders'), flags(minsu.id, 'inbox'), flags(minsu.id, 'listings')], [false, false, true]);

  // …and the areas' own routes agree.
  assert.ok(allowed(await inUsama('GET', `/api/connections/${walexo.id}/orders`)), 'Orders on Walexo');
  assert.strictEqual((await inUsama('GET', `/api/connections/${walexo.id}/inbox/unread`)).status, 200);
  assert.strictEqual((await inUsama('GET', `/api/connections/${walexo.id}/listings/drafts`)).status, 403);
  assert.strictEqual((await inUsama('GET', `/api/connections/${minsu.id}/listings/drafts`)).status, 200);
  assert.strictEqual((await inUsama('GET', `/api/connections/${minsu.id}/orders`)).status, 403);
  assert.strictEqual((await inUsama('GET', `/api/connections/${minsu.id}/inbox/unread`)).status, 403);
  // The rail's unread counts: only where they have the Inbox, only in this workspace.
  assert.deepStrictEqual((await inUsama('GET', '/api/inbox/unread')).data.accounts, { [walexo.id]: 1 });
  // A member doesn't run the workspace here.
  assert.strictEqual((await inUsama('GET', '/api/team/members')).status, 403);
  assert.strictEqual((await inUsama('POST', '/api/team/members', { email: `scenario-x-${crypto.randomUUID()}@example.com`, name: 'X', password: PASSWORD })).status, 403);
  // Talha's account isn't reachable from Usama's workspace.
  assert.strictEqual((await inUsama('GET', `/api/connections/${talhas.id}`)).status, 404);

  // Talha's workspace: everything, as its owner has.
  const theirs = (await inTalha('GET', '/api/connections')).data.connections;
  assert.deepStrictEqual(theirs.map((c) => c.id), [talhas.id]);
  assert.strictEqual((await inTalha('GET', `/api/connections/${talhas.id}/listings/drafts`)).status, 200);
  assert.strictEqual((await inTalha('GET', `/api/connections/${talhas.id}/inbox/unread`)).status, 200);
  assert.ok(allowed(await inTalha('GET', `/api/connections/${talhas.id}/orders`)), 'Orders on Talha Deals');
  assert.deepStrictEqual((await inTalha('GET', '/api/inbox/unread')).data.accounts, { [talhas.id]: 1 });
  // Usama's accounts aren't reachable from Talha's workspace.
  assert.strictEqual((await inTalha('GET', `/api/connections/${walexo.id}`)).status, 404);
  assert.ok([403, 404].includes((await inTalha('GET', `/api/connections/${walexo.id}/inbox/unread`)).status), "Walexo's messages from Talha's workspace");
});

test('a co-manager runs the members, but never makes co-managers, renames or deletes the workspace', async () => {
  const { talha, bilal, talhas } = await scenario();
  const inTalha = (method, path, body) => request(method, path, body, bilal.token, talha.id);

  const members = await inTalha('GET', '/api/team/members');
  assert.strictEqual(members.status, 200);
  const sara = await inTalha('POST', '/api/team/members', { email: `scenario-sara-${crypto.randomUUID()}@example.com`, name: 'Sara', password: PASSWORD });
  assert.strictEqual(sara.status, 201, JSON.stringify(sara.data));
  const saraId = sara.data.member.id;
  assert.strictEqual((await inTalha('PUT', `/api/team/members/${saraId}/permissions`, { permissions: [{ connectionId: talhas.id, feature: 'orders', allowed: true }] })).status, 200);

  assert.strictEqual((await inTalha('PUT', `/api/team/members/${saraId}/owner-access`, { ownerAccess: true })).status, 403);
  assert.strictEqual((await inTalha('PUT', `/api/team/members/${bilal.id}/permissions`, { permissions: [{ connectionId: null, feature: 'orders', allowed: false }] })).status, 403, 'not their own access');
  assert.strictEqual((await inTalha('PUT', '/api/team/name', { name: 'Taken over' })).status, 403);
  assert.strictEqual((await inTalha('DELETE', '/api/team/workspace', { name: 'Talha Traders' })).status, 403);
  assert.strictEqual((await request('GET', '/api/users/me', null, talha.token)).data.user.team.name, 'Talha Traders');
});

test('changes in one workspace never reach the other', async () => {
  const { usama, talha, bilal, walexo, talhas } = await scenario();
  const inUsama = (method, path) => request(method, path, null, bilal.token, usama.id);
  const inTalha = (method, path) => request(method, path, null, bilal.token, talha.id);

  // Usama takes the Inbox on Walexo away: gone there, untouched in Talha's.
  await request('PUT', `/api/team/members/${bilal.id}/permissions`, { permissions: [{ connectionId: walexo.id, feature: 'inbox', allowed: false }] }, usama.token);
  assert.strictEqual((await inUsama('GET', `/api/connections/${walexo.id}/inbox/unread`)).status, 403);
  assert.deepStrictEqual((await inUsama('GET', '/api/inbox/unread')).data.accounts, {});
  assert.strictEqual((await inTalha('GET', `/api/connections/${talhas.id}/inbox/unread`)).status, 200);

  // Talha stops them being a co-manager: a member there with nothing given, Usama's grants unchanged.
  await request('PUT', `/api/team/members/${bilal.id}/owner-access`, { ownerAccess: false }, talha.token);
  const meTalha = (await inTalha('GET', '/api/users/me')).data.user;
  assert.deepStrictEqual([meTalha.role, meTalha.owner_access], ['member', false]);
  assert.strictEqual((await inTalha('GET', '/api/team/members')).status, 403);
  assert.strictEqual((await inTalha('GET', `/api/connections/${talhas.id}/listings/drafts`)).status, 403);
  assert.ok(allowed(await inUsama('GET', `/api/connections/${walexo.id}/orders`)), "Usama's Orders grant stays");

  // Removed from Usama's workspace: they still sign in, straight into Talha's.
  await request('DELETE', `/api/team/members/${bilal.id}`, null, usama.token);
  assert.deepStrictEqual((await inUsama('GET', '/api/connections')).data.code, 'TEAM_GONE');
  const again = await login(bilal.email);
  assert.deepStrictEqual([again.status, again.data.user.team.id], [200, talha.id]);
});
