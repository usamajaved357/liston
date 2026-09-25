const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const { pool } = require('../../src/db/client');
const connectionRepository = require('../../src/modules/connections/connection.repository');
const listingRepository = require('../../src/modules/listings/listing.repository');

test.after(async () => {
  await pool.end();
});

async function owner() {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, access_status, plan_id)
     VALUES ($1, 'x', 'active', (SELECT id FROM plans WHERE name = 'starter')) RETURNING id`,
    [`test-${crypto.randomUUID()}@example.com`]
  );
  return rows[0].id;
}

async function draft(connectionId, title, errorMessage, variation = false) {
  const row = await listingRepository.createDraft({
    connectionId,
    sku: `SKU-${crypto.randomUUID()}`,
    generatedData: variation ? { commonTitle: title, variants: [] } : { title },
  });
  if (errorMessage) await listingRepository.updateStatus(row.id, 'pending_review', { errorMessage });
  return row;
}

test("research sees the drafts eBay refused for policy on any of the owner's accounts, and only theirs", async () => {
  const ownerId = await owner();
  const platform = await connectionRepository.findPlatformByKey('ebay');
  const uk = await connectionRepository.create({ userId: ownerId, destinationPlatformId: platform.id, label: 'Walexo', credentials: {} });
  const au = await connectionRepository.create({ userId: ownerId, destinationPlatformId: platform.id, label: 'Walexo AU', credentials: {} });
  await draft(uk.id, 'Toe Corrector Bunion Splint', 'This listing may be in violation of the VeRO program.');
  await draft(au.id, 'Bunion Night Splint', 'Hazardous Materials policy (PI_HAZ)', true);
  await draft(uk.id, 'Garden lights', 'The EAN field is missing.');
  await draft(uk.id, 'Socks', null);

  const other = await owner();
  const theirs = await connectionRepository.create({ userId: other, destinationPlatformId: platform.id, label: 'Other', credentials: {} });
  await draft(theirs.id, 'Toe Corrector', 'VeRO');

  const refusals = await listingRepository.findPolicyRefusals(ownerId);
  assert.deepStrictEqual(refusals.map((r) => r.title).sort(), ['Bunion Night Splint', 'Toe Corrector Bunion Splint']);
  const vero = refusals.find((r) => r.title === 'Toe Corrector Bunion Splint');
  assert.strictEqual(vero.account, 'Walexo');
  assert.match(vero.message, /VeRO/);
  assert.ok(vero.at instanceof Date);
});
