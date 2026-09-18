const createApp = require('./app');
const config = require('./config');
const logger = require('./utils/logger');
const { pool } = require('./db/client');
const aliexpressApi = require('./modules/sourcing/aliexpress/ds-api');
const governor = require('./modules/ebay/request-governor');

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(`Server listening on port ${config.port} (${config.env})`);
  aliexpressApi.startTokenKeepAlive();
  // Loads today's eBay usage and keeps it in step with eBay's own figure.
  governor.start();
});

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    await pool.end();
    logger.info('Shutdown complete');
    process.exit(0);
  });
  // Long-lived streams (the live-update event streams pages keep open) never
  // finish on their own, and server.close waits for them. End them now;
  // browsers reconnect to the new process by themselves.
  server.closeAllConnections();
  // And never hang a deploy: whatever is still open after a few seconds is
  // cut off.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
