#!/usr/bin/env node
// Subscribes every connected eBay account to Platform Notifications, so
// eBay tells Liston when a listing or order changes instead of Liston
// polling. Run once after setting EBAY_NOTIFICATIONS_URL (and again for any
// account connected later — or connect flows can call the same function).
//
//   node scripts/enable-ebay-notifications.js [--url https://.../api/ebay/notifications]
//
// Costs two Trading calls per account (SetNotificationPreferences, GetUser).
require('dotenv').config();
const config = require('../src/config');
const connectionRepository = require('../src/modules/connections/connection.repository');
const connectionService = require('../src/modules/connections/connection.service');
const ebayService = require('../src/modules/ebay/ebay.service');
const { pool } = require('../src/db/client');

async function main() {
  const urlArg = process.argv.indexOf('--url');
  const url = urlArg > -1 ? process.argv[urlArg + 1] : config.ebay.notificationsUrl;
  if (!url || !/^https:\/\//.test(url)) {
    console.error('Set EBAY_NOTIFICATIONS_URL (public https URL of /api/ebay/notifications) or pass --url.');
    process.exit(1);
  }

  const connections = await connectionRepository.findAllEbay();
  console.log(`${connections.length} eBay account(s) → ${url}`);
  for (const connection of connections) {
    try {
      const result = await connectionService.withDecryptedCredentials(connection.id, connection.user_id, (credentials) =>
        ebayService.enableNotifications(credentials, url)
      );
      await connectionService.updateConnectionSettings(connection.id, connection.user_id, {
        ebay: { ...(connection.settings?.ebay || {}), username: result.username, notificationsEnabledAt: new Date().toISOString() },
      });
      console.log(`  ✔ ${connection.label} (${result.username})`);
    } catch (err) {
      console.log(`  ✖ ${connection.label}: ${err.message}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
