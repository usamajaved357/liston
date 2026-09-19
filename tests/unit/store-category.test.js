const test = require('node:test');
const assert = require('node:assert');
const { suggestStoreCategories } = require('../../src/modules/listings/store-category');

const shop = [
  { id: '1', name: 'New In', children: [] },
  { id: '2', name: 'Car Parts & Accessories', children: [{ id: '21', name: 'Interior Organisers', children: [] }, { id: '22', name: 'Cleaning', children: [] }] },
  { id: '3', name: 'Phone Cases', children: [] },
  { id: '4', name: 'Other', children: [] },
];

test('picks the department whose name matches the listing, preferring the deeper one', () => {
  const r = suggestStoreCategories(shop, { title: 'Black Coin Holder Cup Holder 8 Slots', categoryPath: ['Vehicle Parts & Accessories', 'Car Parts & Accessories', 'Interior Parts & Accessories', 'Storage & Organisers', 'Cup Holders'] });
  assert.deepStrictEqual(r, { names: ['/Car Parts & Accessories/Interior Organisers'], matched: true });
});

test('a phone case goes to Phone Cases', () => {
  const r = suggestStoreCategories(shop, { title: 'Shockproof Case for iPhone 15', categoryPath: ['Mobile Phones & Communication', 'Mobile Phone Accessories', 'Cases, Covers & Skins'] });
  assert.deepStrictEqual(r, { names: ['/Phone Cases'], matched: true });
});

test('falls back to the New In department when nothing matches', () => {
  const r = suggestStoreCategories(shop, { title: 'Thermal Cycling Gloves', categoryPath: ['Sporting Goods', 'Cycling', 'Gloves & Mittens'] });
  assert.deepStrictEqual(r, { names: ['/New In'], matched: false });
});

test('no departments, or none matching and no New In, means no Shop category', () => {
  assert.deepStrictEqual(suggestStoreCategories([], { title: 'x' }), { names: [], matched: false });
  assert.deepStrictEqual(suggestStoreCategories([{ id: '4', name: 'Other', children: [] }], { title: 'Gloves' }), { names: [], matched: false });
});

test('shop words and catalogue words meet: a car part is filed under "Tools, DIY & Auto"', () => {
  const shop = [
    { id: '1', name: 'Beauty, Health & Personal Care', children: [] },
    { id: '2', name: 'Tech, Phone & Audio', children: [] },
    { id: '3', name: 'Tools, DIY & Auto', children: [] },
    { id: '4', name: 'Other', children: [] },
  ];
  assert.deepStrictEqual(
    suggestStoreCategories(shop, { title: 'Black Coin Holder Cup Holder', categoryPath: ['Vehicle Parts & Accessories', 'Car Parts & Accessories', 'Cup Holders'] }),
    { names: ['/Tools, DIY & Auto'], matched: true }
  );
  assert.deepStrictEqual(
    suggestStoreCategories(shop, { title: 'USB Type-C Endoscope Camera', categoryPath: ['Mobile Phones & Communication', 'Mobile Phone Accessories'] }),
    { names: ['/Tech, Phone & Audio'], matched: true }
  );
});
