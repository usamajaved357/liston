const { query } = require('../../db/client');
const { TRAFFIC_COLUMNS } = require('./analytics-days');

// The only file that touches the traffic tables (see migrations 016, 017):
//   ebay_traffic_days             account totals per day ('' listing) and
//                                 per-day rows for the busiest listings
//   ebay_traffic_listing_reports  each listing's totals for one exact range
//   ebay_traffic_sync             per-account bookkeeping

const ACCOUNT = ''; // listing_id of the whole-account rows

/**
 * Upserts traffic rows: { day, listingId? (omitted = account), ...counts }.
 * `final` false marks the running day, replaced once it's final.
 */
async function upsertTraffic(connectionId, rows, { final }) {
  if (!rows.length) return;
  const cols = ['connection_id', 'day', 'listing_id', ...TRAFFIC_COLUMNS, 'final'];
  const updates = [...TRAFFIC_COLUMNS, 'final'].map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  // In chunks: Postgres caps a statement at 65,535 parameters.
  const perChunk = Math.floor(60000 / cols.length);
  for (let start = 0; start < rows.length; start += perChunk) {
    const chunk = rows.slice(start, start + perChunk);
    const values = chunk.flatMap((row) => [connectionId, row.day, row.listingId || ACCOUNT, ...TRAFFIC_COLUMNS.map((c) => Number(row[c]) || 0), final]);
    const tuples = chunk.map((_, i) => `(${cols.map((__, j) => `$${i * cols.length + j + 1}`).join(', ')}, now())`);
    await query(
      `INSERT INTO ebay_traffic_days (${cols.join(', ')}, fetched_at) VALUES ${tuples.join(', ')}
       ON CONFLICT (connection_id, listing_id, day) DO UPDATE SET ${updates}, fetched_at = now()`,
      values
    );
  }
}

/** Removes one day's per-listing rows (before a fresh read of that day replaces them). */
async function clearListingDay(connectionId, day) {
  await query(`DELETE FROM ebay_traffic_days WHERE connection_id = $1 AND day = $2 AND listing_id <> $3`, [connectionId, day, ACCOUNT]);
}

/** Whole-account rows between two days, one per day. */
async function accountDays(connectionId, from, to) {
  const { rows } = await query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, ${TRAFFIC_COLUMNS.join(', ')}, final, fetched_at
     FROM ebay_traffic_days WHERE connection_id = $1 AND listing_id = $2 AND day BETWEEN $3 AND $4 ORDER BY day`,
    [connectionId, ACCOUNT, from, to]
  );
  return rows;
}

/** Listings that have day-by-day rows between two days. */
async function detailListingIds(connectionId, from, to) {
  const { rows } = await query(
    `SELECT DISTINCT listing_id FROM ebay_traffic_days WHERE connection_id = $1 AND listing_id <> $2 AND day BETWEEN $3 AND $4`,
    [connectionId, ACCOUNT, from, to]
  );
  return new Set(rows.map((r) => r.listing_id));
}

/** One listing's rows between two days, one per day. */
async function listingDays(connectionId, listingId, from, to) {
  const { rows } = await query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, ${TRAFFIC_COLUMNS.join(', ')}, final
     FROM ebay_traffic_days WHERE connection_id = $1 AND listing_id = $2 AND day BETWEEN $3 AND $4 ORDER BY day`,
    [connectionId, String(listingId), from, to]
  );
  return rows;
}

/** Drops rows older than the kept history. */
async function pruneBefore(connectionId, { accountBefore, listingBefore }) {
  await query(`DELETE FROM ebay_traffic_days WHERE connection_id = $1 AND listing_id = $2 AND day < $3`, [connectionId, ACCOUNT, accountBefore]);
  await query(`DELETE FROM ebay_traffic_days WHERE connection_id = $1 AND listing_id <> $2 AND day < $3`, [connectionId, ACCOUNT, listingBefore]);
}

/** Everything stored for an account (its days moved to another time zone). */
async function clearAccount(connectionId) {
  await query(`DELETE FROM ebay_traffic_days WHERE connection_id = $1`, [connectionId]);
  await query(`DELETE FROM ebay_traffic_listing_reports WHERE connection_id = $1`, [connectionId]);
  await query(`DELETE FROM ebay_traffic_sync WHERE connection_id = $1`, [connectionId]);
}

