// A per-key cache for slow eBay reads, with the behaviours that together
// make pages feel instant and keep eBay calls rare:
//   - one fetch at a time per key: concurrent callers share the promise;
//   - stale-while-revalidate: within `freshMs` the copy is served as is; up
//     to `staleMs` it's served immediately while a refresh runs behind it;
//     only a cold or very old entry makes the caller wait;
//   - optional persistence: `load(key)` fills a cold entry from durable
//     storage (with the time it was synced, so the fresh/stale rules apply
//     to it as usual) and `store(key, value, meta)` writes each successful
//     fetch back. With it, a server restart costs no eBay calls at all.
// Nothing refreshes on a timer: eBay's Trading API gives an app a fixed
// daily call allowance, and a background refresh across every account
// burned through it. eBay is only ever called because someone looked.
// Process-local memory layer. Would move to Redis once this runs on
// several instances; the persistence hooks already make that safe.
// `freshMs` may be a function of the caller's ctx, so an account that gets
// push notifications from eBay can be given a much longer window than one
// that has to be polled.
function createSwrCache({ freshMs, staleMs, fetcher, load, store, onUpdate }) {
  const freshFor = (ctx) => (typeof freshMs === 'function' ? freshMs(ctx) : freshMs);
  const entries = new Map(); // key -> { fetchedAt, value, meta, inflight, loading, lastAccess, ctx }
  const MAX_ENTRIES = 500;

  function evictOld() {
    if (entries.size < MAX_ENTRIES) return;
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (now - (entry.lastAccess || 0) > staleMs) entries.delete(key);
    }
  }

  async function hydrate(key, entry) {
    if (!load || entry.value !== undefined || entry.hydrated) return;
    if (!entry.loading) {
      entry.loading = Promise.resolve(load(key))
        .then((persisted) => {
          if (persisted && persisted.value !== undefined && entry.value === undefined) {
            Object.assign(entry, { value: persisted.value, meta: persisted.meta, fetchedAt: persisted.syncedAt || 0 });
          }
        })
        .catch(() => {})
        .finally(() => {
          entry.hydrated = true;
          entry.loading = null;
        });
    }
    await entry.loading;
  }

  // `ctx` is whatever the fetcher needs (an access token, say); the latest
  // one seen is kept for background refreshes. The fetcher gets
  // (ctx, meta, currentValue) and returns { value, meta }; `meta` (a page
  // count, a last-sync time) is handed back to the next fetch so it can be
  // smarter, or incremental, the second time.
  async function get(key, ctx, { touch = true } = {}) {
    const entry = entries.get(key) || {};
    if (touch) entry.lastAccess = Date.now();
    entry.ctx = ctx;
    entries.set(key, entry);
    evictOld();
    await hydrate(key, entry);
    // An invalidate/markStale that arrived before the entry was loaded from
    // storage applies now, to the loaded copy.
    if (entry.forceRefresh) {
      entry.fetchedAt = 0;
      entry.forceRefresh = false;
    } else if (entry.staleRequested) {
      if (entry.fetchedAt) entry.fetchedAt = Math.min(entry.fetchedAt, Date.now() - freshFor(ctx));
      entry.staleRequested = false;
    }
    const age = entry.fetchedAt ? Date.now() - entry.fetchedAt : Infinity;

    if (entry.value !== undefined && age < freshFor(ctx)) return entry.value;

    if (!entry.inflight) {
      entry.inflight = Promise.resolve(fetcher(ctx, entry.meta, entry.value))
        .then(({ value, meta }) => {
          Object.assign(entry, { fetchedAt: Date.now(), value, meta, inflight: null });
          if (store) Promise.resolve(store(key, value, meta)).catch(() => {});
          if (onUpdate) onUpdate(key, value);
          return value;
        })
        .catch((err) => {
          entry.inflight = null;
          throw err;
        });
    }

    if (entry.value !== undefined && age < staleMs) {
      entry.inflight.catch(() => {});
      return entry.value;
    }
    return entry.inflight;
  }

  function entryFor(key) {
    let entry = entries.get(key);
    if (!entry) {
      entry = {};
      entries.set(key, entry);
    }
    return entry;
  }

  // Forget the copy entirely: the next look waits for a fresh read. Works
  // on a key not loaded yet (e.g. right after a restart) by deferring.
  function invalidate(key) {
    const entry = entryFor(key);
    if (entry.value !== undefined) entry.fetchedAt = 0;
    else entry.forceRefresh = true;
  }

  // Keep serving the copy, but refresh it behind the next look. The right
  // call after a change we made ourselves: the seller sees the page at
  // once and the eBay-side truth arrives a moment later.
  function markStale(key) {
    const entry = entryFor(key);
    if (entry.value !== undefined) {
      if (entry.fetchedAt) entry.fetchedAt = Math.min(entry.fetchedAt, Date.now() - freshFor(entry.ctx));
    } else {
      entry.staleRequested = true;
    }
  }

  // Replace the copy in place (and persist it), for changes whose outcome
  // we already know — no eBay call needed to reflect them.
  function patch(key, update) {
    const entry = entries.get(key);
    if (!entry || entry.value === undefined) return;
    entry.value = update(entry.value);
    if (store) Promise.resolve(store(key, entry.value, entry.meta)).catch(() => {});
    if (onUpdate) onUpdate(key, entry.value);
  }

  function syncedAt(key) {
    const entry = entries.get(key);
    return entry?.fetchedAt || null;
  }

  // Waits for a fresh read regardless of age; used by a manual refresh.
  async function refresh(key) {
    const entry = entries.get(key);
    if (!entry || !entry.ctx) return undefined;
    invalidate(key);
    return get(key, entry.ctx, { touch: false });
  }

  return { get, invalidate, markStale, patch, syncedAt, refresh };
}

module.exports = { createSwrCache };
