const createApp = require('./app');
const config = require('./config');
const logger = require('./utils/logger');
const { pool } = require('./db/client');
const aliexpressApi = require('./modules/sourcing/aliexpress/ds-api');

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(`Server listening on port ${config.port} (${config.env})`);
  aliexpressApi.startTokenKeepAlive();
});

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    await pool.end();
    logger.info('Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
