// eBay's Analytics API (REST): the traffic report — how often a seller's
// listings were shown, viewed and bought. Needs the sell.analytics.readonly
// scope on the seller's token (see ebay.oauth).
//
// eBay's limits shape every caller of this file:
//   - ~100 traffic_report calls a day for the whole app (see
//     ebay/analytics-budget.js, which every call here must pass through);
//   - a day is eBay's reporting day, US Pacific time; at most 90 days per
//     call; the running day comes back partial;
//   - dimension DAY (one row per day, whole account) or LISTING (one row per
//     listing over the range), never both; LISTING returns at most 200
//     listings, so larger accounts pass listing ids in batches of 200.
const { request } = require('./ebay.client');

const METRICS = [
  'LISTING_IMPRESSION_TOTAL',
  'LISTING_IMPRESSION_SEARCH_RESULTS_PAGE',
  'LISTING_IMPRESSION_STORE',
  'TOTAL_IMPRESSION_TOTAL',
  'LISTING_VIEWS_TOTAL',
  'LISTING_VIEWS_SOURCE_SEARCH_RESULTS_PAGE',
  'LISTING_VIEWS_SOURCE_STORE',
  'LISTING_VIEWS_SOURCE_DIRECT',
  'LISTING_VIEWS_SOURCE_OFF_EBAY',
  'LISTING_VIEWS_SOURCE_OTHER_EBAY',
  'TRANSACTION',
];

// Our column for each eBay metric (see migration 016).
const COLUMN_FOR_METRIC = {
  LISTING_IMPRESSION_TOTAL: 'impressions',
  LISTING_IMPRESSION_SEARCH_RESULTS_PAGE: 'impressions_search',
  LISTING_IMPRESSION_STORE: 'impressions_store',
  TOTAL_IMPRESSION_TOTAL: 'total_impressions',
  LISTING_VIEWS_TOTAL: 'views',
  LISTING_VIEWS_SOURCE_SEARCH_RESULTS_PAGE: 'views_search',
  LISTING_VIEWS_SOURCE_STORE: 'views_store',
  LISTING_VIEWS_SOURCE_DIRECT: 'views_direct',
  LISTING_VIEWS_SOURCE_OFF_EBAY: 'views_off_ebay',
  LISTING_VIEWS_SOURCE_OTHER_EBAY: 'views_other_ebay',
  TRANSACTION: 'transactions',
};

const MAX_LISTING_IDS = 200;

// "2026-09-21" -> "20260921" (eBay's Pacific-day date format).
const compact = (day) => day.replace(/-/g, '');

/**
 * One traffic report. `from`/`to` are eBay days ("YYYY-MM-DD", inclusive).
 * Returns the raw report: { header, records, startDate, endDate, lastUpdatedDate }.
 */
function getTrafficReport(accessToken, { dimension, marketplaceId, from, to, listingIds, sort }) {
  const filter = [`marketplace_ids:{${marketplaceId}}`, `date_range:[${compact(from)}..${compact(to)}]`];
  if (listingIds?.length) {
    if (listingIds.length > MAX_LISTING_IDS) throw new Error(`At most ${MAX_LISTING_IDS} listing ids per traffic report`);
    filter.push(`listing_ids:{${listingIds.join('|')}}`);
  }
  const query = new URLSearchParams({ dimension, metric: METRICS.join(','), filter: filter.join(',') });
  if (sort) query.set('sort', sort);
  return request(accessToken, 'GET', `/sell/analytics/v1/traffic_report?${query.toString()}`, undefined, marketplaceId);
}

/**
 * The report's rows as { key, day?, listingId?, <column>: number }. The
 * header names each metric's position, so the column order eBay sends
 * doesn't matter. DAY keys are "YYYYMMDD" and come back as "YYYY-MM-DD".
 */
function parseTrafficReport(report, dimension) {
  const metricKeys = (report?.header?.metrics || []).map((m) => m.key);
  return (report?.records || []).map((record) => {
    const key = String(record.dimensionValues?.[0]?.value ?? '');
    const row = {};
    if (dimension === 'DAY') row.day = /^\d{8}$/.test(key) ? `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}` : key;
    else row.listingId = key;
    for (const column of Object.values(COLUMN_FOR_METRIC)) row[column] = 0;
    (record.metricValues || []).forEach((metric, i) => {
      const column = COLUMN_FOR_METRIC[metricKeys[i]];
      if (column) row[column] = Math.max(0, Math.round(Number(metric?.value) || 0));
    });
    return row;
  });
}

module.exports = { getTrafficReport, parseTrafficReport, METRICS, COLUMN_FOR_METRIC, MAX_LISTING_IDS };
