const test = require('node:test');
const assert = require('node:assert');
require('dotenv').config();

const config = require('../../src/config');
const storage = require('../../src/lib/storage');
const { detect } = require('../../src/modules/references/reference-detect');
const filesService = require('../../src/modules/files/files.service');

test('references in a message: Liston links, eBay order numbers, eBay listing links and item numbers, in the order written, each once', () => {
  const conn = 'f03b57ff-d9ee-415b-8bfa-45cae3146176';
  const hunt = '3b6f20e9-5e31-4f80-a193-9a2e23e206cc';
  assert.deepStrictEqual(
    detect(`see 13-15143-01089 then https://www.ebay.co.uk/itm/Some-Title/358376442432 and 147444373012 (and 13-15143-01089 again) http://localhost:3001/accounts/${conn}/hunting?open=${hunt}`),
    [
      { kind: 'order', id: '13-15143-01089' },
      { kind: 'listing', id: '358376442432' },
      { kind: 'listing', id: '147444373012' },
      { kind: 'hunt', id: hunt, connectionId: conn },
    ]
  );
  assert.deepStrictEqual(detect(`https://app.liston.co/accounts/${conn}/orders/20-15161-78659`), [{ kind: 'order', id: '20-15161-78659', connectionId: conn }]);
  assert.deepStrictEqual(detect(`/accounts/${conn}/listings?filter=active&q=358376442432`), [{ kind: 'listing', id: '358376442432', connectionId: conn }]);
  assert.deepStrictEqual(detect('call 07700900123 or 0123456789012, ref 1234-56789-12345'), [], 'phone numbers and longer runs are not item or order numbers');
  assert.strictEqual(detect(Array.from({ length: 9 }, (_, i) => `10000000000${i}`).join(' ')).length, 5, 'a few per message');
});

test('file names are kept without folders or control characters, shortened keeping the extension', () => {
  assert.strictEqual(filesService.cleanName('../../etc/passwd'), 'passwd');
  assert.strictEqual(filesService.cleanName('C:\\Users\\me\\photo.jpg'), 'photo.jpg');
  assert.strictEqual(filesService.cleanName('bad\u0000name\n.txt'), 'badname.txt');
  assert.strictEqual(filesService.cleanName(''), 'file');
  const long = filesService.cleanName(`${'a'.repeat(300)}.pdf`);
  assert.strictEqual(long.length, 180);
  assert.ok(long.endsWith('.pdf'));
});

test('storage: Cloudflare R2 once its four settings are set (through the S3 API), a local folder until then', async () => {
  const saved = { ...config.storage.r2 };
  try {
    Object.assign(config.storage.r2, { accountId: null, accessKeyId: null, secretAccessKey: null, bucket: null });
    assert.strictEqual(storage.driver(), 'local');
    assert.strictEqual(await storage.directUrl('files/x'), null, 'the local store streams through /media');
    assert.throws(() => storage.localPath('files/../../etc'), /Bad storage key/);

    Object.assign(config.storage.r2, { accountId: 'acc', accessKeyId: 'key', secretAccessKey: 'secret', bucket: 'liston-files' });
    assert.strictEqual(storage.driver(), 'r2');
    const sent = [];
    storage.useClient({
      send: async (command) => {
        sent.push({ name: command.constructor.name, input: command.input });
        if (command.constructor.name === 'GetObjectCommand') return { Body: (async function* () { yield Buffer.from('hello'); })(), ContentLength: 5 };
        return {};
      },
    });
    await storage.put('files/o/1', Buffer.from('hello'), 'text/plain');
    assert.strictEqual((await storage.readBuffer('files/o/1')).toString(), 'hello');
    await storage.remove('files/o/1');
    assert.deepStrictEqual(
      sent.map((s) => [s.name, s.input.Bucket, s.input.Key]),
      [
        ['PutObjectCommand', 'liston-files', 'files/o/1'],
        ['GetObjectCommand', 'liston-files', 'files/o/1'],
        ['DeleteObjectCommand', 'liston-files', 'files/o/1'],
      ]
    );
    assert.strictEqual(sent[0].input.ContentType, 'text/plain');
  } finally {
    Object.assign(config.storage.r2, saved);
    storage.useClient(null);
  }
});
