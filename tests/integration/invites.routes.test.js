const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const { addMember, linkToken } = require('../helpers/members');

// Joining a workspace by invitation (invites.service): the person accepts
// from the emailed link — someone new choosing their own name and password,
// someone already on Liston with their login — and a member's login moving
// to a real email once its person confirms it there.

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
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const PASSWORD = 'invitepassword123';
const fresh = (name) => `invite-${name}-${crypto.randomUUID()}@example.com`;
const login = (email, password = PASSWORD) => request('POST', '/api/auth/login', { email, password });

async function owner(name, teamName) {
  const email = fresh(name.toLowerCase());
  const { data } = await request('POST', '/api/auth/signup', { email, password: PASSWORD, name, teamName });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  return { id: data.user.id, email, token: data.token };
}

const invite = (o, body) => request('POST', '/api/team/invites', body, o.token);
const view = (link) => request('GET', `/api/invites/${linkToken(link)}`);
const accept = (link, body, token) => request('POST', `/api/invites/${linkToken(link)}/accept`, body, token);
const members = async (o) => (await request('GET', '/api/team/members', undefined, o.token)).data.members;

test('someone new joins from the link with their own name and password, and the inviter is told', async () => {
  const talha = await owner('Talha', 'Talha Traders');
  const email = fresh('sara');
  const sent = await invite(talha, { email: email.toUpperCase(), name: 'Sara' });
  assert.strictEqual(sent.status, 201, JSON.stringify(sent.data));
  assert.deepStrictEqual([sent.data.invite.email, sent.data.invite.kind, sent.data.invite.existingLogin, sent.data.invite.expired], [email, 'join', false, false]);
  // Nobody joins by being invited: not a member until they accept.
  assert.deepStrictEqual(await members(talha), []);
  assert.deepStrictEqual((await request('GET', '/api/team/invites', undefined, talha.token)).data.invites.map((i) => i.email), [email]);

  const page = await view(sent.data.invite.link);
  assert.deepStrictEqual(
    [page.data.invite.kind, page.data.invite.workspace, page.data.invite.invitedBy, page.data.invite.email, page.data.invite.name, page.data.invite.status],
    ['new', 'Talha Traders', 'Talha', email, 'Sara', 'open']
  );

  const noPassword = await accept(sent.data.invite.link, { name: 'Sara Khan' });
  assert.deepStrictEqual([noPassword.status, noPassword.data.code], [400, 'PASSWORD_NEEDED']);
  const joined = await accept(sent.data.invite.link, { name: 'Sara Khan', password: PASSWORD });
  assert.strictEqual(joined.status, 200, JSON.stringify(joined.data));
  assert.deepStrictEqual([joined.data.user.email, joined.data.user.name, joined.data.user.role, joined.data.user.team.id], [email, 'Sara Khan', 'member', talha.id]);

  // Signed in by joining, and the password is theirs.
  assert.strictEqual((await request('GET', '/api/users/me', undefined, joined.data.token)).data.user.team.id, talha.id);
  assert.strictEqual((await login(email)).status, 200);
  const sara = (await members(talha)).find((m) => m.email === email);
  assert.deepStrictEqual([sara.name, sara.email_confirmed, sara.shared_login, sara.pending_email], ['Sara Khan', true, false, null]);
  const bell = await request('GET', '/api/notifications', undefined, talha.token);
  assert.deepStrictEqual(bell.data.items.map((n) => [n.kind, n.title]), [['team.joined', 'Sara Khan joined Talha Traders']]);

  // Used: the link doesn't work again, and the invitation is off the list.
  assert.deepStrictEqual([(await accept(sent.data.invite.link, { password: PASSWORD })).data.code, (await view(sent.data.invite.link)).data.invite.status], ['INVITE_USED', 'accepted']);
  assert.deepStrictEqual((await request('GET', '/api/team/invites', undefined, talha.token)).data.invites, []);
});

