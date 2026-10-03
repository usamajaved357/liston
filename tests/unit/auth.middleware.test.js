const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const config = require('../../src/config');
const workspaceRepository = require('../../src/modules/team/workspace.repository');
const { requireAuth } = require('../../src/middleware/auth.middleware');

// A sign-in renewed while in use; one that has run out says so (the pages
// go to sign-in on its code); a database hiccup is never a sign-out.

const user = { id: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', role: 'owner', access_status: 'active', last_workspace_id: null };
const ownTeam = { ownerId: user.id, own: true, ownerAccessAt: null, accessStatus: 'active' };
const session = { user, teams: [ownTeam] };
const tokenAt = (secondsAgo, expiresIn = '7d') => jwt.sign({ sub: user.id, email: user.email, iat: Math.floor(Date.now() / 1000) - secondsAgo }, config.jwt.secret, { expiresIn });

function call(token, team = null) {
  const req = { headers: { authorization: `Bearer ${token}`, ...(team ? { 'x-liston-workspace': team } : {}) } };
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
  mock.method(workspaceRepository, 'sessionFor', async () => session);
  const fresh = await call(tokenAt(60));
  assert.deepStrictEqual([fresh.next, fresh.req.userId, fresh.headers['X-Liston-Token']], ['next', user.id, undefined]);
  const old = await call(tokenAt(3 * 24 * 3600));
  assert.strictEqual(old.next, 'next');
  const renewed = jwt.verify(old.headers['X-Liston-Token'], config.jwt.secret);
  assert.strictEqual(renewed.sub, user.id);
  assert.ok(renewed.exp * 1000 > Date.now() + 6 * 24 * 3600 * 1000, 'good for about a week from now');
});

test('a sign-in that has run out, or a login removed, ends the session with a code the pages act on', async () => {
  mock.method(workspaceRepository, 'sessionFor', async () => session);
  const expired = await call(tokenAt(8 * 24 * 3600, '7d'));
  assert.deepStrictEqual([expired.status, expired.body.code], [401, 'SESSION_ENDED']);
  assert.strictEqual((await call('not-a-token')).body.code, 'SESSION_ENDED');
  mock.restoreAll();
  // Removed from every team they were in (and no team of their own).
  mock.method(workspaceRepository, 'sessionFor', async () => ({ user: { ...user, role: 'member' }, teams: [] }));
  const removed = await call(tokenAt(60));
  assert.deepStrictEqual([removed.status, removed.body.code, removed.body.error], [401, 'SESSION_ENDED', 'This login has been removed by the workspace owner.']);
});

test('the database failing is an error to retry, not a sign-out', async () => {
  mock.method(workspaceRepository, 'sessionFor', async () => {
    throw new Error('Connection terminated unexpectedly');
  });
  const out = await call(tokenAt(60));
  assert.strictEqual(out.status, 200, 'no 401 written');
  assert.match(String(out.next?.message), /Connection terminated/);
});

test('a login in several teams works in the one the page names, and is refused one it is not in', async () => {
  const other = '00000000-0000-4000-8000-000000000002';
  const third = '00000000-0000-4000-8000-000000000003';
  mock.method(workspaceRepository, 'sessionFor', async () => ({
    user: { ...user, last_workspace_id: other },
    teams: [ownTeam, { ownerId: other, own: false, ownerAccessAt: null, accessStatus: 'active' }, { ownerId: third, own: false, ownerAccessAt: '2026-10-01T00:00:00Z', accessStatus: 'active' }],
  }));
  // No team named: the last one used.
  const last = await call(tokenAt(60));
  assert.deepStrictEqual([last.req.ownerId, last.req.role, last.req.coOwner], [other, 'member', false]);
  const own = await call(tokenAt(60), user.id);
  assert.deepStrictEqual([own.req.ownerId, own.req.role, own.req.ownsTeam], [user.id, 'owner', true]);
  const coOwned = await call(tokenAt(60), third);
  assert.deepStrictEqual([coOwned.req.ownerId, coOwned.req.role, coOwned.req.coOwner], [third, 'owner', true]);
  const gone = await call(tokenAt(60), '00000000-0000-4000-8000-000000000009');
  assert.deepStrictEqual([gone.status, gone.body.code, gone.req.userId], [403, 'TEAM_GONE', undefined]);
});
