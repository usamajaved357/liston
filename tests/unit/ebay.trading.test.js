const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const ebayTrading = require('../../src/modules/ebay/api/ebay.trading');

test.afterEach(() => {
  mock.restoreAll();
});

function fakeResponse(xml) {
  return { text: async () => xml };
}

test('getActiveListings maps items and pagination out of the Trading API XML', async () => {
  mock.method(global, 'fetch', async () =>
    fakeResponse(`<?xml version="1.0"?>
      <GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
        <Ack>Success</Ack>
        <ActiveList>
          <PaginationResult><TotalNumberOfEntries>1</TotalNumberOfEntries><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult>
          <ItemArray>
            <Item>
              <ItemID>123</ItemID>
              <SKU>SKU-1</SKU>
              <Title>Test Item</Title>
              <Quantity>10</Quantity>
              <QuantityAvailable>7</QuantityAvailable>
              <SellingStatus><CurrentPrice currencyID="GBP">9.99</CurrentPrice><QuantitySold>3</QuantitySold></SellingStatus>
              <PictureDetails><GalleryURL>https://example.com/pic.jpg</GalleryURL></PictureDetails>
              <ListingDetails><StartTime>2026-01-01T00:00:00.000Z</StartTime><ViewItemURL>https://ebay.com/itm/123</ViewItemURL></ListingDetails>
              <WatchCount>5</WatchCount>
            </Item>
          </ItemArray>
        </ActiveList>
      </GetMyeBaySellingResponse>`)
  );

  const result = await ebayTrading.getActiveListings('token');

  assert.strictEqual(result.totalEntries, 1);
  assert.strictEqual(result.items.length, 1);
  assert.deepStrictEqual(result.items[0], {
    itemId: '123',
    sku: 'SKU-1',
    title: 'Test Item',
    price: { amount: 9.99, currency: 'GBP' },
    convertedPrice: null,
    quantity: 10,
    quantityAvailable: 7,
    quantitySold: 3,
    imageUrl: 'https://example.com/pic.jpg',
    viewItemUrl: 'https://ebay.com/itm/123',
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: null,
    watchCount: 5,
  });
});

