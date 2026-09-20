const jwt = require('jsonwebtoken');
const config = require('../../config');

// What a seller consents to when connecting. A token only ever carries the
// scopes that were in ITS consent link — the developer portal's list is what
// the app may ask for, not what any token has. Connections made before the
// order scopes were added keep working for listings; order actions on them
// say "reconnect" (see hasScope).
const SCOPE_INVENTORY = 'https://api.ebay.com/oauth/api_scope/sell.inventory';
const SCOPE_ACCOUNT = 'https://api.ebay.com/oauth/api_scope/sell.account';
const SCOPE_FULFILLMENT = 'https://api.ebay.com/oauth/api_scope/sell.fulfillment';
const SCOPE_FINANCES = 'https://api.ebay.com/oauth/api_scope/sell.finances';
const SCOPE_MARKETING = 'https://api.ebay.com/oauth/api_scope/sell.marketing';
const LEGACY_SCOPES = [SCOPE_INVENTORY, SCOPE_ACCOUNT];
// Every seller permission eBay offers a keyset like ours, asked for in one
// consent so an account never has to be reconnected for a feature added
// later. Verified against eBay's authorize endpoint for the production
// keyset (an unknown scope there fails with invalid_scope; this list is
// accepted). Roughly, what each is for:
//   inventory/account       listings, policies, locations (today)
//   fulfillment/finances    orders, dispatch, refunds, fees, payouts (today)
//   payment.dispute         chargebacks
//   marketing               Promoted Listings campaigns, promotions, coupons
//   analytics.readonly      traffic and seller-standards reports
//   reputation              feedback
//   stores                  Shop categories and settings
//   notification.subscription  event push subscriptions
//   identity.readonly       the seller's own user profile
//   vero / edelivery        VeRO reports, eDelivery (digital goods)
//   commerce.message        buyer messages (eBay's Messaging API) — the Inbox
//   commerce.feedback       feedback (newer Feedback API)
//   sell.listing            newer Listing API
//   api_scope               public read (Browse etc.) on the user token too
const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  SCOPE_INVENTORY,
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  SCOPE_ACCOUNT,
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  SCOPE_FULFILLMENT,
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  SCOPE_FINANCES,
  'https://api.ebay.com/oauth/api_scope/sell.payment.dispute',
  SCOPE_MARKETING,
  'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.reputation',
  'https://api.ebay.com/oauth/api_scope/sell.reputation.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.stores',
  'https://api.ebay.com/oauth/api_scope/sell.stores.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription',
  'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.vero',
  'https://api.ebay.com/oauth/scope/sell.edelivery',
  'https://api.ebay.com/oauth/api_scope/commerce.message',
  'https://api.ebay.com/oauth/api_scope/commerce.feedback',
  'https://api.ebay.com/oauth/api_scope/sell.listing',
];

// The scopes a stored credential set was granted. Older records predate the
// `scopes` field and were all issued with the legacy pair.
function grantedScopes(credentials) {
  return Array.isArray(credentials?.scopes) && credentials.scopes.length ? credentials.scopes : LEGACY_SCOPES;
}

function hasScope(credentials, scope) {
  return grantedScopes(credentials).includes(scope);
}

// The base "public data" scope. Note this identifier is literally api.ebay.com
// even in sandbox — scopes are names, not endpoints we call.
const APP_SCOPE = 'https://api.ebay.com/oauth/api_scope';

const STATE_TTL = '10m';

function isSandbox() {
  return config.ebay.environment !== 'PRODUCTION';
}

function authorizeBaseUrl() {
  return isSandbox() ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com';
}

function apiBaseUrl() {
  return isSandbox() ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
}

// Client ID/secret are needed for every token request (Basic auth). RU Name is
// only needed for the redirect-based flow (building the consent URL, and the
// authorization_code exchange) — a refresh_token grant never uses it, so it's
// checked separately rather than lumped into one blanket "not configured".
function assertAppCredentials() {
  if (!config.ebay.clientId || !config.ebay.clientSecret) {
    const err = new Error("eBay isn't configured yet. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env");
    err.statusCode = 500;
    throw err;
  }
}

