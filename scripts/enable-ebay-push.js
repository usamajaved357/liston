#!/usr/bin/env node
// Turns on eBay's push (Notification API) for every connected eBay account:
// new orders (ORDER_CONFIRMATION) and listing changes (LISTING) — see
// src/modules/ebay/ebay-push.js. Run it with PRODUCTION's environment once
// the build with /api/ebay/commerce-notifications is live: eBay checks the
// endpoint the moment the destination is created. Accounts connected or
// reconnected later subscribe themselves.
//
//   node scripts/enable-ebay-push.js
//
// Uses EBAY_COMMERCE_NOTIFICATIONS_URL/_TOKEN, or by default the
// account-deletion endpoint's host and token. Costs a few Notification API
// calls per account (its own allowance), no Trading calls.
require('dotenv').config();
const config = require('../src/config');
const connectionRepository = require('../src/modules/connections/connection.repository');
const ebayPush = require('../src/modules/ebay/ebay-push');
const { pool } = require('../src/db/client');

async function main() {
  if (!ebayPush.configured()) {
    console.error('Set EBAY_COMMERCE_NOTIFICATIONS_URL (public https URL of /api/ebay/commerce-notifications) and a 32-80 character token, or EBAY_DELETION_ENDPOINT_URL/_TOKEN.');
    process.exit(1);
  }
  console.log(`Destination: ${config.ebay.commerceNotificationsUrl}`);
  const destinationId = await ebayPush.ensureDestination();
  console.log(`  ✔ destination ${destinationId}`);

  const connections = await connectionRepository.findAllEbay();
  console.log(`${connections.length} eBay account(s)`);
  for (const connection of connections) {
    try {
      const result = await ebayPush.subscribeConnection(connection.id, connection.user_id);
      const topics = Object.entries(result.topics).map(([topic, id]) => `${topic} ${id ? '✔' : '✖'}`).join(', ');
      console.log(`  ✔ ${connection.label} (${result.username || 'username hidden'}) — ${topics}`);
    } catch (err) {
      console.log(`  ✖ ${connection.label}: ${err.message}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
