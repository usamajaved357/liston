#!/usr/bin/env node
// One-off: copy ONE account (user, team members, connections with their
// settings, listings, permissions) between two databases, re-encrypting
// platform credentials with the target's key. Works in both directions:
//
//   # local -> production
//   node scripts/copy-account.js xcoderpc@gmail.com --to-prod
//   # production -> local (to reproduce an account's data locally)
//   node scripts/copy-account.js talhaubaid001@gmail.com --from-prod
//
// Production is read from PROD_DATABASE_URL and PROD_CREDENTIALS_ENCRYPTION_KEY
// in .env; local from DATABASE_URL and CREDENTIALS_ENCRYPTION_KEY.
// Plans and platforms are matched by name/key (their IDs differ per DB).
// Idempotent: rows are upserted by primary key.
require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');
const { rebuildOrderActivity } = require('../src/modules/team/activity-backfill');

const email = process.argv[2];
const direction = process.argv[3];
if (!email || !['--to-prod', '--from-prod'].includes(direction)) {
  console.error('usage: node scripts/copy-account.js <email> --to-prod | --from-prod');
  process.exit(1);
}
const prod = { url: process.env.PROD_DATABASE_URL, key: process.env.PROD_CREDENTIALS_ENCRYPTION_KEY };
const localCfg = { url: process.env.DATABASE_URL, key: process.env.CREDENTIALS_ENCRYPTION_KEY };
if (!prod.url || !prod.key) {
  console.error('Set PROD_DATABASE_URL and PROD_CREDENTIALS_ENCRYPTION_KEY in .env');
  process.exit(1);
}
const [source, dest] = direction === '--to-prod' ? [localCfg, prod] : [prod, localCfg];

function keyOf(base64) {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('An encryption key must decode to 32 bytes');
  return key;
}
const sourceKey = keyOf(source.key);
const destKey = keyOf(dest.key);

// Same envelope as credentials.encryption.js.
function decryptWith(key, payload) {
  const raw = Buffer.from(payload, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
}
function encryptWith(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

const sslFor = (url) => (url.includes('rlwy.net') || url.includes('railway.app') ? { rejectUnauthorized: false } : undefined);
const local = new Pool({ connectionString: source.url, ssl: sslFor(source.url) });
const target = new Pool({ connectionString: dest.url, ssl: sslFor(dest.url) });

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
  if (!users.length) throw new Error(`No user ${email} in the source database`);
  const owner = users[0];

  // plan by name
  const { rows: planRows } = await local.query('SELECT name FROM plans WHERE id = $1', [owner.plan_id]);
  const { rows: targetPlan } = await target.query('SELECT id FROM plans WHERE name = $1', [planRows[0]?.name || 'starter']);
  if (!targetPlan.length) throw new Error('Target has no plans — has the seed run?');

  const hasTable = async (db, name) => (await db.query('SELECT to_regclass($1) AS t', [name])).rows[0].t !== null;
  const sourceHasActivity = await hasTable(local, 'public.member_activity');
  const targetHasActivity = await hasTable(target, 'public.member_activity');

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
    const plain = decryptWith(sourceKey, c.credentials.enc);
    await upsert(target, 'connections', {
      ...c,
      destination_platform_id: targetPlatform[0].id,
      credentials: { enc: encryptWith(destKey, plain) },
    });
    console.log('connection', c.label);

    const listings = (await local.query('SELECT * FROM listings WHERE connection_id = $1', [c.id])).rows;
    for (const l of listings) await upsert(target, 'listings', l);
    console.log(`  listings: ${listings.length}`);

    // Order history (down only — production's is its own): the timeline
    // (who placed, dispatched, refunded…) the team's activity is built
    // from, and the mirrored orders it reads titles and totals from.
    if (direction !== '--from-prod') continue;
    const orders = (await local.query('SELECT * FROM ebay_orders WHERE connection_id = $1', [c.id])).rows;
    for (const o of orders) await upsert(target, 'ebay_orders', o, 'connection_id, order_id');
    const events = (await local.query('SELECT * FROM order_events WHERE connection_id = $1', [c.id])).rows;
    for (const e of events) await upsert(target, 'order_events', e);
    console.log(`  orders: ${orders.length}, order events: ${events.length}`);
    if (sourceHasActivity) {
      const activity = (await local.query('SELECT * FROM member_activity WHERE connection_id = $1', [c.id])).rows;
      for (const a of activity) await upsert(target, 'member_activity', a);
      console.log(`  team activity: ${activity.length}`);
    }
  }

  // A source from before migration 021 has no team activity: build it here
  // from the order events just copied.
  if (direction === '--from-prod' && !sourceHasActivity && targetHasActivity) {
    const added = await rebuildOrderActivity(target, connections.map((c) => c.id));
    console.log(`team activity rebuilt from order events: ${added}`);
  }

  const perms = (await local.query('SELECT * FROM member_permissions WHERE member_user_id = ANY($1)', [members.map((m) => m.id)])).rows;
  for (const p of perms) await upsert(target, 'member_permissions', p);
  console.log('permissions', perms.length);

  // The AliExpress token only travels up to production, never down.
  const token = direction === '--to-prod' ? (await local.query("SELECT value FROM app_state WHERE key = 'aliexpress.token'")).rows[0] : null;
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
