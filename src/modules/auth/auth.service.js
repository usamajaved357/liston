const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../../db/client');
const config = require('../../config');
const logger = require('../../utils/logger');
const emailService = require('../../utils/email');

const SALT_ROUNDS = 12;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

class AuthError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Raw token goes in the emailed link; only its hash is stored, same pattern
// as password hashing — a leaked DB row can't be replayed as a valid link.
function generateRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Sends via Resend when RESEND_API_KEY is configured (see utils/email.js).
// Falls back to logging the link when it isn't (or the send failed) — never
// in production, where a real provider is required.
async function deliverLink(kind, sendFn, userEmail, rawToken, path) {
  const link = `${config.frontendUrl}${path}?token=${rawToken}`;
  const { sent } = await sendFn(userEmail, link);
  if (!sent && config.env !== 'production') {
    logger.info(`[DEV FALLBACK — no email sent] ${kind} link for ${userEmail}`, { link });
  }
}

async function signup({ email, password }) {
  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    throw new AuthError('An account with this email already exists', 409);
  }

  // Everyone starts on the lowest tier; upgrading happens through billing (Phase 8)
  const starterPlan = await query('SELECT id FROM plans WHERE name = $1', ['starter']);
  if (starterPlan.rows.length === 0) {
    throw new AuthError('No starter plan configured — run the seed script', 500);
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const rawVerificationToken = generateRawToken();
  const result = await query(
    `INSERT INTO users (email, password_hash, plan_id, email_verification_token_hash, email_verification_expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, plan_id, created_at`,
    [
      email,
      passwordHash,
      starterPlan.rows[0].id,
      hashToken(rawVerificationToken),
      new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    ]
  );

  const user = result.rows[0];
  await deliverLink('Email verification', emailService.sendVerificationEmail, email, rawVerificationToken, '/verify-email');

  const token = issueToken(user);
  // emailVerificationToken is for internal/test use only — controllers must
  // not include it in the HTTP response.
  return { user, token, emailVerificationToken: rawVerificationToken };
}

async function verifyEmail(rawToken) {
  const tokenHash = hashToken(rawToken);
  const result = await query(
    `UPDATE users
     SET email_verified_at = now(), email_verification_token_hash = NULL, email_verification_expires_at = NULL
     WHERE email_verification_token_hash = $1 AND email_verification_expires_at > now()
     RETURNING id, email`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    throw new AuthError('This verification link is invalid or has expired', 400);
  }
  return { user: result.rows[0] };
}

async function resendVerification(userId) {
  const result = await query(
    'SELECT email, email_verified_at FROM users WHERE id = $1',
    [userId]
  );
  if (result.rows.length === 0) {
    throw new AuthError('User not found', 404);
  }
  const { email, email_verified_at: emailVerifiedAt } = result.rows[0];
  if (emailVerifiedAt) {
    throw new AuthError('This email is already verified', 400);
  }

  const rawToken = generateRawToken();
  await query(
    `UPDATE users
     SET email_verification_token_hash = $1, email_verification_expires_at = $2
     WHERE id = $3`,
    [hashToken(rawToken), new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS), userId]
  );
  await deliverLink('Email verification', emailService.sendVerificationEmail, email, rawToken, '/verify-email');
  return { emailVerificationToken: rawToken };
}

// Always succeeds from the caller's point of view whether or not the email
// exists — otherwise this endpoint becomes an account-enumeration oracle.
async function requestPasswordReset(email) {
  const result = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (result.rows.length === 0) return {};

  const rawToken = generateRawToken();
  await query(
    `UPDATE users
     SET password_reset_token_hash = $1, password_reset_expires_at = $2
     WHERE id = $3`,
    [hashToken(rawToken), new Date(Date.now() + PASSWORD_RESET_TTL_MS), result.rows[0].id]
  );
  await deliverLink('Password reset', emailService.sendPasswordResetEmail, email, rawToken, '/reset-password');
  return { passwordResetToken: rawToken };
}

async function resetPassword(rawToken, newPassword) {
  const tokenHash = hashToken(rawToken);
  const result = await query(
    `SELECT id FROM users
     WHERE password_reset_token_hash = $1 AND password_reset_expires_at > now()`,
    [tokenHash]
  );
  if (result.rows.length === 0) {
    throw new AuthError('This password reset link is invalid or has expired', 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await query(
    `UPDATE users
     SET password_hash = $1, password_reset_token_hash = NULL, password_reset_expires_at = NULL
     WHERE id = $2`,
    [passwordHash, result.rows[0].id]
  );
}

async function login({ email, password }) {
  const result = await query(
    'SELECT id, email, password_hash, plan_id FROM users WHERE email = $1',
    [email]
  );
  if (result.rows.length === 0) {
    throw new AuthError('Invalid email or password', 401);
  }

  const user = result.rows[0];
  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    throw new AuthError('Invalid email or password', 401);
  }

  const token = issueToken(user);
  return {
    user: { id: user.id, email: user.email, plan_id: user.plan_id },
    token,
  };
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
}

function verifyToken(token) {
  return jwt.verify(token, config.jwt.secret);
}

module.exports = {
  signup,
  login,
  verifyToken,
  verifyEmail,
  resendVerification,
  requestPasswordReset,
  resetPassword,
  AuthError,
};
