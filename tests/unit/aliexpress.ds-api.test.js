const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const dsApi = require('../../src/modules/sourcing/aliexpress/ds-api');
const aliexpressSource = require('../../src/modules/sourcing/aliexpress');
const { ScrapingError } = require('../../src/modules/scraping/scraping.errors');

// The DS API itself can't be exercised here — it needs an approved AliExpress
// Open Platform app, which this environment has no key for. These cover the
// parts that are pure logic and would otherwise only fail on the first real
// call: the signing rule, the response envelope, and normalization.

test('sign follows the IOP rule: sorted key-value concat, HMAC-SHA256, uppercase hex', () => {
  const params = { method: 'aliexpress.ds.product.get', app_key: 'key123', timestamp: '1700000000000' };
  const expected = crypto
    .createHmac('sha256', 'secret')
    .update('app_keykey123methodaliexpress.ds.product.gettimestamp1700000000000', 'utf8')
    .digest('hex')
    .toUpperCase();

  assert.strictEqual(dsApi.sign(params, 'secret'), expected);
});

test('sign excludes any existing sign parameter', () => {
  const withSign = { a: '1', b: '2', sign: 'STALE' };
  assert.strictEqual(dsApi.sign(withSign, 'secret'), dsApi.sign({ a: '1', b: '2' }, 'secret'));
});

test('raiseIfError surfaces a business error', () => {
  assert.throws(
    () => dsApi.raiseIfError({ error_response: { code: '15', sub_msg: 'Invalid product id' } }),
    (err) => err instanceof ScrapingError && /Invalid product id/.test(err.message)
  );
});

test('raiseIfError surfaces a gateway error that carries no response envelope', () => {
  // What a bad signature or app key looks like: bare top-level fields.
  assert.throws(
    () => dsApi.raiseIfError({ code: 'IncompleteSignature', type: 'ISV', message: 'signature mismatch' }),
    (err) => err instanceof ScrapingError && /signature mismatch/.test(err.message)
  );
});

test('raiseIfError surfaces a non-200 rsp_code inside an otherwise successful envelope', () => {
  // A failed fetch still returns the envelope — without this check the caller
  // would silently receive blank fields instead of an error.
  assert.throws(
    () =>
      dsApi.raiseIfError({
        aliexpress_ds_product_get_response: { rsp_code: '404', rsp_msg: 'Product not found' },
      }),
    (err) => err instanceof ScrapingError && /Product not found/.test(err.message)
  );
});

test('raiseIfError accepts a successful envelope', () => {
  assert.doesNotThrow(() =>
    dsApi.raiseIfError({ aliexpress_ds_product_get_response: { rsp_code: 200, rsp_msg: 'Call succeeds' } })
  );
});

test('unwrapEnvelope descends through both the method key and the inner result', () => {
  const payload = { ae_item_base_info_dto: { subject: 'Widget' } };
  assert.deepStrictEqual(
    dsApi.unwrapEnvelope({ aliexpress_ds_product_get_response: { rsp_code: 200, result: payload } }),
    payload
  );
});

test('normalizeProduct reads price from the SKU, not the base object', () => {
  // The product's base currency_code is CNY while each SKU carries the
  // requested currency — so a base-level price would be the wrong number in
  // the wrong currency.
  const raw = {
    aliexpress_ds_product_get_response: {
      rsp_code: 200,
      result: {
        ae_item_base_info_dto: { subject: 'LED Lamp', currency_code: 'CNY' },
        ae_multimedia_info_dto: { image_urls: 'https://a.jpg;https://b.jpg' },
        ae_item_sku_info_dtos: {
          ae_item_sku_info_d_t_o: [
            {
              sku_id: '1',
              offer_sale_price: '8.99',
              currency_code: 'GBP',
              ae_sku_property_dtos: {
                ae_sku_property_d_t_o: [
                  { sku_property_name: 'Body Color', property_value_definition_name: 'Cold white', sku_image: 'https://cold.jpg' },
                ],
              },
            },
          ],
        },
      },
    },
  };

  const result = dsApi.normalizeProduct(raw, '123', 'https://aliexpress.com/item/123.html');

  assert.strictEqual(result.title, 'LED Lamp');
  assert.strictEqual(result.priceText, 'GBP 8.99');
  // The SKU's own photo joins the gallery after the main photos.
  assert.deepStrictEqual(result.imageUrls, ['https://a.jpg', 'https://b.jpg', 'https://cold.jpg']);
  assert.deepStrictEqual(result.variants[0].attributes, { 'Body Color': 'Cold white' });
  assert.strictEqual(result.variants[0].imageUrl, 'https://cold.jpg');
});

