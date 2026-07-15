const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
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
  return data.token;
}

test('PATCH /api/users/me/password requires the correct current password', async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const token = await signupAndLogin(email, 'oldpassword123');

  const wrong = await request(
    'PATCH',
    '/api/users/me/password',
    { currentPassword: 'notmypassword', newPassword: 'newpassword456' },
    token
  );
  assert.strictEqual(wrong.status, 401);
  assert.strictEqual(wrong.data.error, 'Current password is incorrect');

  const ok = await request(
    'PATCH',
    '/api/users/me/password',
    { currentPassword: 'oldpassword123', newPassword: 'newpassword456' },
    token
  );
  assert.strictEqual(ok.status, 200);

  const loginOld = await request('POST', '/api/auth/login', { email, password: 'oldpassword123' });
  assert.strictEqual(loginOld.status, 401);

  const loginNew = await request('POST', '/api/auth/login', { email, password: 'newpassword456' });
  assert.strictEqual(loginNew.status, 200);
});

test('PATCH /api/users/me/email requires current password, rejects taken emails, and resets verification', async () => {
  const emailA = `test-a-${crypto.randomUUID()}@example.com`;
  const emailB = `test-b-${crypto.randomUUID()}@example.com`;
  const newEmail = `test-new-${crypto.randomUUID()}@example.com`;

  await request('POST', '/api/auth/signup', { email: emailB, password: 'testpassword123' });
  const tokenA = await signupAndLogin(emailA, 'testpassword123');

  const wrongPassword = await request(
    'PATCH',
    '/api/users/me/email',
    { email: newEmail, currentPassword: 'notmypassword' },
    tokenA
  );
  assert.strictEqual(wrongPassword.status, 401);

  const takenEmail = await request(
    'PATCH',
    '/api/users/me/email',
    { email: emailB, currentPassword: 'testpassword123' },
    tokenA
  );
  assert.strictEqual(takenEmail.status, 409);

  const ok = await request(
    'PATCH',
    '/api/users/me/email',
    { email: newEmail, currentPassword: 'testpassword123' },
    tokenA
  );
  assert.strictEqual(ok.status, 200);

  const me = await request('GET', '/api/users/me', undefined, tokenA);
  assert.strictEqual(me.data.user.email, newEmail);
  assert.strictEqual(me.data.user.email_verified_at, null);
});

test('PATCH /api/users/me/password rejects reusing the current password', async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const token = await signupAndLogin(email, 'samepassword123');

  const { status, data } = await request(
    'PATCH',
    '/api/users/me/password',
    { currentPassword: 'samepassword123', newPassword: 'samepassword123' },
    token
  );
  assert.strictEqual(status, 400);
  assert.strictEqual(data.error, 'New password must be different from your current password');
});

test('PATCH /api/users/me/email rejects setting the same email (case-insensitive)', async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const token = await signupAndLogin(email, 'testpassword123');

  const { status, data } = await request(
    'PATCH',
    '/api/users/me/email',
    { email: email.toUpperCase(), currentPassword: 'testpassword123' },
    token
  );
  assert.strictEqual(status, 400);
  assert.strictEqual(data.error, 'New email must be different from your current email');
});

test('account settings endpoints require auth', async () => {
  const email = await request('PATCH', '/api/users/me/email', { email: 'x@example.com', currentPassword: 'a' });
  assert.strictEqual(email.status, 401);

  const password = await request('PATCH', '/api/users/me/password', {
    currentPassword: 'a',
    newPassword: 'newpassword456',
  });
  assert.strictEqual(password.status, 401);
});
