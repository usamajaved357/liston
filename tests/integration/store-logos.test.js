const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');

// Each eBay account's store logo on the account rail: read from Liston's
// copy of the store profile (no eBay call on the way), and an account with
// no copy, or one over a week old, read in the background, at most every
// ten minutes per workspace and every six hours per account.

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

async function owner() {
  const email = `logos-${crypto.randomUUID()}@example.com`;
  const res = await fetch(`${baseUrl}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'logospassword123', name: 'Usama' }) });
  const data = await res.json();
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  return { id: data.user.id, token: data.token };
}

const account = (ownerId, label) =>
  connectionService.createConnection(ownerId, {
    platformKey: 'ebay',
    label,
    credentials: { accessToken: 'fake', refreshToken: 'fake', accessTokenExpiresAt: Date.now() + 3600e3, marketplaceId: 'EBAY_GB' },
  });

async function storeProfile(connectionId, logoUrl, daysAgo = 0) {
  await pool.query(
    `INSERT INTO ebay_snapshots (connection_id, kind, data, synced_at) VALUES ($1, 'store_profile', $2, now() - make_interval(days => $3))`,
    [connectionId, JSON.stringify({ storeName: 'Store', logoUrl }), daysAgo]
  );
}

test("the account list carries each account's store logo from Liston's copy", async () => {
  const usama = await owner();
  const walexo = await account(usama.id, 'Walexo');
  const selvora = await account(usama.id, 'Selvora');
  await storeProfile(walexo.id, 'https://i.ebayimg.com/00/s/MTI1NFgxMjU0/z/JbMAAeSw-~pqbgS2/$_57.PNG?set_id=880000500F');

  const res = await fetch(`${baseUrl}/api/connections`, { headers: { Authorization: `Bearer ${usama.token}` } });
  assert.strictEqual(res.status, 200);
  const { connections } = await res.json();
  const logo = (id) => connections.find((c) => c.id === id).logo_url;
  // eBay's 140px copy of the logo, not the full upload.
  assert.strictEqual(logo(walexo.id), 'https://i.ebayimg.com/images/g/JbMAAeSw-~pqbgS2/s-l140.png');
  assert.strictEqual(logo(selvora.id), null);
});

test('accounts without a store profile, or one over a week old, are read in the background, not again for six hours', async () => {
  const usama = await owner();
  const fresh = await account(usama.id, 'Fresh');
  const old = await account(usama.id, 'Old');
  const never = await account(usama.id, 'Never');
  const lapsed = await account(usama.id, 'Lapsed');
  await storeProfile(fresh.id, 'https://i.ebayimg.com/fresh.png', 1);
  await storeProfile(old.id, 'https://i.ebayimg.com/old.png', 8);
  await pool.query("UPDATE connections SET status = 'expired' WHERE id = $1", [lapsed.id]);

  const asked = [];
  const ebay = {
    getStoreProfile: async (credentials, connectionId, options) => {
      assert.strictEqual(credentials.accessToken, 'fake', 'with the account’s own credentials');
      assert.strictEqual(options.priority, 'background');
      asked.push(connectionId);
      return { logoUrl: null };
    },
  };
  const now = Date.now();
  const read = await connectionService.refreshStoreLogos(usama.id, ebay, now);
  assert.deepStrictEqual(read.sort(), [old.id, never.id].sort());
  assert.deepStrictEqual(asked.sort(), [old.id, never.id].sort());

  // The same workspace within ten minutes: not even looked at.
  assert.deepStrictEqual(await connectionService.refreshStoreLogos(usama.id, ebay, now + 60e3), []);
  // Later, the two just tried wait out their six hours.
  assert.deepStrictEqual(await connectionService.refreshStoreLogos(usama.id, ebay, now + 11 * 60e3), []);
  assert.deepStrictEqual((await connectionService.refreshStoreLogos(usama.id, ebay, now + 7 * 3600e3)).sort(), [old.id, never.id].sort());
  assert.strictEqual(asked.length, 4);
});
