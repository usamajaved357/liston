const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const config = require('../../src/config');
const ebayController = require('../../src/modules/ebay/ebay.controller');

function mockRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('accountDeletionChallenge replies with the correct SHA-256 hash', () => {
  const originalToken = config.ebay.deletionVerificationToken;
  const originalEndpoint = config.ebay.deletionEndpointUrl;
  config.ebay.deletionVerificationToken = 'a'.repeat(40);
  config.ebay.deletionEndpointUrl = 'https://example.com/api/ebay/account-deletion';

  try {
    const req = { query: { challenge_code: '12345' } };
    const res = mockRes();

    ebayController.accountDeletionChallenge(req, res);

    const expectedHash = crypto
      .createHash('sha256')
      .update('12345')
      .update(config.ebay.deletionVerificationToken)
      .update(config.ebay.deletionEndpointUrl)
      .digest('hex');

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['Content-Type'], 'application/json');
    assert.deepStrictEqual(res.body, { challengeResponse: expectedHash });
  } finally {
    config.ebay.deletionVerificationToken = originalToken;
    config.ebay.deletionEndpointUrl = originalEndpoint;
  }
});

test('accountDeletionChallenge returns 400 when challenge_code is missing', () => {
  const req = { query: {} };
  const res = mockRes();

  ebayController.accountDeletionChallenge(req, res);

  assert.strictEqual(res.statusCode, 400);
});

test('accountDeletionChallenge returns 500 when not configured', () => {
  const originalToken = config.ebay.deletionVerificationToken;
  const originalEndpoint = config.ebay.deletionEndpointUrl;
  config.ebay.deletionVerificationToken = null;
  config.ebay.deletionEndpointUrl = null;

  try {
    const req = { query: { challenge_code: '12345' } };
    const res = mockRes();

    ebayController.accountDeletionChallenge(req, res);

    assert.strictEqual(res.statusCode, 500);
  } finally {
    config.ebay.deletionVerificationToken = originalToken;
    config.ebay.deletionEndpointUrl = originalEndpoint;
  }
});

test('accountDeletionNotification always acknowledges with 200', () => {
  const req = { body: { notification: { notificationId: 'abc-123' } } };
  const res = mockRes();

  ebayController.accountDeletionNotification(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, {});
});
