const test = require('node:test');
const assert = require('node:assert');
require('dotenv').config();

const { parseProxyConfig } = require('../../src/modules/scraping/browser');

test('parseProxyConfig returns undefined when no proxy URL is configured', () => {
  assert.strictEqual(parseProxyConfig(null), undefined);
  assert.strictEqual(parseProxyConfig(undefined), undefined);
});

test('parseProxyConfig splits credentials out of the URL for Playwright\'s proxy option', () => {
  const result = parseProxyConfig('http://myuser:mypass@proxy.example.com:8080');
  assert.deepStrictEqual(result, {
    server: 'http://proxy.example.com:8080',
    username: 'myuser',
    password: 'mypass',
  });
});

test('parseProxyConfig works with no credentials in the URL', () => {
  const result = parseProxyConfig('http://proxy.example.com:8080');
  assert.deepStrictEqual(result, { server: 'http://proxy.example.com:8080' });
});

test('parseProxyConfig decodes URL-encoded special characters in credentials', () => {
  const result = parseProxyConfig('http://user%40host:p%40ss@proxy.example.com:8080');
  assert.strictEqual(result.username, 'user@host');
  assert.strictEqual(result.password, 'p@ss');
});
