const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
process.env.NODE_ENV = 'test';
require('dotenv').config();

const config = require('../../src/config');
const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const accessService = require('../../src/modules/auth/access.service');

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

  await request('GET', `/api/auth/access/reject?token=${accessService.decisionToken(user.id, 'reject')}`);
  const blocked = await request('GET', '/api/listings/00000000-0000-0000-0000-000000000000', null, token);
  assert.strictEqual(blocked.status, 403);
  assert.match(blocked.data.error, /declined/);
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
