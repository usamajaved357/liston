const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');
const teamRepository = require('../../src/modules/team/team.repository');

// Owner access (migration 050): the owner gives a member everything the
// owner has, and takes it away again. Someone with it runs the rest of the
// team, but never their own login or another with owner access.

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

async function request(method, path, body, token) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function addMember(ownerToken, name) {
  const email = `${name}-${crypto.randomUUID()}@example.com`;
  const password = 'memberpassword123';
  const added = await request('POST', '/api/team/members', { email, name, password }, ownerToken);
  assert.strictEqual(added.status, 201, JSON.stringify(added.data));
  const login = await request('POST', '/api/auth/login', { email, password });
  return { id: added.data.member.id, email, password, token: login.data.token, login: login.data };
}

// An approved owner with an eBay account, and two members with no access yet.
async function team() {
  const ownerEmail = `owner-${crypto.randomUUID()}@example.com`;
  const signup = await request('POST', '/api/auth/signup', { email: ownerEmail, password: 'testpassword123' });
  await pool.query("UPDATE users SET access_status = 'active', name = 'Olive Owner' WHERE id = $1", [signup.data.user.id]);
  const owner = { id: signup.data.user.id, email: ownerEmail, token: signup.data.token };
  const connection = await connectionService.createConnection(owner.id, { platformKey: 'ebay', label: 'Owner Access Store', credentials: { accessToken: 'x' } });
  const partner = await addMember(owner.token, 'partner');
  const worker = await addMember(owner.token, 'worker');
  return { owner, connectionId: connection.id, partner, worker };
}

const giveOwnerAccess = (t, member, on = true) => request('PUT', `/api/team/members/${member.id}/owner-access`, { ownerAccess: on }, t.owner.token);

test('owner access gives a member everything the owner has, and taking it away puts their own access back', async () => {
  const t = await team();

  // Before: no grants, so no accounts and no owner pages.
  assert.deepStrictEqual((await request('GET', '/api/connections', undefined, t.partner.token)).data.connections, []);
  assert.strictEqual((await request('GET', `/api/connections/${t.connectionId}/messages`, undefined, t.partner.token)).status, 403);
  assert.strictEqual((await request('GET', '/api/team/members', undefined, t.partner.token)).status, 403);

  const given = await giveOwnerAccess(t, t.partner);
  assert.strictEqual(given.status, 200, JSON.stringify(given.data));
  assert.ok(given.data.member.owner_access_at);

  // As the owner, on the owner's data: every account (no per-feature map), the owner's settings and the team.
  const list = await request('GET', '/api/connections', undefined, t.partner.token);
  assert.strictEqual(list.data.connections.length, 1);
  assert.strictEqual(list.data.connections[0].permissions, undefined);
  assert.strictEqual((await request('GET', `/api/connections/${t.connectionId}/messages`, undefined, t.partner.token)).status, 200);
  const members = await request('GET', '/api/team/members', undefined, t.partner.token);
  assert.strictEqual(members.status, 200);
  assert.ok(members.data.members.find((m) => m.id === t.partner.id).owner_access_at);
  assert.strictEqual(await teamRepository.resolvePermission(t.partner.id, t.connectionId, 'orders'), true);

  // Their own profile says so, with who the owner is; their next login goes where the owner's does.
  const me = await request('GET', '/api/users/me', undefined, t.partner.token);
  assert.strictEqual(me.data.user.role, 'owner');
  assert.strictEqual(me.data.user.owner_access, true);
  assert.strictEqual(me.data.user.owner.email, t.owner.email);
  assert.strictEqual(me.data.user.email, t.partner.email);
  const relogin = await request('POST', '/api/auth/login', { email: t.partner.email, password: t.partner.password });
  assert.strictEqual(relogin.data.user.role, 'owner');

  // They were told.
  const { rows: told } = await pool.query(`SELECT kind, title FROM notifications WHERE user_id = $1 ORDER BY created_at`, [t.partner.id]);
  assert.deepStrictEqual(told.map((n) => n.kind), ['team.owner_access_given']);
  assert.match(told[0].title, /Olive Owner gave you owner access/);

  // Taken away: back to their own (empty) access from the next request.
  const removed = await giveOwnerAccess(t, t.partner, false);
  assert.strictEqual(removed.status, 200);
  assert.strictEqual(removed.data.member.owner_access_at, null);
  assert.deepStrictEqual((await request('GET', '/api/connections', undefined, t.partner.token)).data.connections, []);
  assert.strictEqual((await request('GET', `/api/connections/${t.connectionId}/messages`, undefined, t.partner.token)).status, 403);
  assert.strictEqual((await request('GET', '/api/users/me', undefined, t.partner.token)).data.user.role, 'member');
  assert.strictEqual(await teamRepository.resolvePermission(t.partner.id, t.connectionId, 'orders'), false);
  const { rows: toldAgain } = await pool.query(`SELECT kind FROM notifications WHERE user_id = $1 ORDER BY created_at`, [t.partner.id]);
  assert.deepStrictEqual(toldAgain.map((n) => n.kind), ['team.owner_access_given', 'team.owner_access_removed']);
});

test('their own access settings are kept through owner access and apply again after it', async () => {
  const t = await team();
  await request('PUT', `/api/team/members/${t.partner.id}/permissions`, { permissions: [{ connectionId: null, feature: 'orders', allowed: true }] }, t.owner.token);
  await giveOwnerAccess(t, t.partner);
  await giveOwnerAccess(t, t.partner, false);
  const list = await request('GET', '/api/connections', undefined, t.partner.token);
  assert.strictEqual(list.data.connections.length, 1);
  assert.strictEqual(list.data.connections[0].permissions.orders, true);
  assert.strictEqual(list.data.connections[0].permissions.listings, false);
});

