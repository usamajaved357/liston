const test = require('node:test');
const assert = require('node:assert');
const { createSwrCache } = require('../../src/modules/ebay/swr-cache');

const tick = () => new Promise((r) => setImmediate(r));

test('a cold key is filled from durable storage without calling the fetcher', async () => {
  let fetches = 0;
  const cache = createSwrCache({
    freshMs: 1000,
    staleMs: 10000,
    fetcher: async () => {
      fetches++;
      return { value: 'from-ebay', meta: null };
    },
    load: async () => ({ value: 'from-db', meta: { pages: 2 }, syncedAt: Date.now() }),
    store: async () => {},
  });
  assert.strictEqual(await cache.get('k', {}), 'from-db');
  assert.strictEqual(fetches, 0);
  assert.ok(cache.syncedAt('k') > 0);
});

test('a persisted copy past its fresh window is served at once and refreshed behind it', async () => {
  let fetches = 0;
  const stored = [];
  const cache = createSwrCache({
    freshMs: 1000,
    staleMs: 10000,
    fetcher: async (ctx, meta, current) => {
      fetches++;
      return { value: `${current}+new`, meta: { from: meta } };
    },
    load: async () => ({ value: 'old', meta: { pages: 1 }, syncedAt: Date.now() - 5000 }),
    store: async (key, value, meta) => stored.push({ key, value, meta }),
  });
  assert.strictEqual(await cache.get('k', {}), 'old');
  assert.strictEqual(fetches, 1);
  await tick();
  await tick();
  assert.strictEqual(await cache.get('k', {}), 'old+new');
  assert.deepStrictEqual(stored[0], { key: 'k', value: 'old+new', meta: { from: { pages: 1 } } });
});

test('markStale keeps serving the copy while refreshing; patch changes it in place and persists', async () => {
  let fetches = 0;
  const stored = [];
  const cache = createSwrCache({
    freshMs: 1000,
    staleMs: 10000,
    fetcher: async () => {
      fetches++;
      return { value: [1, 2, 3], meta: null };
    },
    store: async (key, value) => stored.push(value),
  });
  assert.deepStrictEqual(await cache.get('k', {}), [1, 2, 3]);
  assert.strictEqual(fetches, 1);

  cache.patch('k', (items) => items.filter((i) => i !== 2));
  assert.deepStrictEqual(await cache.get('k', {}), [1, 3]);
  assert.strictEqual(fetches, 1);
  assert.deepStrictEqual(stored[stored.length - 1], [1, 3]);

  cache.markStale('k');
  assert.deepStrictEqual(await cache.get('k', {}), [1, 3]); // still the copy
  assert.strictEqual(fetches, 2); // refresh started behind it
});

test('refresh waits for a fresh read even when the copy is fresh', async () => {
  let fetches = 0;
  const cache = createSwrCache({
    freshMs: 100000,
    staleMs: 100000,
    fetcher: async () => ({ value: ++fetches, meta: null }),
  });
  assert.strictEqual(await cache.get('k', {}), 1);
  assert.strictEqual(await cache.get('k', {}), 1);
  assert.strictEqual(await cache.refresh('k'), 2);
});

test('invalidate before the first load still forces a fresh read of the persisted copy', async () => {
  let fetches = 0;
  const cache = createSwrCache({
    freshMs: 100000,
    staleMs: 100000,
    fetcher: async () => ({ value: `fetched-${++fetches}`, meta: null }),
    load: async () => ({ value: 'from-db', meta: null, syncedAt: Date.now() }),
  });
  cache.invalidate('k');
  assert.strictEqual(await cache.get('k', {}), 'fetched-1');

  const cache2 = createSwrCache({
    freshMs: 100000,
    staleMs: 900000,
    fetcher: async () => ({ value: 'fetched', meta: null }),
    load: async () => ({ value: 'from-db', meta: null, syncedAt: Date.now() }),
  });
  cache2.markStale('k');
  assert.strictEqual(await cache2.get('k', {}), 'from-db'); // served, refresh behind it
  await tick();
  await tick();
  assert.strictEqual(await cache2.get('k', {}), 'fetched');
});
