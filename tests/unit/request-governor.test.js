const test = require('node:test');
const assert = require('node:assert');
const governor = require('../../src/modules/ebay/request-governor');

test.beforeEach(() => governor._reset());

test('background reads stop at 80%, push reads at 92%, user reads keep going', async () => {
  governor._state.limit = 100;
  governor._state.used = 85;

  await assert.rejects(
    () => governor.withContext({ priority: 'background' }, () => governor.acquire('GetOrders')),
    (err) => err.code === 'EBAY_BUDGET'
  );
  const releasePush = await governor.withContext({ priority: 'push' }, () => governor.acquire('GetOrders'));
  releasePush();

  governor._state.used = 95;
  await assert.rejects(
    () => governor.withContext({ priority: 'push' }, () => governor.acquire('GetOrders')),
    (err) => err.code === 'EBAY_BUDGET'
  );
  const releaseUser = await governor.withContext({ priority: 'user' }, () => governor.acquire('GetOrders'));
  releaseUser();

  assert.deepStrictEqual(governor.snapshot().deferred, { background: 1, push: 1 });
});

test('once eBay has refused for the day, nothing is sent until the reset', async () => {
  governor._state.limit = 100;
  await governor.withContext({ priority: 'user', connectionId: 'c1' }, () =>
    assert.rejects(
      () =>
        governor.run('GetUser', async () => {
          const err = new Error("eBay's daily API allowance for Liston is used up for today.");
          err.statusCode = 429;
          throw err;
        }),
      /used up/
    )
  );
  assert.strictEqual(governor.snapshot().exhausted, true);
  await assert.rejects(() => governor.withContext({ priority: 'user' }, () => governor.acquire('GetUser')), (err) => err.code === 'EBAY_EXHAUSTED');
  await assert.rejects(() => governor.withContext({ priority: 'push' }, () => governor.acquire('GetUser')), (err) => err.code === 'EBAY_BUDGET');

  // The window rolls over: back in business.
  governor._state.resetAt = new Date(Date.now() - 1000).toISOString();
  await governor.withContext({ priority: 'user' }, () => governor.run('GetUser', async () => 'ok'));
  assert.strictEqual(governor.snapshot().exhausted, false);
  assert.strictEqual(governor.snapshot().used, 1);
});

test('run counts every call against the account it was made for', async () => {
  await governor.withContext({ priority: 'user', connectionId: 'acct-1' }, () => governor.run('GetOrders', async () => 'ok'));
  await governor.withContext({ priority: 'push', connectionId: 'acct-1' }, () => governor.run('GetMyeBaySelling', async () => 'ok'));
  await governor.withContext({ priority: 'push', connectionId: 'acct-2' }, () => governor.run('GetMyeBaySelling', async () => 'ok'));
  const snap = governor.snapshot();
  assert.strictEqual(snap.used, 3);
  assert.deepStrictEqual(snap.byAccount, { 'acct-1': 2, 'acct-2': 1 });
  assert.deepStrictEqual(snap.byCall, { GetOrders: 1, GetMyeBaySelling: 2 });
});

test('at most three calls in flight per account, and a waiting user call goes before a background one', async () => {
  const order = [];
  let releaseFirst;
  const gate = new Promise((r) => (releaseFirst = r));

  const busy = (name) =>
    governor.withContext({ priority: 'background', connectionId: 'acct-1' }, () =>
      governor.run(name, async () => {
        order.push(`start ${name}`);
        await gate;
      })
    );
  const a = busy('A');
  const b = busy('B');
  const c = busy('C');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(governor.snapshot().inFlight, 3);

  // Two more queue: a background one first, then a user one. The user one
  // must get the next free slot.
  const d = busy('D');
  const e = governor.withContext({ priority: 'user', connectionId: 'acct-1' }, () => governor.run('E', async () => order.push('start E')));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(governor.snapshot().waiting, 2);

  releaseFirst();
  await Promise.all([a, b, c, d, e]);
  assert.ok(order.indexOf('start E') < order.indexOf('start D'), order.join(', '));
});

test('a nested context overrides the outer one for its calls only', async () => {
  await governor.withContext({ priority: 'background', connectionId: 'x' }, async () => {
    assert.strictEqual(governor.current().priority, 'background');
    await governor.withContext({ priority: 'user' }, async () => {
      assert.deepStrictEqual(governor.current(), { priority: 'user', connectionId: 'x' });
    });
    assert.strictEqual(governor.current().priority, 'background');
  });
  assert.strictEqual(governor.current().priority, 'user'); // no context = a person is waiting
});
