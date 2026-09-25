#!/usr/bin/env node
// Gives every eBay site an account sells on its own connection — what the
// "Add eBay Australia as its own account" button on an account's Overview
// does, for every account at once.
//
//   node scripts/split-ebay-sites.js           → lists what would be added
//   node scripts/split-ebay-sites.js --apply   → adds them
//
// Sites come from each account's copies of its listings and orders (eBay
// sends every site's to every connection of the account). No eBay sign-in
// and nothing written to eBay: the new connection reuses the account's
// token, as the button does. Run it against the deployed database
// (DATABASE_URL) to split production's accounts.
require('dotenv').config();
const { query, pool } = require('../src/db/client');
const connectionService = require('../src/modules/connections/connection.service');
const ebayService = require('../src/modules/ebay/ebay.service');

(async () => {
  const apply = process.argv.includes('--apply');
  const { rows } = await query(
    `SELECT c.id, c.user_id, c.label, u.email FROM connections c
     JOIN platforms p ON p.id = c.destination_platform_id JOIN users u ON u.id = c.user_id
     WHERE p.key = 'ebay' ORDER BY u.email, c.label, c.created_at`
  );
  let added = 0;
  for (const connection of rows) {
    let sites;
    try {
      sites = await connectionService.ebaySites(connection.user_id, connection.id, ebayService);
    } catch (err) {
      console.log(`  ${connection.email} · ${connection.label}: couldn't read its sites (${err.message})`);
      continue;
    }
    for (const site of sites.filter((s) => !s.connectionId)) {
      const what = `${connection.email} · ${connection.label} → ${site.marketplace.name} (${site.listings} listings, ${site.orders} orders)`;
      if (!apply) {
        console.log(`  would add ${what}`);
        continue;
      }
      try {
        const created = await connectionService.addEbaySite(connection.user_id, connection.id, site.marketplace.id, ebayService);
        added += 1;
        console.log(`  added ${what} as ${created.id}`);
      } catch (err) {
        console.log(`  skipped ${what}: ${err.message}`);
      }
    }
  }
  console.log(apply ? `\n${added} site${added === 1 ? '' : 's'} added.` : '\nNothing changed. Run with --apply to add them.');
  await pool.end();
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