test('normalizeProduct returns an empty variants array for a product with no options', () => {
  const raw = {
    aliexpress_ds_product_get_response: {
      rsp_code: 200,
      result: { ae_item_base_info_dto: { subject: 'Plain Widget' }, ae_multimedia_info_dto: { image_urls: '' } },
    },
  };
  assert.deepStrictEqual(dsApi.normalizeProduct(raw, '1', 'url').variants, []);
});

test('normalizeProduct throws rather than returning a titleless product', () => {
  const raw = { aliexpress_ds_product_get_response: { rsp_code: 200, result: {} } };
  assert.throws(() => dsApi.normalizeProduct(raw, '1', 'url'), ScrapingError);
});

test('productIdFromUrl accepts item URLs, slugged URLs and bare ids', () => {
  assert.strictEqual(
    aliexpressSource.productIdFromUrl('https://www.aliexpress.com/item/1005006113546205.html'),
    '1005006113546205'
  );
  assert.strictEqual(aliexpressSource.productIdFromUrl('https://aliexpress.com/item/1005006113546205'), '1005006113546205');
  assert.strictEqual(aliexpressSource.productIdFromUrl('1005006113546205'), '1005006113546205');
});

test('productIdFromUrl rejects a non-AliExpress URL', () => {
  assert.throws(
    () => aliexpressSource.productIdFromUrl('https://www.ebay.co.uk/itm/147565754825'),
    (err) => err instanceof ScrapingError && err.source === 'aliexpress'
  );
});

// The picker and the eBay group read `variantAxes`; the API only gives flat
// SKUs. A ten-SKU product came back without axes and the picker reported
// "one variation" while the draft carried all ten.
test('deriveVariantAxes builds ordered axes and flags only the image-varying one', () => {
  const variants = [
    { attributes: { Color: 'Red', Size: 'S' }, imageUrl: 'https://red.jpg' },
    { attributes: { Color: 'Red', Size: 'M' }, imageUrl: 'https://red.jpg' },
    { attributes: { Color: 'Blue', Size: 'S' }, imageUrl: 'https://blue.jpg' },
    { attributes: { Color: 'Blue', Size: 'M' }, imageUrl: 'https://blue.jpg' },
  ];
  const axes = dsApi.deriveVariantAxes(variants);

  assert.deepStrictEqual(
    axes.map((a) => ({ name: a.name, values: a.values, hasImages: a.hasImages })),
    [
      { name: 'Color', values: ['Red', 'Blue'], hasImages: true },
      { name: 'Size', values: ['S', 'M'], hasImages: false },
    ]
  );
});

test('deriveVariantAxes does not treat a single-value axis as image-bearing', () => {
  const variants = [
    { attributes: { Color: 'Red', 'Gloves Size': 'One Size' }, imageUrl: 'https://red.jpg' },
    { attributes: { Color: 'Blue', 'Gloves Size': 'One Size' }, imageUrl: 'https://blue.jpg' },
  ];
  const axes = dsApi.deriveVariantAxes(variants);
  assert.strictEqual(axes.find((a) => a.name === 'Color').hasImages, true);
  assert.strictEqual(axes.find((a) => a.name === 'Gloves Size').hasImages, false);
});

test('normalizeProduct returns variantAxes alongside variants', () => {
  const raw = {
    aliexpress_ds_product_get_response: {
      rsp_code: 200,
      result: {
        ae_item_base_info_dto: { subject: 'Gloves' },
        ae_item_sku_info_dtos: {
          ae_item_sku_info_d_t_o: [
            { sku_id: '1', offer_sale_price: '2', currency_code: 'GBP', ae_sku_property_dtos: { ae_sku_property_d_t_o: [{ sku_property_name: 'Color', sku_property_value: 'A', sku_image: 'https://a.jpg' }] } },
            { sku_id: '2', offer_sale_price: '2', currency_code: 'GBP', ae_sku_property_dtos: { ae_sku_property_d_t_o: [{ sku_property_name: 'Color', sku_property_value: 'B', sku_image: 'https://b.jpg' }] } },
          ],
        },
      },
    },
  };
  const result = dsApi.normalizeProduct(raw, '1', 'https://aliexpress.com/item/1.html');
  assert.deepStrictEqual(result.variantAxes, [{ name: 'Color', values: ['A', 'B'], hasImages: true }]);
});

