// Owner accounts are gated behind an explicit approval. The product is run
// for a small number of businesses today; anyone can sign up, but nobody
// connects an eBay account or drafts anything until an admin says yes.
//
// Members (created by an approved owner) are never gated here. When billing
// exists, `isActive` becomes "has an active subscription" and the rest of
// this module — the pending screen, the middleware, the emails — stays.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { query, pool } = require('../../db/client');
const userRepository = require('../users/user.repository');
const marketplaces = require('../ebay/marketplaces');
const config = require('../../config');
const logger = require('../../utils/logger');
const emailService = require('../../utils/email');

const DECISION_TTL = '7d';

class AccessError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.expose = true;
  }
}

function isAdminEmail(email) {
  return config.adminEmails.includes(String(email || '').toLowerCase());
}

// Signed, single-purpose tokens for the one-click links in the admin email.
// A JWT with a distinct `purpose` claim so a login token can never be used
// to approve an account and vice versa.
function decisionToken(userId, decision) {
  return jwt.sign({ sub: userId, purpose: 'access-decision', decision, nonce: crypto.randomBytes(8).toString('hex') }, config.jwt.secret, {
    expiresIn: DECISION_TTL,
  });
}

function verifyDecisionToken(token) {
  const payload = jwt.verify(token, config.jwt.secret);
  if (payload.purpose !== 'access-decision' || !['approve', 'reject'].includes(payload.decision)) {
    throw new AccessError('That link is not valid.', 400);
  }
  return payload;
}

// Sent at signup. The email says whether the address is verified yet; an
// admin approving vouches for it either way (see setStatus/decide).
async function notifyAdmins(user) {
  if (!config.adminEmails.length) {
    logger.warn('ADMIN_EMAILS is not set. No one will receive access requests', { userId: user.id });
    return;
  }
  const base = `${config.apiUrl}/api/auth/access`;
  const approveLink = `${base}/approve?token=${decisionToken(user.id, 'approve')}`;
  const rejectLink = `${base}/reject?token=${decisionToken(user.id, 'reject')}`;
  for (const to of config.adminEmails) {
    const { sent } = await emailService.sendAccessRequestEmail(to, {
      applicantEmail: user.email,
      applicantName: user.name,
      teamName: user.team_name || null,
      note: user.access_note,
      emailVerified: Boolean(user.emailVerified ?? user.email_verified_at),
      approveLink,
      rejectLink,
    });
    if (!sent && config.env !== 'production') {
      logger.info(`[DEV FALLBACK — no email sent] access request for ${user.email}`, { approveLink, rejectLink });
    }
  }
}

// A "no" to a pending applicant deletes the account outright: they were
// never let in, so there is nothing of theirs to keep, and the address is
// free to sign up again later. Revoking an already-approved owner is
// different — their connections and listings stay, they just can't get in.
async function reject(userId) {
  const { rows } = await query(`SELECT id, email, access_status FROM users WHERE id = $1 AND role = 'owner'`, [userId]);
  if (!rows.length) throw new AccessError('That account no longer exists.', 404);
  const user = rows[0];
  await emailService.sendAccessDecisionEmail(user.email, { approved: false, loginLink: `${config.frontendUrl}/login` });
  if (user.access_status === 'active') {
    await query(`UPDATE users SET access_status = 'rejected', access_reviewed_at = now(), updated_at = now() WHERE id = $1`, [userId]);
    logger.info('Access revoked', { userId });
    return { ...user, access_status: 'rejected' };
  }
  await query('DELETE FROM users WHERE id = $1', [userId]);
  logger.info('Access request rejected, account deleted', { userId });
  return { ...user, access_status: 'rejected', deleted: true };
}

async function approve(userId) {
  // An admin approving someone vouches for the address too — needed while
  // the email provider can't reach every applicant with a verification link.
  const { rows } = await query(
    `UPDATE users SET access_status = 'active', access_reviewed_at = now(), updated_at = now(),
       email_verified_at = COALESCE(email_verified_at, now())
     WHERE id = $1 AND role = 'owner' RETURNING id, email, access_status`,
    [userId]
  );
  if (!rows.length) throw new AccessError('That account no longer exists.', 404);
  await emailService.sendAccessDecisionEmail(rows[0].email, { approved: true, loginLink: `${config.frontendUrl}/login` });
  logger.info('Access approved', { userId });
  return rows[0];
}

async function decide(token) {
  const { sub: userId, decision } = verifyDecisionToken(token);
  return decision === 'approve' ? approve(userId) : reject(userId);
}

