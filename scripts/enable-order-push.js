#!/usr/bin/env node
// Turns on eBay's new-order push (Notification API, ORDER_CONFIRMATION) for
// every connected eBay account — see src/modules/ebay/order-push.js. Run it
// on the production server once the build with /api/ebay/commerce-notifications
// is live: eBay checks the endpoint the moment the destination is created.
// Accounts connected or reconnected later subscribe themselves.
//
//   node scripts/enable-order-push.js
//
// Uses EBAY_COMMERCE_NOTIFICATIONS_URL/_TOKEN, or by default the
// account-deletion endpoint's host and token. Costs a few Notification API
// calls per account (its own allowance), no Trading calls.
require('dotenv').config();
const config = require('../src/config');
const connectionRepository = require('../src/modules/connections/connection.repository');
const orderPush = require('../src/modules/ebay/order-push');
const { pool } = require('../src/db/client');

async function main() {
  if (!orderPush.configured()) {
    console.error('Set EBAY_COMMERCE_NOTIFICATIONS_URL (public https URL of /api/ebay/commerce-notifications) and a 32-80 character token, or EBAY_DELETION_ENDPOINT_URL/_TOKEN.');
    process.exit(1);
  }
  console.log(`Destination: ${config.ebay.commerceNotificationsUrl}`);
  const destinationId = await orderPush.ensureDestination();
  console.log(`  ✔ destination ${destinationId}`);

  const connections = await connectionRepository.findAllEbay();
  console.log(`${connections.length} eBay account(s)`);
  for (const connection of connections) {
    try {
      const result = await orderPush.subscribeConnection(connection.id, connection.user_id);
      console.log(`  ✔ ${connection.label} (${result.username || 'username hidden'}) — subscription ${result.subscriptionId}`);
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