// ---- range reports --------------------------------------------------------------

const REPORT_COLUMNS = `to_char(from_day, 'YYYY-MM-DD') AS from_day, to_char(to_day, 'YYYY-MM-DD') AS to_day, scope, rows, cutoff, final, fetched_at`;

/** Every stored report for one exact range, keyed by scope. */
async function reportsFor(connectionId, from, to) {
  const { rows } = await query(`SELECT ${REPORT_COLUMNS} FROM ebay_traffic_listing_reports WHERE connection_id = $1 AND from_day = $2 AND to_day = $3`, [connectionId, from, to]);
  return new Map(rows.map((r) => [r.scope, r]));
}

async function saveReport(connectionId, { from, to, scope, rows, cutoff = null, final = true }) {
  await query(
    `INSERT INTO ebay_traffic_listing_reports (connection_id, from_day, to_day, scope, rows, cutoff, final, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (connection_id, from_day, to_day, scope)
     DO UPDATE SET rows = EXCLUDED.rows, cutoff = EXCLUDED.cutoff, final = EXCLUDED.final, fetched_at = now()`,
    [connectionId, from, to, scope, JSON.stringify(rows), cutoff, final]
  );
}

/**
 * Range reports are superseded daily (every range moves on), so they go
 * after a few days. A single day's report of the busiest listings is kept
 * as long as that day's detail rows: it holds the day's cutoff.
 */
async function pruneReports(connectionId, fetchedBefore, dayReportsBefore) {
  await query(
    `DELETE FROM ebay_traffic_listing_reports
     WHERE connection_id = $1 AND ((from_day <> to_day AND fetched_at < $2) OR (scope LIKE 'item:%' AND fetched_at < $2) OR to_day < $3)`,
    [connectionId, fetchedBefore, dayReportsBefore]
  );
}

// ---- sync bookkeeping ---------------------------------------------------------

const SYNC_FIELDS = ['time_zone', 'account_through', 'detail_days', 'today_day', 'today_fetched_at', 'refresh_day', 'refresh_count', 'last_error', 'last_synced_at'];

async function getSyncState(connectionId) {
  const { rows } = await query(
    `SELECT time_zone, to_char(account_through, 'YYYY-MM-DD') AS account_through,
            ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(detail_days) AS d ORDER BY d) AS detail_days,
            to_char(today_day, 'YYYY-MM-DD') AS today_day, today_fetched_at,
            to_char(refresh_day, 'YYYY-MM-DD') AS refresh_day, refresh_count, last_error, last_synced_at
     FROM ebay_traffic_sync WHERE connection_id = $1`,
    [connectionId]
  );
  return (
    rows[0] || { time_zone: null, account_through: null, detail_days: [], today_day: null, today_fetched_at: null, refresh_day: null, refresh_count: 0, last_error: null, last_synced_at: null }
  );
}

/** Saves the given fields of an account's sync state (others unchanged). */
async function saveSyncState(connectionId, fields) {
  const keys = Object.keys(fields).filter((k) => SYNC_FIELDS.includes(k));
  if (!keys.length) return;
  const cast = (k, i) => (k === 'detail_days' ? `$${i}::date[]` : `$${i}`);
  await query(
    `INSERT INTO ebay_traffic_sync (connection_id, ${keys.join(', ')}, updated_at)
     VALUES ($1, ${keys.map((k, i) => cast(k, i + 2)).join(', ')}, now())
     ON CONFLICT (connection_id) DO UPDATE SET ${keys.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, updated_at = now()`,
    [connectionId, ...keys.map((k) => fields[k])]
  );
}

/** Every account's sync state, for the admin page. */
async function allSyncStates() {
  const { rows } = await query(
    `SELECT connection_id, time_zone, to_char(account_through, 'YYYY-MM-DD') AS account_through, cardinality(detail_days) AS detail_day_count,
            refresh_count, to_char(refresh_day, 'YYYY-MM-DD') AS refresh_day, last_error, last_synced_at
     FROM ebay_traffic_sync`
  );
  return rows;
}

module.exports = {
  upsertTraffic,
  clearListingDay,
  accountDays,
  detailListingIds,
  listingDays,
  clearAccount,
  reportsFor,
  saveReport,
  pruneReports,
  pruneBefore,
  getSyncState,
  saveSyncState,
  allSyncStates,
};
