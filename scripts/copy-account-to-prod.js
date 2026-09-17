#!/usr/bin/env node
// One-off: copy ONE account (user, team members, connections with their
// settings, listings, permissions) from the local database to production,
// re-encrypting platform credentials with the production key.
//
//   TARGET_DATABASE_URL=postgresql://... TARGET_CREDENTIALS_ENCRYPTION_KEY=... \
//     node scripts/copy-account-to-prod.js xcoderpc@gmail.com
//
// Plans and platforms are matched by name/key (their IDs differ per DB).
// Idempotent: rows are upserted by primary key.
require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');
const localEncryption = require('../src/modules/connections/credentials.encryption');

const email = process.argv[2];
const targetUrl = process.env.TARGET_DATABASE_URL;
const targetKey = process.env.TARGET_CREDENTIALS_ENCRYPTION_KEY;
if (!email || !targetUrl || !targetKey) {
  console.error('usage: TARGET_DATABASE_URL=… TARGET_CREDENTIALS_ENCRYPTION_KEY=… node scripts/copy-account-to-prod.js <email>');
  process.exit(1);
}
const key = Buffer.from(targetKey, 'base64');
if (key.length !== 32) {
  console.error('TARGET_CREDENTIALS_ENCRYPTION_KEY must decode to 32 bytes');
  process.exit(1);
}
// Same envelope as credentials.encryption.js, with the target key.
function encryptForTarget(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

const local = new Pool({ connectionString: process.env.DATABASE_URL });
const target = new Pool({ connectionString: targetUrl, ssl: targetUrl.includes('rlwy.net') ? { rejectUnauthorized: false } : undefined });

async function upsert(db, table, row, conflictKey = 'id') {
  const cols = Object.keys(row);
  const values = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' && !(row[c] instanceof Date) ? JSON.stringify(row[c]) : row[c]));
  const sets = cols.filter((c) => c !== conflictKey).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (${conflictKey}) DO UPDATE SET ${sets}`,
    values
  );
}

(async () => {
  const { rows: users } = await local.query('SELECT * FROM users WHERE email = $1', [email]);
  if (!users.length) throw new Error(`No local user ${email}`);
  const owner = users[0];

  // plan by name
  const { rows: planRows } = await local.query('SELECT name FROM plans WHERE id = $1', [owner.plan_id]);
  const { rows: targetPlan } = await target.query('SELECT id FROM plans WHERE name = $1', [planRows[0]?.name || 'starter']);
  if (!targetPlan.length) throw new Error('Target has no plans — has the seed run?');

  const members = (await local.query('SELECT * FROM users WHERE parent_user_id = $1', [owner.id])).rows;
  for (const u of [owner, ...members]) {
    await upsert(target, 'users', { ...u, plan_id: targetPlan[0].id, stripe_customer_id: null, stripe_subscription_id: null });
    console.log('user', u.email);
  }

  const connections = (await local.query('SELECT * FROM connections WHERE user_id = $1', [owner.id])).rows;
  for (const c of connections) {
    const { rows: platformKey } = await local.query('SELECT key FROM platforms WHERE id = $1', [c.destination_platform_id]);
    const { rows: targetPlatform } = await target.query('SELECT id FROM platforms WHERE key = $1', [platformKey[0].key]);
    // credentials is JSONB: { enc: <base64 envelope> }
    const plain = localEncryption.decrypt(c.credentials.enc);
    await upsert(target, 'connections', {
      ...c,
      destination_platform_id: targetPlatform[0].id,
      credentials: { enc: encryptForTarget(plain) },
    });
    console.log('connection', c.label);

    const listings = (await local.query('SELECT * FROM listings WHERE connection_id = $1', [c.id])).rows;
    for (const l of listings) await upsert(target, 'listings', l);
    console.log(`  listings: ${listings.length}`);
  }

  const perms = (await local.query('SELECT * FROM member_permissions WHERE member_user_id = ANY($1)', [members.map((m) => m.id)])).rows;
  for (const p of perms) await upsert(target, 'member_permissions', p);
  console.log('permissions', perms.length);

  const token = (await local.query("SELECT value FROM app_state WHERE key = 'aliexpress.token'")).rows[0];
  if (token) {
    await upsert(target, 'app_state', { key: 'aliexpress.token', value: token.value, updated_at: new Date() }, 'key');
    console.log('aliexpress token copied');
  }
  await local.end();
  await target.end();
  console.log('done');
})().catch(async (err) => {
  console.error('Failed:', err.message);
  await local.end().catch(() => {});
  await target.end().catch(() => {});
  process.exit(1);
});
