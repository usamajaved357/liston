const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const config = require('../../config');

// eBay Platform Notifications: instead of Liston polling an account to find
// out whether anything changed, eBay POSTs a SOAP envelope to us the moment
// a listing is created, revised, ended or sold on a subscribed account.
// Liston then marks that account's mirrored copies stale, and the next look
// at the page refreshes them. Nothing here changes data; the worst a forged
// notification can do is cause one re-read, and those are throttled.

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });

// Everything that changes what the Listings or Orders pages show.
const EVENTS = [
  'ItemListed',
  'ItemRevised',
  'ItemClosed',
  'ItemSold',
  'ItemUnsold',
  'FixedPriceTransaction',
  'ItemMarkedPaid',
  'ItemMarkedShipped',
];

// eBay signs each notification: base64(md5(Timestamp + DevID + AppID + CertID)).
function expectedSignature(timestamp) {
  const { devId, clientId, clientSecret } = config.ebay;
  if (!devId || !clientId || !clientSecret) return null;
  return crypto.createHash('md5').update(`${timestamp}${devId}${clientId}${clientSecret}`).digest('base64');
}

// Pulls what Liston needs out of the envelope: which event, which seller,
// and (when present) which item. Returns null for anything unrecognisable.
function parseNotification(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  const envelope = doc.Envelope;
  if (!envelope) return null;

  const header = envelope.Header?.RequesterCredentials?.NotificationSignature;
  const signature = typeof header === 'object' ? header['#text'] : header;

  const body = envelope.Body || {};
  const responseName = Object.keys(body).find((k) => /Response$/.test(k));
  const response = responseName ? body[responseName] : null;
  if (!response) return null;

  const eventName = response.NotificationEventName;
  const recipient = response.RecipientUserID;
  const item = response.Item || response.TransactionArray?.Transaction?.Item || null;
  const itemId = item?.ItemID ? String(item.ItemID) : null;

  return {
    eventName: eventName ? String(eventName) : null,
    recipientUserId: recipient ? String(recipient) : null,
    itemId,
    timestamp: response.Timestamp ? String(response.Timestamp) : null,
    signature: signature ? String(signature) : null,
  };
}

function verify(notification) {
  const expected = notification.timestamp ? expectedSignature(notification.timestamp) : null;
  // Unverifiable (no Dev ID configured) is accepted; the action is harmless.
  if (!expected) return true;
  return notification.signature === expected;
}

// The SetNotificationPreferences body that subscribes one account.
function subscriptionXml(applicationUrl) {
  return (
    `<ApplicationDeliveryPreferences>` +
    `<ApplicationEnable>Enable</ApplicationEnable>` +
    `<ApplicationURL>${applicationUrl}</ApplicationURL>` +
    `<DeviceType>Platform</DeviceType>` +
    `</ApplicationDeliveryPreferences>` +
    `<UserDeliveryPreferenceArray>` +
    EVENTS.map((event) => `<NotificationEnable><EventType>${event}</EventType><EventEnable>Enable</EventEnable></NotificationEnable>`).join('') +
    `</UserDeliveryPreferenceArray>`
  );
}

module.exports = { EVENTS, parseNotification, verify, subscriptionXml, expectedSignature };
