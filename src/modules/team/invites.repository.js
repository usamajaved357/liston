const { query, pool } = require('../../db/client');

// Invitations to a workspace (migration 053): someone joining by email, or a
// member's login moving to a real email (member_user_id). `ownerId`: the
// workspace (its owner's user id).

const COLUMNS = `i.id, i.owner_user_id, i.email, i.name, i.member_user_id, i.same_as_user_id, i.invited_by,
  i.created_at, i.sent_at, i.expires_at, i.accepted_at, i.revoked_at`;

/** The workspace's invitations still open (expired ones too, for a resend), newest first. */
async function listOpen(ownerId) {
  const { rows } = await query(
    `SELECT ${COLUMNS}, b.name AS invited_by_name, b.email AS invited_by_email, s.name AS same_as_name, s.email AS same_as_email,
            EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(i.email)) AS existing_login
       FROM workspace_invites i
       LEFT JOIN users b ON b.id = i.invited_by
       LEFT JOIN users s ON s.id = i.same_as_user_id
      WHERE i.owner_user_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
      ORDER BY i.sent_at DESC`,
    [ownerId]
  );
  return rows;
}

/** One invitation with its workspace's name and who sent it. */
async function findById(id) {
  const { rows } = await query(
    `SELECT ${COLUMNS}, w.name AS team_name, o.name AS owner_name, o.email AS owner_email,
            b.name AS invited_by_name, b.email AS invited_by_email, m.email AS member_email
       FROM workspace_invites i
       JOIN workspaces w ON w.owner_user_id = i.owner_user_id
       JOIN users o ON o.id = i.owner_user_id
       LEFT JOIN users b ON b.id = i.invited_by
       LEFT JOIN users m ON m.id = i.member_user_id
      WHERE i.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function findForOwner(id, ownerId) {
  const invite = await findById(id);
  return invite && String(invite.owner_user_id) === String(ownerId) ? invite : null;
}

/** The open invitation for this email in the workspace (not an email change). */
async function findOpenByEmail(ownerId, email) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM workspace_invites i
      WHERE i.owner_user_id = $1 AND lower(i.email) = lower($2) AND i.member_user_id IS NULL AND i.accepted_at IS NULL AND i.revoked_at IS NULL`,
    [ownerId, email]
  );
  return rows[0] || null;
}

