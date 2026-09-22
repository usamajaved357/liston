// Keeps every account's traffic current without anyone opening the page: a
// light check every few minutes asks each eBay account "is a read due?"
// (analytics.service.isDue) — its totals and every listing's day once the
// day is complete (02:00 in the seller's time zone), then older days of
// listing history from whatever allowance isn't held back for the other
// accounts' nightly reads — and syncs the ones that are, one at a time. Progress lives in
// the database, so a restart neither repeats a read nor skips one. No job
// queue needed; moves to BullMQ with the other background work (§9).
const config = require('../../config');
const logger = require('../../utils/logger');
const connectionRepository = require('../connections/connection.repository');
const repo = require('./analytics.repository');
const service = require('./analytics.service');

const TICK_MS = 10 * 60 * 1000;
const FIRST_TICK_MS = 60 * 1000;

let timer = null;
let ticking = false;

async function tick(now = new Date()) {
  if (ticking) return { skipped: true };
  ticking = true;
  const synced = [];
  try {
    const connections = await connectionRepository.findAllEbay();
    for (const connection of connections) {
      const state = await repo.getSyncState(connection.id);
      if (!service.isDue(state, now, { reserve: await service.nightlyReserve(now) })) continue;
      try {
        await service.syncAccount(connection.id, connection.user_id, { now });
        synced.push(connection.id);
      } catch (err) {
        // Recorded on the account (last_error); the next tick tries again.
        logger.warn('Scheduled analytics sync failed', { connectionId: connection.id, error: err.message });
      }
    }
  } catch (err) {
    logger.warn('Analytics scheduler tick failed', { error: err.message });
  } finally {
    ticking = false;
  }
  return { synced };
}

function start() {
  if (timer || config.env === 'test' || !config.analytics.schedulerEnabled) return;
  setTimeout(() => tick(), FIRST_TICK_MS).unref();
  timer = setInterval(() => tick(), TICK_MS);
  timer.unref();
}

module.exports = { start, tick };