test('someone with owner access runs the rest of the team', async () => {
  const t = await team();
  await giveOwnerAccess(t, t.partner);

  const added = await request('POST', '/api/team/members', { email: `new-${crypto.randomUUID()}@example.com`, password: 'testpassword123' }, t.partner.token);
  assert.strictEqual(added.status, 201);

  const grant = await request('PUT', `/api/team/members/${t.worker.id}/permissions`, { permissions: [{ connectionId: t.connectionId, feature: 'listings', allowed: true }] }, t.partner.token);
  assert.strictEqual(grant.status, 200);
  assert.strictEqual((await request('PUT', `/api/team/members/${t.worker.id}/password`, { password: 'anotherpassword1' }, t.partner.token)).status, 204);
  assert.strictEqual((await request('DELETE', `/api/team/members/${t.worker.id}`, undefined, t.partner.token)).status, 204);
  assert.strictEqual((await request('POST', `/api/team/members/${t.worker.id}/restore`, undefined, t.partner.token)).status, 204);
  assert.strictEqual((await request('GET', `/api/team/members/${t.worker.id}/overview?range=7d`, undefined, t.partner.token)).status, 200);
});

test('someone with owner access can never change their own login, another with owner access, or who has it', async () => {
  const t = await team();
  await giveOwnerAccess(t, t.partner);
  await giveOwnerAccess(t, t.worker);
  const self = t.partner;
  const other = t.worker;

  for (const target of [self, other]) {
    const perms = await request('PUT', `/api/team/members/${target.id}/permissions`, { permissions: [{ connectionId: null, feature: 'orders', allowed: false }] }, self.token);
    assert.strictEqual(perms.status, 403);
    assert.strictEqual((await request('PUT', `/api/team/members/${target.id}/password`, { password: 'takeoverpass1' }, self.token)).status, 403);
    assert.strictEqual((await request('DELETE', `/api/team/members/${target.id}`, undefined, self.token)).status, 403);
    assert.strictEqual((await request('POST', `/api/team/members/${target.id}/restore`, undefined, self.token)).status, 403);
    assert.strictEqual((await request('PUT', `/api/team/members/${target.id}/owner-access`, { ownerAccess: false }, self.token)).status, 403);
  }
  // Nor give it to a regular member, nor remove their own login.
  const regular = await addMember(t.owner.token, 'regular');
  assert.strictEqual((await request('PUT', `/api/team/members/${regular.id}/owner-access`, { ownerAccess: true }, self.token)).status, 403);
  assert.strictEqual((await request('DELETE', '/api/users/me', undefined, self.token)).status, 403);

  // Nothing changed: both still have owner access and can sign in with their own password.
  const { rows } = await pool.query(`SELECT id, owner_access_at, deactivated_at FROM users WHERE id = ANY($1::uuid[])`, [[self.id, other.id]]);
  assert.ok(rows.every((r) => r.owner_access_at && !r.deactivated_at));
  assert.strictEqual((await request('POST', '/api/auth/login', { email: other.email, password: other.password })).status, 200);

  // The owner still manages both.
  assert.strictEqual((await request('PUT', `/api/team/members/${other.id}/password`, { password: 'ownerresetpass1' }, t.owner.token)).status, 204);
  assert.strictEqual((await request('DELETE', `/api/team/members/${other.id}`, undefined, t.owner.token)).status, 204);
});

test('a removed member is restored before being given owner access, and keeps it through a removal', async () => {
  const t = await team();
  await request('DELETE', `/api/team/members/${t.worker.id}`, undefined, t.owner.token);
  assert.strictEqual((await giveOwnerAccess(t, t.worker)).status, 409);

  await giveOwnerAccess(t, t.partner);
  await request('DELETE', `/api/team/members/${t.partner.id}`, undefined, t.owner.token);
  // Removed: signed out, whatever their access.
  assert.strictEqual((await request('GET', '/api/connections', undefined, t.partner.token)).status, 401);
  await request('POST', `/api/team/members/${t.partner.id}/restore`, undefined, t.owner.token);
  assert.strictEqual((await request('GET', '/api/users/me', undefined, t.partner.token)).data.user.owner_access, true);
});

test("someone with owner access has their time in Liston kept, as a member's", async () => {
  const t = await team();
  await giveOwnerAccess(t, t.partner);
  const clocked = await request('POST', '/api/team/clock', { working: true, area: 'orders', connectionId: t.connectionId }, t.partner.token);
  assert.strictEqual(clocked.status, 204);
  const { rows } = await pool.query(`SELECT owner_user_id, area FROM member_minutes WHERE user_id = $1`, [t.partner.id]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].owner_user_id, t.owner.id);
  // The owner's own isn't.
  await request('POST', '/api/team/clock', { working: true, area: 'orders' }, t.owner.token);
  assert.strictEqual((await pool.query(`SELECT 1 FROM member_minutes WHERE user_id = $1`, [t.owner.id])).rows.length, 0);
});

test('only an owner may give owner access; a regular member is refused', async () => {
  const t = await team();
  assert.strictEqual((await request('PUT', `/api/team/members/${t.worker.id}/owner-access`, { ownerAccess: true }, t.partner.token)).status, 403);
  assert.strictEqual((await request('PUT', `/api/team/members/${t.worker.id}/owner-access`, { ownerAccess: 'yes' }, t.owner.token)).status, 400);
});
