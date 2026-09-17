// A per-key in-memory cache for slow eBay reads, with two behaviours that
// together make pages feel instant:
//   - one fetch at a time per key: concurrent callers share the promise;
//   - stale-while-revalidate: within `freshMs` the copy is served as is; up
//     to `staleMs` it's served immediately while a refresh runs behind it;
//     only a cold or very old entry makes the caller wait.
// Nothing refreshes on a timer: eBay's Trading API gives an app a fixed
// daily call allowance, and a background refresh across every account
// burned through it. eBay is only ever called because someone looked.
// Process-local. Would move to Redis once this runs on several instances.
function createSwrCache({ freshMs, staleMs, fetcher }) {
  const entries = new Map(); // key -> { fetchedAt, value, meta, inflight, lastAccess, ctx }
  const MAX_ENTRIES = 500;

  function evictOld() {
    if (entries.size < MAX_ENTRIES) return;
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (now - (entry.lastAccess || 0) > staleMs) entries.delete(key);
    }
  }

  // `ctx` is whatever the fetcher needs (an access token, say); the latest
  // one seen is kept for background refreshes. The fetcher returns
  // { value, meta }; `meta` (a page count, for instance) is handed back to
  // the next fetch so it can be smarter the second time.
  async function get(key, ctx, { touch = true } = {}) {
    const entry = entries.get(key) || {};
    if (touch) entry.lastAccess = Date.now();
    entry.ctx = ctx;
    entries.set(key, entry);
    evictOld();
    const age = entry.fetchedAt ? Date.now() - entry.fetchedAt : Infinity;

    if (entry.value !== undefined && age < freshMs) return entry.value;

    if (!entry.inflight) {
      entry.inflight = Promise.resolve(fetcher(ctx, entry.meta))
        .then(({ value, meta }) => {
          Object.assign(entry, { fetchedAt: Date.now(), value, meta, inflight: null });
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

  function invalidate(key) {
    const entry = entries.get(key);
    if (entry) entry.fetchedAt = 0;
  }

  return { get, invalidate };
}

module.exports = { createSwrCache };
