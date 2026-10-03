const { query, pool } = require('../../db/client');

// The gated feature set today. `feature` itself is free-text in the DB (see
// migration 007) so a new module can register a new string with zero
// migration — this list is only used to (a) seed sensible defaults when a
// member is created and (b) decide whether a connection has "any" access at
// all for a member. Add a new feature here once its routes are wired up.
// 'hunting' adds products for review; 'hunting_review' reviews them (and
// includes hunting). 'listings_publish' puts drafts live on eBay (on top of
// 'listings', which drafts and edits).
const KNOWN_FEATURES = ['orders', 'listings', 'listings_publish', 'analytics', 'inbox', 'campaigns', 'hunting', 'hunting_review'];

// A team's members (migration 051: a login's place in an owner's team).
// `created_at` is when they joined this team; `shared_login`: the login is
// also an owner's or in another team, so only the person changes its
// password; `avatar_url` their profile photo (a small JPEG, as workspace
// chat sends it) for the Members page and their own page; `email_confirmed`
// whether the login's email was ever proven (an invitation accepted, or
// confirmed), `pending_email` an email change sent and not yet confirmed
// (migration 053).
const MEMBER_COLUMNS = `u.id, u.email, u.name, u.avatar_url, m.created_at, u.last_login_at, m.deactivated_at, m.owner_access_at,
  (u.role = 'owner' OR EXISTS (SELECT 1 FROM workspace_members o WHERE o.user_id = u.id AND o.owner_user_id <> m.owner_user_id)) AS shared_login,
  (u.email_verified_at IS NOT NULL) AS email_confirmed,
  (SELECT i.email FROM workspace_invites i WHERE i.member_user_id = u.id AND i.owner_user_id = m.owner_user_id AND i.accepted_at IS NULL AND i.revoked_at IS NULL LIMIT 1) AS pending_email`;

async function listMembers(ownerId) {
  const result = await query(
    `SELECT ${MEMBER_COLUMNS}
       FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.owner_user_id = $1
      ORDER BY m.created_at ASC`,
    [ownerId]
  );
  return result.rows;
}

async function findMemberForOwner(id, ownerId) {
  const result = await query(
    `SELECT ${MEMBER_COLUMNS}
       FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1 AND m.owner_user_id = $2`,
    [id, ownerId]
  );
  return result.rows[0] || null;
}

/** The login with this email, whoever's it is: { id, email, name, role } or null. */
async function findLoginByEmail(email) {
  const result = await query(`SELECT id, email, name, role, created_at FROM users WHERE lower(email) = lower($1)`, [email]);
  return result.rows[0] || null;
}

// Removing a member takes them out of this team but keeps them (and their
// activity, which salaries are worked out from); their access settings stay
// for a restore. Their other teams are untouched.
async function setMemberDeactivated(id, ownerId, deactivated) {
  const result = await query(
    `UPDATE workspace_members SET deactivated_at = ${deactivated ? 'now()' : 'NULL'}, updated_at = now()
      WHERE user_id = $1 AND owner_user_id = $2`,
    [id, ownerId]
  );
  return result.rowCount > 0;
}

// Owner access (migration 050, per team since 051): everything the owner
// has in this team. Given keeps the first time it was given; taken away
// clears it, and the member's own access settings apply again.
async function setOwnerAccess(id, ownerId, on) {
  const result = await query(
    `UPDATE workspace_members SET owner_access_at = ${on ? 'COALESCE(owner_access_at, now())' : 'NULL'}, updated_at = now()
      WHERE user_id = $1 AND owner_user_id = $2
      RETURNING user_id AS id, owner_access_at, deactivated_at`,
    [id, ownerId]
  );
  return result.rows[0] || null;
}

/** A member's access in one team. */
async function getPermissions(memberId, ownerId) {
  const result = await query(
    `SELECT id, connection_id, feature, allowed
     FROM member_permissions WHERE member_user_id = $1 AND owner_user_id = $2
     ORDER BY feature ASC`,
    [memberId, ownerId]
  );
  return result.rows;
}

// Upserts against whichever partial unique index applies (see migrations
// 007, 051) — connection_id present targets the scoped index, null targets
// the team's global-default index. `ownerId`: the team.
async function setPermission({ memberId, ownerId, connectionId, feature, allowed }) {
  if (connectionId) {
    const result = await query(
      `INSERT INTO member_permissions (member_user_id, owner_user_id, connection_id, feature, allowed)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (member_user_id, connection_id, feature) WHERE connection_id IS NOT NULL
       DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
       RETURNING id, connection_id, feature, allowed`,
      [memberId, ownerId, connectionId, feature, allowed]
    );
    return result.rows[0];
  }

  const result = await query(
    `INSERT INTO member_permissions (member_user_id, owner_user_id, connection_id, feature, allowed)
     VALUES ($1, $2, NULL, $3, $4)
     ON CONFLICT (member_user_id, owner_user_id, feature) WHERE connection_id IS NULL
     DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     RETURNING id, connection_id, feature, allowed`,
    [memberId, ownerId, feature, allowed]
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

// Deny-by-default resolution, in the team the account is in (the
// connection's owner; `ownerId` for a team-wide feature with no account,
// such as chat_manage): no place in that team (or removed from it) is
// denied; owner access there has everything; otherwise a connection-scoped
// row wins if present, then the member's default in that team for this
// feature, otherwise denied. One query.
async function resolvePermission(memberId, connectionId, feature, ownerId = null) {
  const { rows } = await query(
    `WITH team AS (SELECT coalesce((SELECT user_id FROM connections WHERE id = $2), $4::uuid) AS owner_id)
     SELECT m.owner_access_at IS NOT NULL AS owner_access, m.deactivated_at IS NULL AS active,
            (SELECT allowed FROM member_permissions WHERE member_user_id = $1 AND connection_id = $2 AND feature = $3) AS scoped,
            (SELECT allowed FROM member_permissions p WHERE p.member_user_id = $1 AND p.connection_id IS NULL AND p.owner_user_id = team.owner_id AND p.feature = $3) AS global
       FROM team JOIN workspace_members m ON m.owner_user_id = team.owner_id AND m.user_id = $1`,
    [memberId, connectionId || null, feature, ownerId]
  );
  const row = rows[0];
  if (!row || !row.active) return false;
  if (row.owner_access) return true;
  return row.scoped ?? row.global ?? false;
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

// A new connection split off another (the same eBay account's second site)
// is worked by the same people: each member's grants on the one are copied.
async function copyConnectionPermissions(fromConnectionId, toConnectionId) {
  await query(
    `INSERT INTO member_permissions (member_user_id, owner_user_id, connection_id, feature, allowed)
     SELECT member_user_id, owner_user_id, $2, feature, allowed FROM member_permissions WHERE connection_id = $1`,
    [fromConnectionId, toConnectionId]
  );
}

module.exports = {
  copyConnectionPermissions,
  KNOWN_FEATURES,
  listMembers,
  findMemberForOwner,
  findLoginByEmail,
  setMemberDeactivated,
  setOwnerAccess,
  getPermissions,
  setPermission,
  clearPermission,
  resolvePermission,
  resolveAnyPermission,
  getResolvedPermissions,
};
