const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { query } = require('../../db/client');
const config = require('../../config');

const SALT_ROUNDS = 12;

class AuthError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
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
  const result = await query(
    `INSERT INTO users (email, password_hash, plan_id)
     VALUES ($1, $2, $3)
     RETURNING id, email, plan_id, created_at`,
    [email, passwordHash, starterPlan.rows[0].id]
  );

  const user = result.rows[0];
  const token = issueToken(user);
  return { user, token };
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

module.exports = { signup, login, verifyToken, AuthError };
