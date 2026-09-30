const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
require('dotenv').config();
// Files go to a throwaway folder, never R2, under test.
process.env.STORAGE_DIR = path.join(os.tmpdir(), `liston-test-storage-${process.pid}`);
delete process.env.R2_ACCOUNT_ID;

const sharp = require('sharp');
const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');
const storage = require('../../src/lib/storage');
const userEvents = require('../../src/modules/realtime/user-events');

// The Inbox's foundations: shared files (upload, a straightened image with a
// preview, signed links that run out, public eBay links), Liston cards
// across accounts (each checked against the viewer's access), and a live
// channel per person.

const app = createApp();
let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function request(method, url, body, token) {
  const res = await fetch(`${baseUrl}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// Links name the configured API address; followed here on the test server.
const local = (url) => String(url).replace(/^https?:\/\/[^/]+/, baseUrl);

async function upload(token, bytes, { name, type, purpose = 'chat' }) {
  const res = await fetch(`${baseUrl}/api/files?purpose=${purpose}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) }, body: bytes });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function owner(label) {
  const email = `inbox-${label}-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  return { id: data.user.id, token: data.token };
}

async function member(ownerToken, grants) {
  const email = `inbox-member-${crypto.randomUUID()}@example.com`;
  const added = await request('POST', '/api/team/members', { email, password: 'memberpassword123', name: 'Sara' }, ownerToken);
  await request('PUT', `/api/team/members/${added.data.id || added.data.member?.id}/permissions`, { permissions: grants }, ownerToken);
  const login = await request('POST', '/api/auth/login', { email, password: 'memberpassword123' });
  return { id: login.data.user.id, token: login.data.token };
}

test('files: an image is straightened, stripped and previewed, reached by a signed link that runs out; programs are refused; eBay attachments get a public link', async () => {
  const o = await owner('files');
  // A 60x30 photo taken on its side (EXIF orientation 6), with where it was taken.
  const photo = await sharp({ create: { width: 60, height: 30, channels: 3, background: '#3355aa' } })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'PhoneCo' } } })
    .toBuffer();
  const up = await upload(o.token, photo, { name: '../../holiday snap.JPG', type: 'image/jpeg' });
  assert.strictEqual(up.status, 201, JSON.stringify(up.data));
  assert.deepStrictEqual([up.data.name, up.data.mime, up.data.image, up.data.width, up.data.height], ['holiday snap.JPG', 'image/jpeg', true, 30, 60], 'no folders in the name; turned upright');
  assert.ok(up.data.thumbUrl && up.data.url.includes('/media/f/'));

  const full = await fetch(local(up.data.url));
  assert.strictEqual(full.status, 200);
  assert.strictEqual(full.headers.get('content-type'), 'image/jpeg');
  assert.strictEqual(full.headers.get('cross-origin-resource-policy'), 'cross-origin', 'the frontend (another origin) may show it');
  const kept = Buffer.from(await full.arrayBuffer());
  const meta = await sharp(kept).metadata();
  assert.deepStrictEqual([meta.width, meta.height, meta.orientation, meta.exif], [30, 60, undefined, undefined], 'upright, camera data left behind');
  const thumb = await fetch(local(up.data.thumbUrl));
  assert.deepStrictEqual([thumb.status, thumb.headers.get('content-type')], [200, 'image/webp']);

  // A changed or run-out link is refused.
  assert.strictEqual((await fetch(local(up.data.url).replace(/sig=[^&]+/, 'sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))).status, 403);
  assert.strictEqual((await fetch(local(up.data.url).replace(/exp=\d+/, 'exp=1000'))).status, 403);
  assert.strictEqual((await fetch(local(up.data.url).replace('/full?', '/thumb?'))).status, 403, 'a link is for one variant');

  // Only its uploader (or the owner) reads it back before it's sent.
  assert.strictEqual((await request('GET', `/api/files/${up.data.id}`, undefined, o.token)).status, 200);
  const m = await member(o.token, []);
  assert.strictEqual((await request('GET', `/api/files/${up.data.id}`, undefined, m.token)).status, 404);
  const other = await owner('files-other');
  assert.strictEqual((await request('GET', `/api/files/${up.data.id}`, undefined, other.token)).status, 404);

  // A document is downloaded, never shown on Liston's own address; a picture that isn't one is kept as a plain file.
  const doc = await upload(o.token, Buffer.from('<html><script>alert(1)</script></html>'), { name: 'notes.html', type: 'text/html' });
  assert.strictEqual(doc.status, 201);
  const docRes = await fetch(local(doc.data.url));
  assert.match(docRes.headers.get('content-disposition'), /^attachment;/);
  assert.match(docRes.headers.get('content-security-policy'), /sandbox/);
  const fake = await upload(o.token, Buffer.from('not a picture'), { name: 'x.png', type: 'image/png' });
  assert.deepStrictEqual([fake.data.image, fake.data.mime, fake.data.thumbUrl], [false, 'application/octet-stream', null]);

  // Programs and empty files are refused.
  assert.strictEqual((await upload(o.token, Buffer.from('MZ'), { name: 'setup.exe', type: 'application/octet-stream' })).status, 400);
  assert.strictEqual((await upload(o.token, Buffer.alloc(0), { name: 'empty.txt', type: 'text/plain' })).status, 400);

  // An eBay attachment: a public, unguessable link eBay can fetch, gone after 30 days.
  const ebay = await upload(o.token, photo, { name: 'receipt.jpg', type: 'image/jpeg', purpose: 'ebay' });
  assert.match(ebay.data.url, /\/media\/p\/[A-Za-z0-9_-]{20,}\/receipt\.jpg$/);
  assert.strictEqual((await fetch(local(ebay.data.url))).status, 200);
  const { rows } = await pool.query('SELECT expires_at, storage_key FROM files WHERE id = $1', [ebay.data.id]);
  assert.ok(rows[0].expires_at > new Date(Date.now() + 29 * 86400000));
  await pool.query("UPDATE files SET expires_at = now() - interval '1 minute' WHERE id = $1", [ebay.data.id]);
  assert.strictEqual((await fetch(local(ebay.data.url))).status, 404, 'expired');
  assert.ok(await require('../../src/modules/files/files.service').removeExpired() >= 1);
  assert.strictEqual(await storage.read(rows[0].storage_key), null, 'its bytes deleted too');
  assert.strictEqual((await fetch(`${baseUrl}/media/p/nope/x`)).status, 404);
});

test('Liston cards: an order, listing, draft or hunted product from any account, opening that page in that account; locked where the viewer has no access', async () => {
  const o = await owner('cards');
  const flipx = await connectionService.createConnection(o.id, { platformKey: 'ebay', label: 'FlipX', credentials: { accessToken: 'x' } });
  const selvora = await connectionService.createConnection(o.id, { platformKey: 'ebay', label: 'Selvora', credentials: { accessToken: 'x' } });
  const orderId = `${String(crypto.randomInt(10, 99))}-${String(crypto.randomInt(10000, 99999))}-${String(crypto.randomInt(10000, 99999))}`;
  const itemId = String(crypto.randomInt(100000000000, 999999999999));
  await pool.query(`INSERT INTO ebay_orders (connection_id, order_id, created_at, data) VALUES ($1, $2, now(), $3)`, [
    flipx.id,
    orderId,
    JSON.stringify({ orderId, status: 'Completed', checkoutStatus: 'Complete', cancelStatus: 'NotApplicable', shippedTime: '2026-09-20T10:00:00Z', total: { amount: 12.5, currency: 'GBP' }, buyerUserId: 'jane_uk', createdAt: '2026-09-19T10:00:00Z', lineItems: [{ itemId, title: 'Coconut squishy ball', quantityPurchased: 1 }, { itemId: '1', title: 'Other' }] }),
  ]);
  await pool.query(`INSERT INTO ebay_snapshots (connection_id, kind, data) VALUES ($1, 'listings:active', $2)`, [
    selvora.id,
    JSON.stringify({ items: [{ itemId, title: 'Coconut squishy ball', sku: 'SQ-1', price: { amount: 6.99, currency: 'GBP' }, quantityAvailable: 7, quantitySold: 3, imageUrl: 'https://i.ebayimg.com/images/g/abc/s-l140.jpg' }] }),
  ]);
  const { rows: drafts } = await pool.query(`INSERT INTO listings (connection_id, status, generated_data) VALUES ($1, 'pending_review', $2) RETURNING id`, [
    selvora.id,
    JSON.stringify({ title: 'Squishy stress ball draft', price: { value: '7.49', currency: 'GBP' }, sku: 'SQ-2', imageUrls: ['https://i.ebayimg.com/x.jpg'] }),
  ]);
  const { rows: hunts } = await pool.query(
    `INSERT INTO hunted_products (owner_user_id, connection_id, hunter_user_id, status, competitor_url, competitor_item_id, title, currency, check_result, headline_profit, headline_roi)
     VALUES ($1, $2, $1, 'pending', 'https://www.ebay.co.uk/itm/1', '1', 'Hunted squishy', 'GBP', '{}', 3.2, 80) RETURNING id`,
    [o.id, flipx.id]
  );

  // The owner: every card, naming its account, linking to that page there.
  const all = await request('POST', '/api/references/resolve', { refs: [{ kind: 'order', id: orderId }, { kind: 'listing', id: itemId }, { kind: 'draft', id: drafts[0].id }, { kind: 'hunt', id: hunts[0].id }, { kind: 'order', id: '00-00000-00000' }] }, o.token);
  assert.strictEqual(all.status, 200, JSON.stringify(all.data));
  const [order, listing, draft, hunt, missing] = all.data.cards;
  assert.deepStrictEqual([order.account.label, order.url, order.status.label, order.title], ['FlipX', `/accounts/${flipx.id}/orders/${orderId}`, 'Dispatched', 'Coconut squishy ball (+1 more)']);
  assert.strictEqual(order.image, 'https://i.ebayimg.com/images/g/abc/s-l500.jpg', "the listing's photo stands in");
  assert.ok(order.facts.some((f) => f.kind === 'money' && f.amount === 12.5) && order.facts.some((f) => f.text === 'Buyer jane_uk'));
  assert.deepStrictEqual([listing.account.label, listing.url, listing.status.label], ['Selvora', `/accounts/${selvora.id}/listings?q=${itemId}`, 'Live']);
  assert.ok(listing.facts.some((f) => f.text === '7 available'));
  assert.deepStrictEqual([draft.url, draft.title, draft.status.label], [`/accounts/${selvora.id}/listings/draft/${drafts[0].id}`, 'Squishy stress ball draft', 'Draft']);
  assert.deepStrictEqual([hunt.url, hunt.status.label], [`/accounts/${flipx.id}/hunting?open=${hunts[0].id}`, 'Waiting for review']);
  assert.strictEqual(missing, null);

  // A member with Orders on FlipX only: the order opens; the listing and draft are locked, nothing of them shown.
  const m = await member(o.token, [
    { connectionId: flipx.id, feature: 'orders', allowed: true },
  ]);
  const seen = await request('POST', '/api/references/resolve', { refs: [{ kind: 'order', id: orderId }, { kind: 'listing', id: itemId }, { kind: 'draft', id: drafts[0].id }] }, m.token);
  assert.strictEqual(seen.data.cards[0].account.label, 'FlipX');
  assert.deepStrictEqual(seen.data.cards[1], { kind: 'listing', id: itemId, key: `listing:locked:${itemId}`, locked: true });
  assert.strictEqual(seen.data.cards[2].locked, true);
  // Another owner's things are simply not there.
  const stranger = await owner('cards-stranger');
  assert.deepStrictEqual((await request('POST', '/api/references/resolve', { refs: [{ kind: 'order', id: orderId }] }, stranger.token)).data.cards, [null]);

  // Found in a message's words, in the order written.
  const found = await request('POST', '/api/references/detect', { text: `Can you check ${orderId}? Same as https://www.ebay.co.uk/itm/Squishy/${itemId}` }, o.token);
  assert.deepStrictEqual(found.data.cards.map((c) => c.kind), ['order', 'listing']);

  // The "/" picker: by buyer, title or SKU, across accounts.
  assert.deepStrictEqual((await request('GET', '/api/references/search?q=jane_uk', undefined, o.token)).data.cards.map((c) => c.kind), ['order']);
  const bySku = await request('GET', '/api/references/search?q=SQ-&kinds=listing,draft', undefined, o.token);
  assert.deepStrictEqual(bySku.data.cards.map((c) => c.kind).sort(), ['draft', 'listing']);
  assert.deepStrictEqual((await request('GET', '/api/references/search?q=squishy', undefined, m.token)).data.cards.map((c) => c.kind), ['order'], 'only what the member can open');
});

