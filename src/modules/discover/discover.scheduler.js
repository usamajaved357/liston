// Reads each watched category and keyword again once a day
// (discover.service.readDueWatches): a light tick every hour reads the few
// that are due, within Discover's share of the allowances, and once a day
// drops readings older than Discover keeps. Progress lives in the database
// (each watch's last reading), so a restart neither repeats nor skips one.
const config = require('../../config');
const logger = require('../../utils/logger');
const discoverService = require('./discover.service');

const TICK_MS = 60 * 60 * 1000;
const FIRST_TICK_MS = 3 * 60 * 1000;
const PRUNE_MS = 24 * 60 * 60 * 1000;

let timer = null;
let ticking = false;
let prunedAt = 0;

async function tick() {
  if (ticking) return 0;
  ticking = true;
  try {
    if (Date.now() - prunedAt > PRUNE_MS) {
      prunedAt = Date.now();
      await discoverService.pruneReads().catch((err) => logger.warn('Discover: old readings not pruned', { error: err.message }));
    }
    return await discoverService.readDueWatches({ limit: 5 });
  } catch (err) {
    logger.warn('Discover scheduler tick failed', { error: err.message });
    return 0;
  } finally {
    ticking = false;
  }
}

function start() {
  if (timer || config.env === 'test' || !config.discover.watchEnabled) return;
  setTimeout(() => tick(), FIRST_TICK_MS).unref();
  timer = setInterval(() => tick(), TICK_MS);
  timer.unref();
}

module.exports = { start, tick };
