const { requestApplicationToken } = require('./ebay.oauth');

// An application token belongs to our developer keyset, not to a seller, so a
// single process-wide cache serves every request — unlike user tokens, which
// are per-connection and live encrypted in the DB.
//
// eBay issues these for 7200s. We refresh 5 minutes early so a token can't
// expire mid-flight on a request that's already been authorized.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

let cached = null;
// Concurrent callers (the orchestrator fires Browse + Taxonomy in parallel)
// must not each kick off their own token request — they await the same one.
let inFlight = null;

function isUsable(token) {
  return token && token.accessTokenExpiresAt - EXPIRY_MARGIN_MS > Date.now();
}

async function getApplicationToken() {
  if (isUsable(cached)) return cached.accessToken;

  if (!inFlight) {
    inFlight = requestApplicationToken()
      .then((token) => {
        cached = token;
        return token;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  const token = await inFlight;
  return token.accessToken;
}

// Tests only — the module-level cache would otherwise leak between cases.
function resetApplicationTokenCache() {
  cached = null;
  inFlight = null;
}

module.exports = { getApplicationToken, resetApplicationTokenCache };
