// Thrown by the scrapers when a competitor/source page can't be read —
// never fabricate listing data, fail loud instead (same convention as
// EbayError/ConnectionError/ListingError elsewhere in the codebase).
class ScrapingError extends Error {
  constructor(message, { statusCode = 502, source } = {}) {
    super(message);
    this.statusCode = statusCode;
    this.source = source;
  }
}

module.exports = { ScrapingError };
