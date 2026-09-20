const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { signatureHeaders, verifySignature, contentDigest, isExpired, toPem } = require('../../src/modules/ebay/api/ebay.signature');

// A key pair in the shape eBay's Key Management API returns: bare base64
// DER, no PEM armour.
function fakeKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    jwe: 'eyJhbGciOiJBMjU2R0NNS1ciLCJlbmMiOiJBMjU2R0NNIn0.fake.jwe',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

test('signatureHeaders signs a GET the way eBay expects: key, method, path (no query), authority', () => {
  const key = fakeKey();
  const url = 'https://apiz.ebay.com/sell/finances/v1/transaction?filter=orderId:%7B04-15201-50944%7D&limit=50';
  const headers = signatureHeaders({ method: 'GET', url, key, now: 1663459378000 });
  assert.strictEqual(headers['x-ebay-signature-key'], key.jwe);
  assert.strictEqual(headers['x-ebay-enforce-signature'], 'true');
  assert.strictEqual(headers['Signature-Input'], 'sig1=("x-ebay-signature-key" "@method" "@path" "@authority");created=1663459378');
  assert.strictEqual(headers['Content-Digest'], undefined, 'no body, no digest');
  assert.match(headers.Signature, /^sig1=:[A-Za-z0-9+/=]+:$/);
  assert.ok(verifySignature({ method: 'GET', url, headers, publicKey: key.publicKey }));
  // Tampering with what was signed breaks it.
  assert.ok(!verifySignature({ method: 'POST', url, headers, publicKey: key.publicKey }));
});

test('signatureHeaders covers a body through its Content-Digest', () => {
  const key = fakeKey();
  const url = 'https://apiz.ebay.com/sell/fulfillment/v1/order/04-15201-50944/issue_refund';
  const body = JSON.stringify({ reasonForRefund: 'BUYER_CANCEL', orderLevelRefundAmount: { value: '4.74', currency: 'GBP' } });
  const headers = signatureHeaders({ method: 'POST', url, body, key });
  assert.strictEqual(headers['Content-Digest'], contentDigest(body));
  assert.match(headers['Signature-Input'], /^sig1=\("content-digest" "x-ebay-signature-key" "@method" "@path" "@authority"\);created=\d+$/);
  assert.ok(verifySignature({ method: 'POST', url, body, headers, publicKey: key.publicKey }));
  assert.ok(!verifySignature({ method: 'POST', url, body: body.replace('4.74', '9.74'), headers, publicKey: key.publicKey }));
});

test("contentDigest matches eBay's documented sha-256 form", () => {
  // eBay's example: the digest of {"hello": "world"}.
  assert.strictEqual(contentDigest('{"hello": "world"}'), 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:');
});

test('toPem wraps bare base64 and leaves PEM alone', () => {
  const pem = toPem('MC4CAQAwBQYDK2VwBCIEIA', 'PRIVATE KEY');
  assert.strictEqual(pem, '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA\n-----END PRIVATE KEY-----\n');
  assert.strictEqual(toPem(pem, 'PRIVATE KEY'), pem.trim());
});

test('isExpired flags a key within a week of its end, and never one without an end', () => {
  const now = Date.parse('2026-09-20T00:00:00Z');
  assert.strictEqual(isExpired({ expiresAt: '2029-09-20T00:00:00Z' }, now), false);
  assert.strictEqual(isExpired({ expiresAt: '2026-09-24T00:00:00Z' }, now), true);
  assert.strictEqual(isExpired({ expiresAt: null }, now), false);
});
