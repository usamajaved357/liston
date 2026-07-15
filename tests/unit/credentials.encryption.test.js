const test = require('node:test');
const assert = require('node:assert');
require('dotenv').config();

const { encrypt, decrypt } = require('../../src/modules/connections/credentials.encryption');

test('encrypt/decrypt round-trips an arbitrary credentials object', () => {
  const original = { appKey: 'abc123', appSecret: 'shh_secret', accessToken: 'tok_xyz' };
  const encrypted = encrypt(original);

  assert.notStrictEqual(encrypted, JSON.stringify(original), 'ciphertext should not equal plaintext');
  assert.deepStrictEqual(decrypt(encrypted), original);
});

test('decrypt rejects tampered ciphertext (GCM auth tag check)', () => {
  const encrypted = encrypt({ token: 'value' });
  const tampered = encrypted.slice(0, -4) + 'XXXX';

  assert.throws(() => decrypt(tampered));
});

test('encrypt produces different ciphertext for the same input each time (random IV)', () => {
  const value = { token: 'same-value' };
  const first = encrypt(value);
  const second = encrypt(value);

  assert.notStrictEqual(first, second, 'IV should be randomized per encryption');
  assert.deepStrictEqual(decrypt(first), value);
  assert.deepStrictEqual(decrypt(second), value);
});
