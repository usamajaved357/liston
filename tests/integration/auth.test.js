const test = require('node:test');
const assert = require('node:assert');
require('dotenv').config();

const authService = require('../../src/modules/auth/auth.service');
const { pool } = require('../../src/db/client');

test.after(async () => {
  await pool.end();
});

test('signup creates a user on the starter plan and returns a valid token', async () => {
  const email = `test-${Date.now()}@example.com`;
  const { user, token } = await authService.signup({ email, password: 'testpassword123' });

  assert.strictEqual(user.email, email);
  assert.ok(user.plan_id, 'user should be assigned a plan_id');
  assert.ok(token, 'signup should return a token');

  const payload = authService.verifyToken(token);
  assert.strictEqual(payload.sub, user.id);
});

test('signup rejects a duplicate email', async () => {
  const email = `test-${Date.now()}@example.com`;
  await authService.signup({ email, password: 'testpassword123' });

  await assert.rejects(
    () => authService.signup({ email, password: 'anotherpassword123' }),
    (err) => err.statusCode === 409
  );
});

test('login succeeds with correct credentials and fails with incorrect ones', async () => {
  const email = `test-${Date.now()}@example.com`;
  const password = 'testpassword123';
  await authService.signup({ email, password });

  const { user, token } = await authService.login({ email, password });
  assert.strictEqual(user.email, email);
  assert.ok(token);

  await assert.rejects(
    () => authService.login({ email, password: 'wrongpassword' }),
    (err) => err.statusCode === 401
  );
});

test('signup issues a usable email verification token', async () => {
  const email = `test-${Date.now()}@example.com`;
  const { emailVerificationToken } = await authService.signup({ email, password: 'testpassword123' });

  const { user } = await authService.verifyEmail(emailVerificationToken);
  assert.strictEqual(user.email, email);

  // Token is single-use — the second attempt with the same token must fail
  await assert.rejects(
    () => authService.verifyEmail(emailVerificationToken),
    (err) => err.statusCode === 400
  );
});

test('verifyEmail rejects an unknown token', async () => {
  await assert.rejects(
    () => authService.verifyEmail('not-a-real-token'),
    (err) => err.statusCode === 400
  );
});

test('resendVerification issues a new token and rejects an already-verified user', async () => {
  const email = `test-${Date.now()}@example.com`;
  const { user } = await authService.signup({ email, password: 'testpassword123' });

  const { emailVerificationToken } = await authService.resendVerification(user.id);
  assert.ok(emailVerificationToken);
  await authService.verifyEmail(emailVerificationToken);

  await assert.rejects(
    () => authService.resendVerification(user.id),
    (err) => err.statusCode === 400
  );
});

test('password reset flow: request token, reset password, log in with new password', async () => {
  const email = `test-${Date.now()}@example.com`;
  await authService.signup({ email, password: 'oldpassword123' });

  const { passwordResetToken } = await authService.requestPasswordReset(email);
  assert.ok(passwordResetToken);

  await authService.resetPassword(passwordResetToken, 'newpassword456');

  await assert.rejects(
    () => authService.login({ email, password: 'oldpassword123' }),
    (err) => err.statusCode === 401
  );
  const { user } = await authService.login({ email, password: 'newpassword456' });
  assert.strictEqual(user.email, email);

  // Token is single-use
  await assert.rejects(
    () => authService.resetPassword(passwordResetToken, 'anotherpassword789'),
    (err) => err.statusCode === 400
  );
});

test('requestPasswordReset does not reveal whether an email is registered', async () => {
  const result = await authService.requestPasswordReset('no-such-user@example.com');
  assert.strictEqual(result.passwordResetToken, undefined);
});
