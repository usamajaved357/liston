const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
process.env.NODE_ENV = 'test';
require('dotenv').config();

const config = require('../../src/config');
const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const accessService = require('../../src/modules/auth/access.service');
const connectionService = require('../../src/modules/connections/connection.service');
const { addMember, linkToken } = require('../helpers/members');

let server;
let baseUrl;

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function request(method, path, body, token) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

// The whole point of the gate: a fresh owner can sign up and log in, but
// can't touch connections, listings or team until an admin approves.
test('a new owner is pending and blocked from the app until approved', async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const signup = await request('POST', '/api/auth/signup', { email, password: 'testpassword123', name: 'Pat', accessNote: 'Two offices, eBay UK' });
  assert.strictEqual(signup.status, 201);
  assert.strictEqual(signup.data.user.access_status, 'pending');
  const token = signup.data.token;

  const me = await request('GET', '/api/users/me', null, token);
  assert.strictEqual(me.status, 200, 'own profile stays reachable');
  assert.strictEqual(me.data.user.access_status, 'pending');

  const blocked = await request('GET', '/api/connections', null, token);
  assert.strictEqual(blocked.status, 403);
  assert.match(blocked.data.error, /under review/);
  assert.strictEqual(blocked.data.accessStatus, 'pending');

  // The one-click approve link from the admin email.
  const approve = await request('GET', `/api/auth/access/approve?token=${accessService.decisionToken(signup.data.user.id, 'approve')}`);
  assert.strictEqual(approve.status, 200);
  assert.match(String(approve.data), /Access approved/);

  const allowed = await request('GET', '/api/connections', null, token);
  assert.strictEqual(allowed.status, 200);
});

test('a rejected owner gets a clear refusal, and a login token cannot approve anyone', async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const signup = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  const { token, user } = signup.data;

  // A login JWT has no access-decision purpose — must be refused.
  const misuse = await request('GET', `/api/auth/access/approve?token=${token}`);
  assert.match(String(misuse.data), /didn't work/);

  // Rejecting a pending applicant removes the account entirely — nothing of
  // theirs exists yet, and the address is free to try again later.
  await request('GET', `/api/auth/access/reject?token=${accessService.decisionToken(user.id, 'reject')}`);
  const gone = await request('GET', '/api/users/me', null, token);
  assert.strictEqual(gone.status, 401);
  const again = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  assert.strictEqual(again.status, 201);
});

test('revoking an approved owner keeps their account and data, and it can be restored', async () => {
  const adminEmail = `admin-${crypto.randomUUID()}@example.com`;
  const previous = [...config.adminEmails];
  config.adminEmails.push(adminEmail);
  try {
    const admin = await request('POST', '/api/auth/signup', { email: adminEmail, password: 'testpassword123' });
    const owner = await request('POST', '/api/auth/signup', { email: `test-${crypto.randomUUID()}@example.com`, password: 'testpassword123' });
    const id = owner.data.user.id;

    await request('POST', `/api/auth/access/requests/${id}`, { status: 'active' }, admin.data.token);
    const revoked = await request('POST', `/api/auth/access/requests/${id}`, { status: 'rejected' }, admin.data.token);
    assert.strictEqual(revoked.status, 200);
    assert.strictEqual(revoked.data.user.access_status, 'rejected');
    assert.ok(!revoked.data.user.deleted);

    const blocked = await request('GET', '/api/connections', null, owner.data.token);
    assert.strictEqual(blocked.status, 403);
    assert.match(blocked.data.error, /declined/);

    const list = await request('GET', '/api/auth/access/requests', null, admin.data.token);
    assert.ok(list.data.reviewed.some((r) => r.id === id && r.access_status === 'rejected'));

    const restored = await request('POST', `/api/auth/access/requests/${id}`, { status: 'active' }, admin.data.token);
    assert.strictEqual(restored.data.user.access_status, 'active');
    const undo = await request('POST', `/api/auth/access/requests/${id}`, { status: 'pending' }, admin.data.token);
    assert.strictEqual(undo.status, 400);
  } finally {
    config.adminEmails.length = 0;
    config.adminEmails.push(...previous);
  }
});

