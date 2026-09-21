const { query } = require('../../db/client');
const { TRAFFIC_COLUMNS } = require('./analytics-days');

// The only file that touches the traffic tables (see migration 016).

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

const sumColumns = TRAFFIC_COLUMNS.map((c) => `COALESCE(SUM(${c}), 0)::int AS ${c}`).join(', ');

/** Whole-account rows between two days, one per day. */
async function accountDays(connectionId, from, to) {
  const { rows } = await query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, ${TRAFFIC_COLUMNS.join(', ')}, final, fetched_at
     FROM ebay_traffic_days WHERE connection_id = $1 AND listing_id = $2 AND day BETWEEN $3 AND $4 ORDER BY day`,
    [connectionId, ACCOUNT, from, to]
  );
  return rows;
}

/** Per-listing totals between two days: Map(listingId -> counts). */
async function listingTotals(connectionId, from, to) {
  const { rows } = await query(
    `SELECT listing_id, ${sumColumns}
     FROM ebay_traffic_days WHERE connection_id = $1 AND listing_id <> $2 AND day BETWEEN $3 AND $4 GROUP BY listing_id`,
    [connectionId, ACCOUNT, from, to]
  );
  return new Map(rows.map((r) => [r.listing_id, r]));
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

// ---- sync bookkeeping ---------------------------------------------------------

const SYNC_FIELDS = ['account_through', 'listing_days', 'today_day', 'today_fetched_at', 'refresh_day', 'refresh_count', 'last_error', 'last_synced_at'];

async function getSyncState(connectionId) {
  const { rows } = await query(
    `SELECT to_char(account_through, 'YYYY-MM-DD') AS account_through,
            ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(listing_days) AS d ORDER BY d) AS listing_days,
            to_char(today_day, 'YYYY-MM-DD') AS today_day, today_fetched_at,
            to_char(refresh_day, 'YYYY-MM-DD') AS refresh_day, refresh_count, last_error, last_synced_at
     FROM ebay_traffic_sync WHERE connection_id = $1`,
    [connectionId]
  );
  return rows[0] || { account_through: null, listing_days: [], today_day: null, today_fetched_at: null, refresh_day: null, refresh_count: 0, last_error: null, last_synced_at: null };
}

/** Saves the given fields of an account's sync state (others unchanged). */
async function saveSyncState(connectionId, fields) {
  const keys = Object.keys(fields).filter((k) => SYNC_FIELDS.includes(k));
  if (!keys.length) return;
  const cast = (k, i) => (k === 'listing_days' ? `$${i}::date[]` : `$${i}`);
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
    `SELECT connection_id, to_char(account_through, 'YYYY-MM-DD') AS account_through, cardinality(listing_days) AS listing_day_count,
            refresh_count, to_char(refresh_day, 'YYYY-MM-DD') AS refresh_day, last_error, last_synced_at
     FROM ebay_traffic_sync`
  );
  return rows;
}

module.exports = {
  upsertTraffic,
  clearListingDay,
  accountDays,
  listingTotals,
  listingDays,
  pruneBefore,
  getSyncState,
  saveSyncState,
  allSyncStates,
};
