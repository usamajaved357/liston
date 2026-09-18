const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const config = require('../../src/config');
const notifications = require('../../src/modules/ebay/ebay.notifications');

const ENVELOPE = (signature) => `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ebl="urn:ebay:apis:eBLBaseComponents">
  <soapenv:Header>
    <ebl:RequesterCredentials soapenv:mustUnderstand="0">
      <ebl:NotificationSignature>${signature}</ebl:NotificationSignature>
    </ebl:RequesterCredentials>
  </soapenv:Header>
  <soapenv:Body>
    <GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
      <Timestamp>2026-09-18T10:00:00.000Z</Timestamp>
      <Ack>Success</Ack>
      <NotificationEventName>ItemRevised</NotificationEventName>
      <RecipientUserID>flashing_goods</RecipientUserID>
      <Item><ItemID>123456789012</ItemID><Title>Coin holder</Title></Item>
    </GetItemResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

test('parseNotification reads the event, seller and item from a SOAP envelope', () => {
  const n = notifications.parseNotification(ENVELOPE('sig'));
  assert.deepStrictEqual(n, {
    eventName: 'ItemRevised',
    recipientUserId: 'flashing_goods',
    itemId: '123456789012',
    timestamp: '2026-09-18T10:00:00.000Z',
    signature: 'sig',
  });
});

test('parseNotification returns null for anything that is not a notification', () => {
  assert.strictEqual(notifications.parseNotification('not xml at all <'), null);
  assert.strictEqual(notifications.parseNotification('<root/>'), null);
});

test('verify checks the MD5 signature when a Dev ID is configured, and accepts when it is not', () => {
  const original = { ...config.ebay };
  try {
    Object.assign(config.ebay, { devId: 'dev', clientId: 'app', clientSecret: 'cert' });
    const good = crypto.createHash('md5').update('2026-09-18T10:00:00.000Zdevappcert').digest('base64');
    assert.strictEqual(notifications.verify(notifications.parseNotification(ENVELOPE(good))), true);
    assert.strictEqual(notifications.verify(notifications.parseNotification(ENVELOPE('forged'))), false);

    config.ebay.devId = null;
    assert.strictEqual(notifications.verify(notifications.parseNotification(ENVELOPE('anything'))), true);
  } finally {
    Object.assign(config.ebay, original);
  }
});

test('subscriptionXml enables every listing/order event at the given URL', () => {
  const xml = notifications.subscriptionXml('https://example.com/api/ebay/notifications');
  assert.match(xml, /<ApplicationURL>https:\/\/example.com\/api\/ebay\/notifications<\/ApplicationURL>/);
  for (const event of notifications.EVENTS) assert.match(xml, new RegExp(`<EventType>${event}</EventType><EventEnable>Enable`));
});
