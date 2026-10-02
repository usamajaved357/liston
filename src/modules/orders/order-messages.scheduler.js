// Sends the messages Liston sends buyers by itself (order-messages.service)
// every hour, to the accounts that switched them on: the delivered
// thank-you, and any order-placed welcome eBay's push didn't bring. Progress
// lives in order_messages, so a restart never repeats a message (one cut
// off mid-send is closed as failed, not resent). ORDER_MESSAGES=off stops it.
const config = require('../../config');
const logger = require('../../utils/logger');
const service = require('./order-messages.service');

const TICK_MS = 60 * 60 * 1000;
const FIRST_TICK_MS = 5 * 60 * 1000;
let timer = null;
let ticking = false;

async function tick() {
  if (ticking) return 0;
  ticking = true;
  try {
    return await service.runAll();
  } catch (err) {
    logger.warn('Order messages tick failed', { error: err.message });
    return 0;
  } finally {
    ticking = false;
  }
}

function start() {
  if (timer || config.env === 'test' || process.env.ORDER_MESSAGES === 'off') return;
  setTimeout(() => tick(), FIRST_TICK_MS).unref();
  timer = setInterval(() => tick(), TICK_MS);
  timer.unref();
}

module.exports = { start, tick };