function assertRedirectConfigured() {
  assertAppCredentials();
  if (!config.ebay.ruName) {
    const err = new Error("eBay redirect isn't configured yet. Set EBAY_RU_NAME in .env");
    err.statusCode = 500;
    throw err;
  }
}

// State ties the eBay redirect back to the Liston user who started the flow
// (and the label they chose) without needing a server-side pending-connection
// table — it's a short-lived signed token, not a session.
function signState(payload) {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: STATE_TTL, subject: 'ebay-oauth-state' });
}

function verifyState(token) {
  return jwt.verify(token, config.jwt.secret, { subject: 'ebay-oauth-state' });
}

function buildAuthorizeUrl(state) {
  assertRedirectConfigured();
  const params = new URLSearchParams({
    client_id: config.ebay.clientId,
    redirect_uri: config.ebay.ruName,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
  });
  return `${authorizeBaseUrl()}/oauth2/authorize?${params.toString()}`;
}

function basicAuthHeader() {
  const raw = `${config.ebay.clientId}:${config.ebay.clientSecret}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

// eBay's own wording for a failed token request is terse ("client
// authentication failed") and points nowhere. The two cases a seller can
// actually act on are named: a refresh token that belongs to a different app
// keyset than the one this server runs with (an account authorised on one
// environment and moved to another), and one eBay no longer honours
// (revoked, or past its 18 months). Both are fixed by reconnecting.
function describeTokenError(data) {
  if (data.error === 'invalid_client') {
    return "eBay didn't accept this server's app key for the account's token — the account was authorised under a different eBay app key. Reconnect the account from Connections.";
  }
  if (data.error === 'invalid_grant') {
    return `eBay no longer accepts this account's authorisation${data.error_description ? ` (${data.error_description})` : ''}. Reconnect the account from Connections.`;
  }
  return data.error_description || 'eBay rejected the token request';
}

async function requestToken(body) {
  assertAppCredentials();
  const res = await fetch(`${apiBaseUrl()}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body: body.toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(describeTokenError(data));
    err.statusCode = data.error === 'invalid_client' || data.error === 'invalid_grant' ? 401 : 502;
    err.ebayError = data.error;
    throw err;
  }
  return data;
}

async function exchangeCodeForToken(code) {
  assertRedirectConfigured();
  const data = await requestToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.ebay.ruName,
    })
  );
  return normalizeTokenResponse(data);
}

// Client-credentials grant: an APPLICATION token, tied to our developer keyset
// rather than to any seller. It carries only the public read scope, which is
// all the Browse/Taxonomy APIs need — reading public listings and category
// schemas involves no seller's account, so there's nothing to consent to.
async function requestApplicationToken() {
  const data = await requestToken(
    new URLSearchParams({
      grant_type: 'client_credentials',
      scope: APP_SCOPE,
    })
  );
  return {
    accessToken: data.access_token,
    accessTokenExpiresAt: Date.now() + data.expires_in * 1000,
  };
}

// A refresh must ask for the scopes the refresh token was granted — asking
// for more (say, the order scopes on a pre-orders token) is refused outright.
async function refreshAccessToken(refreshToken, scopes = LEGACY_SCOPES) {
  const data = await requestToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    })
  );
  return { ...normalizeTokenResponse(data, refreshToken), scopes };
}

function normalizeTokenResponse(data, existingRefreshToken) {
  const now = Date.now();
  return {
    scopes: SCOPES,
    accessToken: data.access_token,
    accessTokenExpiresAt: now + data.expires_in * 1000,
    // A refresh-token grant doesn't always return a new refresh token — keep
    // the existing one when eBay doesn't send a fresh one.
    refreshToken: data.refresh_token || existingRefreshToken,
    refreshTokenExpiresAt: data.refresh_token_expires_in
      ? now + data.refresh_token_expires_in * 1000
      : undefined,
  };
}

module.exports = {
  SCOPES,
  LEGACY_SCOPES,
  SCOPE_FULFILLMENT,
  SCOPE_FINANCES,
  SCOPE_MARKETING,
  grantedScopes,
  hasScope,
  isSandbox,
  apiBaseUrl,
  signState,
  verifyState,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  requestApplicationToken,
};
