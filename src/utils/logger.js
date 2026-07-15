const winston = require('winston');

const isProd = process.env.NODE_ENV === 'production';

// Structured JSON always (Phase 0 requirement — easier to wire into
// error tracking / log aggregation later without reformatting).
// In local dev we layer a human-readable line on top for readability.
const consoleFormat = isProd
  ? winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json())
  : winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} [${level}] ${message}${extra}`;
      })
    );

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: { service: 'listing-automation-api' },
  transports: [new winston.transports.Console({ format: consoleFormat })],
});

module.exports = logger;
