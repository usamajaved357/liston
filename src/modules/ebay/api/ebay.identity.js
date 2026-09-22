// eBay's Identity API: who the token's seller is — their username and the
// immutable public user id that eBay's REST notifications carry (US
// usernames are being withdrawn from payloads). Scope
// commerce.identity.readonly, part of every connection's consent.
const { request } = require('./ebay.client');
const ebayOauth = require('./ebay.oauth');

function baseUrl() {
  return ebayOauth.isSandbox() ? 'https://apiz.sandbox.ebay.com' : 'https://apiz.ebay.com';
}

/** Resolves to { userId, username }. */
async function getUser(accessToken) {
  const data = await request(accessToken, 'GET', '/commerce/identity/v1/user/', undefined, undefined, { baseUrl: baseUrl() });
  return { userId: data.userId ? String(data.userId) : null, username: data.username ? String(data.username) : null };
}

module.exports = { getUser };
