const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { mock } = require('node:test');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');
const connectionRepository = require('../../src/modules/connections/connection.repository');
const ebayMessage = require('../../src/modules/ebay/api/ebay.message');
const inboxService = require('../../src/modules/inbox/inbox.service');
const orderIssues = require('../../src/modules/inbox/order-issues.service');
const ebayPostOrder = require('../../src/modules/ebay/api/ebay.postorder');
const ebayFulfillment = require('../../src/modules/ebay/api/ebay.fulfillment');
const ebayOauth = require('../../src/modules/ebay/api/ebay.oauth');

// The Inbox's eBay messages, with eBay's Message API stood in for: the
// account's conversations read into Liston (all the first time, then only
// what changed), folders for buyers, eBay and the archive, a thread's
// messages read when it's opened and marked read on eBay, the buyer's
// orders beside it (Orders access only), archive, every account together,
// and a closed eBay member's messages forgotten.

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

const ago = (m) => new Date(Date.now() - m * 60000).toISOString();

async function setup({ scopes = [inboxService.SCOPE] } = {}) {
  const email = `inbox-ebay-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  const connection = await connectionService.createConnection(data.user.id, {
    platformKey: 'ebay',
    label: 'Walexo',
    credentials: { accessToken: 'token', refreshToken: 'refresh', accessTokenExpiresAt: Date.now() + 3600e3, scopes, marketplaceId: 'EBAY_GB' },
  });
  await connectionRepository.mergeEbaySettings(connection.id, { username: 'walexo_shop', marketplaceId: 'EBAY_GB' });
  return { owner: { id: data.user.id, token: data.token }, connection };
}

// eBay's side: two buyer conversations and one from eBay; a thread each.
function stubEbay({ buyers, ebay = [], threads = {} }) {
  const calls = { list: [], thread: [], update: [] };
  mock.method(ebayMessage, 'getConversations', async (token, { type, status, offset }) => {
    calls.list.push({ type, status, offset });
    const all = status === 'ARCHIVE' ? [] : type === 'FROM_EBAY' ? ebay : buyers;
    return { conversations: all.slice(offset, offset + 50), total: all.length };
  });
  mock.method(ebayMessage, 'getConversation', async (token, id, { type }) => {
    calls.thread.push({ id, type });
    const messages = threads[id] || [];
    return { messages, total: messages.length };
  });
  mock.method(ebayMessage, 'updateConversation', async (token, body) => {
    calls.update.push(body);
  });
  return calls;
}

const conv = (id, { type = 'FROM_MEMBERS', buyer = 'and_630713', fromSeller = false, text = 'Where is my parcel?', item = '358376442432', unread = 1, at = ago(30), title = 'Coconut Oil Squishy Stress Ball' } = {}) => ({
  conversationId: id,
  type,
  status: 'ACTIVE',
  title,
  referenceId: type === 'FROM_EBAY' ? null : item,
  referenceType: type === 'FROM_EBAY' ? null : 'LISTING',
  unreadCount: unread,
  createdAt: ago(5000),
  latestMessage: { messageId: `${id}-last`, body: text, sender: type === 'FROM_EBAY' ? 'eBay' : fromSeller ? 'walexo_shop' : buyer, recipient: fromSeller ? buyer : 'walexo_shop', createdAt: at, media: [] },
});

test('the account\'s conversations are read into Liston: folders for buyers and eBay, who spoke last, the item\'s photo, then only what changed', async () => {
  const t = await setup();
  await pool.query(`INSERT INTO ebay_snapshots (connection_id, kind, data) VALUES ($1, 'listings:active', $2)`, [t.connection.id, JSON.stringify({ items: [{ itemId: '358376442432', title: 'Coconut Oil Squishy Stress Ball', price: { amount: 8.49, currency: 'GBP' }, imageUrl: 'https://i.ebayimg.com/images/g/x/s-l140.jpg' }] })]);
  const calls = stubEbay({
    buyers: [conv('c1', { text: 'Still not arrived and it’s for a birthday tomorrow', at: ago(10) }), conv('c2', { buyer: 'lotsofstuff1244', fromSeller: true, text: 'Could you send a photo?', unread: 0, at: ago(60) })],
    ebay: [conv('e1', { type: 'FROM_EBAY', text: '<p>Success! All seller privileges have been <b>restored</b>.</p>', title: 'Success! All seller privileges have been restored' })],
  });
  try {
    const base = `/api/connections/${t.connection.id}/inbox`;
    await inboxService.sync(t.connection.id, t.owner.id);
    assert.deepStrictEqual(calls.list.map((c) => `${c.type}:${c.status}`), ['FROM_MEMBERS:ACTIVE', 'FROM_MEMBERS:ARCHIVE', 'FROM_EBAY:ACTIVE', 'FROM_EBAY:ARCHIVE'], 'all of it, inbox and archive, the first time');

    const buyers = await request('GET', base, undefined, t.owner.token);
    assert.strictEqual(buyers.status, 200, JSON.stringify(buyers.data));
    assert.deepStrictEqual(buyers.data.conversations.map((c) => [c.conversationId, c.otherParty, c.latestFromSeller, Boolean(c.waitingSince)]), [
      ['c1', 'and_630713', false, true],
      ['c2', 'lotsofstuff1244', true, false],
    ]);
    assert.strictEqual(buyers.data.conversations[0].image, 'https://i.ebayimg.com/images/g/x/s-l225.jpg', "the listing's photo");
    assert.deepStrictEqual(buyers.data.counts, { buyers: 1, ebay: 1, waiting: 1, archived: 0 });
    // The Unread view: the buyers' and eBay's unread together.
    assert.deepStrictEqual((await request('GET', `${base}?folder=all&show=unread`, undefined, t.owner.token)).data.conversations.map((c) => c.conversationId).sort(), ['c1', 'e1']);
    const fromEbay = await request('GET', `${base}?folder=ebay`, undefined, t.owner.token);
    assert.deepStrictEqual([fromEbay.data.conversations[0].otherParty, fromEbay.data.conversations[0].latestPreview], ['eBay', 'Success! All seller privileges have been restored.'], "eBay's HTML made readable");
    assert.deepStrictEqual((await request('GET', `${base}?q=lotsofstuff`, undefined, t.owner.token)).data.conversations.map((c) => c.conversationId), ['c2'], 'found by buyer');

    // Again: nothing new on the first page, so nothing more is read (the archive waits for the next full read).
    calls.list.length = 0;
    const again = await inboxService.sync(t.connection.id, t.owner.id);
    assert.deepStrictEqual([again.changed, again.full, calls.list.length], [0, false, 2]);
  } finally {
    mock.restoreAll();
  }
});

test('opening a conversation reads its messages, marks it read on eBay, and puts the buyer\'s orders beside it (for people with Orders)', async () => {
  const t = await setup();
  const orderId = '20-15161-78659';
  await pool.query(`INSERT INTO ebay_orders (connection_id, order_id, created_at, data) VALUES ($1, $2, now(), $3)`, [
    t.connection.id,
    orderId,
    JSON.stringify({ orderId, buyerUserId: 'and_630713', buyerName: 'ANDREW JONES', checkoutStatus: 'Complete', cancelStatus: 'NotApplicable', shippedTime: ago(2000), total: { amount: 8.49, currency: 'GBP' }, lineItems: [{ itemId: '358376442432', title: 'Coconut Oil Squishy', trackingNumber: 'TRK1', trackingCarrier: 'Royal Mail' }] }),
  ]);
  const calls = stubEbay({
    buyers: [conv('c1')],
    threads: {
      c1: [
        { messageId: 'm1', body: 'Hi Andrea, thank you for your order!', sender: 'walexo_shop', recipient: 'and_630713', createdAt: ago(3000), media: [] },
        { messageId: 'c1-last', body: 'Where is my parcel?', sender: 'and_630713', recipient: 'walexo_shop', createdAt: ago(30), media: [{ name: 'p1.jpg', type: 'IMAGE', url: 'https://i.ebayimg.com/p1.jpg' }] },
      ],
    },
  });
  try {
    await inboxService.sync(t.connection.id, t.owner.id);
    const base = `/api/connections/${t.connection.id}/inbox`;
    const opened = await request('GET', `${base}/c1`, undefined, t.owner.token);
    assert.strictEqual(opened.status, 200, JSON.stringify(opened.data));
    assert.deepStrictEqual(opened.data.messages.map((m) => [m.id, m.fromSeller]), [
      ['m1', true],
      ['c1-last', false],
    ]);
    assert.deepStrictEqual(opened.data.messages[1].media[0], { name: 'p1.jpg', type: 'IMAGE', url: 'https://i.ebayimg.com/p1.jpg', image: true });
    const order = opened.data.context.order;
    assert.deepStrictEqual([order.orderId, order.statusLabel, order.tracking[0].number, order.url], [orderId, 'Dispatched', 'TRK1', `/accounts/${t.connection.id}/orders/${orderId}`]);
    assert.strictEqual(opened.data.context.item.ebayUrl, 'https://www.ebay.co.uk/itm/358376442432');
    assert.strictEqual(opened.data.context.buyerName, 'Andrew', "what to call them: the first name on their order, not shouted");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(calls.update, [{ conversationId: 'c1', type: 'FROM_MEMBERS', read: true }], 'read on eBay too');
    assert.strictEqual(opened.data.conversation.unread, 0);

    // Opened again with nothing new: eBay isn't asked for the thread again.
    calls.thread.length = 0;
    await request('GET', `${base}/c1`, undefined, t.owner.token);
    assert.strictEqual(calls.thread.length, 0);

    // Unread again, archived, back: here and on eBay.
    await request('POST', `${base}/c1/read`, { read: false }, t.owner.token);
    assert.strictEqual((await request('GET', base, undefined, t.owner.token)).data.conversations[0].unread, 1);
    await request('POST', `${base}/c1/status`, { status: 'ARCHIVE' }, t.owner.token);
    const afterArchive = await request('GET', base, undefined, t.owner.token);
    assert.deepStrictEqual(afterArchive.data.conversations, []);
    assert.strictEqual(afterArchive.data.counts.archived, 1, 'the archive counted, for its row in the list');
    assert.deepStrictEqual((await request('GET', `${base}?folder=archived`, undefined, t.owner.token)).data.conversations.map((c) => c.conversationId), ['c1']);
    assert.deepStrictEqual(calls.update.slice(1), [
      { conversationId: 'c1', type: 'FROM_MEMBERS', read: false },
      { conversationId: 'c1', type: 'FROM_MEMBERS', status: 'ARCHIVE' },
    ]);

    // A member with Inbox but not Orders: the messages, not the orders. Without Inbox: nothing.
    const memberEmail = `inbox-member-${crypto.randomUUID()}@example.com`;
    const added = await request('POST', '/api/team/members', { email: memberEmail, password: 'memberpassword123', name: 'Sara' }, t.owner.token);
    await request('PUT', `/api/team/members/${added.data.id || added.data.member?.id}/permissions`, { permissions: [{ connectionId: t.connection.id, feature: 'inbox', allowed: true }] }, t.owner.token);
    const member = (await request('POST', '/api/auth/login', { email: memberEmail, password: 'memberpassword123' })).data.token;
    const seen = await request('GET', `${base}/c1`, undefined, member);
    assert.deepStrictEqual([seen.data.context.orders, seen.data.context.ordersHidden, seen.data.context.buyerName], [[], true, null], 'no orders, no name from them');
    const other = `inbox-other-${crypto.randomUUID()}@example.com`;
    const added2 = await request('POST', '/api/team/members', { email: other, password: 'memberpassword123', name: 'Tom' }, t.owner.token);
    await request('PUT', `/api/team/members/${added2.data.id || added2.data.member?.id}/permissions`, { permissions: [{ connectionId: t.connection.id, feature: 'orders', allowed: true }] }, t.owner.token);
    const tom = (await request('POST', '/api/auth/login', { email: other, password: 'memberpassword123' })).data.token;
    assert.strictEqual((await request('GET', base, undefined, tom)).status, 403);

    // Every account together, each row naming its account.
    const all = await request('GET', '/api/inbox?folder=archived', undefined, t.owner.token);
    assert.deepStrictEqual(all.data.conversations.map((c) => c.account.label), ['Walexo']);

    // eBay says the buyer closed their account: their conversation and messages go.
    assert.ok((await inboxService.forgetMember('AND_630713')) >= 1, 'on every account');
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM ebay_conversations WHERE connection_id = $1', [t.connection.id])).rows[0].n, 0);
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM ebay_messages WHERE connection_id = $1', [t.connection.id])).rows[0].n, 0);
  } finally {
    mock.restoreAll();
  }
});

test("a conversation read in Liston stays read when eBay's list still says unread (the seller had the last word), until the buyer writes again or it's marked unread", async () => {
  const t = await setup();
  // eBay's list: the seller's "You're welcome." last, and eBay still counting one unread.
  const buyers = [conv('c1', { fromSeller: true, text: "You're welcome.", unread: 1, at: ago(20) })];
  const calls = stubEbay({ buyers, threads: { c1: [{ messageId: 'm1', sender: 'and_630713', recipient: 'walexo_shop', body: 'Okay thank you', createdAt: ago(40), media: [] }, { messageId: 'c1-last', sender: 'walexo_shop', recipient: 'and_630713', body: "You're welcome.", createdAt: ago(20), media: [] }] } });
  try {
    const base = `/api/connections/${t.connection.id}/inbox`;
    const unreadOf = async () => (await request('GET', base, undefined, t.owner.token)).data.conversations[0].unread;
    const syncAgain = async () => {
      await pool.query('UPDATE ebay_inbox_sync SET last_sync_at = now() - interval \'1 hour\' WHERE connection_id = $1', [t.connection.id]);
      await inboxService.sync(t.connection.id, t.owner.id);
    };
    await inboxService.sync(t.connection.id, t.owner.id);
    assert.strictEqual(await unreadOf(), 1, "never opened in Liston: eBay's word");

    // Opened: read, and eBay told.
    assert.strictEqual((await request('GET', `${base}/c1`, undefined, t.owner.token)).status, 200);
    assert.strictEqual(await unreadOf(), 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(calls.update.map((u) => u.read), [true]);

    // eBay's list still says 1 unread: it stays read, and isn't counted as a change.
    calls.list.length = 0;
    await syncAgain();
    assert.strictEqual(await unreadOf(), 0, "eBay's stale count doesn't make it unread again");
    assert.strictEqual((await request('GET', `${base}/unread`, undefined, t.owner.token)).data.unread, 0);

    // The buyer writes again: unread.
    buyers[0] = { ...conv('c1', { text: 'One more question', unread: 1, at: ago(1) }), latestMessage: { ...conv('c1', { text: 'One more question', at: ago(1) }).latestMessage, messageId: 'c1-new' } };
    await syncAgain();
    assert.strictEqual(await unreadOf(), 1, "a newer message from the buyer: eBay's count again");

    // Read again, then marked unread by hand: unread, and it stays so after eBay's list is read.
    await request('GET', `${base}/c1`, undefined, t.owner.token);
    assert.strictEqual(await unreadOf(), 0);
    await request('POST', `${base}/c1/read`, { read: false }, t.owner.token);
    assert.strictEqual(await unreadOf(), 1);
    await syncAgain();
    assert.strictEqual(await unreadOf(), 1, 'marked unread stays unread');
  } finally {
    mock.restoreAll();
  }
});

test("a buyer's conversation is marked with an open return (eBay's for the whole account) or the cancellation they asked for, for those who may see orders", async () => {
  const t = await setup({ scopes: [inboxService.SCOPE, ebayOauth.SCOPE_FULFILLMENT] });
  stubEbay({ buyers: [conv('c1', { buyer: 'and_630713', item: '358376442432' }), conv('c2', { buyer: 'lotsofstuff1244', item: '111222333', at: ago(40) })] });
  const order = (orderId, buyerUserId, itemId, extra = {}) =>
    pool.query(`INSERT INTO ebay_orders (connection_id, order_id, created_at, data) VALUES ($1, $2, now(), $3)`, [
      t.connection.id,
      orderId,
      JSON.stringify({ orderId, buyerUserId, checkoutStatus: 'Complete', cancelStatus: 'NotApplicable', total: { amount: 5, currency: 'GBP' }, lineItems: [{ itemId, title: 'Thing' }], ...extra }),
    ]);
  await order('20-00001-00001', 'and_630713', '358376442432', { shippedTime: ago(3000), deliveredAt: ago(1000) });
  await order('20-00002-00002', 'lotsofstuff1244', '111222333', { cancelStatus: 'CancelPending' });
  const searched = [];
  mock.method(ebayPostOrder, 'searchReturns', async (token, filters) => {
    searched.push(['returns', filters]);
    return {
      members: [
        { returnId: 'R1', orderId: '20-00001-00001', buyerLoginName: 'and_630713', state: 'RETURN_REQUESTED', creationInfo: { item: { itemId: '358376442432' } }, sellerResponseDue: { respondByDate: { value: '2026-10-03T10:00:00.000Z' } } },
        { returnId: 'R0', orderId: '20-00001-00001', buyerLoginName: 'and_630713', state: 'CLOSED', creationInfo: { item: { itemId: '358376442432' } } },
      ],
    };
  });
  mock.method(ebayPostOrder, 'searchInquiries', async () => ({ members: [] }));
  mock.method(ebayFulfillment, 'getPaymentDisputeSummaries', async () => ({ paymentDisputeSummaries: [] }));
  try {
    const base = `/api/connections/${t.connection.id}/inbox`;
    await inboxService.sync(t.connection.id, t.owner.id);
    await orderIssues.refresh(t.connection.id, t.owner.id);
    assert.deepStrictEqual(searched, [['returns', {}]], "one read for the whole account, not one per order");

    const rows = (await request('GET', base, undefined, t.owner.token)).data.conversations;
    const byId = Object.fromEntries(rows.map((r) => [r.conversationId, r.issue]));
    assert.deepStrictEqual(byId.c1, { kind: 'return', label: 'Return open', respondBy: '2026-10-03T10:00:00.000Z', orderId: '20-00001-00001' }, 'the open return, not the closed one');
    assert.deepStrictEqual(byId.c2, { kind: 'cancel', label: 'Cancel requested', respondBy: null, orderId: '20-00002-00002' });

    // Opened: the header's mark, and the order as it stands (a request waiting isn't a cancelled order).
    const opened = (await request('GET', `${base}/c2`, undefined, t.owner.token)).data;
    assert.strictEqual(opened.conversation.issue.kind, 'cancel');
    assert.deepStrictEqual([opened.context.order.cancelRequested, opened.context.order.status], [true, 'awaiting_dispatch']);

    // The order page reads the return closed: the mark goes at once.
    await orderIssues.noteOrder(t.connection.id, { orderIds: ['20-00001-00001'], buyer: 'and_630713', itemIds: ['358376442432'], cases: { returns: [{ id: 'R1', closed: true }], inquiries: [], disputes: [] } });
    assert.strictEqual((await request('GET', base, undefined, t.owner.token)).data.conversations.find((r) => r.conversationId === 'c1').issue, null);

    // A member with the Inbox but not Orders sees no marks.
    const email = `inbox-issues-${crypto.randomUUID()}@example.com`;
    const added = await request('POST', '/api/team/members', { email, password: 'memberpassword123', name: 'Sara' }, t.owner.token);
    await request('PUT', `/api/team/members/${added.data.id || added.data.member?.id}/permissions`, { permissions: [{ connectionId: t.connection.id, feature: 'inbox', allowed: true }] }, t.owner.token);
    const sara = (await request('POST', '/api/auth/login', { email, password: 'memberpassword123' })).data.token;
    assert.deepStrictEqual((await request('GET', base, undefined, sara)).data.conversations.map((r) => r.issue), [null, null]);
  } finally {
    mock.restoreAll();
  }
});

test('an account connected before messages were added is asked to reconnect, and the list says so', async () => {
  const t = await setup({ scopes: ['https://api.ebay.com/oauth/api_scope/sell.fulfillment'] });
  const calls = stubEbay({ buyers: [conv('c1')] });
  try {
    await assert.rejects(inboxService.sync(t.connection.id, t.owner.id), /Reconnect this eBay account/);
    const list = await request('GET', `/api/connections/${t.connection.id}/inbox`, undefined, t.owner.token);
    assert.deepStrictEqual([list.status, list.data.sync.error.scope, list.data.conversations], [200, true, []]);
    assert.strictEqual(calls.list.length, 0, 'eBay not asked');
  } finally {
    mock.restoreAll();
  }
});

test('replying to a buyer: a warning first when eBay would block it, attachments on public links, kept at once as the last word, never for eBay\'s own', async () => {
  const t = await setup();
  const calls = stubEbay({ buyers: [conv('c1')], ebay: [conv('e1', { type: 'FROM_EBAY', text: 'Notice' })], threads: { c1: [] } });
  const sent = [];
  mock.method(ebayMessage, 'sendMessage', async (token, body) => {
    sent.push(body);
    return { messageId: 'reply-1', conversationId: body.conversationId };
  });
  try {
    await inboxService.sync(t.connection.id, t.owner.id);
    const base = `/api/connections/${t.connection.id}/inbox`;

    // eBay would block contact details: nothing sent until confirmed.
    const warned = await request('POST', `${base}/c1/messages`, { text: 'Sorry! Email me at help@shop.com and I will sort it' }, t.owner.token);
    assert.deepStrictEqual([warned.status, warned.data.sent, warned.data.warnings.map((w) => w.kind)], [200, false, ['email']]);
    assert.strictEqual(sent.length, 0);

    // A photo uploaded for eBay goes on its public link, as an IMAGE.
    const photo = await require('sharp')({ create: { width: 20, height: 20, channels: 3, background: '#f00' } }).jpeg().toBuffer();
    const up = await fetch(`${baseUrl}/api/files?purpose=ebay`, { method: 'POST', headers: { Authorization: `Bearer ${t.owner.token}`, 'Content-Type': 'image/jpeg', 'X-File-Name': 'label.jpg' }, body: photo });
    const file = await up.json();
    const reply = await request('POST', `${base}/c1/messages`, { text: 'So sorry for the delay, it was dispatched on the 23rd. Here is the label:', fileIds: [file.id] }, t.owner.token);
    assert.strictEqual(reply.status, 201, JSON.stringify(reply.data));
    assert.deepStrictEqual(sent[0], { conversationId: 'c1', text: 'So sorry for the delay, it was dispatched on the 23rd. Here is the label:', media: [{ name: 'label.jpg', type: 'IMAGE', url: file.url }] });
    assert.deepStrictEqual([reply.data.message.id, reply.data.message.fromSeller, reply.data.message.media[0].image], ['reply-1', true, true]);
    const row = (await request('GET', base, undefined, t.owner.token)).data.conversations[0];
    assert.deepStrictEqual([row.latestFromSeller, row.waitingSince, row.latestPreview], [true, null, 'So sorry for the delay, it was dispatched on the 23rd. Here is the label:']);
    const { rows } = await pool.query(`SELECT kind, subject_type, subject_id FROM member_activity WHERE connection_id = $1 AND kind = 'inbox.replied'`, [t.connection.id]);
    assert.deepStrictEqual(rows, [{ kind: 'inbox.replied', subject_type: 'conversation', subject_id: 'c1' }]);

    // Confirmed anyway: sent as written.
    const anyway = await request('POST', `${base}/c1/messages`, { text: 'You can also reach us at help@shop.com', confirm: true }, t.owner.token);
    assert.strictEqual(anyway.status, 201);

    // Not to eBay itself; not with a chat file; not over 2,000 characters.
    assert.strictEqual((await request('POST', `${base}/e1/messages`, { text: 'hi' }, t.owner.token)).status, 400);
    const chatFile = await (await fetch(`${baseUrl}/api/files?purpose=chat`, { method: 'POST', headers: { Authorization: `Bearer ${t.owner.token}`, 'Content-Type': 'text/plain', 'X-File-Name': 'n.txt' }, body: 'x' })).json();
    assert.strictEqual((await request('POST', `${base}/c1/messages`, { text: 'hi', fileIds: [chatFile.id] }, t.owner.token)).status, 400);
    assert.strictEqual((await request('POST', `${base}/c1/messages`, { text: 'x'.repeat(2001) }, t.owner.token)).status, 400);
    assert.strictEqual(calls.thread.length >= 0, true);
  } finally {
    mock.restoreAll();
  }
});

test("eBay refusing the archive never stops the inbox being read: the buyers' and eBay's conversations still come in", async () => {
  const t = await setup();
  stubEbay({ buyers: [conv('c1')], ebay: [conv('e1', { type: 'FROM_EBAY', text: 'Notice' })] });
  const real = ebayMessage.getConversations;
  mock.method(ebayMessage, 'getConversations', async (token, args, site) => {
    if (args.status === 'ARCHIVE') throw Object.assign(new Error('Invalid conversationStatus value.'), { statusCode: 400 });
    return real.call(ebayMessage, token, args, site);
  });
  try {
    const out = await inboxService.sync(t.connection.id, t.owner.id);
    assert.deepStrictEqual([out.changed, out.full], [2, true]);
    const list = await request('GET', `/api/connections/${t.connection.id}/inbox?folder=ebay`, undefined, t.owner.token);
    assert.deepStrictEqual([list.data.conversations.length, list.data.sync.error], [1, null]);
  } finally {
    mock.restoreAll();
  }
});
