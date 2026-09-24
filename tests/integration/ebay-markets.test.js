const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');
const connectionRepository = require('../../src/modules/connections/connection.repository');

test.after(async () => {
  await pool.end();
});

async function owner() {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, access_status, plan_id)
     VALUES ($1, 'x', 'active', (SELECT id FROM plans WHERE name = 'starter')) RETURNING id`,
    [email]
  );
  return rows[0].id;
}

// eBay stands in: the token names its seller.
function fakeEbay() {
  const calls = { forgotten: 0 };
  return {
    calls,
    identifySeller: async (tokens) => ({ userId: tokens.seller, username: `${tokens.seller}-name`, credentialsChanged: false, credentials: tokens }),
    detectMarketplace: async () => ({ marketplaceId: 'EBAY_GB' }),
    forgetMarketScopes: () => {
      calls.forgotten += 1;
    },
  };
}

const tokens = (seller, accessToken = 'a') => ({ seller, accessToken, refreshToken: 'r', accessTokenExpiresAt: Date.now() + 3600e3 });

test('one eBay account links once per site, and again on a site it has refreshes that link', async () => {
  const ownerId = await owner();
  const ebay = fakeEbay();
  const seller = `seller-${crypto.randomUUID()}`;

  const uk = await connectionService.connectEbayAccount(ownerId, { label: 'Walexo', marketplaceId: 'EBAY_GB', tokens: tokens(seller) }, ebay);
  const au = await connectionService.connectEbayAccount(ownerId, { label: 'Walexo', marketplaceId: 'EBAY_AU', tokens: tokens(seller) }, ebay);
  assert.strictEqual(uk.existing, false);
  assert.strictEqual(au.existing, false);
  assert.notStrictEqual(uk.connection.id, au.connection.id);

  const stored = await connectionRepository.findByIdForUser(au.connection.id, ownerId);
  assert.strictEqual(stored.settings.ebay.marketplaceId, 'EBAY_AU');
  assert.strictEqual(stored.settings.ebay.userId, seller);
  assert.strictEqual(stored.settings.pricing.currency, 'AUD');
  assert.strictEqual(ebay.calls.forgotten, 2);

  // The UK site again: no copy, the existing link gets the new sign-in.
  const again = await connectionService.connectEbayAccount(ownerId, { label: 'Walexo 2', marketplaceId: 'EBAY_GB', tokens: tokens(seller, 'fresh') }, ebay);
  assert.strictEqual(again.existing, true);
  assert.strictEqual(again.connection.id, uk.connection.id);
  const refreshed = await connectionService.getConnectionWithDecryptedCredentials(uk.connection.id, ownerId);
  assert.strictEqual(refreshed.credentials.accessToken, 'fresh');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM connections WHERE user_id = $1', [ownerId]);
  assert.strictEqual(rows[0].n, 2);

  // Each knows which sites the other holds.
  assert.deepStrictEqual(await connectionRepository.findMarketScope(uk.connection.id), { own: 'EBAY_GB', claimed: ['EBAY_AU'] });
  assert.deepStrictEqual(await connectionRepository.findMarketScope(au.connection.id), { own: 'EBAY_AU', claimed: ['EBAY_GB'] });
});

test('another seller is never mistaken for a second site of the first', async () => {
  const ownerId = await owner();
  const ebay = fakeEbay();
  const a = await connectionService.connectEbayAccount(ownerId, { label: 'A', marketplaceId: 'EBAY_GB', tokens: tokens(`a-${crypto.randomUUID()}`) }, ebay);
  const b = await connectionService.connectEbayAccount(ownerId, { label: 'B', marketplaceId: 'EBAY_GB', tokens: tokens(`b-${crypto.randomUUID()}`) }, ebay);
  assert.strictEqual(b.existing, false);
  assert.deepStrictEqual(await connectionRepository.findMarketScope(a.connection.id), { own: 'EBAY_GB', claimed: [] });
});

test('an account linked before sellers were recorded is recognised when its second site is linked', async () => {
  const ownerId = await owner();
  const seller = `old-${crypto.randomUUID()}`;
  const old = await connectionService.createConnection(ownerId, { platformKey: 'ebay', label: 'Old', credentials: tokens(seller) });
  await connectionRepository.mergeEbaySettings(old.id, { marketplaceId: 'EBAY_GB' });

  const au = await connectionService.connectEbayAccount(ownerId, { label: 'Old AU', marketplaceId: 'EBAY_AU', tokens: tokens(seller) }, fakeEbay());
  assert.strictEqual(au.existing, false);
  assert.deepStrictEqual(await connectionRepository.findMarketScope(old.id), { own: 'EBAY_GB', claimed: ['EBAY_AU'] });
});

test('extra sites of one account take no plan slot; a different account at the limit is refused', async () => {
  const ownerId = await owner();
  const ebay = fakeEbay();
  const seller = `plan-${crypto.randomUUID()}`;
  process.env.ENFORCE_PLAN_LIMITS = 'true';
  try {
    await connectionService.connectEbayAccount(ownerId, { label: 'W', marketplaceId: 'EBAY_GB', tokens: tokens(seller) }, ebay);
    const au = await connectionService.connectEbayAccount(ownerId, { label: 'W', marketplaceId: 'EBAY_AU', tokens: tokens(seller) }, ebay);
    assert.strictEqual(au.existing, false);
    assert.strictEqual(await connectionRepository.countByUser(ownerId), 1);
    await assert.rejects(
      connectionService.connectEbayAccount(ownerId, { label: 'Other', marketplaceId: 'EBAY_GB', tokens: tokens(`other-${crypto.randomUUID()}`) }, ebay),
      (err) => err.statusCode === 403
    );
  } finally {
    delete process.env.ENFORCE_PLAN_LIMITS;
  }
});

test('without a chosen site the account\'s home site is used', async () => {
  const ownerId = await owner();
  const { connection } = await connectionService.connectEbayAccount(ownerId, { label: 'Home', tokens: tokens(`home-${crypto.randomUUID()}`) }, fakeEbay());
  const stored = await connectionRepository.findByIdForUser(connection.id, ownerId);
  assert.strictEqual(stored.settings.ebay.marketplaceId, 'EBAY_GB');
});