test('getOrders maps buyer, payment/dispatch state, and line item details', async () => {
  mock.method(global, 'fetch', async () =>
    fakeResponse(`<?xml version="1.0"?>
      <GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
        <Ack>Success</Ack>
        <PaginationResult><TotalNumberOfEntries>1</TotalNumberOfEntries><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult>
        <OrderArray>
          <Order>
            <OrderID>ORD-1</OrderID>
            <OrderStatus>Completed</OrderStatus>
            <CreatedTime>2026-01-02T00:00:00.000Z</CreatedTime>
            <Total currencyID="GBP">12.50</Total>
            <Subtotal currencyID="GBP">12.50</Subtotal>
            <BuyerUserID>janedoe123</BuyerUserID>
            <CheckoutStatus><Status>Complete</Status></CheckoutStatus>
            <PaidTime>2026-01-02T00:05:00.000Z</PaidTime>
            <ShippedTime>2026-01-03T09:00:00.000Z</ShippedTime>
            <CancelStatus>NotApplicable</CancelStatus>
            <ShippingAddress>
              <Name>Jane Doe</Name>
              <Street1>1 High Street</Street1>
              <Street2>Flat 2</Street2>
              <CityName>Leeds</CityName>
              <StateOrProvince>West Yorkshire</StateOrProvince>
              <CountryName>United Kingdom</CountryName>
              <Phone>Invalid Request</Phone>
              <PostalCode>LS1 1AA</PostalCode>
            </ShippingAddress>
            <TransactionArray>
              <Transaction>
                <Buyer><UserFirstName>Jane</UserFirstName><UserLastName>Doe</UserLastName></Buyer>
                <Item><ItemID>456</ItemID><Title>Widget</Title></Item>
                <QuantityPurchased>2</QuantityPurchased>
                <TransactionPrice currencyID="GBP">6.25</TransactionPrice>
                <Variation><VariationSpecifics><NameValueList><Name>Color</Name><Value>Blue</Value></NameValueList></VariationSpecifics></Variation>
                <ShippingDetails><ShipmentTrackingDetails><ShippingCarrierUsed>Evri</ShippingCarrierUsed><ShipmentTrackingNumber>TRACK123</ShipmentTrackingNumber></ShipmentTrackingDetails></ShippingDetails>
                <ShippingServiceSelected><ShippingPackageInfo><HandleByTime>2026-01-02T23:59:59.000Z</HandleByTime></ShippingPackageInfo></ShippingServiceSelected>
              </Transaction>
            </TransactionArray>
          </Order>
        </OrderArray>
      </GetOrdersResponse>`)
  );

  const result = await ebayTrading.getOrders('token', {
    createTimeFrom: '2026-01-01T00:00:00.000Z',
    createTimeTo: '2026-01-03T00:00:00.000Z',
  });

  assert.strictEqual(result.orders.length, 1);
  assert.deepStrictEqual(result.orders[0], {
    orderId: 'ORD-1',
    status: 'Completed',
    createdAt: '2026-01-02T00:00:00.000Z',
    total: { amount: 12.5, currency: 'GBP' },
    subtotal: { amount: 12.5, currency: 'GBP' },
    buyerName: 'Jane Doe',
    buyerUserId: 'janedoe123',
    buyerEmail: null,
    salesRecordNumber: null,
    shippingAddress: { name: 'Jane Doe', street1: '1 High Street', street2: 'Flat 2', city: 'Leeds', state: 'West Yorkshire', postalCode: 'LS1 1AA', country: 'United Kingdom', phone: '' },
    shippingProgramme: null,
    finalDestination: null,
    buyerTotal: null,
    gspService: null,
    itemTitle: 'Widget',
    itemId: '456',
    itemCount: 1,
    checkoutStatus: 'Complete',
    paidTime: '2026-01-02T00:05:00.000Z',
    shippedTime: '2026-01-03T09:00:00.000Z',
    cancelStatus: 'NotApplicable',
    dispatchByTime: '2026-01-02T23:59:59.000Z',
    deliveredAt: null,
    lineItems: [
      {
        itemId: '456',
        title: 'Widget',
        site: null,
        quantityPurchased: 2,
        price: { amount: 6.25, currency: 'GBP' },
        variation: [{ name: 'Color', value: 'Blue' }],
        trackingCarrier: 'Evri',
        trackingNumber: 'TRACK123',
        handleByTime: '2026-01-02T23:59:59.000Z',
        estimatedDeliveryMin: null,
        estimatedDeliveryMax: null,
        deliveredAt: null,
        shippingService: null,
      },
    ],
  });
});

// An order counts as delivered once every item on it has a carrier-confirmed
// delivery time; the last one is when it was delivered.
function orderWithDeliveries(times) {
  const transactions = times
    .map(
      (t, i) => `<Transaction><Item><ItemID>${i + 1}</ItemID><Title>T${i}</Title></Item><QuantityPurchased>1</QuantityPurchased>
        <ShippingServiceSelected><ShippingPackageInfo>${t ? `<ActualDeliveryTime>${t}</ActualDeliveryTime>` : ''}</ShippingPackageInfo></ShippingServiceSelected></Transaction>`
    )
    .join('');
  return `<?xml version="1.0"?><GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack>
    <PaginationResult><TotalNumberOfEntries>1</TotalNumberOfEntries><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult>
    <OrderArray><Order><OrderID>ORD-2</OrderID><ShippedTime>2026-01-03T09:00:00.000Z</ShippedTime><TransactionArray>${transactions}</TransactionArray></Order></OrderArray></GetOrdersResponse>`;
}

