const jwt = require('jsonwebtoken');
const config = require('../../config');

const SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
];

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
    const err = new Error("eBay isn't configured yet — set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env");
    err.statusCode = 500;
    throw err;
  }
}

function assertRedirectConfigured() {
  assertAppCredentials();
  if (!config.ebay.ruName) {
    const err = new Error("eBay redirect isn't configured yet — set EBAY_RU_NAME in .env");
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
    const err = new Error(data.error_description || 'eBay rejected the token request');
    err.statusCode = 502;
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

async function refreshAccessToken(refreshToken) {
  const data = await requestToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: SCOPES.join(' '),
    })
  );
  return normalizeTokenResponse(data, refreshToken);
}

function normalizeTokenResponse(data, existingRefreshToken) {
  const now = Date.now();
  return {
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
  isSandbox,
  apiBaseUrl,
  signState,
  verifyState,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
};
