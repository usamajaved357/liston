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
    [{ listingPolicies: { fulfillmentPolicyId: '', paymentPolicyId: 'p', returnPolicyId: 'r' } }, 'The postage policy is empty. Fill it in to save.', 'listingPolicies.fulfillmentPolicyId'],
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
