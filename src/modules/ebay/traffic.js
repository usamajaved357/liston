// Reading eBay's traffic report for one account, every call metered by
// analytics-budget. The analytics module decides WHAT to read and when (and
// works out each range's dates and UTC offsets in the seller's time zone);
// this is HOW, in eBay's terms:
//   - DAY reports: whole-account figures per day, up to 90 days a call;
//   - LISTING reports: each listing's totals for one exact range. Without
//     a listing filter eBay returns at most 200 listings — asked here for
//     the 200 with the most impressions; with one, up to 200 named listings
//     a call.
const ebayAnalytics = require('./api/ebay.analytics');
const budget = require('./analytics-budget');

const TOP_SORT = '-TOTAL_IMPRESSION_TOTAL';

/** Calls reading every listing of an account costs. */
function callsForAllListings(listingCount) {
  return Math.max(1, Math.ceil(listingCount / ebayAnalytics.MAX_LISTING_IDS));
}

/**
 * Whole-account figures per day. `segments` are ranges of at most 90 days
 * that each keep one UTC offset (split at clock changes by the caller), one
 * call each. Resolves to [{ day, ...counts }].
 */
async function fetchAccountDays(accessToken, { connectionId, marketplaceId, segments, kind }) {
  if (!budget.allows(kind, segments.length)) {
    throw new budget.AnalyticsBudgetError("Today's allowance for eBay traffic data doesn't cover this read. It runs again after the reset.");
  }
  const rows = [];
  for (const range of segments) {
    const report = await budget.spend(kind, connectionId, () => ebayAnalytics.getTrafficReport(accessToken, { dimension: 'DAY', marketplaceId, range }));
    rows.push(...ebayAnalytics.parseTrafficReport(report, 'DAY'));
  }
  return rows;
}

/**
 * Each listing's totals for one range. `listingIds` null asks for the 200
 * listings with the most impressions (one call); `cutoff` is then the 200th
 * one's impressions when eBay's 200 were full — every other listing had
 * fewer — or null when the account has no more. With ids, every named
 * listing is read, 200 a call, and nothing is cut off.
 * Resolves to { rows: [{ listingId, ...counts }], cutoff }.
 */
async function fetchListingReport(accessToken, { connectionId, marketplaceId, range, listingIds = null, kind }) {
  const batches = [];
  if (listingIds) for (let i = 0; i < listingIds.length; i += ebayAnalytics.MAX_LISTING_IDS) batches.push(listingIds.slice(i, i + ebayAnalytics.MAX_LISTING_IDS));
  else batches.push(null);
  if (!budget.allows(kind, batches.length)) {
    throw new budget.AnalyticsBudgetError("Today's allowance for eBay traffic data doesn't cover this read. It runs again after the reset.");
  }
  const rows = [];
  for (const batch of batches) {
    const report = await budget.spend(kind, connectionId, () =>
      ebayAnalytics.getTrafficReport(accessToken, { dimension: 'LISTING', marketplaceId, range, listingIds: batch || undefined, sort: batch ? undefined : TOP_SORT })
    );
    rows.push(...ebayAnalytics.parseTrafficReport(report, 'LISTING'));
  }
  const full = !listingIds && rows.length >= ebayAnalytics.MAX_LISTING_IDS;
  const cutoff = full ? Math.min(...rows.map((r) => r.total_impressions)) : null;
  return { rows, cutoff };
}

module.exports = { fetchAccountDays, fetchListingReport, callsForAllListings, TOP_SORT };
