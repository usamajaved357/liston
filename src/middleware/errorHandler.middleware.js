const logger = require('../utils/logger');

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const statusCode = err.statusCode || 500;

  if (statusCode >= 500) {
    // Never log request bodies here — credentials/passwords could be in them
    logger.error('Unhandled error', { message: err.message, stack: err.stack, path: req.path });
  }

  // A failure coming BACK from eBay isn't our server breaking, and hiding it
  // behind "Internal server error" cost real debugging time — a draft was
  // rejected with eBay's own, perfectly actionable "imageUrls cannot be null
  // or empty" and the user saw nothing but "internal error". Errors marked
  // `expose` carry a message that's safe and useful to show (upstream API
  // messages, never our internals), so they're passed through even at 5xx.
  const showMessage = statusCode < 500 || err.expose === true;

  res.status(statusCode).json({
    error: showMessage ? err.message : 'Internal server error',
  });
}

module.exports = errorHandler;