test('getOrders reads when each item was delivered, and the order is delivered once all of them are', async () => {
  mock.method(global, 'fetch', async () => fakeResponse(orderWithDeliveries(['2026-01-06T11:00:00.000Z', '2026-01-05T10:00:00.000Z'])));
  const [all] = (await ebayTrading.getOrders('token', { createTimeFrom: 'a', createTimeTo: 'b' })).orders;
  assert.deepStrictEqual(all.lineItems.map((li) => li.deliveredAt), ['2026-01-06T11:00:00.000Z', '2026-01-05T10:00:00.000Z']);
  assert.strictEqual(all.deliveredAt, '2026-01-06T11:00:00.000Z');

  mock.restoreAll();
  mock.method(global, 'fetch', async () => fakeResponse(orderWithDeliveries(['2026-01-06T11:00:00.000Z', null])));
  const [some] = (await ebayTrading.getOrders('token', { createTimeFrom: 'a', createTimeTo: 'b' })).orders;
  assert.strictEqual(some.deliveredAt, null);
});

test('getOrders can read particular orders by number, and asks eBay for the delivery time', async () => {
  let body = '';
  mock.method(global, 'fetch', async (url, options) => {
    body = options.body;
    return fakeResponse(orderWithDeliveries([null]));
  });
  await ebayTrading.getOrders('token', { orderIds: ['12-345-678', 'A&B'] });
  assert.match(body, /<OrderIDArray><OrderID>12-345-678<\/OrderID><OrderID>A&amp;B<\/OrderID><\/OrderIDArray>/);
  assert.doesNotMatch(body, /CreateTimeFrom|ModTimeFrom/);
  assert.match(body, /ShippingPackageInfo\.ActualDeliveryTime/);
});

test('a Trading API failure response throws EbayTradingError with eBay\'s message', async () => {
  mock.method(global, 'fetch', async () =>
    fakeResponse(`<?xml version="1.0"?>
      <GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
        <Ack>Failure</Ack>
        <Errors><ShortMessage>Bad request</ShortMessage><LongMessage>The date range is invalid</LongMessage></Errors>
      </GetOrdersResponse>`)
  );

  await assert.rejects(
    () => ebayTrading.getOrders('token', { createTimeFrom: 'x', createTimeTo: 'y' }),
    (err) => {
      assert.ok(err instanceof ebayTrading.EbayTradingError);
      assert.strictEqual(err.message, 'The date range is invalid');
      return true;
    }
  );
});

// eBay keeps the parts of a revision it refuses and says so only as a
// warning on a successful call. That warning must reach the seller.
test('reviseListing passes eBay\'s warnings back instead of swallowing them', async () => {
  mock.method(global, 'fetch', async () =>
    fakeResponse(`<?xml version="1.0"?>
      <ReviseFixedPriceItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
        <Ack>Warning</Ack>
        <Errors><SeverityCode>Warning</SeverityCode><ShortMessage>Description not revised.</ShortMessage><LongMessage>The description cannot be changed on a listing that has sales; the rest of the revision was applied.</LongMessage></Errors>
        <ItemID>407219164790</ItemID>
      </ReviseFixedPriceItemResponse>`)
  );

  const result = await ebayTrading.reviseListing('token', '407219164790', { descriptionHtml: '<p>new</p>', title: 'T' });
  assert.strictEqual(result.itemId, '407219164790');
  assert.deepStrictEqual(result.warnings, ['The description cannot be changed on a listing that has sales; the rest of the revision was applied.']);
});

// eBay's business-policies notice comes with every revise of a listing that
// still carries old-style postage/payment/returns fields. The revise sent
// none of those and everything applied, so the seller isn't told otherwise.
test('reviseListing drops eBay\'s business-policies notice but keeps real warnings', async () => {
  mock.method(global, 'fetch', async () =>
    fakeResponse(`<?xml version="1.0"?>
      <ReviseFixedPriceItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
        <Ack>Warning</Ack>
        <Errors><SeverityCode>Warning</SeverityCode><ShortMessage>Business policies.</ShortMessage><LongMessage>Seller has opted into business policies. Please use policy IDs rather than legacy fields for Shipping, Payments or Returns or new policies may be automatically created seller's behalf.</LongMessage></Errors>
        <Errors><SeverityCode>Warning</SeverityCode><ShortMessage>Description not revised.</ShortMessage><LongMessage>The description cannot be changed on a listing that has sales; the rest of the revision was applied.</LongMessage></Errors>
        <ItemID>407219072490</ItemID>
      </ReviseFixedPriceItemResponse>`)
  );

  const result = await ebayTrading.reviseListing('token', '407219072490', { title: 'T' });
  assert.deepStrictEqual(result.warnings, ['The description cannot be changed on a listing that has sales; the rest of the revision was applied.']);
});

