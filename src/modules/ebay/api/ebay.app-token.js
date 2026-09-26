const { requestApplicationToken } = require('./ebay.oauth');

// An application token belongs to our developer keyset, not to a seller, so a
// single process-wide cache serves every request — unlike user tokens, which
// are per-connection and live encrypted in the DB.
//
// eBay issues these for 7200s. We refresh 5 minutes early so a token can't
// expire mid-flight on a request that's already been authorized.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

// One token per scope: the public-data one, and one per API that needs its
// own (Marketplace Insights). Concurrent callers (the orchestrator fires
// Browse + Taxonomy in parallel) must not each kick off their own token
// request — they await the same one.
const cached = new Map(); // scope ('' = the public-data scope) -> token
const inFlight = new Map();

function isUsable(token) {
  return token && token.accessTokenExpiresAt - EXPIRY_MARGIN_MS > Date.now();
}

async function getApplicationToken(scope) {
  const key = scope || '';
  if (isUsable(cached.get(key))) return cached.get(key).accessToken;

  if (!inFlight.has(key)) {
    inFlight.set(
      key,
      requestApplicationToken(scope)
        .then((token) => {
          cached.set(key, token);
          return token;
        })
        .finally(() => {
          inFlight.delete(key);
        })
    );
  }

  const token = await inFlight.get(key);
  return token.accessToken;
}

// Tests only — the module-level cache would otherwise leak between cases.
function resetApplicationTokenCache() {
  cached.clear();
  inFlight.clear();
}

module.exports = { getApplicationToken, resetApplicationTokenCache };
