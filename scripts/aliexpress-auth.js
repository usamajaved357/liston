#!/usr/bin/env node
// One-time AliExpress consent for the Dropshipping API.
//
//   node scripts/aliexpress-auth.js            → prints the consent URL to open
//   node scripts/aliexpress-auth.js <code>     → exchanges the code, saves tokens
//
// The refresh token it saves (to the app_state table, with a local file copy)
// is what keeps the integration alive; access tokens refresh themselves from
// then on. Run it against the deployed database (DATABASE_URL) so production
// picks it up.
require('dotenv').config();
const dsApi = require('../src/modules/sourcing/aliexpress/ds-api');
const { pool } = require('../src/db/client');

(async () => {
  const code = process.argv[2];
  if (!code) {
    console.log('\nOpen this in a browser, approve the app, then run again with the `code` from the callback URL:\n');
    console.log(dsApi.authorizeUrl(), '\n');
    return;
  }
  const token = await dsApi.exchangeCode(code);
  console.log('Tokens saved. Access token expires', new Date(token.accessExpiresMs).toISOString());
  if (token.refreshExpiresMs) console.log('Refresh token valid until', new Date(token.refreshExpiresMs).toISOString());
  console.log('Saved to the app_state table (and .cache/aliexpress-token.json). The server refreshes it from here on.');
  await pool.end();
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
