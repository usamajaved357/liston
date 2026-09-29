const test = require('node:test');
const assert = require('node:assert');

const focusing = require('../../src/modules/discover/discover-focus');

const listing = (over = {}) => ({
  title: 'Magnetic window cleaner double sided',
  price: { value: 12, currency: 'USD' },
  shipping: { cost: 0 },
  seller: { feedbackPercentage: 99.4, feedbackScore: 4200 },
  createdAt: new Date(Date.now() - 20 * 86400000).toISOString(),
  deliveryDates: null,
  ...over,
});

test('the filters that decide what Load more reads; none narrowing anything is no focus', () => {
  assert.strictEqual(focusing.focusOf({}), null);
  assert.strictEqual(focusing.focusOf({ brand: 'any', rating: 'any', size: 'any', fit: false }), null);
  const f = focusing.focusOf({ fq: ' Window  ', priceMin: '10', fit: 'true', brand: 'unbranded', listedWithin: 0 });
  assert.deepStrictEqual(f, { q: 'window', priceMin: 10, priceMax: null, fit: true, brand: 'unbranded', rating: 'any', size: 'any', listedWithin: null });
  assert.strictEqual(focusing.signature(f), focusing.signature(focusing.focusOf({ fq: 'window', priceMin: 10, fit: '1', brand: 'unbranded' })), 'the same filters, the same key');
});

test("a listing is read only when it can pass: words, what a buyer pays, delivery, the seller, age, a known brand", () => {
  const f = focusing.focusOf({ priceMin: 10, fq: 'window cleaner' });
  assert.strictEqual(focusing.passes(listing(), f), true);
  assert.strictEqual(focusing.passes(listing({ price: { value: 8 }, shipping: { cost: 2.5 } }), f), true, 'postage counts: £10.50 landed');
  assert.strictEqual(focusing.passes(listing({ price: { value: 8 }, shipping: { cost: 1 } }), f), false);
  assert.strictEqual(focusing.passes(listing({ title: 'Squeegee' }), f), false, 'every word in the title');
  // Delivering slower than the account can: not one to match (dates from when it was read).
  const now = new Date('2026-09-30T10:00:00Z').getTime();
  const slow = listing({ deliveryDates: { min: '2026-10-20T00:00:00Z', max: '2026-10-28T00:00:00Z' } });
  assert.strictEqual(focusing.passes(slow, focusing.focusOf({ fit: true }), { account: { min: 7, max: 10 }, takenAt: now }), false);
  assert.strictEqual(focusing.passes(slow, focusing.focusOf({ fit: true }), { account: null, takenAt: now }), true, 'no account window: not judged');
  assert.strictEqual(focusing.passes(listing({ seller: { feedbackPercentage: 97.1, feedbackScore: 50 } }), focusing.focusOf({ rating: 'good' })), false);
  assert.strictEqual(focusing.passes(listing(), focusing.focusOf({ size: 'small' })), false, '4,200 feedback is a medium seller');
  assert.strictEqual(focusing.passes(listing(), focusing.focusOf({ listedWithin: 14 })), false);
  const unbranded = focusing.focusOf({ brand: 'unbranded' });
  assert.strictEqual(focusing.passes(listing({ title: 'Unger magnetic window cleaner' }), unbranded, { brands: ['Unger', 'Ettore'] }), false);
  assert.strictEqual(focusing.passes(listing(), unbranded, { brands: ['Unger'] }), true);
});

test('the eBay search for more within the filters: the words, the price at eBay (room for postage), an unbranded Brand in a category', () => {
  const f = focusing.focusOf({ fq: 'double sided', priceMin: 10, priceMax: 30, brand: 'unbranded' });
  assert.deepStrictEqual(focusing.searchOf({ categoryId: '20563', q: null }, f, { currency: 'USD' }), {
    q: 'double sided',
    filter: 'buyingOptions:{FIXED_PRICE},price:[8.5..30],priceCurrency:USD',
    aspectFilter: 'categoryId:20563,Brand:{Unbranded|Unbranded/Generic|Generic|Does not apply}',
  });
  const keyword = focusing.searchOf({ categoryId: null, q: 'window cleaner' }, focusing.focusOf({ brand: 'unbranded' }), { currency: 'GBP' });
  assert.deepStrictEqual(keyword, { q: 'window cleaner', filter: 'buyingOptions:{FIXED_PRICE}', aspectFilter: undefined }, 'a keyword has no category to ask for a Brand in');
});
