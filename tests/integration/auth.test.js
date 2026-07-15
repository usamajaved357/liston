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