// Admin-side list/decide from inside the app, for when the email is lost.
async function listPending() {
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, w.name AS team_name, u.access_note, u.created_at, u.email_verified_at
     FROM users u LEFT JOIN workspaces w ON w.owner_user_id = u.id
     WHERE u.role = 'owner' AND u.access_status = 'pending' ORDER BY u.created_at`
  );
  return rows;
}

// The last 30 days of decisions: who was let in, and whose access was
// revoked (rejected applicants are deleted, so they never appear here).
async function listReviewed() {
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, w.name AS team_name, u.access_note, u.created_at, u.email_verified_at, u.access_status, u.access_reviewed_at
     FROM users u LEFT JOIN workspaces w ON w.owner_user_id = u.id
     WHERE u.role = 'owner' AND u.access_status IN ('active', 'rejected') AND u.access_reviewed_at > now() - interval '30 days'
     ORDER BY u.access_reviewed_at DESC LIMIT 50`
  );
  return rows;
}

/**
 * Every workspace account on Liston (each owner and their workspace), for
 * the admin: its status, when it joined and last signed in, its eBay
 * accounts and people, the member logins that are in it alone (deleting it
 * takes them), the other workspaces its login also works in, and whether
 * it's an admin's (never deleted from here). Newest first.
 */
async function listWorkspaces() {
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, w.name AS team_name, u.access_status, u.created_at, u.last_login_at, u.email_verified_at,
            (SELECT count(*)::int FROM connections c WHERE c.user_id = u.id) AS accounts,
            (SELECT count(*)::int FROM workspace_members m WHERE m.owner_user_id = u.id AND m.deactivated_at IS NULL) AS members,
            (SELECT count(*)::int FROM workspace_members m JOIN users x ON x.id = m.user_id
              WHERE m.owner_user_id = u.id AND x.role = 'member'
                AND NOT EXISTS (SELECT 1 FROM workspace_members o WHERE o.user_id = m.user_id AND o.owner_user_id <> u.id)) AS logins_only_here,
            (SELECT count(*)::int FROM workspace_members m WHERE m.user_id = u.id AND m.deactivated_at IS NULL) AS other_workspaces,
            (SELECT count(DISTINCT coalesce(c.settings->'ebay'->>'marketplaceId', 'EBAY_GB'))::int FROM connections c WHERE c.user_id = u.id) AS marketplaces,
            (SELECT max(a.created_at) FROM member_activity a WHERE a.owner_user_id = u.id) AS last_active_at
       FROM users u LEFT JOIN workspaces w ON w.owner_user_id = u.id
      WHERE u.role = 'owner'
      ORDER BY u.created_at DESC`
  );
  return rows.map((r) => ({ ...r, is_admin: isAdminEmail(r.email) }));
}

const DAYS_30 = "now() - interval '30 days'";

/**
 * One workspace account for the admin: who owns it and when it joined and
 * was reviewed, then how much it uses Liston, as counts only: its people,
 * its eBay accounts by marketplace (never which accounts), orders, the work
 * done in it and the team's time in the last 30 days, its inbox and chat,
 * and the files it keeps.
 */
async function workspaceDetail(userId) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.access_status, u.access_reviewed_at, u.created_at, u.last_login_at, u.email_verified_at,
            w.name AS team_name, p.name AS plan_name,
            (SELECT count(*)::int FROM workspace_members m WHERE m.user_id = u.id AND m.deactivated_at IS NULL) AS other_workspaces,
            (SELECT count(*)::int FROM workspace_members m JOIN users x ON x.id = m.user_id
              WHERE m.owner_user_id = u.id AND x.role = 'member'
                AND NOT EXISTS (SELECT 1 FROM workspace_members o WHERE o.user_id = m.user_id AND o.owner_user_id <> u.id)) AS logins_only_here
       FROM users u
       LEFT JOIN workspaces w ON w.owner_user_id = u.id
       LEFT JOIN plans p ON p.id = u.plan_id
      WHERE u.id = $1 AND u.role = 'owner'`,
    [userId]
  );
  const owner = rows[0];
  if (!owner) throw new AccessError('That workspace no longer exists.', 404);
  const one = async (sql) => (await query(sql, [userId])).rows[0];
  const [people, invites, sites, orders, work, time, inbox, chat, files] = await Promise.all([
    one(`SELECT count(*) FILTER (WHERE deactivated_at IS NULL)::int AS members,
                count(*) FILTER (WHERE deactivated_at IS NULL AND owner_access_at IS NOT NULL)::int AS co_managers,
                count(*) FILTER (WHERE deactivated_at IS NOT NULL)::int AS removed
           FROM workspace_members WHERE owner_user_id = $1`),
    one(`SELECT count(*)::int AS waiting FROM workspace_invites
          WHERE owner_user_id = $1 AND member_user_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`),
    query(
      `SELECT coalesce(settings->'ebay'->>'marketplaceId', 'EBAY_GB') AS id, count(*)::int AS accounts,
              count(*) FILTER (WHERE status <> 'active')::int AS needs_attention
         FROM connections WHERE user_id = $1 GROUP BY 1 ORDER BY 2 DESC, 1`,
      [userId]
    ).then((r) => r.rows),
    one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE o.created_at > ${DAYS_30})::int AS last_30
           FROM ebay_orders o JOIN connections c ON c.id = o.connection_id WHERE c.user_id = $1`),
    one(`SELECT count(*)::int AS actions,
                count(*) FILTER (WHERE kind = 'listing.published')::int AS published,
                count(*) FILTER (WHERE kind = 'listing.drafted')::int AS drafted,
                count(*) FILTER (WHERE kind IN ('order.supplier_ordered', 'sourcing.ordered'))::int AS supplier_orders,
                count(*) FILTER (WHERE kind IN ('order.dispatched', 'ebay.dispatched_by_liston'))::int AS dispatched,
                count(*) FILTER (WHERE kind = 'hunt.added')::int AS hunted,
                count(*) FILTER (WHERE kind IN ('inbox.replied', 'inbox.messaged'))::int AS buyers_answered,
                (SELECT max(created_at) FROM member_activity WHERE owner_user_id = $1) AS last_active_at
           FROM member_activity WHERE owner_user_id = $1 AND created_at > ${DAYS_30}`),
    one(`SELECT count(*) FILTER (WHERE working)::int AS working_minutes, count(DISTINCT user_id)::int AS people
           FROM member_minutes WHERE owner_user_id = $1 AND minute > ${DAYS_30}`),
    one(`SELECT count(*)::int AS conversations FROM ebay_conversations e JOIN connections c ON c.id = e.connection_id WHERE c.user_id = $1`),
    one(`SELECT count(*)::int AS messages FROM chat_messages x JOIN chat_conversations c ON c.id = x.conversation_id
          WHERE c.owner_user_id = $1 AND x.kind = 'text' AND x.created_at > ${DAYS_30}`),
    one(`SELECT count(*)::int AS count, coalesce(sum(size_bytes), 0)::bigint AS bytes FROM files WHERE owner_user_id = $1`),
  ]);
  return {
    ...owner,
    is_admin: isAdminEmail(owner.email),
    people: { ...people, invitations: invites.waiting },
    accounts: {
      total: sites.reduce((n, s) => n + s.accounts, 0),
      needsAttention: sites.reduce((n, s) => n + s.needs_attention, 0),
      marketplaces: sites.map((s) => {
        const m = marketplaces.byId(s.id);
        return { id: s.id, site: m?.label || s.id, name: m?.name || s.id, accounts: s.accounts };
      }),
    },
    orders,
    work,
    time,
    inbox: { conversations: inbox.conversations, chatMessages: chat.messages },
    files: { count: files.count, bytes: Number(files.bytes) },
  };
}

/**
 * Deletes a workspace account, as the admin: the owner's login and their
 * workspace with everything in it (eBay accounts, listings, orders, chat),
 * the member logins in it alone, and the login's places in other
 * workspaces. `confirmEmail` must be the account's email. Never an admin's
 * account. Can't be undone.
 */
async function deleteAccount(userId, confirmEmail) {
  const { rows } = await query(`SELECT id, email, name FROM users WHERE id = $1 AND role = 'owner'`, [userId]);
  const user = rows[0];
  if (!user) throw new AccessError('That account no longer exists.', 404);
  if (isAdminEmail(user.email)) throw new AccessError("An admin's account can't be deleted from here.", 403);
  if (String(confirmEmail || '').trim().toLowerCase() !== user.email.toLowerCase()) {
    throw new AccessError(`Type ${user.email} to delete this account.`, 400);
  }
  const client = await pool.connect();
  let members = 0;
  try {
    await client.query('BEGIN');
    members = await userRepository.deleteLoginsOnlyIn(userId, client);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  logger.info('Access: workspace account deleted by an admin', { userId, memberLogins: members });
  return { deleted: true, email: user.email, memberLogins: members };
}

async function setStatus(userId, status) {
  if (status === 'active') return approve(userId);
  if (status === 'rejected') return reject(userId);
  throw new AccessError('Status must be active or rejected.', 400);
}

module.exports = { AccessError, isAdminEmail, notifyAdmins, decide, listPending, listReviewed, listWorkspaces, workspaceDetail, deleteAccount, setStatus, decisionToken };
