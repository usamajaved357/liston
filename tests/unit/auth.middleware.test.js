const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const config = require('../../src/config');
const userRepository = require('../../src/modules/users/user.repository');
const { requireAuth } = require('../../src/middleware/auth.middleware');

// A sign-in renewed while in use; one that has run out says so (the pages
// go to sign-in on its code); a database hiccup is never a sign-out.

const user = { id: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', role: 'owner', parent_user_id: null, access_status: 'active', deactivated_at: null };
const tokenAt = (secondsAgo, expiresIn = '7d') => jwt.sign({ sub: user.id, email: user.email, iat: Math.floor(Date.now() / 1000) - secondsAgo }, config.jwt.secret, { expiresIn });

function call(token) {
  const req = { headers: { authorization: `Bearer ${token}` } };
  const out = { status: 200, body: null, headers: {}, next: null };
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json(body) {
      out.body = body;
      return this;
    },
    setHeader(name, value) {
      out.headers[name] = value;
    },
  };
  return new Promise((resolve) => {
    const done = (err) => resolve({ ...out, next: err === undefined ? 'next' : err, req });
    const r = requireAuth(req, res, done);
    Promise.resolve(r).then(() => setImmediate(() => resolve({ ...out, req })));
  });
}

test.afterEach(() => mock.restoreAll());

test('a fresh sign-in passes as it is; one over a day old comes back renewed for another week', async () => {
  mock.method(userRepository, 'findRoleInfo', async () => user);
  const fresh = await call(tokenAt(60));
  assert.deepStrictEqual([fresh.next, fresh.req.userId, fresh.headers['X-Liston-Token']], ['next', user.id, undefined]);
  const old = await call(tokenAt(3 * 24 * 3600));
  assert.strictEqual(old.next, 'next');
  const renewed = jwt.verify(old.headers['X-Liston-Token'], config.jwt.secret);
  assert.strictEqual(renewed.sub, user.id);
  assert.ok(renewed.exp * 1000 > Date.now() + 6 * 24 * 3600 * 1000, 'good for about a week from now');
});

test('a sign-in that has run out, or a login removed, ends the session with a code the pages act on', async () => {
  mock.method(userRepository, 'findRoleInfo', async () => user);
  const expired = await call(tokenAt(8 * 24 * 3600, '7d'));
  assert.deepStrictEqual([expired.status, expired.body.code], [401, 'SESSION_ENDED']);
  assert.strictEqual((await call('not-a-token')).body.code, 'SESSION_ENDED');
  mock.restoreAll();
  mock.method(userRepository, 'findRoleInfo', async () => ({ ...user, deactivated_at: new Date() }));
  const removed = await call(tokenAt(60));
  assert.deepStrictEqual([removed.status, removed.body.code, removed.body.error], [401, 'SESSION_ENDED', 'This login has been removed by the account owner.']);
});

test('the database failing is an error to retry, not a sign-out', async () => {
  mock.method(userRepository, 'findRoleInfo', async () => {
    throw new Error('Connection terminated unexpectedly');
  });
  const out = await call(tokenAt(60));
  assert.strictEqual(out.status, 200, 'no 401 written');
  assert.match(String(out.next?.message), /Connection terminated/);
});