test('admin emails are approved at signup and can list pending requests', async () => {
  const adminEmail = `admin-${crypto.randomUUID()}@example.com`;
  const previous = [...config.adminEmails];
  config.adminEmails.push(adminEmail);
  try {
    const admin = await request('POST', '/api/auth/signup', { email: adminEmail, password: 'testpassword123' });
    assert.strictEqual(admin.data.user.access_status, 'active');

    const applicant = `test-${crypto.randomUUID()}@example.com`;
    const pending = await request('POST', '/api/auth/signup', { email: applicant, password: 'testpassword123' });

    const list = await request('GET', '/api/auth/access/requests', null, admin.data.token);
    assert.strictEqual(list.status, 200);
    assert.ok(list.data.requests.some((r) => r.id === pending.data.user.id));

    const nonAdmin = await request('GET', '/api/auth/access/requests', null, pending.data.token);
    assert.strictEqual(nonAdmin.status, 403);

    const decided = await request('POST', `/api/auth/access/requests/${pending.data.user.id}`, { status: 'active' }, admin.data.token);
    assert.strictEqual(decided.status, 200);
    assert.strictEqual(decided.data.user.access_status, 'active');
  } finally {
    config.adminEmails.length = 0;
    config.adminEmails.push(...previous);
  }
});

test('an admin deletes a workspace account: the login, its workspace and everything in it, and the logins only in it', async () => {
  const adminEmail = `admin-${crypto.randomUUID()}@example.com`;
  const previous = [...config.adminEmails];
  config.adminEmails.push(adminEmail);
  try {
    const admin = await request('POST', '/api/auth/signup', { email: adminEmail, password: 'testpassword123' });
    const ownerEmail = `test-${crypto.randomUUID()}@example.com`;
    const owner = await request('POST', '/api/auth/signup', { email: ownerEmail, password: 'testpassword123', teamName: 'Doomed Traders' });
    const ownerId = owner.data.user.id;
    await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [ownerId]);
    const connection = await connectionService.createConnection(ownerId, { platformKey: 'ebay', label: 'Doomed Store', credentials: { accessToken: 'x' } });
    // One member only here, one also in another workspace.
    const only = await addMember(baseUrl, owner.data.token, { email: `test-only-${crypto.randomUUID()}@example.com`, name: 'Only', password: 'testpassword123' });
    const other = await request('POST', '/api/auth/signup', { email: `test-other-${crypto.randomUUID()}@example.com`, password: 'testpassword123' });
    await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [other.data.user.id]);
    const shared = await addMember(baseUrl, other.data.token, { email: `test-shared-${crypto.randomUUID()}@example.com`, name: 'Shared', password: 'testpassword123' });
    const invited = await request('POST', '/api/team/invites', { email: shared.data.member.email }, owner.data.token);
    await request('POST', `/api/invites/${linkToken(invited.data.invite.link)}/accept`, { password: 'testpassword123' });

    const listed = await request('GET', '/api/auth/access/workspaces', null, admin.data.token);
    assert.strictEqual(listed.status, 200);
    const row = listed.data.workspaces.find((w) => w.id === ownerId);
    assert.deepStrictEqual([row.team_name, row.accounts, row.members, row.logins_only_here, row.is_admin], ['Doomed Traders', 1, 2, 1, false]);
    assert.strictEqual(listed.data.workspaces.find((w) => w.email === adminEmail).is_admin, true);
    assert.strictEqual((await request('GET', '/api/auth/access/workspaces', null, owner.data.token)).status, 403, 'admins only');

    // The email typed must be the account's; an admin's account is never deleted here.
    assert.strictEqual((await request('DELETE', `/api/auth/access/accounts/${ownerId}`, { email: 'someone-else@example.com' }, admin.data.token)).status, 400);
    assert.strictEqual((await request('DELETE', `/api/auth/access/accounts/${admin.data.user.id}`, { email: adminEmail }, admin.data.token)).status, 403);
    assert.strictEqual((await request('DELETE', `/api/auth/access/accounts/${ownerId}`, { email: ownerEmail }, other.data.token)).status, 403, 'admins only');

    const gone = await request('DELETE', `/api/auth/access/accounts/${ownerId}`, { email: ownerEmail.toUpperCase() }, admin.data.token);
    assert.deepStrictEqual([gone.status, gone.data.deleted, gone.data.memberLogins], [200, true, 1]);
    const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;
    assert.strictEqual(await count('SELECT count(*)::int AS n FROM users WHERE id = ANY($1::uuid[])', [[ownerId, only.data.member.id]]), 0, 'the owner and the login only in it');
    assert.strictEqual(await count('SELECT count(*)::int AS n FROM connections WHERE id = $1', [connection.id]), 0, 'with its eBay accounts');
    assert.strictEqual(await count('SELECT count(*)::int AS n FROM workspaces WHERE owner_user_id = $1', [ownerId]), 0);
    assert.strictEqual((await request('POST', '/api/auth/login', { email: shared.data.member.email, password: 'testpassword123' })).status, 200, 'a member also elsewhere keeps their login');
    assert.strictEqual((await request('GET', '/api/users/me', null, owner.data.token)).status, 401, 'signed out');
    // The email is free again: a sign-up or an invitation starts fresh.
    assert.strictEqual((await request('POST', '/api/auth/signup', { email: ownerEmail, password: 'testpassword123' })).status, 201);
    assert.strictEqual((await request('DELETE', `/api/auth/access/accounts/${ownerId}`, { email: ownerEmail }, admin.data.token)).status, 404);
  } finally {
    config.adminEmails.length = 0;
    config.adminEmails.push(...previous);
  }
});

