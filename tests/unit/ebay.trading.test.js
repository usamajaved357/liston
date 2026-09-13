const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const ebayTrading = require('../../src/modules/ebay/ebay.trading');

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
  });
});

test('getOrders maps buyer name and order total', async () => {
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
            <TransactionArray>
              <Transaction>
                <Buyer><UserFirstName>Jane</UserFirstName><UserLastName>Doe</UserLastName></Buyer>
                <Item><ItemID>456</ItemID><Title>Widget</Title></Item>
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
    buyerName: 'Jane Doe',
    itemTitle: 'Widget',
    itemId: '456',
    itemCount: 1,
  });
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