async function countOpen(ownerId) {
  const { rows } = await query(`SELECT count(*)::int AS n FROM workspace_invites WHERE owner_user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [ownerId]);
  return rows[0].n;
}

async function create({ ownerId, email, name = null, memberUserId = null, sameAsUserId = null, invitedBy = null, expiresAt }) {
  const { rows } = await query(
    `INSERT INTO workspace_invites (owner_user_id, email, name, member_user_id, same_as_user_id, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [ownerId, email, name, memberUserId, sameAsUserId, invitedBy, expiresAt]
  );
  return rows[0].id;
}

/** Sent again: open for another stretch from now. */
async function markSent(id, expiresAt) {
  await query(`UPDATE workspace_invites SET sent_at = now(), expires_at = $2 WHERE id = $1`, [id, expiresAt]);
}

/** Withdrawn by the workspace; false when it was no longer open. */
async function revoke(id, ownerId) {
  const { rowCount } = await query(
    `UPDATE workspace_invites SET revoked_at = now() WHERE id = $1 AND owner_user_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [id, ownerId]
  );
  return rowCount > 0;
}

/** A member's email change waiting, withdrawn (a new one replaces it). */
async function revokeChangeFor(memberUserId) {
  await query(`UPDATE workspace_invites SET revoked_at = now() WHERE member_user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [memberUserId]);
}

/** A login's sign-in details (to check the password someone joining types). */
async function findLogin(email) {
  const { rows } = await query(`SELECT id, email, name, role, password_hash, session_version FROM users WHERE lower(email) = lower($1)`, [email]);
  return rows[0] || null;
}

async function findLoginById(id) {
  const { rows } = await query(`SELECT id, email, name, role, session_version FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Taken inside the transaction that acts on it, so the same link can't be used twice at once.
async function claim(client, id) {
  const { rowCount } = await client.query(
    `UPDATE workspace_invites SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    [id]
  );
  return rowCount > 0;
}

// The access of the member the invitation named, copied to the one joining.
async function copyAccess(client, { ownerId, fromUserId, toUserId }) {
  if (!fromUserId) return;
  await client.query(
    `INSERT INTO member_permissions (member_user_id, owner_user_id, connection_id, feature, allowed)
     SELECT $3, owner_user_id, connection_id, feature, allowed FROM member_permissions WHERE member_user_id = $2 AND owner_user_id = $1
     ON CONFLICT DO NOTHING`,
    [ownerId, fromUserId, toUserId]
  );
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await work(client);
    if (out === null) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Someone new joining: their login (the email proven by the link they
 * opened), their place in the workspace and its access, together. Null when
 * the invitation was used or withdrawn meanwhile.
 */
async function acceptNew(invite, { name, passwordHash }) {
  return inTransaction(async (client) => {
    if (!(await claim(client, invite.id))) return null;
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, role, name, email_verified_at, last_workspace_id, last_login_at)
       VALUES ($1, $2, 'member', $3, now(), $4, now()) RETURNING id, email, name, session_version`,
      [invite.email, passwordHash, name || null, invite.owner_user_id]
    );
    const user = rows[0];
    await client.query(`INSERT INTO workspace_members (owner_user_id, user_id, added_by) VALUES ($1, $2, $3)`, [invite.owner_user_id, user.id, invite.invited_by]);
    await copyAccess(client, { ownerId: invite.owner_user_id, fromUserId: invite.same_as_user_id, toUserId: user.id });
    await client.query(`UPDATE workspace_invites SET accepted_user_id = $2 WHERE id = $1`, [invite.id, user.id]);
    return user;
  });
}

/** A login already on Liston joining the workspace. Null when the invitation was used or withdrawn meanwhile. */
async function acceptExisting(invite, userId) {
  return inTransaction(async (client) => {
    if (!(await claim(client, invite.id))) return null;
    await client.query(
      `INSERT INTO workspace_members (owner_user_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [invite.owner_user_id, userId, invite.invited_by]
    );
    await copyAccess(client, { ownerId: invite.owner_user_id, fromUserId: invite.same_as_user_id, toUserId: userId });
    await client.query(`UPDATE workspace_invites SET accepted_user_id = $2 WHERE id = $1`, [invite.id, userId]);
    await client.query(`UPDATE users SET last_workspace_id = $2, last_login_at = now() WHERE id = $1`, [userId, invite.owner_user_id]);
    return { id: userId };
  });
}

/**
 * A member's login taking the confirmed email and their own password. Only
 * a login that's still this workspace's alone (as a password change by the
 * workspace); 'gone', 'shared' or 'taken' say why not, null when the
 * invitation was used or withdrawn meanwhile.
 */
async function acceptEmailChange(invite, { passwordHash }) {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT u.id, u.role,
              EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = u.id AND m.owner_user_id = $2 AND m.deactivated_at IS NULL) AS here,
              EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = u.id AND m.owner_user_id <> $2) AS elsewhere,
              EXISTS (SELECT 1 FROM users o WHERE lower(o.email) = lower($3) AND o.id <> u.id) AS taken
         FROM users u WHERE u.id = $1 FOR UPDATE`,
      [invite.member_user_id, invite.owner_user_id, invite.email]
    );
    const login = rows[0];
    if (!login || !login.here) return { refused: 'gone' };
    if (login.role !== 'member' || login.elsewhere) return { refused: 'shared' };
    if (login.taken) return { refused: 'taken' };
    if (!(await claim(client, invite.id))) return null;
    const updated = await client.query(
      `UPDATE users SET email = $2, email_verified_at = now(), password_hash = $3, session_version = session_version + 1, last_login_at = now(), updated_at = now()
        WHERE id = $1 RETURNING id, email, name, session_version`,
      [login.id, invite.email, passwordHash]
    );
    await client.query(`UPDATE workspace_invites SET accepted_user_id = $2 WHERE id = $1`, [invite.id, login.id]);
    return { user: updated.rows[0] };
  });
}

module.exports = {
  listOpen,
  findById,
  findForOwner,
  findOpenByEmail,
  countOpen,
  create,
  markSent,
  revoke,
  revokeChangeFor,
  findLogin,
  findLoginById,
  acceptNew,
  acceptExisting,
  acceptEmailChange,
};