test("a workspace's own page for the admin: its owner and dates, and its usage as counts only", async () => {
  const adminEmail = `admin-${crypto.randomUUID()}@example.com`;
  const previous = [...config.adminEmails];
  config.adminEmails.push(adminEmail);
  try {
    const admin = await request('POST', '/api/auth/signup', { email: adminEmail, password: 'testpassword123' });
    const owner = await request('POST', '/api/auth/signup', { email: `test-${crypto.randomUUID()}@example.com`, password: 'testpassword123', name: 'Owen', teamName: 'Owen Retail' });
    const ownerId = owner.data.user.id;
    await pool.query("UPDATE users SET access_status = 'active', access_reviewed_at = now() WHERE id = $1", [ownerId]);
    const gb = await connectionService.createConnection(ownerId, { platformKey: 'ebay', label: 'Owen UK', credentials: { accessToken: 'x' } });
    await connectionService.createConnection(ownerId, { platformKey: 'ebay', label: 'Owen UK 2', credentials: { accessToken: 'x' } });
    const us = await connectionService.createConnection(ownerId, { platformKey: 'ebay', label: 'Owen US', credentials: { accessToken: 'x' } });
    await pool.query(`UPDATE connections SET settings = jsonb_set(coalesce(settings, '{}'), '{ebay}', '{"marketplaceId":"EBAY_US"}') WHERE id = $1`, [us.id]);
    await pool.query("UPDATE connections SET status = 'expired' WHERE id = $1", [gb.id]);
    await addMember(baseUrl, owner.data.token, { email: `test-m-${crypto.randomUUID()}@example.com`, name: 'Mia', password: 'testpassword123' });
    await request('POST', '/api/team/invites', { email: `test-i-${crypto.randomUUID()}@example.com` }, owner.data.token);
    await pool.query(`INSERT INTO ebay_orders (connection_id, order_id, created_at, data) VALUES ($1, 'o-1', now() - interval '2 days', '{}'), ($1, 'o-2', now() - interval '60 days', '{}')`, [gb.id]);

    const res = await request('GET', `/api/auth/access/workspaces/${ownerId}`, null, admin.data.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.data));
    const w = res.data.workspace;
    assert.deepStrictEqual([w.team_name, w.name, w.access_status, w.is_admin], ['Owen Retail', 'Owen', 'active', false]);
    assert.deepStrictEqual(w.people, { members: 1, co_managers: 0, removed: 0, invitations: 1 });
    assert.deepStrictEqual([w.accounts.total, w.accounts.needsAttention], [3, 1]);
    assert.deepStrictEqual(w.accounts.marketplaces.map((m) => [m.id, m.accounts]), [['EBAY_GB', 2], ['EBAY_US', 1]]);
    assert.ok(!JSON.stringify(w).includes('Owen UK'), "never which eBay accounts");
    assert.deepStrictEqual(w.orders, { total: 2, last_30: 1 });
    assert.strictEqual(w.logins_only_here, 1);
    const listed = (await request('GET', '/api/auth/access/workspaces', null, admin.data.token)).data.workspaces.find((x) => x.id === ownerId);
    assert.strictEqual(listed.marketplaces, 2);

    assert.strictEqual((await request('GET', `/api/auth/access/workspaces/${ownerId}`, null, owner.data.token)).status, 403, 'admins only');
    assert.strictEqual((await request('GET', `/api/auth/access/workspaces/${crypto.randomUUID()}`, null, admin.data.token)).status, 404);
  } finally {
    config.adminEmails.length = 0;
    config.adminEmails.push(...previous);
  }
});
