// Reads each hunted product's competitor once a day so its sales history
// builds up (hunting.service.readDueSales): a light tick every hour reads
// the few that are due, within their own share of the Browse allowance.
// Progress lives in the database (each reading's time), so a restart
// neither repeats a read nor skips one.
const config = require('../../config');
const logger = require('../../utils/logger');
const huntingService = require('./hunting.service');

const TICK_MS = 60 * 60 * 1000;
const FIRST_TICK_MS = 2 * 60 * 1000;

let timer = null;
let ticking = false;

async function tick() {
  if (ticking) return 0;
  ticking = true;
  try {
    return await huntingService.readDueSales({ limit: 20 });
  } catch (err) {
    logger.warn('Hunting scheduler tick failed', { error: err.message });
    return 0;
  } finally {
    ticking = false;
  }
}

function start() {
  if (timer || config.env === 'test' || !config.hunting.trackerEnabled) return;
  setTimeout(() => tick(), FIRST_TICK_MS).unref();
  timer = setInterval(() => tick(), TICK_MS);
  timer.unref();
}

module.exports = { start, tick };