test('the live channel: each person gets their own events, and says which conversation their tab shows', async () => {
  const o = await owner('live');
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/me/events`, { headers: { Authorization: `Bearer ${o.token}` }, signal: controller.signal });
  assert.strictEqual(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async (needle) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  };
  await until('event: ready');
  assert.strictEqual(userEvents.isOnline(o.id), true);
  userEvents.emit(o.id, { type: 'chat.message', conversationId: 'c1' });
  userEvents.emit(crypto.randomUUID(), { type: 'chat.message', conversationId: 'not-yours' });
  await until('chat.message');
  assert.match(text, /"conversationId":"c1"/);
  assert.doesNotMatch(text, /not-yours/);

  assert.strictEqual((await request('POST', '/api/me/presence', { tabId: 'tab-1', view: 'chat:c1', focused: true }, o.token)).status, 204);
  assert.strictEqual(userEvents.isViewing(o.id, 'chat:c1'), true);
  assert.strictEqual(userEvents.isViewing(o.id, 'chat:c2'), false);
  await request('POST', '/api/me/presence', { tabId: 'tab-1', view: 'chat:c1', focused: false }, o.token);
  assert.strictEqual(userEvents.isViewing(o.id, 'chat:c1'), false, 'a tab in the background is not reading');
  assert.strictEqual((await request('POST', '/api/me/presence', { view: 'chat:c1' }, o.token)).status, 400);
  controller.abort();
  assert.strictEqual((await fetch(`${baseUrl}/api/me/events`)).status, 401);
});
