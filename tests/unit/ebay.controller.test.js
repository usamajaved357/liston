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

test('oauthCallback links the chosen site, and sends a site already linked back to that account', async () => {
  const { mock } = require('node:test');
  const ebayOauth = require('../../src/modules/ebay/api/ebay.oauth');
  const connectionService = require('../../src/modules/connections/connection.service');
  const ebayPush = require('../../src/modules/ebay/ebay-push');
  mock.method(ebayOauth, 'verifyState', () => ({ userId: 'owner-1', label: 'Walexo', marketplaceId: 'EBAY_AU' }));
  mock.method(ebayOauth, 'exchangeCodeForToken', async () => ({ accessToken: 'a', refreshToken: 'r' }));
  mock.method(ebayPush, 'subscribeInBackground', () => {});
  let existing = false;
  const linked = mock.method(connectionService, 'connectEbayAccount', async () => ({ connection: { id: 'conn-au' }, existing }));
  const redirectRes = () => ({ location: null, redirect(url) { this.location = url; } });
  try {
    const first = redirectRes();
    await ebayController.oauthCallback({ query: { code: 'c', state: 's' } }, first);
    assert.deepStrictEqual(linked.mock.calls[0].arguments.slice(0, 2), ['owner-1', { label: 'Walexo', marketplaceId: 'EBAY_AU', tokens: { accessToken: 'a', refreshToken: 'r' } }]);
    assert.match(first.location, /\/dashboard\?connected=ebay$/);

    existing = true;
    const again = redirectRes();
    await ebayController.oauthCallback({ query: { code: 'c', state: 's' } }, again);
    assert.match(again.location, /\/accounts\/conn-au\?alreadyConnected=1$/);

    linked.mock.mockImplementation(async () => {
      throw Object.assign(new Error('plan'), { statusCode: 403 });
    });
    const full = redirectRes();
    await ebayController.oauthCallback({ query: { code: 'c', state: 's' } }, full);
    assert.match(full.location, /ebayError=plan_limit$/);
  } finally {
    mock.restoreAll();
  }
});

test('oauthCallback reconnects every market of the account and says how many; a different seller is sent back with a reason', async () => {
  const { mock } = require('node:test');
  const ebayOauth = require('../../src/modules/ebay/api/ebay.oauth');
  const connectionService = require('../../src/modules/connections/connection.service');
  const ebayPush = require('../../src/modules/ebay/ebay-push');
  mock.method(ebayOauth, 'verifyState', () => ({ userId: 'owner-1', label: 'Minsu', connectionId: 'conn-uk', returnTo: '/connections' }));
  mock.method(ebayOauth, 'exchangeCodeForToken', async () => ({ accessToken: 'a' }));
  const subscribed = mock.method(ebayPush, 'subscribeInBackground', () => {});
  const reconnect = mock.method(connectionService, 'reconnectEbayAccount', async () => ({ connection: { id: 'conn-uk' }, siblings: ['conn-au'] }));
  const redirectRes = () => ({ location: null, redirect(url) { this.location = url; } });
  try {
    const res = redirectRes();
    await ebayController.oauthCallback({ query: { code: 'c', state: 's' } }, res);
    assert.strictEqual(reconnect.mock.calls[0].arguments[1], 'conn-uk');
    assert.match(res.location, /\/connections\?reconnected=1&sites=2$/);
    assert.deepStrictEqual(subscribed.mock.calls.map((c) => c.arguments[0]), ['conn-uk', 'conn-au']);

    reconnect.mock.mockImplementation(async () => {
      throw Object.assign(new Error('different'), { statusCode: 403 });
    });
    const wrong = redirectRes();
    await ebayController.oauthCallback({ query: { code: 'c', state: 's' } }, wrong);
    assert.match(wrong.location, /ebayError=different_account$/);
  } finally {
    mock.restoreAll();
  }
});