test('deriveVariantAxes gives the photo to the axis it actually follows', () => {
  // Every SKU has a photo, but it's the colour's photo: each prescription
  // value maps to two different photos, so it is not image-bearing.
  const variants = [
    { attributes: { Color: 'Black', Prescription: '+100' }, imageUrl: 'https://black.jpg' },
    { attributes: { Color: 'Orange', Prescription: '+100' }, imageUrl: 'https://orange.jpg' },
    { attributes: { Color: 'Black', Prescription: '+150' }, imageUrl: 'https://black.jpg' },
    { attributes: { Color: 'Orange', Prescription: '+150' }, imageUrl: 'https://orange.jpg' },
  ];
  const axes = dsApi.deriveVariantAxes(variants);
  assert.strictEqual(axes.find((a) => a.name === 'Color').hasImages, true);
  assert.strictEqual(axes.find((a) => a.name === 'Prescription').hasImages, false);
});

test('normalizeProduct keeps two SKUs shown under the same label apart by their raw property value', () => {
  const sku = (id, label, raw) => ({
    sku_id: id,
    offer_sale_price: '8.99',
    currency_code: 'GBP',
    ae_sku_property_dtos: {
      ae_sku_property_d_t_o: [{ sku_property_name: 'Color', property_value_definition_name: label, sku_property_value: raw }],
    },
  });
  const raw = {
    aliexpress_ds_product_get_response: {
      rsp_code: 200,
      result: {
        ae_item_base_info_dto: { subject: 'Braid', currency_code: 'CNY' },
        ae_multimedia_info_dto: { image_urls: 'https://a.jpg' },
        ae_item_sku_info_dtos: { ae_item_sku_info_d_t_o: [sku('1', 'Camo Brown', 'Camo Brown 25LB'), sku('2', 'Camo Brown', 'Camo Brown 35LB'), sku('3', 'Green', 'Green')] },
      },
    },
  };

  const result = dsApi.normalizeProduct(raw, '1', 'https://aliexpress.com/item/1.html');
  assert.deepStrictEqual(
    result.variants.map((v) => v.attributes.Color),
    ['Camo Brown 25LB', 'Camo Brown 35LB', 'Green']
  );
});

test("normalizeProduct keeps the supplier's parcel: gross weight in kg and the box in cm, as AliExpress documents package_info_dto", () => {
  const raw = (info) => ({
    aliexpress_ds_product_get_response: {
      rsp_code: 200,
      result: { ae_item_base_info_dto: { subject: 'Phone Holder' }, ae_multimedia_info_dto: { image_urls: '' }, ...(info ? { package_info_dto: info } : {}) },
    },
  });
  // AliExpress's own example: gross_weight "0.050", 18 × 8 × 6.
  assert.deepStrictEqual(dsApi.normalizeProduct(raw({ gross_weight: '0.050', package_length: 18, package_width: 8, package_height: 6, package_type: false }), '1', 'url').package, {
    weightKg: 0.05,
    lengthCm: 18,
    widthCm: 8,
    heightCm: 6,
  });
  assert.deepStrictEqual(dsApi.normalizeProduct(raw({ gross_weight: '1.2', package_length: 0 }), '1', 'url').package, { weightKg: 1.2, lengthCm: null, widthCm: null, heightCm: null }, 'a box without all three sides is left out');
  assert.strictEqual(dsApi.normalizeProduct(raw({ gross_weight: '0' }), '1', 'url').package, null, 'no usable weight, no parcel');
  assert.strictEqual(dsApi.normalizeProduct(raw(null), '1', 'url').package, null);
});

test('normalizeProduct keeps each SKU id and stock, and the product and store record', () => {
  const raw = {
    aliexpress_ds_product_get_response: {
      rsp_code: 200,
      result: {
        ae_item_base_info_dto: { subject: 'Earbuds', sales_count: '1000+', avg_evaluation_rating: '4.9', evaluation_count: '336', product_status_type: 'onSelling' },
        ae_store_info: { store_name: "Stone's Store", store_country_code: 'CN', item_as_described_rating: '5.0', communication_rating: '4.8', shipping_speed_rating: '4.8' },
        logistics_info_dto: { delivery_time: 7, ship_to_country: 'GB' },
        ae_item_sku_info_dtos: {
          ae_item_sku_info_d_t_o: [
            { sku_id: '12000040177060882', sku_available_stock: 15, offer_sale_price: '3.36', currency_code: 'GBP', ae_sku_property_dtos: { ae_sku_property_d_t_o: [{ sku_property_name: 'Color', property_value_definition_name: 'Black' }] } },
            { sku_id: '12000040177060883', sku_available_stock: 0, offer_sale_price: '3.36', currency_code: 'GBP', ae_sku_property_dtos: { ae_sku_property_d_t_o: [{ sku_property_name: 'Color', property_value_definition_name: 'White' }] } },
          ],
        },
      },
    },
  };
  const result = dsApi.normalizeProduct(raw, '1', 'https://aliexpress.com/item/1.html');
  assert.deepStrictEqual(result.variants.map((v) => [v.skuId, v.stock]), [['12000040177060882', 15], ['12000040177060883', 0]]);
  assert.deepStrictEqual(result.supplier, {
    orders: '1000+',
    rating: 4.9,
    reviews: 336,
    onSale: true,
    store: { name: "Stone's Store", country: 'CN', described: 5, communication: 4.8, shipping: 4.8 },
    deliveryDays: 7,
  });
});

