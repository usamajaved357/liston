const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { addMember, linkToken } = require('../helpers/members');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');

// Teams (migration 051), as Slack's workspaces: one login in several
// owners' teams, each team's access, owner access and removal its own; the
// page names the team it's in (X-Liston-Workspace).

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

async function request(method, path, body, token, team = null) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(team ? { 'X-Liston-Workspace': team } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const password = 'teampassword123';

async function owner(first, teamName) {
  const email = `${first.toLowerCase()}-${crypto.randomUUID()}@example.com`;
  const signup = await request('POST', '/api/auth/signup', { email, password, name: `${first} Example`, ...(teamName ? { teamName } : {}) });
  assert.strictEqual(signup.status, 201, JSON.stringify(signup.data));
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [signup.data.user.id]);
  const connection = await connectionService.createConnection(signup.data.user.id, { platformKey: 'ebay', label: `${first} Store`, credentials: { accessToken: 'x' } });
  return { id: signup.data.user.id, email, token: signup.data.token, connectionId: connection.id, signup: signup.data };
}

const login = (email) => request('POST', '/api/auth/login', { email, password });
const me = (token, team) => request('GET', '/api/users/me', undefined, token, team);
const accounts = async (token, team) => (await request('GET', '/api/connections', undefined, token, team)).data.connections;

// Usama and Talha each run a team; Bilal works in both on one login: new to
// Liston at Usama's invitation, then joining Talha's with that login.
async function twoTeams() {
  const usama = await owner('Usama', 'Usama Retail');
  const talha = await owner('Talha');
  const email = `bilal-${crypto.randomUUID()}@example.com`;
  const added = await addMember(baseUrl, usama.token, { email, name: 'Bilal', password });
  assert.strictEqual(added.status, 201, JSON.stringify(added.data));
  assert.strictEqual(added.data.existingLogin, false);
  const invited = await request('POST', '/api/team/invites', { email }, talha.token);
  assert.strictEqual(invited.status, 201, JSON.stringify(invited.data));
  const joined = await request('POST', `/api/invites/${linkToken(invited.data.invite.link)}/accept`, { password });
  assert.strictEqual(joined.status, 200, JSON.stringify(joined.data));
  const bilal = { id: added.data.member.id, email, token: (await login(email)).data.token };
  return { usama, talha, bilal, invited, joined };
}

test('a team is named at sign-up, or after its owner', async () => {
  const usama = await owner('Usama', '  Usama   Retail ');
  const talha = await owner('Talha');
  assert.strictEqual(usama.signup.user.team.name, 'Usama Retail');
  assert.strictEqual((await me(usama.token)).data.user.team.name, 'Usama Retail');
  assert.strictEqual((await me(talha.token)).data.user.team.name, "Talha's workspace");
  const { rows } = await pool.query(`SELECT name FROM workspaces WHERE owner_user_id = $1`, [talha.id]);
  assert.strictEqual(rows[0].name, "Talha's workspace");
});

