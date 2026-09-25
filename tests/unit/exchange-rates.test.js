const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const exchangeRates = require('../../src/modules/rates/exchange-rates');
const appState = require('../../src/db/app-state.repository');
const moneySummary = require('../../src/modules/overview/money-summary');

test.afterEach(() => {
  mock.restoreAll();
  exchangeRates.forget();
});

const answer = (rates, date = '2026-09-24') => new Response(JSON.stringify({ amount: 1, base: 'GBP', date, rates }), { status: 200 });

test('rates come from the ECB feed once, then from the kept copy', async () => {
  let saved = null;
  mock.method(appState, 'get', async () => saved);
  mock.method(appState, 'set', async (key, value) => {
    saved = value;
  });
  const calls = mock.method(global, 'fetch', async (url) => {
    assert.match(String(url), /base=GBP&symbols=USD,AUD/);
    return answer({ USD: 1.322, AUD: 1.8814 });
  });
  const first = await exchangeRates.ratesFor('GBP', ['GBP', 'USD', 'AUD', 'USD']);
  assert.deepStrictEqual(first, { rates: { USD: 1.322, AUD: 1.8814 }, date: '2026-09-24' });
  const again = await exchangeRates.ratesFor('GBP', ['USD']);
  assert.deepStrictEqual(again.rates, { USD: 1.322 });
  assert.strictEqual(calls.mock.calls.length, 1);
});

test('without a rate there is no conversion: null when the feed fails and nothing is kept', async () => {
  mock.method(appState, 'get', async () => null);
  mock.method(appState, 'set', async () => {});
  mock.method(global, 'fetch', async () => new Response('down', { status: 503 }));
  assert.strictEqual(await exchangeRates.ratesFor('GBP', ['USD']), null);
  // One currency only needs no rate at all.
  assert.deepStrictEqual(await exchangeRates.ratesFor('GBP', ['GBP']), { rates: {}, date: null });
});

test('a kept copy is used when the feed is down', async () => {
  mock.method(appState, 'get', async () => ({ rates: { USD: 1.3 }, date: '2026-09-20', fetchedAt: 0 }));
  mock.method(appState, 'set', async () => {});
  mock.method(global, 'fetch', async () => {
    throw new Error('offline');
  });
  assert.deepStrictEqual(await exchangeRates.ratesFor('GBP', ['USD']), { rates: { USD: 1.3 }, date: '2026-09-20' });
});

test('a market\'s money converts into another currency; counts and margin stay', () => {
  const us = { currency: 'USD', sales: 132.2, fees: 13.22, adFees: 0, refunds: 0, earnings: 119, sourceCost: 26.44, profit: 92.56, settledSales: 132.2, orders: 10, withEarnings: 10, margin: 70 };
  const gbp = moneySummary.convert(us, 1.322, 'GBP');
  assert.strictEqual(gbp.currency, 'GBP');
  assert.strictEqual(gbp.sales, 100);
  assert.strictEqual(gbp.fees, 10);
  assert.strictEqual(gbp.sourceCost, 20);
  assert.strictEqual(gbp.orders, 10);
  const total = moneySummary.addUp([gbp, { ...gbp, sales: 50, settledSales: 50, profit: 20 }], 'GBP');
  assert.strictEqual(total.sales, 150);
  assert.strictEqual(total.orders, 20);
});
