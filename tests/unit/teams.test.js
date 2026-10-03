const test = require('node:test');
const assert = require('node:assert');
const teams = require('../../src/modules/team/teams');

// Teams (migration 051): their names, and which team a request is in.

test("a team is named after its owner's first name, else their email's name", () => {
  assert.strictEqual(teams.defaultTeamName({ name: 'Talha Ubaid', email: 't@example.com' }), "Talha's workspace");
  assert.strictEqual(teams.defaultTeamName({ name: '  ', email: 'usama.j@example.com' }), "usama.j's workspace");
  assert.ok(teams.defaultTeamName({ name: 'x'.repeat(200) }).length <= teams.NAME_MAX);
});

test('a typed team name is tidied, and nothing is no name', () => {
  assert.strictEqual(teams.cleanTeamName('  Talha   Retail  '), 'Talha Retail');
  assert.strictEqual(teams.cleanTeamName('   '), null);
  assert.strictEqual(teams.cleanTeamName(null), null);
  assert.strictEqual(teams.cleanTeamName('y'.repeat(80)).length, teams.NAME_MAX);
});

const own = { ownerId: 'a', own: true, accessStatus: 'pending' };
const usama = { ownerId: 'u', own: false, accessStatus: 'active' };
const talha = { ownerId: 't', own: false, ownerAccessAt: '2026-10-01', accessStatus: 'active' };

test('the team a page names, if the login is in it; never another in its place', () => {
  assert.strictEqual(teams.pickTeam([own, usama, talha], { asked: 't' }).team, talha);
  assert.deepStrictEqual(teams.pickTeam([own, usama], { asked: 't' }), { refused: true });
  assert.deepStrictEqual(teams.pickTeam([], { asked: 't' }), { none: true });
});

test('without one: the last team used, else the first approved one, else the first', () => {
  assert.strictEqual(teams.pickTeam([own, usama, talha], { last: 't' }).team, talha);
  // Their own team still waiting for approval: an approved team they're in opens instead.
  assert.strictEqual(teams.pickTeam([own, usama, talha]).team, usama);
  assert.strictEqual(teams.pickTeam([own]).team, own);
});

test("what a login is in a team: its owner, owner access there, or a member", () => {
  assert.deepStrictEqual(teams.roleIn(own), { role: 'owner', coOwner: false });
  assert.deepStrictEqual(teams.roleIn(talha), { role: 'owner', coOwner: true });
  assert.deepStrictEqual(teams.roleIn(usama), { role: 'member', coOwner: false });
});

test('a notification link opens in its team', () => {
  assert.strictEqual(teams.linkInTeam('/connections', 'u'), '/connections?ws=u');
  assert.strictEqual(teams.linkInTeam('/accounts/1/hunting?open=2', 'u'), '/accounts/1/hunting?open=2&ws=u');
  assert.strictEqual(teams.linkInTeam('/x?ws=t', 'u'), '/x?ws=t');
  assert.strictEqual(teams.linkInTeam(null, 'u'), null);
  assert.strictEqual(teams.linkInTeam('/x', null), '/x');
});
