const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const config = require('../../src/config');
const authService = require('../../src/modules/auth/auth.service');
const userEvents = require('../../src/modules/realtime/user-events');
const { addMember, linkToken } = require('../helpers/members');

// A changed password signs the login out on every device (migration 054,
// users.session_version): from Settings, a reset link, or an email
// confirmed with a password of their own. Every sign-in from before is
// refused at its next request (with reason 'password'), open tabs are told
// on the live channel, and browsers stop getting its notifications.

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
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const PASSWORD = 'sessionpassword123';
const login = (email, password = PASSWORD) => request('POST', '/api/auth/login', { email, password });
const me = (token) => request('GET', '/api/users/me', undefined, token);

async function owner() {
  const email = `sessions-${crypto.randomUUID()}@example.com`;
  const signup = await request('POST', '/api/auth/signup', { email, password: PASSWORD, name: 'Usama' });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [signup.data.user.id]);
  return { id: signup.data.user.id, email };
}

const pushRow = (userId) =>
  pool.query(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES ($1, $2, 'k', 'a')`, [`https://push.example.com/${crypto.randomUUID()}`, userId]);
const pushCount = async (userId) => (await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [userId])).rows[0].n;

function assertSignedOut(res, what) {
  assert.deepStrictEqual([res.status, res.data.code, res.data.reason], [401, 'SESSION_ENDED', 'password'], what);
}

test('changing the password in Settings signs the login out on every device, this one too', async () => {
  const usama = await owner();
  const laptop = (await login(usama.email)).data.token;
  const phone = (await login(usama.email)).data.token;
  await pushRow(usama.id);
  const told = [];
  const stop = userEvents.subscribe(String(usama.id), (event) => told.push(event));

  // A wrong current password changes nothing.
  assert.strictEqual((await request('PATCH', '/api/users/me/password', { currentPassword: 'not-it', newPassword: 'brandnewpass123' }, laptop)).status, 401);
  assert.strictEqual((await me(phone)).status, 200);

  const changed = await request('PATCH', '/api/users/me/password', { currentPassword: PASSWORD, newPassword: 'brandnewpass123' }, laptop);
  assert.strictEqual(changed.status, 200, JSON.stringify(changed.data));
  stop();

  assertSignedOut(await me(laptop), 'the device that changed it');
  assertSignedOut(await me(phone), 'every other device');
  assertSignedOut(await request('GET', '/api/connections', undefined, phone), 'every page, not just the profile');
  assert.deepStrictEqual(told, [{ type: 'session.ended', reason: 'password' }], 'open tabs told at once');
  assert.strictEqual(await pushCount(usama.id), 0, 'no more notifications to signed-out browsers');

  // The new password signs in, and that sign-in works; the old one doesn't.
  assert.strictEqual((await login(usama.email)).status, 401);
  const fresh = await login(usama.email, 'brandnewpass123');
  assert.strictEqual(fresh.status, 200);
  assert.strictEqual((await me(fresh.data.token)).status, 200);
});

test('a password reset from the emailed link signs out every device', async () => {
  const usama = await owner();
  const before = (await login(usama.email)).data.token;
  const { passwordResetToken } = await authService.requestPasswordReset(usama.email);
  assert.strictEqual((await request('POST', '/api/auth/reset-password', { token: passwordResetToken, password: 'resetpassword123' })).status, 200);
  assertSignedOut(await me(before), 'signed in before the reset');
  assert.strictEqual((await me((await login(usama.email, 'resetpassword123')).data.token)).status, 200);
});

test('a member confirming their email with a password of their own signs out whoever used the old one', async () => {
  const talha = await owner();
  const ownerToken = (await login(talha.email)).data.token;
  const added = await addMember(baseUrl, ownerToken, { email: `sessions-ali-${crypto.randomUUID()}@example.com`, name: 'Ali', password: PASSWORD });
  const ali = added.data.member;
  await pool.query('UPDATE users SET email_verified_at = NULL WHERE id = $1', [ali.id]);
  // Someone else signed in with the password the owner knew.
  const elsewhere = (await login(ali.email)).data.token;

  const asked = await request('POST', `/api/team/members/${ali.id}/email`, { email: ali.email }, ownerToken);
  const done = await request('POST', `/api/invites/${linkToken(asked.data.invite.link)}/accept`, { password: 'alisownpassword1' });
  assert.strictEqual(done.status, 200, JSON.stringify(done.data));
  assertSignedOut(await me(elsewhere), 'the old password’s sign-in');
  assertSignedOut(await me(added.data.token), 'and the one from joining');
  assert.strictEqual((await me(done.data.token)).status, 200, 'the sign-in confirming gives works');
  assert.strictEqual((await me(ownerToken)).status, 200, "the owner's own sign-in is untouched");
});

test('sign-ins from before session versions still work until the password first changes', async () => {
  const usama = await owner();
  // A token as Liston issued them before migration 054: no version in it.
  const old = jwt.sign({ sub: usama.id, email: usama.email }, config.jwt.secret, { expiresIn: '1h' });
  assert.strictEqual((await me(old)).status, 200);
  await request('PATCH', '/api/users/me/password', { currentPassword: PASSWORD, newPassword: 'brandnewpass123' }, old);
  assertSignedOut(await me(old), 'ended with the change');
});