test("an invitation can start them with another member's access", async () => {
  const talha = await owner('Talha');
  const model = await addMember(baseUrl, talha.token, { email: fresh('model'), name: 'Model', password: PASSWORD });
  const grants = [{ connectionId: null, feature: 'orders', allowed: true }, { connectionId: null, feature: 'inbox', allowed: true }];
  await request('PUT', `/api/team/members/${model.data.member.id}/permissions`, { permissions: grants }, talha.token);

  const added = await addMember(baseUrl, talha.token, { email: fresh('copy'), name: 'Copy', password: PASSWORD, sameAs: model.data.member.id });
  assert.strictEqual(added.status, 201, JSON.stringify(added.data));
  const copied = (await members(talha)).find((m) => m.id === added.data.member.id);
  const perms = (await request('GET', `/api/team/members/${copied.id}/permissions`, undefined, talha.token)).data.permissions;
  assert.deepStrictEqual(perms.filter((p) => p.allowed).map((p) => p.feature).sort(), ['inbox', 'orders']);

  // Only someone in the workspace can be copied.
  assert.strictEqual((await invite(talha, { email: fresh('x'), sameAs: crypto.randomUUID() })).status, 400);
});

test('someone already on Liston joins with their password, or signed in, never with a wrong one', async () => {
  const usama = await owner('Usama');
  const talha = await owner('Talha');
  const sent = await invite(talha, { email: usama.email });
  assert.strictEqual(sent.data.invite.existingLogin, true);
  assert.strictEqual((await view(sent.data.invite.link)).data.invite.kind, 'join');

  // Signed in as someone else, it still asks for this login's password.
  const other = await owner('Other');
  assert.deepStrictEqual([(await accept(sent.data.invite.link, {}, other.token)).data.code], ['PASSWORD_NEEDED']);
  const wrong = await accept(sent.data.invite.link, { password: 'not-the-password' });
  assert.deepStrictEqual([wrong.status, wrong.data.code], [401, 'WRONG_PASSWORD']);
  const joined = await accept(sent.data.invite.link, { password: PASSWORD });
  assert.deepStrictEqual([joined.status, joined.data.user.id, joined.data.user.role], [200, usama.id, 'member']);
  assert.ok((await members(talha)).find((m) => m.id === usama.id));
  // Their own workspace and password are untouched.
  assert.strictEqual((await login(usama.email)).status, 200);
  assert.strictEqual((await request('GET', '/api/users/me', undefined, usama.token, usama.id)).data.user.owns_team, true);

  // Joining opened them in Talha's workspace; their own is still theirs to run.
  assert.strictEqual((await request('GET', '/api/users/me', undefined, usama.token)).data.user.team.id, talha.id);

  // Signed in as the invited login: no password needed.
  const bilal = await addMember(baseUrl, usama.token, { email: fresh('bilal'), name: 'Bilal', password: PASSWORD }, { team: usama.id });
  const second = await invite(talha, { email: bilal.data.member.email });
  const signedIn = await accept(second.data.invite.link, {}, bilal.data.token);
  assert.deepStrictEqual([signedIn.status, signedIn.data.user.id], [200, bilal.data.member.id]);
});

