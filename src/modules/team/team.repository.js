const { query } = require('../../db/client');

// The gated feature set today. `feature` itself is free-text in the DB (see
// migration 007) so a new module can register a new string with zero
// migration — this list is only used to (a) seed sensible defaults when a
// member is created and (b) decide whether a connection has "any" access at
// all for a member. Add a new feature here once its routes are wired up.
const KNOWN_FEATURES = ['orders', 'listings', 'inbox', 'campaigns'];

async function listMembers(ownerId) {
  const result = await query(
    `SELECT id, email, name, created_at
     FROM users WHERE parent_user_id = $1 AND role = 'member'
     ORDER BY created_at ASC`,
    [ownerId]
  );
  return result.rows;
}

async function createMember({ ownerId, email, name, passwordHash }) {
  const result = await query(
    `INSERT INTO users (email, password_hash, role, parent_user_id, name)
     VALUES ($1, $2, 'member', $3, $4)
     RETURNING id, email, name, created_at`,
    [email, passwordHash, ownerId, name || null]
  );
  return result.rows[0];
}

async function findMemberForOwner(id, ownerId) {
  const result = await query(
    `SELECT id, email, name, created_at
     FROM users WHERE id = $1 AND parent_user_id = $2 AND role = 'member'`,
    [id, ownerId]
  );
  return result.rows[0] || null;
}

async function deleteMember(id, ownerId) {
  const result = await query(
    `DELETE FROM users WHERE id = $1 AND parent_user_id = $2 AND role = 'member'`,
    [id, ownerId]
  );
  return result.rowCount > 0;
}

async function getPermissions(memberId) {
  const result = await query(
    `SELECT id, connection_id, feature, allowed
     FROM member_permissions WHERE member_user_id = $1
     ORDER BY feature ASC`,
    [memberId]
  );
  return result.rows;
}

// Upserts against whichever partial unique index applies (see migration
// 007) — connection_id present targets the scoped index, null targets the
// global-default index.
async function setPermission({ memberId, connectionId, feature, allowed }) {
  if (connectionId) {
    const result = await query(
      `INSERT INTO member_permissions (member_user_id, connection_id, feature, allowed)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (member_user_id, connection_id, feature) WHERE connection_id IS NOT NULL
       DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
       RETURNING id, connection_id, feature, allowed`,
      [memberId, connectionId, feature, allowed]
    );
    return result.rows[0];
  }

  const result = await query(
    `INSERT INTO member_permissions (member_user_id, connection_id, feature, allowed)
     VALUES ($1, NULL, $2, $3)
     ON CONFLICT (member_user_id, feature) WHERE connection_id IS NULL
     DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     RETURNING id, connection_id, feature, allowed`,
    [memberId, feature, allowed]
  );
  return result.rows[0];
}

// Removes a connection-scoped override so the member's global default takes
// over again for this feature/connection — the only way to undo an override
// without it silently reading as an explicit "false" forever (which is
// indistinguishable from "no opinion" once written as a row).
async function clearPermission({ memberId, connectionId, feature }) {
  await query(
    `DELETE FROM member_permissions WHERE member_user_id = $1 AND connection_id = $2 AND feature = $3`,
    [memberId, connectionId, feature]
  );
}

// Deny-by-default resolution: a connection-scoped row wins if present,
// otherwise the member's global default for this feature, otherwise denied.
async function resolvePermission(memberId, connectionId, feature) {
  if (connectionId) {
    const scoped = await query(
      `SELECT allowed FROM member_permissions
       WHERE member_user_id = $1 AND connection_id = $2 AND feature = $3`,
      [memberId, connectionId, feature]
    );
    if (scoped.rows.length > 0) return scoped.rows[0].allowed;
  }

  const global = await query(
    `SELECT allowed FROM member_permissions
     WHERE member_user_id = $1 AND connection_id IS NULL AND feature = $2`,
    [memberId, feature]
  );
  return global.rows.length > 0 ? global.rows[0].allowed : false;
}

// True if the member has at least one of the given features on this
// connection — used to decide whether a connection should be visible to
// them at all (defense in depth alongside listConnections' own filtering).
async function resolveAnyPermission(memberId, connectionId, features) {
  for (const feature of features) {
    // eslint-disable-next-line no-await-in-loop -- short-circuits on the first grant, only a handful of features
    if (await resolvePermission(memberId, connectionId, feature)) return true;
  }
  return false;
}

async function getResolvedPermissions(memberId, connectionId, features = KNOWN_FEATURES) {
  const entries = await Promise.all(
    features.map(async (feature) => [feature, await resolvePermission(memberId, connectionId, feature)])
  );
  return Object.fromEntries(entries);
}

module.exports = {
  KNOWN_FEATURES,
  listMembers,
  createMember,
  findMemberForOwner,
  deleteMember,
  getPermissions,
  setPermission,
  clearPermission,
  resolvePermission,
  resolveAnyPermission,
  getResolvedPermissions,
};