test('deliveryOption reads the fee in whole units, the free-postage threshold and the delivery days (live freight.query shape)', () => {
  const option = dsApi.deliveryOption({
    code: 'CAINIAO_FULFILLMENT_PRE',
    shipping_fee_currency: 'GBP',
    free_shipping: false,
    max_delivery_days: 8,
    min_delivery_days: 5,
    tracking: true,
    shipping_fee_format: '￡1.99',
    free_shipping_threshold: '￡8.00',
    company: 'AliExpress Selection Premium shipping',
    ship_from_country: 'CN',
    shipping_fee_cent: '1.99',
  });
  assert.deepStrictEqual(option, { code: 'CAINIAO_FULFILLMENT_PRE', company: 'AliExpress Selection Premium shipping', cost: 1.99, currency: 'GBP', freeOver: 8, minDays: 5, maxDays: 8, tracking: true, shipFrom: 'CN' });
  assert.strictEqual(dsApi.deliveryOption({ free_shipping: true, shipping_fee_cent: '2.50' }).cost, 0);
});

test('a dropped connection to AliExpress is tried once more, then explained instead of an internal error', async () => {
  const dropped = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw dropped();
    return { ok: true, status: 200 };
  };
  const res = await dsApi.postGateway('a=1', { fetchImpl: flaky, retryDelayMs: 0 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls, 2);

  calls = 0;
  const down = async () => {
    calls += 1;
    throw dropped();
  };
  await assert.rejects(dsApi.postGateway('a=1', { fetchImpl: down, retryDelayMs: 0 }), (err) => err instanceof ScrapingError && err.statusCode === 502 && err.expose && /Couldn't reach AliExpress/.test(err.message));
  assert.strictEqual(calls, 2);

  // No answer in time: said at once, not waited for twice.
  calls = 0;
  const slow = async () => {
    calls += 1;
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  };
  await assert.rejects(dsApi.postGateway('a=1', { fetchImpl: slow, retryDelayMs: 0 }), (err) => err instanceof ScrapingError && err.statusCode === 504);
  assert.strictEqual(calls, 1);
});

test("search results' photos are served from AliExpress's main image host", () => {
  const dsApi = require('../../src/modules/sourcing/aliexpress/ds-api');
  assert.strictEqual(dsApi.photoUrl('https://ae-pic-a1.aliexpress-media.com/kf/Sabc.jpg'), 'https://ae01.alicdn.com/kf/Sabc.jpg');
  assert.strictEqual(dsApi.photoUrl('https://ae01.alicdn.com/kf/Sabc.jpg'), 'https://ae01.alicdn.com/kf/Sabc.jpg');
  assert.strictEqual(dsApi.photoUrl(null), null);
});

test('downloadViaOtherDns fetches the photo from the address another resolver gave, not the local DNS answer', async () => {
  const net = require('net');
  let connected = 0;
  const server = net.createServer((socket) => {
    connected += 1;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    // photo.invalid never resolves locally; the connection can only come from the address given.
    await assert.rejects(aliexpressSource.downloadViaOtherDns(`https://photo.invalid:${port}/s-l500.jpg`, async (host) => {
      assert.strictEqual(host, 'photo.invalid');
      return ['127.0.0.1'];
    }));
    assert.strictEqual(connected, 1);
  } finally {
    server.close();
  }
});

test('downloadViaOtherDns fails plainly when the other resolvers give no address', async () => {
  await assert.rejects(aliexpressSource.downloadViaOtherDns('https://i.ebayimg.com/images/g/x/s-l500.jpg', async () => []), /no other address/);
});
