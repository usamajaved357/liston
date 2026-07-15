#!/usr/bin/env node
/**
 * Seeds plans and the platforms registry. Safe to re-run — uses
 * upsert-by-unique-key so it won't duplicate rows.
 */
const { Pool } = require('pg');
const config = require('../../config');

const PLANS = [
  { name: 'starter', max_connections: 1, listings_included_per_month: 150, overage_price_cents: 5, price_cents: 1500 },
  { name: 'basic', max_connections: 2, listings_included_per_month: 400, overage_price_cents: 5, price_cents: 3500 },
  { name: 'pro', max_connections: 3, listings_included_per_month: 800, overage_price_cents: 5, price_cents: 6500 },
  { name: 'pro_max', max_connections: 4, listings_included_per_month: 1400, overage_price_cents: 5, price_cents: 10900 },
  { name: 'pro_ultra', max_connections: 5, listings_included_per_month: 2200, overage_price_cents: 5, price_cents: 16900 },
];

// Final platform roles per the architecture doc: eBay + Amazon are both
// source and destination; AliExpress is source-only; TikTok Shop is
// destination-only. AliExpress/Amazon ship 'coming_soon' — Phase 2 flips
// status to 'active', no migration needed.
const PLATFORMS = [
  { key: 'ebay', name: 'eBay', role: 'both', status: 'active' },
  { key: 'tiktok_shop', name: 'TikTok Shop', role: 'destination', status: 'active' },
  { key: 'aliexpress', name: 'AliExpress', role: 'source', status: 'coming_soon' },
  { key: 'amazon', name: 'Amazon', role: 'both', status: 'coming_soon' },
];

async function seedPlans(pool) {
  for (const plan of PLANS) {
    await pool.query(
      `INSERT INTO plans (name, max_connections, listings_included_per_month, overage_price_cents, price_cents)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET
         max_connections = EXCLUDED.max_connections,
         listings_included_per_month = EXCLUDED.listings_included_per_month,
         overage_price_cents = EXCLUDED.overage_price_cents,
         price_cents = EXCLUDED.price_cents,
         updated_at = now()`,
      [plan.name, plan.max_connections, plan.listings_included_per_month, plan.overage_price_cents, plan.price_cents]
    );
    console.log(`seeded plan: ${plan.name}`);
  }
}

async function seedPlatforms(pool) {
  for (const platform of PLATFORMS) {
    await pool.query(
      `INSERT INTO platforms (key, name, role, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         status = EXCLUDED.status`,
      [platform.key, platform.name, platform.role, platform.status]
    );
    console.log(`seeded platform: ${platform.key} (${platform.status})`);
  }
}

async function grantActivePlatformsToAllPlans(pool) {
  // v1: every plan gets every currently-active platform (eBay + TikTok Shop).
  // Phase 2 gating (e.g. "AliExpress requires Pro+") is added later as
  // additional targeted INSERTs, not a change to this seed.
  await pool.query(`
    INSERT INTO plan_platform_access (plan_id, platform_id)
    SELECT p.id, pl.id FROM plans p, platforms pl
    WHERE pl.status = 'active'
    ON CONFLICT DO NOTHING;
  `);
  console.log('granted active platforms to all plans');
}

async function main() {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await seedPlans(pool);
    await seedPlatforms(pool);
    await grantActivePlatformsToAllPlans(pool);
    console.log('seed complete');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