test('resending keeps one invitation open for another 7 days; withdrawn or expired links stop working', async () => {
  const talha = await owner('Talha');
  const email = fresh('late');
  const first = await invite(talha, { email });
  // Invited again: the same invitation, sent again.
  const again = await invite(talha, { email });
  assert.deepStrictEqual([again.status, again.data.again, again.data.invite.id], [200, true, first.data.invite.id]);

  await pool.query(`UPDATE workspace_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [first.data.invite.id]);
  assert.strictEqual((await view(first.data.invite.link)).data.invite.status, 'expired');
  assert.deepStrictEqual((await accept(first.data.invite.link, { password: PASSWORD })).data.code, 'INVITE_EXPIRED');
  assert.strictEqual((await request('GET', '/api/team/invites', undefined, talha.token)).data.invites[0].expired, true);

  const resent = await request('POST', `/api/team/invites/${first.data.invite.id}/resend`, undefined, talha.token);
  assert.deepStrictEqual([resent.status, resent.data.invite.expired, resent.data.invite.link], [200, false, first.data.invite.link]);
  const days = (new Date(resent.data.invite.expiresAt) - Date.now()) / 86400e3;
  assert.ok(days > 6.9 && days <= 7, `open ${days} days`);

  assert.strictEqual((await request('DELETE', `/api/team/invites/${first.data.invite.id}`, undefined, talha.token)).status, 204);
  assert.deepStrictEqual((await accept(first.data.invite.link, { password: PASSWORD })).data.code, 'INVITE_REVOKED');
  assert.strictEqual((await request('DELETE', `/api/team/invites/${first.data.invite.id}`, undefined, talha.token)).status, 404);
  // Another workspace can't touch it.
  const usama = await owner('Usama');
  const theirs = await invite(talha, { email: fresh('theirs') });
  assert.strictEqual((await request('DELETE', `/api/team/invites/${theirs.data.invite.id}`, undefined, usama.token)).status, 404);
});

test("a link that isn't one Liston signed is refused", async () => {
  const talha = await owner('Talha');
  const sent = await invite(talha, { email: fresh('forged') });
  const [id, sig] = linkToken(sent.data.invite.link).split('.');
  const forged = `${id}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`;
  for (const token of [forged, `${crypto.randomUUID()}.${sig}`, id, 'nonsense']) {
    const res = await request('GET', `/api/invites/${token}`);
    assert.deepStrictEqual([res.status, res.data.code], [404, 'INVITE_INVALID'], token);
    assert.strictEqual((await request('POST', `/api/invites/${token}/accept`, { password: PASSWORD })).status, 404);
  }
});

test('members and removed members are not invited again, and the old way of adding is gone', async () => {
  const talha = await owner('Talha');
  const sara = await addMember(baseUrl, talha.token, { email: fresh('sara'), name: 'Sara', password: PASSWORD });
  const inAgain = await invite(talha, { email: sara.data.member.email });
  assert.deepStrictEqual([inAgain.status, /already in this workspace/.test(inAgain.data.error)], [409, true]);
  await request('DELETE', `/api/team/members/${sara.data.member.id}`, undefined, talha.token);
  const removed = await invite(talha, { email: sara.data.member.email });
  assert.deepStrictEqual([removed.status, /Restore them/.test(removed.data.error)], [409, true]);
  assert.strictEqual((await invite(talha, { email: talha.email })).status, 400);
  assert.strictEqual((await invite(talha, { email: 'not-an-email' })).status, 400);

  const old = await request('POST', '/api/team/members', { email: fresh('old'), password: PASSWORD }, talha.token);
  assert.strictEqual(old.status, 404);
});

test("a member's login moves to a real email once they confirm it there, with a password of their own", async () => {
  const talha = await owner('Talha', 'Talha Traders');
  // A login from before invitations: an email typed by the owner, never proven.
  const made = await addMember(baseUrl, talha.token, { email: fresh('typed'), name: 'Ali', password: PASSWORD });
  const ali = made.data.member;
  await pool.query('UPDATE users SET email_verified_at = NULL WHERE id = $1', [ali.id]);
  assert.strictEqual((await members(talha)).find((m) => m.id === ali.id).email_confirmed, false);

  const real = fresh('ali-real');
  const asked = await request('POST', `/api/team/members/${ali.id}/email`, { email: real }, talha.token);
  assert.strictEqual(asked.status, 201, JSON.stringify(asked.data));
  assert.deepStrictEqual([asked.data.invite.kind, asked.data.invite.memberId], ['email', ali.id]);
  // Waiting: they still sign in as before, and the Members page shows the change.
  assert.strictEqual((await login(ali.email)).status, 200);
  assert.strictEqual((await members(talha)).find((m) => m.id === ali.id).pending_email, real);
  const page = await view(asked.data.invite.link);
  assert.deepStrictEqual([page.data.invite.kind, page.data.invite.currentEmail, page.data.invite.email], ['email', ali.email, real]);

  // Asked again: the newer address replaces the first.
  const realer = fresh('ali-realer');
  const second = await request('POST', `/api/team/members/${ali.id}/email`, { email: realer }, talha.token);
  assert.deepStrictEqual((await accept(asked.data.invite.link, { password: 'alisownpassword1' })).data.code, 'INVITE_REVOKED');

  assert.deepStrictEqual((await accept(second.data.invite.link, {})).data.code, 'PASSWORD_NEEDED');
  const done = await accept(second.data.invite.link, { password: 'alisownpassword1' });
  assert.deepStrictEqual([done.status, done.data.user.id, done.data.user.email], [200, ali.id, realer]);
  assert.strictEqual((await login(realer, 'alisownpassword1')).status, 200);
  assert.strictEqual((await login(realer)).status, 401, 'the password the owner knew no longer works');
  assert.strictEqual((await login(ali.email, 'alisownpassword1')).status, 401, 'the typed email is gone');
  const after = (await members(talha)).find((m) => m.id === ali.id);
  assert.deepStrictEqual([after.email, after.email_confirmed, after.pending_email], [realer, true, null]);
});

test("an email that's real but never confirmed is confirmed in place: the same address, a password of their own", async () => {
  const talha = await owner('Talha');
  const made = await addMember(baseUrl, talha.token, { email: fresh('real-typed'), name: 'Bilal', password: PASSWORD });
  const bilal = made.data.member;
  await pool.query('UPDATE users SET email_verified_at = NULL WHERE id = $1', [bilal.id]);

  const asked = await request('POST', `/api/team/members/${bilal.id}/email`, { email: bilal.email }, talha.token);
  assert.strictEqual(asked.status, 201, JSON.stringify(asked.data));
  const page = await view(asked.data.invite.link);
  assert.deepStrictEqual([page.data.invite.kind, page.data.invite.currentEmail, page.data.invite.email], ['email', bilal.email, bilal.email]);
  const done = await accept(asked.data.invite.link, { password: 'bilalsownpassword1' });
  assert.deepStrictEqual([done.status, done.data.user.email], [200, bilal.email]);
  assert.strictEqual((await login(bilal.email, 'bilalsownpassword1')).status, 200);
  assert.strictEqual((await login(bilal.email)).status, 401, 'the password the owner knew no longer works');
  assert.strictEqual((await members(talha)).find((m) => m.id === bilal.id).email_confirmed, true);
});

test("an email change is refused for a login in another workspace, or an email someone else has", async () => {
  const usama = await owner('Usama');
  const talha = await owner('Talha');
  const bilal = await addMember(baseUrl, usama.token, { email: fresh('bilal'), name: 'Bilal', password: PASSWORD });
  const second = await invite(talha, { email: bilal.data.member.email });
  await accept(second.data.invite.link, { password: PASSWORD });
  const shared = await request('POST', `/api/team/members/${bilal.data.member.id}/email`, { email: fresh('bilal-real') }, talha.token);
  assert.deepStrictEqual([shared.status, /only they can change their email/.test(shared.data.error)], [403, true]);

  const sara = await addMember(baseUrl, talha.token, { email: fresh('sara'), name: 'Sara', password: PASSWORD });
  const taken = await request('POST', `/api/team/members/${sara.data.member.id}/email`, { email: usama.email }, talha.token);
  assert.strictEqual(taken.status, 409);
  // Her email was confirmed by joining: nothing to confirm again.
  const same = await request('POST', `/api/team/members/${sara.data.member.id}/email`, { email: sara.data.member.email }, talha.token);
  assert.deepStrictEqual([same.status, /confirmed this email already/.test(same.data.error)], [400, true]);
  // Someone signing up with the address meanwhile: confirming is refused, nothing changes.
  const later = fresh('sara-real');
  const asked = await request('POST', `/api/team/members/${sara.data.member.id}/email`, { email: later }, talha.token);
  await request('POST', '/api/auth/signup', { email: later, password: PASSWORD });
  const refused = await accept(asked.data.invite.link, { password: 'sarasownpassword1' });
  assert.strictEqual(refused.status, 409);
  assert.strictEqual((await login(sara.data.member.email)).status, 200);
});
