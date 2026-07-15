const logger = require('../utils/logger');

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const statusCode = err.statusCode || 500;

  if (statusCode >= 500) {
    // Never log request bodies here — credentials/passwords could be in them
    logger.error('Unhandled error', { message: err.message, stack: err.stack, path: req.path });
  }

  res.status(statusCode).json({
    error: statusCode >= 500 ? 'Internal server error' : err.message,
  });
}

module.exports = errorHandler;
