const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const listingService = require('../../src/modules/listings/listing.service');
const listingController = require('../../src/modules/listings/listing.controller');

test.afterEach(() => mock.restoreAll());

// Runs the draft save handler as Express would and returns what it sent.
async function save(body) {
  const sent = {};
  const res = {
    status(code) {
      sent.status = code;
      return this;
    },
    json(payload) {
      sent.body = payload;
      return this;
    },
  };
  await listingController.update({ params: { listingId: 'listing-1' }, ownerId: 'user-1', body }, res, (err) => {
    sent.error = err;
  });
  return sent;
}

test('a draft save that is refused says which field and what to do, not Zod’s wording', async () => {
  const cases = [
    [{ price: { value: '', currency: 'GBP' } }, 'The price is empty. Fill it in to save.', 'price.value'],
    [{ price: { value: '   ', currency: 'GBP' } }, 'The price is empty. Fill it in to save.', 'price.value'],
    [{ variants: { 2: { price: { value: '', currency: 'GBP' } } } }, "Variation 3's price is empty. Fill it in to save.", 'variants.2.price.value'],
    [{ listingPolicies: { fulfillmentPolicyId: '', paymentPolicyId: 'p', returnPolicyId: 'r' } }, 'Choose a postage policy for this draft.', 'listingPolicies.fulfillmentPolicyId'],
    [{ renameAxisValues: [{ axis: 'Colour', from: 'Red', to: '' }] }, 'The new name for option "Red" (Colour) is empty. Fill it in to save.', 'renameAxisValues.0.to'],
    [{ title: 'x'.repeat(81) }, 'eBay titles are limited to 80 characters', 'title'],
    [{ imageUrls: ['not a link'] }, "Photo 1 isn't a working image link. Remove it or upload the photo again.", 'imageUrls.0'],
  ];
  for (const [body, message, field] of cases) {
    const sent = await save(body);
    assert.strictEqual(sent.status, 400, field);
    assert.deepStrictEqual(sent.body, { error: message, field }, field);
    assert.doesNotMatch(sent.body.error, /String must contain/);
  }
});

test('a blank option name a supplier left can still be renamed or removed', async () => {
  const update = mock.method(listingService, 'updateDraft', async () => ({ listing: { id: 'listing-1' }, imageCheck: null }));
  const renamed = await save({ renameAxisValues: [{ axis: 'Style', from: '', to: 'Logo 1' }] });
  assert.strictEqual(renamed.status, 200);
  const removed = await save({ removeAxisValues: [{ axis: 'Style', value: '' }] });
  assert.strictEqual(removed.status, 200);
  assert.strictEqual(update.mock.calls.length, 2);
});

test("a draft's package saves in kg and cm, clears with null, and a zero weight is refused by name", async () => {
  const update = mock.method(listingService, 'updateDraft', async () => ({ listing: { id: 'listing-1' }, imageCheck: null }));
  assert.strictEqual((await save({ package: { weightKg: 0.45, lengthCm: 18, widthCm: 8, heightCm: 6 } })).status, 200);
  assert.strictEqual((await save({ package: { weightKg: 0.2, lengthCm: null, widthCm: null, heightCm: null } })).status, 200);
  assert.strictEqual((await save({ package: null })).status, 200);
  assert.deepStrictEqual(update.mock.calls[0].arguments[2].package, { weightKg: 0.45, lengthCm: 18, widthCm: 8, heightCm: 6 });
  const refused = await save({ package: { weightKg: 0 } });
  assert.strictEqual(refused.status, 400);
  assert.strictEqual(refused.body.field, 'package.weightKg');
  assert.strictEqual(refused.body.error, 'Enter the package weight in kg, above 0.');
});
