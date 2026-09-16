// Owner accounts are gated behind an explicit approval. The product is run
// for a small number of businesses today; anyone can sign up, but nobody
// connects an eBay account or drafts anything until an admin says yes.
//
// Members (created by an approved owner) are never gated here. When billing
// exists, `isActive` becomes "has an active subscription" and the rest of
// this module — the pending screen, the middleware, the emails — stays.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { query } = require('../../db/client');
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
    logger.warn('ADMIN_EMAILS is not set — no one will receive access requests', { userId: user.id });
    return;
  }
  const base = `${config.apiUrl}/api/auth/access`;
  const approveLink = `${base}/approve?token=${decisionToken(user.id, 'approve')}`;
  const rejectLink = `${base}/reject?token=${decisionToken(user.id, 'reject')}`;
  for (const to of config.adminEmails) {
    const { sent } = await emailService.sendAccessRequestEmail(to, {
      applicantEmail: user.email,
      applicantName: user.name,
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
    `SELECT id, email, name, access_note, created_at, email_verified_at
     FROM users WHERE role = 'owner' AND access_status = 'pending' ORDER BY created_at`
  );
  return rows;
}

// The last 30 days of decisions: who was let in, and whose access was
// revoked (rejected applicants are deleted, so they never appear here).
async function listReviewed() {
  const { rows } = await query(
    `SELECT id, email, name, access_note, created_at, email_verified_at, access_status, access_reviewed_at
     FROM users WHERE role = 'owner' AND access_status IN ('active', 'rejected') AND access_reviewed_at > now() - interval '30 days'
     ORDER BY access_reviewed_at DESC LIMIT 50`
  );
  return rows;
}

async function setStatus(userId, status) {
  if (status === 'active') return approve(userId);
  if (status === 'rejected') return reject(userId);
  throw new AccessError('Status must be active or rejected.', 400);
}

module.exports = { AccessError, isAdminEmail, notifyAdmins, decide, listPending, listReviewed, setStatus, decisionToken };