test('reviseListing with only the business-policies notice returns no warnings', async () => {
  mock.method(global, 'fetch', async () =>
    fakeResponse(`<?xml version="1.0"?>
      <ReviseFixedPriceItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
        <Ack>Warning</Ack>
        <Errors><SeverityCode>Warning</SeverityCode><LongMessage>Seller has opted into business policies. Please use policy IDs rather than legacy fields for Shipping, Payments or Returns or new policies may be automatically created seller's behalf.</LongMessage></Errors>
        <ItemID>407219072490</ItemID>
      </ReviseFixedPriceItemResponse>`)
  );

  const result = await ebayTrading.reviseListing('token', '407219072490', { title: 'T' });
  assert.deepStrictEqual(result.warnings, []);
});

test('relistListing sends the edit to RelistFixedPriceItem and returns eBay\'s new item number', async () => {
  let body;
  mock.method(global, 'fetch', async (url, init) => {
    body = init.body;
    return fakeResponse(`<?xml version="1.0"?>
      <RelistFixedPriceItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
        <Ack>Success</Ack>
        <ItemID>407999999999</ItemID>
      </RelistFixedPriceItemResponse>`);
  });
  const result = await ebayTrading.relistListing('token', '407000000001', { title: 'Back again', price: { amount: 6.99, currency: 'GBP' }, quantity: 3 });
  assert.match(body, /<RelistFixedPriceItemRequest/);
  assert.match(body, /<ItemID>407000000001<\/ItemID><Title>Back again<\/Title>/);
  assert.match(body, /<Quantity>3<\/Quantity>/);
  assert.deepStrictEqual(result, { itemId: '407999999999', relistedFrom: '407000000001', warnings: [] });
});

test("eBay's refusal is shown to the seller, not hidden as an internal error", async () => {
  mock.method(global, 'fetch', async () =>
    fakeResponse(`<?xml version="1.0"?>
      <RelistFixedPriceItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
        <Ack>Failure</Ack>
        <Errors><ErrorCode>21919067</ErrorCode><LongMessage>It looks like this listing is for an item you already have on eBay: Case (800680929541).</LongMessage></Errors>
      </RelistFixedPriceItemResponse>`)
  );
  await assert.rejects(
    () => ebayTrading.relistListing('token', '800539509961', { title: 'Case' }),
    (err) => err.expose === true && /already have on eBay/.test(err.message)
  );
});

// A Global Shipping Programme order, as eBay's GetOrders returns it (order
// 26-15179-49854, Minsu LTD): the buyer in Spain, the seller posting to the
// UK hub with a Ref #, the buyer's international postage paid to eBay.
const GSP_ORDER = `<?xml version="1.0"?><GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack>
  <PaginationResult><TotalNumberOfEntries>1</TotalNumberOfEntries><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult>
  <OrderArray><Order><OrderID>26-15179-49854</OrderID><OrderStatus>Completed</OrderStatus>
    <Subtotal currencyID="GBP">109.99</Subtotal><Total currencyID="GBP">152.96</Total>
    <ShippingAddress><Name>paul diamond</Name><Street1>Cal Rei 19</Street1><CityName>castell d´Aro</CityName><StateOrProvince>Cataluña</StateOrProvince><PostalCode>17249</PostalCode><CountryName>Spain</CountryName><Phone>+34 634544265</Phone></ShippingAddress>
    <IsMultiLegShipping>true</IsMultiLegShipping>
    <MultiLegShippingDetails><SellerShipmentToLogisticsProvider>
      <ShipToAddress><Name>paul diamond</Name><Street1>GSP, Unit 3 Dove CL, Fradley Pk</Street1><CityName>LICHFIELD</CityName><StateOrProvince>Staffordshire</StateOrProvince><PostalCode>WS13 8UR</PostalCode><CountryName>United Kingdom</CountryName><Phone>634544265</Phone><ReferenceID>A6539148534ES</ReferenceID></ShipToAddress>
      <ShippingServiceDetails><ShippingService>UK_OtherCourier3To5Days</ShippingService><TotalShippingCost currencyID="GBP">0.0</TotalShippingCost></ShippingServiceDetails>
    </SellerShipmentToLogisticsProvider></MultiLegShippingDetails>
    <TransactionArray><Transaction><Item><ItemID>1</ItemID><Title>Unihertz Jelly Pro</Title></Item><QuantityPurchased>1</QuantityPurchased><TransactionPrice currencyID="GBP">109.99</TransactionPrice>
      <ShippingServiceSelected><ShippingService>InternationalPriorityShipping</ShippingService></ShippingServiceSelected></Transaction></TransactionArray>
  </Order></OrderArray></GetOrdersResponse>`;

