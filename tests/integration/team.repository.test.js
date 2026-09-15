const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const authService = require('../../src/modules/auth/auth.service');
const connectionService = require('../../src/modules/connections/connection.service');
const teamRepository = require('../../src/modules/team/team.repository');
const { pool } = require('../../src/db/client');

test.after(async () => {
  await pool.end();
});

async function createOwnerWithConnection() {
  const email = `owner-${crypto.randomUUID()}@example.com`;
  const { user } = await authService.signup({ email, password: 'testpassword123' });
  const connection = await connectionService.createConnection(user.id, {
    platformKey: 'ebay',
    label: 'Test Store',
    credentials: { accessToken: 'x' },
  });
  return { ownerId: user.id, connectionId: connection.id };
}

test('resolvePermission denies by default when no rows exist', async () => {
  const { ownerId, connectionId } = await createOwnerWithConnection();
  const member = await teamRepository.createMember({
    ownerId,
    email: `member-${crypto.randomUUID()}@example.com`,
    name: 'Test Member',
    passwordHash: 'hash',
  });

  const allowed = await teamRepository.resolvePermission(member.id, connectionId, 'orders');
  assert.strictEqual(allowed, false);
});

test('resolvePermission uses the global default when no scoped row exists', async () => {
  const { ownerId, connectionId } = await createOwnerWithConnection();
  const member = await teamRepository.createMember({
    ownerId,
    email: `member-${crypto.randomUUID()}@example.com`,
    passwordHash: 'hash',
  });

  await teamRepository.setPermission({ memberId: member.id, connectionId: null, feature: 'orders', allowed: true });

  assert.strictEqual(await teamRepository.resolvePermission(member.id, connectionId, 'orders'), true);
  assert.strictEqual(await teamRepository.resolvePermission(member.id, connectionId, 'listings'), false);
});

test('a scoped override wins over the global default, in both directions', async () => {
  const { ownerId, connectionId } = await createOwnerWithConnection();
  const member = await teamRepository.createMember({
    ownerId,
    email: `member-${crypto.randomUUID()}@example.com`,
    passwordHash: 'hash',
  });

  await teamRepository.setPermission({ memberId: member.id, connectionId: null, feature: 'orders', allowed: true });
  await teamRepository.setPermission({ memberId: member.id, connectionId, feature: 'orders', allowed: false });
  assert.strictEqual(await teamRepository.resolvePermission(member.id, connectionId, 'orders'), false);

  await teamRepository.setPermission({ memberId: member.id, connectionId: null, feature: 'listings', allowed: false });
  await teamRepository.setPermission({ memberId: member.id, connectionId, feature: 'listings', allowed: true });
  assert.strictEqual(await teamRepository.resolvePermission(member.id, connectionId, 'listings'), true);
});

// The exact bug reported live: an admin set a connection-scoped override to
// false while testing, then later turned the global default on — but the
// stale false override kept silently winning since a hard `false` row is
// indistinguishable from an intentional deny. clearPermission is the fix:
// it removes the override entirely so the global default takes over again.
test('clearPermission removes a scoped override so the global default takes over again', async () => {
  const { ownerId, connectionId } = await createOwnerWithConnection();
  const member = await teamRepository.createMember({
    ownerId,
    email: `member-${crypto.randomUUID()}@example.com`,
    passwordHash: 'hash',
  });

  await teamRepository.setPermission({ memberId: member.id, connectionId, feature: 'listings', allowed: false });
  await teamRepository.setPermission({ memberId: member.id, connectionId: null, feature: 'listings', allowed: true });
  assert.strictEqual(
    await teamRepository.resolvePermission(member.id, connectionId, 'listings'),
    false,
    'the stale scoped override should still be winning at this point'
  );

  await teamRepository.clearPermission({ memberId: member.id, connectionId, feature: 'listings' });
  assert.strictEqual(await teamRepository.resolvePermission(member.id, connectionId, 'listings'), true);

  const rows = await teamRepository.getPermissions(member.id);
  assert.strictEqual(rows.find((r) => r.connection_id === connectionId && r.feature === 'listings'), undefined);
});

test('setPermission upserts rather than duplicating rows on repeated writes', async () => {
  const { ownerId, connectionId } = await createOwnerWithConnection();
  const member = await teamRepository.createMember({
    ownerId,
    email: `member-${crypto.randomUUID()}@example.com`,
    passwordHash: 'hash',
  });

  await teamRepository.setPermission({ memberId: member.id, connectionId: null, feature: 'orders', allowed: true });
  await teamRepository.setPermission({ memberId: member.id, connectionId: null, feature: 'orders', allowed: false });
  await teamRepository.setPermission({ memberId: member.id, connectionId, feature: 'orders', allowed: true });
  await teamRepository.setPermission({ memberId: member.id, connectionId, feature: 'orders', allowed: false });

  const rows = await teamRepository.getPermissions(member.id);
  assert.strictEqual(rows.length, 2); // one global + one scoped, not four
  assert.strictEqual(rows.find((r) => r.connection_id === null).allowed, false);
  assert.strictEqual(rows.find((r) => r.connection_id === connectionId).allowed, false);
});

test('resolveAnyPermission is true if at least one feature is granted', async () => {
  const { ownerId, connectionId } = await createOwnerWithConnection();
  const member = await teamRepository.createMember({
    ownerId,
    email: `member-${crypto.randomUUID()}@example.com`,
    passwordHash: 'hash',
  });

  assert.strictEqual(await teamRepository.resolveAnyPermission(member.id, connectionId, teamRepository.KNOWN_FEATURES), false);

  await teamRepository.setPermission({ memberId: member.id, connectionId: null, feature: 'inbox', allowed: true });
  assert.strictEqual(await teamRepository.resolveAnyPermission(member.id, connectionId, teamRepository.KNOWN_FEATURES), true);
});

test('getResolvedPermissions returns a flat map across every known feature', async () => {
  const { ownerId, connectionId } = await createOwnerWithConnection();
  const member = await teamRepository.createMember({
    ownerId,
    email: `member-${crypto.randomUUID()}@example.com`,
    passwordHash: 'hash',
  });
  await teamRepository.setPermission({ memberId: member.id, connectionId: null, feature: 'orders', allowed: true });

  const resolved = await teamRepository.getResolvedPermissions(member.id, connectionId);
  assert.deepStrictEqual(resolved, { orders: true, listings: false, inbox: false, campaigns: false });
});
