const test = require('node:test');
const assert = require('node:assert');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');

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

async function post(path, body, token) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('login does not enforce the signup password-length rule', async () => {
  const email = `test-${Date.now()}@example.com`;
  await post('/api/auth/signup', { email, password: 'correctpassword123' });

  // Wrong, short password — must fail as bad credentials (401), not a
  // "password must be at least 8 characters" validation error (400).
  const { status, data } = await post('/api/auth/login', { email, password: 'abc' });
  assert.strictEqual(status, 401);
  assert.strictEqual(data.error, 'Invalid email or password');
});

test('signup still enforces the password-length rule', async () => {
  const email = `test-${Date.now()}@example.com`;
  const { status, data } = await post('/api/auth/signup', { email, password: 'short' });
  assert.strictEqual(status, 400);
  assert.match(data.error, /at least 8 characters/);
});

test('DELETE /api/users/me deletes the account and invalidates future logins', async () => {
  const email = `test-${Date.now()}@example.com`;
  const { data: signupData } = await post('/api/auth/signup', { email, password: 'testpassword123' });

  const res = await fetch(`${baseUrl}/api/users/me`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${signupData.token}` },
  });
  assert.strictEqual(res.status, 204);

  const { status, data } = await post('/api/auth/login', { email, password: 'testpassword123' });
  assert.strictEqual(status, 401);
  assert.strictEqual(data.error, 'Invalid email or password');
});

test('DELETE /api/users/me requires auth', async () => {
  const res = await fetch(`${baseUrl}/api/users/me`, { method: 'DELETE' });
  assert.strictEqual(res.status, 401);
});
