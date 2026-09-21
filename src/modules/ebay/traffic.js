// Reading eBay's traffic report for one account, every call metered by
// analytics-budget. The analytics module decides WHAT to read and when;
// this is HOW, in eBay's terms: DAY reports for account totals (up to 90
// days per call) and LISTING reports for one day at a time (up to 200
// listings per call).
const ebayAnalytics = require('./api/ebay.analytics');
const budget = require('./analytics-budget');

const MAX_DAYS_PER_CALL = 90;

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Calls a per-listing day costs for an account with this many live listings. */
function callsForListingDay(listingCount) {
  return listingCount > ebayAnalytics.MAX_LISTING_IDS ? Math.ceil(listingCount / ebayAnalytics.MAX_LISTING_IDS) : 1;
}

/** Calls an account-totals read of this many days costs. */
function callsForAccountDays(from, to) {
  const days = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
  return Math.max(1, Math.ceil(days / MAX_DAYS_PER_CALL));
}

/**
 * Whole-account figures per day, `from`..`to` inclusive, oldest window
 * first. Resolves to [{ day, ...counts }].
 */
async function fetchAccountDays(accessToken, { connectionId, marketplaceId, from, to, kind }) {
  const rows = [];
  for (let start = from; start <= to; start = addDays(start, MAX_DAYS_PER_CALL)) {
    const end = [addDays(start, MAX_DAYS_PER_CALL - 1), to].sort()[0];
    const report = await budget.spend(kind, connectionId, () =>
      ebayAnalytics.getTrafficReport(accessToken, { dimension: 'DAY', marketplaceId, from: start, to: end })
    );
    rows.push(...ebayAnalytics.parseTrafficReport(report, 'DAY'));
  }
  return rows;
}

/**
 * Per-listing figures for one day. With up to 200 live listings one call
 * without a listing filter covers them (and any that sold or ended that
 * day); beyond that, the live listings go in batches of 200.
 * Resolves to [{ listingId, ...counts }].
 */
async function fetchListingDay(accessToken, { connectionId, marketplaceId, day, listingIds = [], kind }) {
  const batches = [];
  if (listingIds.length > ebayAnalytics.MAX_LISTING_IDS) {
    for (let i = 0; i < listingIds.length; i += ebayAnalytics.MAX_LISTING_IDS) batches.push(listingIds.slice(i, i + ebayAnalytics.MAX_LISTING_IDS));
  } else {
    batches.push(null);
  }
  if (!budget.allows(kind, batches.length)) {
    throw new budget.AnalyticsBudgetError("Today's allowance for eBay traffic data doesn't cover this read. It runs again after the reset.");
  }
  const rows = [];
  for (const batch of batches) {
    const report = await budget.spend(kind, connectionId, () =>
      // Unfiltered, eBay returns up to 200 listings: ask for the busiest.
      ebayAnalytics.getTrafficReport(accessToken, { dimension: 'LISTING', marketplaceId, from: day, to: day, listingIds: batch || undefined, sort: batch ? undefined : '-LISTING_IMPRESSION_TOTAL' })
    );
    rows.push(...ebayAnalytics.parseTrafficReport(report, 'LISTING'));
  }
  return rows;
}

module.exports = { fetchAccountDays, fetchListingDay, callsForListingDay, callsForAccountDays };