test("a Global Shipping Programme order posts to eBay's UK hub with its Ref #, for the seller's total, as Seller Hub shows", async () => {
  let body = '';
  mock.method(global, 'fetch', async (url, options) => {
    body = options.body;
    return fakeResponse(GSP_ORDER);
  });
  const [order] = (await ebayTrading.getOrders('token', { createTimeFrom: 'a', createTimeTo: 'b' })).orders;
  assert.match(body, /MultiLegShippingDetails/);
  assert.strictEqual(order.shippingProgramme, 'GSP');
  assert.strictEqual(order.shippingAddress.street1, 'GSP, Unit 3 Dove CL, Fradley Pk');
  assert.strictEqual(order.shippingAddress.postalCode, 'WS13 8UR');
  assert.strictEqual(order.shippingAddress.referenceId, 'A6539148534ES');
  assert.strictEqual(order.finalDestination.country, 'Spain', "the buyer's own address is kept for reference");
  assert.deepStrictEqual(order.total, { amount: 109.99, currency: 'GBP' }, 'items plus the seller\'s leg (free), not the buyer\'s £152.96');
  assert.deepStrictEqual(order.buyerTotal, { amount: 152.96, currency: 'GBP' });
  assert.strictEqual(order.gspService, 'UK_OtherCourier3To5Days');

  mock.restoreAll();
  mock.method(global, 'fetch', async () => fakeResponse(orderWithDeliveries([null])));
  const [plain] = (await ebayTrading.getOrders('token', { createTimeFrom: 'a', createTimeTo: 'b' })).orders;
  assert.strictEqual(plain.shippingProgramme, null);
  assert.strictEqual(plain.finalDestination, null);
});

test("what became of another seller's listing: live, ended the normal way, or deleted by eBay (error 17); any other failure is an error, not a verdict", async () => {
  const reply = (body) => mock.method(global, 'fetch', async () => fakeResponse(`<?xml version="1.0"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">${body}</GetItemResponse>`));
  reply('<Ack>Success</Ack><Item><SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus></Item>');
  assert.strictEqual((await ebayTrading.getListingState('t', '1', { siteId: 3 })).state, 'live');
  mock.restoreAll();
  reply('<Ack>Success</Ack><Item><SellingStatus><ListingStatus>Completed</ListingStatus></SellingStatus><ListingDetails><EndTime>2026-09-20T10:00:00.000Z</EndTime></ListingDetails></Item>');
  assert.deepStrictEqual(await ebayTrading.getListingState('t', '1', { siteId: 3 }), { state: 'ended', endTime: '2026-09-20T10:00:00.000Z' });
  mock.restoreAll();
  reply('<Ack>Failure</Ack><Errors><ShortMessage>Item cannot be accessed.</ShortMessage><LongMessage>This item cannot be accessed because the listing has been deleted, is a Half.com listing, or you are not the seller.</LongMessage><ErrorCode>17</ErrorCode></Errors>');
  assert.strictEqual((await ebayTrading.getListingState('t', '1', { siteId: 3 })).state, 'removed');
  mock.restoreAll();
  reply('<Ack>Failure</Ack><Errors><ShortMessage>Invalid token.</ShortMessage><ErrorCode>931</ErrorCode></Errors>');
  await assert.rejects(ebayTrading.getListingState('t', '1', { siteId: 3 }));
});
