const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const config = require('../../src/config');
const ebayOauth = require('../../src/modules/ebay/ebay.oauth');

// These tests mutate the shared config singleton's ebay block directly —
// simplest way to exercise "configured" vs "not configured" without adding
// a DI layer just for testing. Restored after each test.
function withEbayConfig(overrides, fn) {
  const original = { ...config.ebay };
  Object.assign(config.ebay, overrides);
  return Promise.resolve(fn()).finally(() => Object.assign(config.ebay, original));
}

test('signState/verifyState round-trips the payload', () => {
  const state = ebayOauth.signState({ userId: 'user-123', label: 'My eBay Store' });
  const payload = ebayOauth.verifyState(state);
  assert.strictEqual(payload.userId, 'user-123');
  assert.strictEqual(payload.label, 'My eBay Store');
});

test('verifyState rejects a tampered token', () => {
  const state = ebayOauth.signState({ userId: 'user-123', label: 'Store' });
  assert.throws(() => ebayOauth.verifyState(`${state}tampered`));
});

test('buildAuthorizeUrl throws a clear error when eBay is not configured', () => {
  return withEbayConfig({ clientId: null, clientSecret: null, ruName: null }, () => {
    assert.throws(() => ebayOauth.buildAuthorizeUrl('some-state'), /isn't configured/i);
  });
});

test('buildAuthorizeUrl includes client_id, redirect_uri, scope and state', () => {
  return withEbayConfig(
    { clientId: 'test-client-id', clientSecret: 'test-secret', ruName: 'test-ru-name', environment: 'SANDBOX' },
    () => {
      const url = new URL(ebayOauth.buildAuthorizeUrl('the-state-value'));
      assert.strictEqual(url.hostname, 'auth.sandbox.ebay.com');
      assert.strictEqual(url.searchParams.get('client_id'), 'test-client-id');
      assert.strictEqual(url.searchParams.get('redirect_uri'), 'test-ru-name');
      assert.strictEqual(url.searchParams.get('state'), 'the-state-value');
      assert.match(url.searchParams.get('scope'), /sell\.inventory/);
    }
  );
});

test('buildAuthorizeUrl points at production auth host when configured for production', () => {
  return withEbayConfig(
    { clientId: 'x', clientSecret: 'y', ruName: 'z', environment: 'PRODUCTION' },
    () => {
      const url = new URL(ebayOauth.buildAuthorizeUrl('state'));
      assert.strictEqual(url.hostname, 'auth.ebay.com');
    }
  );
});

test('exchangeCodeForToken posts the authorization_code grant and normalizes the response', async (t) => {
  await withEbayConfig({ clientId: 'cid', clientSecret: 'csecret', ruName: 'ru' }, async () => {
    const fetchMock = t.mock.fn(async (url, options) => {
      assert.match(url, /identity\/v1\/oauth2\/token$/);
      assert.match(options.body, /grant_type=authorization_code/);
      assert.match(options.body, /code=the-code/);
      return {
        ok: true,
        json: async () => ({
          access_token: 'access-123',
          expires_in: 7200,
          refresh_token: 'refresh-456',
          refresh_token_expires_in: 47304000,
        }),
      };
    });
    mock.method(global, 'fetch', fetchMock);

    const result = await ebayOauth.exchangeCodeForToken('the-code');
    assert.strictEqual(result.accessToken, 'access-123');
    assert.strictEqual(result.refreshToken, 'refresh-456');
    assert.ok(result.accessTokenExpiresAt > Date.now());
    assert.ok(result.refreshTokenExpiresAt > Date.now());
    assert.strictEqual(fetchMock.mock.calls.length, 1);
  });
});

test('refreshAccessToken keeps the existing refresh token when eBay does not return a new one', async (t) => {
  await withEbayConfig({ clientId: 'cid', clientSecret: 'csecret', ruName: 'ru' }, async () => {
    mock.method(global, 'fetch', async () => ({
      ok: true,
      json: async () => ({ access_token: 'new-access', expires_in: 7200 }),
    }));

    const result = await ebayOauth.refreshAccessToken('old-refresh-token');
    assert.strictEqual(result.accessToken, 'new-access');
    assert.strictEqual(result.refreshToken, 'old-refresh-token');
  });
});

test('requestToken throws with eBay error_description when the request fails', async (t) => {
  await withEbayConfig({ clientId: 'cid', clientSecret: 'csecret', ruName: 'ru' }, async () => {
    mock.method(global, 'fetch', async () => ({
      ok: false,
      json: async () => ({ error_description: 'invalid_grant' }),
    }));

    await assert.rejects(() => ebayOauth.exchangeCodeForToken('bad-code'), /invalid_grant/);
  });
});

test.after(() => {
  mock.restoreAll();
});