test('one login joins a second team from its invitation, with the same email and password', async () => {
  const { usama, talha, bilal, invited, joined } = await twoTeams();
  assert.strictEqual(invited.data.invite.existingLogin, true);
  assert.strictEqual(joined.data.user.id, bilal.id, 'the same login, not a second one');
  assert.strictEqual(joined.data.user.team.id, talha.id, 'signed in, in the team joined');
  // Their password is untouched, and Talha's team appears in their team menu.
  assert.strictEqual((await login(bilal.email)).status, 200);
  const profile = (await me(bilal.token, usama.id)).data.user;
  assert.deepStrictEqual(profile.teams.map((t) => [t.id, t.name, t.role]), [
    [usama.id, 'Usama Retail', 'member'],
    [talha.id, "Talha's workspace", 'member'],
  ]);
  assert.strictEqual(profile.owns_team, false);
  // Invited in the bell wherever they were (not yet in Talha's team), read once they joined.
  const bell = await request('GET', '/api/notifications', undefined, bilal.token, usama.id);
  const told = bell.data.items.find((n) => n.kind === 'team.invited');
  assert.match(told.url, /^\/invite\//);
  assert.ok(told.readAt, 'read: they joined');
  // Talha is told Bilal joined, the link opening his access.
  const talhaBell = await request('GET', '/api/notifications', undefined, talha.token);
  assert.deepStrictEqual(talhaBell.data.items.map((n) => n.kind), ['team.joined']);
  assert.match(talhaBell.data.items[0].url, new RegExp(`^/team/${bilal.id}\\?tab=access`));

  // Inviting them again is refused, as is the owner's own login; the link is used.
  assert.strictEqual((await request('POST', '/api/team/invites', { email: bilal.email }, talha.token)).status, 409);
  assert.strictEqual((await request('POST', '/api/team/invites', { email: talha.email }, talha.token)).status, 400);
  const again = await request('POST', `/api/invites/${linkToken(invited.data.invite.link)}/accept`, { password });
  assert.deepStrictEqual([again.status, again.data.code], [409, 'INVITE_USED']);
});

test("each team's access is its own, and a page works in the team it names", async () => {
  const { usama, talha, bilal } = await twoTeams();
  await request('PUT', `/api/team/members/${bilal.id}/permissions`, { permissions: [{ connectionId: null, feature: 'orders', allowed: true }] }, talha.token);
  await request('PUT', `/api/team/members/${bilal.id}/permissions`, { permissions: [{ connectionId: null, feature: 'listings', allowed: true }] }, usama.token);

  const inTalha = await accounts(bilal.token, talha.id);
  assert.deepStrictEqual(inTalha.map((c) => c.id), [talha.connectionId]);
  assert.strictEqual(inTalha[0].permissions.orders, true);
  assert.strictEqual(inTalha[0].permissions.listings, false, "Usama's grant stays in Usama's team");
  const inUsama = await accounts(bilal.token, usama.id);
  assert.deepStrictEqual(inUsama.map((c) => c.id), [usama.connectionId]);
  assert.deepStrictEqual([inUsama[0].permissions.listings, inUsama[0].permissions.orders], [true, false]);

  // Another team's account isn't reachable from this one, and a team they're not in is refused.
  assert.strictEqual((await request('GET', `/api/connections/${talha.connectionId}`, undefined, bilal.token, usama.id)).status, 404);
  const gone = await request('GET', '/api/connections', undefined, bilal.token, crypto.randomUUID());
  assert.deepStrictEqual([gone.status, gone.data.code], [403, 'TEAM_GONE']);
  // The team an account link belongs to, for opening it from the other team.
  assert.strictEqual((await request('GET', `/api/users/me/team-of?connectionId=${talha.connectionId}`, undefined, bilal.token, usama.id)).data.team.id, talha.id);
  assert.strictEqual((await request('GET', `/api/users/me/team-of?connectionId=${crypto.randomUUID()}`, undefined, bilal.token)).status, 404);
});

test('switching teams is remembered: it opens there next time, at login too', async () => {
  const { usama, talha, bilal } = await twoTeams();
  // The team they joined last is the one they're in.
  assert.strictEqual((await me(bilal.token)).data.user.team.id, talha.id);
  const switched = await request('POST', '/api/users/me/team', { id: usama.id }, bilal.token);
  assert.deepStrictEqual([switched.status, switched.data.team.id, switched.data.team.role], [200, usama.id, 'member']);
  assert.strictEqual((await me(bilal.token)).data.user.team.id, usama.id);
  assert.strictEqual((await login(bilal.email)).data.user.team.id, usama.id);
  assert.strictEqual((await request('POST', '/api/users/me/team', { id: crypto.randomUUID() }, bilal.token)).status, 404);
});

test("owner access is one team's: the owner in Talha's team, a member in Usama's", async () => {
  const { usama, talha, bilal } = await twoTeams();
  await request('PUT', `/api/team/members/${bilal.id}/owner-access`, { ownerAccess: true }, talha.token);
  const inTalha = (await me(bilal.token, talha.id)).data.user;
  assert.deepStrictEqual([inTalha.role, inTalha.owner_access, inTalha.owner.email], ['owner', true, talha.email]);
  assert.strictEqual((await request('GET', '/api/team/members', undefined, bilal.token, talha.id)).status, 200);
  const inUsama = (await me(bilal.token, usama.id)).data.user;
  assert.deepStrictEqual([inUsama.role, inUsama.owner_access], ['member', false]);
  assert.strictEqual((await request('GET', '/api/team/members', undefined, bilal.token, usama.id)).status, 403);
  assert.strictEqual(inUsama.teams.find((t) => t.id === talha.id).role, 'owner_access');
  // Only Talha renames Talha's team, not someone with owner access there.
  assert.strictEqual((await request('PUT', '/api/team/name', { name: 'Taken Over' }, bilal.token, talha.id)).status, 403);
  const renamed = await request('PUT', '/api/team/name', { name: '  Talha Traders ' }, talha.token);
  assert.deepStrictEqual([renamed.status, renamed.data.team.name], [200, 'Talha Traders']);
  assert.strictEqual((await me(bilal.token, usama.id)).data.user.teams.find((t) => t.id === talha.id).name, 'Talha Traders');
  assert.strictEqual((await request('PUT', '/api/team/name', { name: '   ' }, talha.token)).status, 400);
});

test("no owner can change a login that's in another team too; only its person can", async () => {
  const { usama, talha, bilal } = await twoTeams();
  for (const o of [usama, talha]) {
    const moved = await request('POST', `/api/team/members/${bilal.id}/email`, { email: `takenover-${crypto.randomUUID()}@example.com` }, o.token);
    assert.strictEqual(moved.status, 403);
    assert.match(moved.data.error, /only they can change their email/);
  }
  assert.strictEqual((await login(bilal.email)).status, 200, 'the login is unchanged');
  const listed = (await request('GET', '/api/team/members', undefined, usama.token)).data.members.find((m) => m.id === bilal.id);
  assert.strictEqual(listed.shared_login, true);
});

test('removed from one team they keep the other; removed from both they are signed out', async () => {
  const { usama, talha, bilal } = await twoTeams();
  assert.strictEqual((await request('DELETE', `/api/team/members/${bilal.id}`, undefined, usama.token)).status, 204);
  assert.strictEqual((await request('GET', '/api/connections', undefined, bilal.token, usama.id)).data.code, 'TEAM_GONE');
  assert.strictEqual((await request('GET', '/api/connections', undefined, bilal.token, talha.id)).status, 200);
  assert.deepStrictEqual((await me(bilal.token)).data.user.teams.map((t) => t.id), [talha.id]);
  assert.strictEqual((await login(bilal.email)).data.user.team.id, talha.id);
  // Usama's team still lists them, as removed (restorable).
  assert.ok((await request('GET', '/api/team/members', undefined, usama.token)).data.members.find((m) => m.id === bilal.id).deactivated_at);

  assert.strictEqual((await request('DELETE', `/api/team/members/${bilal.id}`, undefined, talha.token)).status, 204);
  const out = await request('GET', '/api/connections', undefined, bilal.token);
  assert.deepStrictEqual([out.status, out.data.code], [401, 'SESSION_ENDED']);
  assert.strictEqual((await login(bilal.email)).status, 403);
  // Restored in Talha's team: back in.
  await request('POST', `/api/team/members/${bilal.id}/restore`, undefined, talha.token);
  assert.strictEqual((await login(bilal.email)).status, 200);
});

test("an owner works in another owner's team as a member there, their own team untouched", async () => {
  const usama = await owner('Usama');
  const talha = await owner('Talha');
  const invited = await request('POST', '/api/team/invites', { email: talha.email }, usama.token);
  assert.strictEqual(invited.data.invite.existingLogin, true);
  // Signed in as Talha, joining needs no password.
  const joined = await request('POST', `/api/invites/${linkToken(invited.data.invite.link)}/accept`, {}, talha.token);
  assert.deepStrictEqual([joined.status, joined.data.user.id], [200, talha.id]);
  const inUsama = (await me(talha.token, usama.id)).data.user;
  assert.deepStrictEqual([inUsama.role, inUsama.owns_team], ['member', true]);
  assert.deepStrictEqual(await accounts(talha.token, usama.id), []);
  assert.strictEqual((await me(talha.token, talha.id)).data.user.role, 'owner');
  // In Usama's team chat Talha is a member, not an owner.
  const people = (await request('GET', '/api/chat/people', undefined, usama.token)).data.people;
  assert.strictEqual(people.find((p) => p.id === talha.id).role, 'member');
  // Usama can't move Talha's own login to another email.
  assert.strictEqual((await request('POST', `/api/team/members/${talha.id}/email`, { email: `takenover-${crypto.randomUUID()}@example.com` }, usama.token)).status, 403);
});

test("an owner's team going takes the logins only in it; those in other teams stay", async () => {
  const { usama, talha, bilal } = await twoTeams();
  const onlyUsama = `only-${crypto.randomUUID()}@example.com`;
  await addMember(baseUrl, usama.token, { email: onlyUsama, password });
  assert.strictEqual((await request('DELETE', '/api/users/me', undefined, usama.token)).status, 204);
  assert.strictEqual((await login(onlyUsama)).status, 401, 'gone with the team');
  const after = await login(bilal.email);
  assert.deepStrictEqual([after.status, after.data.user.team.id], [200, talha.id]);
  assert.deepStrictEqual((await me(bilal.token)).data.user.teams.map((t) => t.id), [talha.id]);
});
