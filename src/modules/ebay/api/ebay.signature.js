// eBay's digital signatures (HTTP Message Signatures, RFC 9421, as eBay
// applies them). UK and EU sellers must sign every call that moves money:
// the whole Finances API, Fulfillment's issueRefund, and the Post-Order
// cancellation calls. Unsigned, eBay answers "Missing x-ebay-signature-key
// header" (215001) — confirmed live on getTransactions.
//
// The key pair comes from eBay's Key Management API: one createSigningKey
// call returns an Ed25519 private key plus a JWE (the public half, wrapped
// by eBay) that rides on every signed request as x-ebay-signature-key. The
// private key is a credential and lives, encrypted, with the connection's
// tokens. Keys last three years.
const crypto = require('crypto');
const { request } = require('./ebay.client');
const ebayOauth = require('./ebay.oauth');

function baseUrl() {
  return ebayOauth.isSandbox() ? 'https://apiz.sandbox.ebay.com' : 'https://apiz.ebay.com';
}

// { signingKeyId, jwe, privateKey, publicKey, expirationTime }.
async function createSigningKey(accessToken, marketplaceId) {
  const key = await request(accessToken, 'POST', '/developer/key_management/v1/signing_key', { signingKeyCipher: 'ED25519' }, marketplaceId, { baseUrl: baseUrl() });
  return {
    id: key.signingKeyId,
    jwe: key.jwe,
    privateKey: key.privateKey,
    publicKey: key.publicKey,
    expiresAt: key.expirationTime || null,
  };
}

// eBay hands the keys back as bare base64 DER (PKCS#8 / SPKI); Node wants
// PEM. Already-PEM input is left alone.
function toPem(key, label) {
  const text = String(key || '').trim();
  if (text.includes('-----BEGIN')) return text;
  const body = text.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function contentDigest(body) {
  return `sha-256=:${crypto.createHash('sha256').update(body).digest('base64')}:`;
}

// The signature base and Signature-Input, exactly as eBay's reference SDK
// builds them: each covered component on its own line, then the
// signature params. The body, when there is one, is covered through its
// Content-Digest; @path is the URL path without the query (RFC 9421).
function signatureBase({ method, url, body, jwe, created }) {
  const target = new URL(url);
  const components = [];
  if (body) components.push(['content-digest', contentDigest(body)]);
  components.push(['x-ebay-signature-key', jwe], ['@method', method.toUpperCase()], ['@path', target.pathname], ['@authority', target.host]);
  const params = `(${components.map(([name]) => `"${name}"`).join(' ')});created=${created}`;
  const base = components.map(([name, value]) => `"${name}": ${value}`).join('\n') + `\n"@signature-params": ${params}`;
  return { base, params };
}

// The headers that make a request signed: the key's JWE, the digest of the
// body, what was signed, and the signature itself.
function signatureHeaders({ method, url, body, key, now = Date.now() }) {
  const created = Math.floor(now / 1000);
  const { base, params } = signatureBase({ method, url, body, jwe: key.jwe, created });
  const signature = crypto.sign(null, Buffer.from(base, 'utf8'), toPem(key.privateKey, 'PRIVATE KEY')).toString('base64');
  return {
    'x-ebay-signature-key': key.jwe,
    'x-ebay-enforce-signature': 'true',
    ...(body ? { 'Content-Digest': contentDigest(body) } : {}),
    'Signature-Input': `sig1=${params}`,
    Signature: `sig1=:${signature}:`,
  };
}

// The other side, for tests: does this signature verify against the public
// key for these request parts?
function verifySignature({ method, url, body, headers, publicKey }) {
  const m = /created=(\d+)/.exec(headers['Signature-Input'] || '');
  if (!m) return false;
  const { base } = signatureBase({ method, url, body, jwe: headers['x-ebay-signature-key'], created: m[1] });
  const sig = /^sig1=:(.+):$/.exec(headers.Signature || '');
  if (!sig) return false;
  return crypto.verify(null, Buffer.from(base, 'utf8'), toPem(publicKey, 'PUBLIC KEY'), Buffer.from(sig[1], 'base64'));
}

function isExpired(key, now = Date.now()) {
  if (!key?.expiresAt) return false;
  // A week's margin: a key that dies mid-refund helps nobody.
  return new Date(key.expiresAt).getTime() - now < 7 * 24 * 60 * 60 * 1000;
}

module.exports = { createSigningKey, signatureHeaders, verifySignature, toPem, contentDigest, isExpired, baseUrl };
