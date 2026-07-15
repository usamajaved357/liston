const crypto = require('crypto');
const config = require('../../config');

const ALGORITHM = 'aes-256-gcm';
const key = Buffer.from(config.credentialsEncryptionKey, 'base64');

if (key.length !== 32) {
  throw new Error(
    `CREDENTIALS_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  );
}

/**
 * Encrypts a JSON-serializable value (e.g. { appKey, appSecret, accessToken }).
 * Returns a single string safe to store in a JSONB/TEXT column.
 */
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Store iv + authTag + ciphertext together, base64-encoded
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypts a value produced by encrypt(). Throws if the payload was
 * tampered with or the key is wrong (GCM auth tag check).
 */
function decrypt(payload) {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

module.exports = { encrypt, decrypt };
