const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const config = require('../../src/config');
const storage = require('../../src/lib/storage');

// Where shared files live, and whether they outlast a redeploy: a folder on
// the server's own disk doesn't (Railway empties it), a mounted volume or R2 does.

async function withStorage(settings, fn) {
  const saved = { dir: config.storage.dir, volume: config.storage.volume, r2: { ...config.storage.r2 } };
  Object.assign(config.storage, settings);
  try {
    return await fn();
  } finally {
    Object.assign(config.storage, saved);
  }
}

const NO_R2 = { accountId: null, accessKeyId: null, secretAccessKey: null, bucket: null };

test("a folder on the server's own disk is said not to last; on the mounted volume, or in R2, it does", async () => {
  await withStorage({ dir: '/app/storage', volume: null, r2: NO_R2 }, () => {
    assert.deepStrictEqual(storage.describe(), { lasting: false, where: "this server's own disk (/app/storage)" });
  });
  await withStorage({ dir: '/data/storage', volume: '/data', r2: NO_R2 }, () => {
    assert.deepStrictEqual(storage.describe(), { lasting: true, where: 'the mounted volume (/data/storage)' });
  });
  // A volume mounted somewhere else doesn't help a folder outside it.
  await withStorage({ dir: '/app/storage', volume: '/data', r2: NO_R2 }, () => assert.strictEqual(storage.describe().lasting, false));
  await withStorage({ dir: '/app/storage', volume: null, r2: { accountId: 'a', accessKeyId: 'k', secretAccessKey: 's', bucket: 'liston-files' } }, () => {
    assert.deepStrictEqual(storage.describe(), { lasting: true, where: 'Cloudflare R2 (bucket liston-files)' });
  });
});

test('exists says whether a file is still there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liston-storage-'));
  await withStorage({ dir, volume: null, r2: NO_R2 }, async () => {
    await storage.put('files/owner/one', Buffer.from('voice'), 'audio/mp4');
    assert.strictEqual(await storage.exists('files/owner/one'), true);
    assert.strictEqual(await storage.exists('files/owner/two'), false);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
