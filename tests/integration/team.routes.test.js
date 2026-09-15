const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');

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
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function signupAndLogin(email, password) {
  const { data } = await request('POST', '/api/auth/signup', { email, password });
  return { userId: data.user.id, token: data.token };
}

async function createOwnerWithMemberAndConnection() {
  const ownerEmail = `owner-${crypto.randomUUID()}@example.com`;
  const { userId: ownerId, token: ownerToken } = await signupAndLogin(ownerEmail, 'testpassword123');

  const connection = await connectionService.createConnection(ownerId, {
    platformKey: 'ebay',
    label: 'Team Test Store',
    credentials: { accessToken: 'x' },
  });

  const memberEmail = `member-${crypto.randomUUID()}@example.com`;
  const memberPassword = 'memberpassword123';
  const addRes = await request('POST', '/api/team/members', { email: memberEmail, password: memberPassword }, ownerToken);
  assert.strictEqual(addRes.status, 201);

  const { data: loginData } = await request('POST', '/api/auth/login', { email: memberEmail, password: memberPassword });
  return { ownerId, ownerToken, memberId: addRes.data.member.id, memberToken: loginData.token, connectionId: connection.id };
}

test('POST /api/team/members requires the caller to be an owner', async () => {
  const { memberToken } = await createOwnerWithMemberAndConnection();

  const { status } = await request(
    'POST',
    '/api/team/members',
    { email: `nested-${crypto.randomUUID()}@example.com`, password: 'testpassword123' },
    memberToken
  );
  assert.strictEqual(status, 403);
});

test('a member with no granted permissions sees no connections and gets 403 on the connection directly', async () => {
  const { memberToken, connectionId } = await createOwnerWithMemberAndConnection();

  const list = await request('GET', '/api/connections', undefined, memberToken);
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.data.connections, []);

  const detail = await request('GET', `/api/connections/${connectionId}`, undefined, memberToken);
  assert.strictEqual(detail.status, 403);
});

test('granting a global default feature makes the connection visible with resolved permissions', async () => {
  const { ownerToken, memberId, memberToken, connectionId } = await createOwnerWithMemberAndConnection();

  const grant = await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId: null, feature: 'orders', allowed: true }] },
    ownerToken
  );
  assert.strictEqual(grant.status, 200);

  const list = await request('GET', '/api/connections', undefined, memberToken);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.data.connections.length, 1);
  assert.deepStrictEqual(list.data.connections[0].permissions, {
    orders: true,
    listings: false,
    inbox: false,
    campaigns: false,
  });

  const detail = await request('GET', `/api/connections/${connectionId}`, undefined, memberToken);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.data.connection.permissions.orders, true);
});

test('an ungranted feature 403s even once the connection is visible for another feature', async () => {
  const { ownerToken, memberId, memberToken, connectionId } = await createOwnerWithMemberAndConnection();

  await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId: null, feature: 'orders', allowed: true }] },
    ownerToken
  );

  const policies = await request('GET', `/api/connections/${connectionId}/policies`, undefined, memberToken);
  assert.strictEqual(policies.status, 403); // owner-only, regardless of any feature grant

  const drafts = await request('GET', `/api/connections/${connectionId}/listings/drafts`, undefined, memberToken);
  assert.strictEqual(drafts.status, 403); // 'listings' was never granted
});

test('a connection-scoped override can revoke what the global default grants', async () => {
  const { ownerToken, memberId, memberToken, connectionId } = await createOwnerWithMemberAndConnection();

  await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId: null, feature: 'orders', allowed: true }] },
    ownerToken
  );
  await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId, feature: 'orders', allowed: false }] },
    ownerToken
  );

  const detail = await request('GET', `/api/connections/${connectionId}`, undefined, memberToken);
  // Every other feature is still false, and orders is now overridden false too
  // for this specific connection, so it has zero access and is not visible.
  assert.strictEqual(detail.status, 403);
});

test('PUT permissions with allowed: null clears a connection-scoped override back to the global default', async () => {
  const { ownerToken, memberId, memberToken, connectionId } = await createOwnerWithMemberAndConnection();

  await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId: null, feature: 'orders', allowed: true }] },
    ownerToken
  );
  await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId, feature: 'orders', allowed: false }] },
    ownerToken
  );
  const blocked = await request('GET', `/api/connections/${connectionId}`, undefined, memberToken);
  assert.strictEqual(blocked.status, 403);

  const clear = await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId, feature: 'orders', allowed: null }] },
    ownerToken
  );
  assert.strictEqual(clear.status, 200);
  assert.strictEqual(
    clear.data.permissions.find((p) => p.connection_id === connectionId && p.feature === 'orders'),
    undefined
  );

  const restored = await request('GET', `/api/connections/${connectionId}`, undefined, memberToken);
  assert.strictEqual(restored.status, 200);
  assert.strictEqual(restored.data.connection.permissions.orders, true);
});

test('PUT permissions refuses allowed: null for the global default (no higher fallback to defer to)', async () => {
  const { ownerToken, memberId } = await createOwnerWithMemberAndConnection();

  const res = await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId: null, feature: 'orders', allowed: null }] },
    ownerToken
  );
  assert.strictEqual(res.status, 400);
});

test('PUT permissions refuses a connectionId that does not belong to the owner', async () => {
  const { ownerToken, memberId } = await createOwnerWithMemberAndConnection();
  const otherOwnerEmail = `other-${crypto.randomUUID()}@example.com`;
  const { userId: otherOwnerId } = await signupAndLogin(otherOwnerEmail, 'testpassword123');
  const otherConnection = await connectionService.createConnection(otherOwnerId, {
    platformKey: 'ebay',
    label: 'Someone else\'s store',
    credentials: { accessToken: 'y' },
  });

  const res = await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId: otherConnection.id, feature: 'orders', allowed: true }] },
    ownerToken
  );
  assert.strictEqual(res.status, 404);
});

test('DELETE /api/team/members/:id removes a member and their permissions', async () => {
  const { ownerToken, memberId, memberToken } = await createOwnerWithMemberAndConnection();

  const del = await request('DELETE', `/api/team/members/${memberId}`, undefined, ownerToken);
  assert.strictEqual(del.status, 204);

  const { status } = await request('GET', '/api/connections', undefined, memberToken);
  assert.strictEqual(status, 401); // token now belongs to a deleted user
});
