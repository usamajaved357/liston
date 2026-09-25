const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const email = require('../../src/utils/email');

// A test file started on its own (no NODE_ENV=test) once reached the real
// mail key and emailed an access request for every fixture owner.
test('any file Node’s test runner runs counts as a test, so no real email goes out', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'run by node --test');
  assert.strictEqual(config.env, 'test');
  const result = await email.sendAccessRequestEmail('admin@gmail.com', {
    applicantEmail: 'someone@gmail.com',
    approveLink: 'https://x/approve',
    rejectLink: 'https://x/reject',
  });
  assert.strictEqual(result.sent, false);
});

test('reserved test addresses are recognised, real ones are not', () => {
  for (const address of ['owner-1f2e@example.com', 'x@example.org', 'a@b.example.net', 'u@shop.test', 'u@nowhere.invalid', 'u@dev.localhost', ' OTHER-1@EXAMPLE.COM ']) {
    assert.strictEqual(email.isReservedAddress(address), true, address);
  }
  for (const address of ['xcoderpc@gmail.com', 'me@example.co.uk', 'me@myexample.com', 'test@company.com', '', null]) {
    assert.strictEqual(email.isReservedAddress(address), false, String(address));
  }
});
