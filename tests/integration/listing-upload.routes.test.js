const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');

const app = createApp();
let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function token() {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const res = await fetch(`${baseUrl}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'testpassword123' }) });
  const data = await res.json();
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  return data.token;
}

test('a photo upload bigger than the app-wide 2MB body limit reaches the upload route', async () => {
  const auth = await token();
  // A 3MB body (an ordinary AI-made PNG, base64) to a draft that doesn't
  // exist: refused as "not found" by the route, not "too large" before it.
  const res = await fetch(`${baseUrl}/api/listings/${crypto.randomUUID()}/images/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify({ dataUrl: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` }),
  });
  assert.notStrictEqual(res.status, 413);
  assert.ok([403, 404].includes(res.status), `got ${res.status}`);

  // Every other route keeps the 2MB limit.
  const other = await fetch(`${baseUrl}/api/users/me/avatar`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify({ avatarUrl: 'x'.repeat(3 * 1024 * 1024) }),
  });
  assert.strictEqual(other.status, 413);
});
