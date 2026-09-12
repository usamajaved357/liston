const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const config = require('../../src/config');
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

test('GET /api/connections/platforms requires auth', async () => {
  const res = await request('GET', '/api/connections/platforms');
  assert.strictEqual(res.status, 401);
});

test('GET /api/connections/platforms lists destination platforms with a connectable flag', async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { token } = await signupAndLogin(email, 'testpassword123');

  const { status, data } = await request('GET', '/api/connections/platforms', undefined, token);
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(data.platforms));

  const ebay = data.platforms.find((p) => p.key === 'ebay');
  assert.ok(ebay, 'expected ebay in the platform list');
  assert.strictEqual(ebay.connectable, true);

  const tiktok = data.platforms.find((p) => p.key === 'tiktok_shop');
  assert.ok(tiktok, 'expected tiktok_shop in the platform list');
  assert.strictEqual(tiktok.connectable, false); // active in the DB, but no connect flow built yet
});

test('GET /api/connections requires auth', async () => {
  const res = await request('GET', '/api/connections');
  assert.strictEqual(res.status, 401);
});

test('GET /api/connections returns an empty list and the plan limit for a fresh account', async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { token } = await signupAndLogin(email, 'testpassword123');

  const { status, data } = await request('GET', '/api/connections', undefined, token);
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(data.connections, []);
  assert.strictEqual(data.maxConnections, 1); // starter plan
});

test('POST /api/connections/ebay/authorize rejects once the plan connection limit is reached', async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { userId, token } = await signupAndLogin(email, 'testpassword123');

  // Starter plan allows 1 connection — simulate a completed OAuth connection
  // directly through the service (the HTTP path only exists via eBay's own
  // redirect, which we can't drive in a test).
  await connectionService.createConnection(userId, {
    platformKey: 'ebay',
    label: 'Existing Store',
    credentials: { accessToken: 'x', refreshToken: 'y', accessTokenExpiresAt: Date.now() + 10000 },
  });

  const { status, data } = await request('POST', '/api/connections/ebay/authorize', { label: 'New Store' }, token);
  assert.strictEqual(status, 403);
  assert.match(data.error, /allows up to 1 connection/);
});

test('POST /api/connections/ebay/authorize returns an authorize URL when under the plan limit', async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { token } = await signupAndLogin(email, 'testpassword123');

  const original = { ...config.ebay };
  Object.assign(config.ebay, { clientId: 'cid', clientSecret: 'csecret', ruName: 'test-runame' });
  try {
    const { status, data } = await request(
      'POST',
      '/api/connections/ebay/authorize',
      { label: 'My Store' },
      token
    );
    assert.strictEqual(status, 200);
    assert.match(data.authorizeUrl, /oauth2\/authorize/);
    assert.match(data.authorizeUrl, /client_id=cid/);
  } finally {
    Object.assign(config.ebay, original);
  }
});

test('POST /api/connections/ebay/authorize validates the label', async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { token } = await signupAndLogin(email, 'testpassword123');

  const { status } = await request('POST', '/api/connections/ebay/authorize', { label: '' }, token);
  assert.strictEqual(status, 400);
});

test('GET /api/connections/:id returns a connection summary without credentials', async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { userId, token } = await signupAndLogin(email, 'testpassword123');

  const created = await connectionService.createConnection(userId, {
    platformKey: 'ebay',
    label: 'My Store',
    credentials: { accessToken: 'super-secret-token' },
  });

  const { status, data } = await request('GET', `/api/connections/${created.id}`, undefined, token);
  assert.strictEqual(status, 200);
  assert.strictEqual(data.connection.label, 'My Store');
  assert.strictEqual(data.connection.platform_key, 'ebay');
  assert.strictEqual(data.connection.credentials, undefined);
  assert.strictEqual(JSON.stringify(data.connection).includes('super-secret-token'), false);
});

test('GET /api/connections/:id refuses another user\'s connection', async () => {
  const emailA = `test-a-${crypto.randomUUID()}@example.com`;
  const emailB = `test-b-${crypto.randomUUID()}@example.com`;
  const { userId: userIdA } = await signupAndLogin(emailA, 'testpassword123');
  const { token: tokenB } = await signupAndLogin(emailB, 'testpassword123');

  const created = await connectionService.createConnection(userIdA, {
    platformKey: 'ebay',
    label: 'Owned by A',
    credentials: { accessToken: 'x' },
  });

  const { status } = await request('GET', `/api/connections/${created.id}`, undefined, tokenB);
  assert.strictEqual(status, 404);
});

test('DELETE /api/connections/:id removes a connection owned by the caller', async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { userId, token } = await signupAndLogin(email, 'testpassword123');

  const connection = await connectionService.createConnection(userId, {
    platformKey: 'ebay',
    label: 'Store to delete',
    credentials: { accessToken: 'x' },
  });

  const del = await request('DELETE', `/api/connections/${connection.id}`, undefined, token);
  assert.strictEqual(del.status, 204);

  const { data } = await request('GET', '/api/connections', undefined, token);
  assert.strictEqual(data.connections.length, 0);
});

test('DELETE /api/connections/:id refuses to delete another user\'s connection', async () => {
  const emailA = `test-a-${crypto.randomUUID()}@example.com`;
  const emailB = `test-b-${crypto.randomUUID()}@example.com`;
  const { userId: userIdA } = await signupAndLogin(emailA, 'testpassword123');
  const { token: tokenB } = await signupAndLogin(emailB, 'testpassword123');

  const connection = await connectionService.createConnection(userIdA, {
    platformKey: 'ebay',
    label: 'Owned by A',
    credentials: { accessToken: 'x' },
  });

  const { status } = await request('DELETE', `/api/connections/${connection.id}`, undefined, tokenB);
  assert.strictEqual(status, 404);
});
