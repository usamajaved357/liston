const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');

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

async function request(method, path, body, token) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function signupAndLogin(email, password) {
  const { data } = await request('POST', '/api/auth/signup', { email, password });
  // New owners are pending until an admin approves; these tests are about
  // what an approved account can do, so approve directly in the DB.
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  return { userId: data.user.id, token: data.token };
}

async function createOwnerWithMemberAndConnection() {
  const ownerEmail = `owner-${crypto.randomUUID()}@example.com`;
  const { userId: ownerId, token: ownerToken } = await signupAndLogin(ownerEmail, 'testpassword123');

  const connection = await connectionService.createConnection(ownerId, {
    platformKey: 'ebay',
    label: 'Team Test Store',
    credentials: { accessToken: 'x' },
  });

  const memberEmail = `member-${crypto.randomUUID()}@example.com`;
  const memberPassword = 'memberpassword123';
  const addRes = await request('POST', '/api/team/members', { email: memberEmail, password: memberPassword }, ownerToken);
  assert.strictEqual(addRes.status, 201);

  const { data: loginData } = await request('POST', '/api/auth/login', { email: memberEmail, password: memberPassword });
  return { ownerId, ownerToken, memberId: addRes.data.member.id, memberToken: loginData.token, memberEmail, connectionId: connection.id };
}

test('POST /api/team/members requires the caller to be an owner', async () => {
  const { memberToken } = await createOwnerWithMemberAndConnection();

  const { status } = await request(
    'POST',
    '/api/team/members',
    { email: `nested-${crypto.randomUUID()}@example.com`, password: 'testpassword123' },
    memberToken
  );
  assert.strictEqual(status, 403);
});

test('a member with no granted permissions sees no connections and gets 403 on the connection directly', async () => {
  const { memberToken, connectionId } = await createOwnerWithMemberAndConnection();

  const list = await request('GET', '/api/connections', undefined, memberToken);
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.data.connections, []);

  const detail = await request('GET', `/api/connections/${connectionId}`, undefined, memberToken);
  assert.strictEqual(detail.status, 403);
});

test('granting a global default feature makes the connection visible with resolved permissions', async () => {
  const { ownerToken, memberId, memberToken, connectionId } = await createOwnerWithMemberAndConnection();

  const grant = await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId: null, feature: 'orders', allowed: true }] },
    ownerToken
  );
  assert.strictEqual(grant.status, 200);

  const list = await request('GET', '/api/connections', undefined, memberToken);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.data.connections.length, 1);
  assert.deepStrictEqual(list.data.connections[0].permissions, {
    orders: true,
    listings: false,
    analytics: false,
    inbox: false,
    campaigns: false,
  });

  const detail = await request('GET', `/api/connections/${connectionId}`, undefined, memberToken);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.data.connection.permissions.orders, true);
});

test('an ungranted feature 403s even once the connection is visible for another feature', async () => {
  const { ownerToken, memberId, memberToken, connectionId } = await createOwnerWithMemberAndConnection();

  await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId: null, feature: 'orders', allowed: true }] },
    ownerToken
  );

  const policies = await request('GET', `/api/connections/${connectionId}/policies`, undefined, memberToken);
  assert.strictEqual(policies.status, 403); // owner-only, regardless of any feature grant

  const drafts = await request('GET', `/api/connections/${connectionId}/listings/drafts`, undefined, memberToken);
  assert.strictEqual(drafts.status, 403); // 'listings' was never granted
});

test('a connection-scoped override can revoke what the global default grants', async () => {
  const { ownerToken, memberId, memberToken, connectionId } = await createOwnerWithMemberAndConnection();

  await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId: null, feature: 'orders', allowed: true }] },
    ownerToken
  );
  await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId, feature: 'orders', allowed: false }] },
    ownerToken
  );

  const detail = await request('GET', `/api/connections/${connectionId}`, undefined, memberToken);
  // Every other feature is still false, and orders is now overridden false too
  // for this specific connection, so it has zero access and is not visible.
  assert.strictEqual(detail.status, 403);
});

test('PUT permissions with allowed: null clears a connection-scoped override back to the global default', async () => {
  const { ownerToken, memberId, memberToken, connectionId } = await createOwnerWithMemberAndConnection();

  await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId: null, feature: 'orders', allowed: true }] },
    ownerToken
  );
  await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId, feature: 'orders', allowed: false }] },
    ownerToken
  );
  const blocked = await request('GET', `/api/connections/${connectionId}`, undefined, memberToken);
  assert.strictEqual(blocked.status, 403);

  const clear = await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId, feature: 'orders', allowed: null }] },
    ownerToken
  );
  assert.strictEqual(clear.status, 200);
  assert.strictEqual(
    clear.data.permissions.find((p) => p.connection_id === connectionId && p.feature === 'orders'),
    undefined
  );

  const restored = await request('GET', `/api/connections/${connectionId}`, undefined, memberToken);
  assert.strictEqual(restored.status, 200);
  assert.strictEqual(restored.data.connection.permissions.orders, true);
});

test('PUT permissions refuses allowed: null for the global default (no higher fallback to defer to)', async () => {
  const { ownerToken, memberId } = await createOwnerWithMemberAndConnection();

  const res = await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId: null, feature: 'orders', allowed: null }] },
    ownerToken
  );
  assert.strictEqual(res.status, 400);
});

test('PUT permissions refuses a connectionId that does not belong to the owner', async () => {
  const { ownerToken, memberId } = await createOwnerWithMemberAndConnection();
  const otherOwnerEmail = `other-${crypto.randomUUID()}@example.com`;
  const { userId: otherOwnerId } = await signupAndLogin(otherOwnerEmail, 'testpassword123');
  const otherConnection = await connectionService.createConnection(otherOwnerId, {
    platformKey: 'ebay',
    label: 'Someone else\'s store',
    credentials: { accessToken: 'y' },
  });

  const res = await request(
    'PUT',
    `/api/team/members/${memberId}/permissions`,
    { permissions: [{ connectionId: otherConnection.id, feature: 'orders', allowed: true }] },
    ownerToken
  );
  assert.strictEqual(res.status, 404);
});

// A member is never deleted — their activity is what salaries are worked
// out from. Removing takes the login away; restoring gives it back.
test('DELETE /api/team/members/:id removes the login but keeps the member, who can be restored', async () => {
  const { ownerToken, memberId, memberToken, memberEmail } = await createOwnerWithMemberAndConnection();

  const del = await request('DELETE', `/api/team/members/${memberId}`, undefined, ownerToken);
  assert.strictEqual(del.status, 204);

  const { status } = await request('GET', '/api/connections', undefined, memberToken);
  assert.strictEqual(status, 401, 'signed out at the next request');
  const login = await request('POST', '/api/auth/login', { email: memberEmail, password: 'memberpassword123' });
  assert.strictEqual(login.status, 403);
  assert.match(login.data.error, /removed by the account owner/);

  const { data } = await request('GET', '/api/team/members', undefined, ownerToken);
  assert.ok(data.members.find((m) => m.id === memberId).deactivated_at, 'still listed, as removed');
  const again = await request('POST', '/api/team/members', { email: memberEmail, password: 'anotherpassword1' }, ownerToken);
  assert.strictEqual(again.status, 409);
  assert.match(again.data.error, /Restore them/);

  assert.strictEqual((await request('POST', `/api/team/members/${memberId}/restore`, undefined, ownerToken)).status, 204);
  const back = await request('POST', '/api/auth/login', { email: memberEmail, password: 'memberpassword123' });
  assert.strictEqual(back.status, 200);
});

test("a member's work is on their page: figures for the range, per account, and the activity log", async () => {
  const { ownerToken, memberId, memberToken, connectionId } = await createOwnerWithMemberAndConnection();
  await request('PUT', `/api/team/members/${memberId}/permissions`, { permissions: [{ connectionId: null, feature: 'orders', allowed: true }] }, ownerToken);
  // Two supplier orders (one re-saved: still one), a dispatch and a note, all by the member.
  const orderRepository = require('../../src/modules/orders/order.repository');
  await orderRepository.addEvent({ connectionId, orderId: '11-111', lineItemId: 'L1', kind: 'sourcing.ordered', detail: { sourceOrderNo: 'A1' }, actorUserId: memberId });
  await orderRepository.addEvent({ connectionId, orderId: '11-111', lineItemId: 'L1', kind: 'sourcing.ordered', detail: { sourceOrderNo: 'A2' }, actorUserId: memberId });
  await orderRepository.addEvent({ connectionId, orderId: '22-222', lineItemId: 'L9', kind: 'sourcing.ordered', detail: {}, actorUserId: memberId });
  await orderRepository.addEvent({ connectionId, orderId: '11-111', kind: 'ebay.dispatched_by_liston', detail: {}, actorUserId: memberId });
  await orderRepository.addEvent({ connectionId, orderId: '11-111', kind: 'ebay.paid', detail: {}, actorUserId: null });
  const note = await request('POST', `/api/connections/${connectionId}/orders/33-333/notes`, { text: 'Supplier out of stock' }, memberToken);
  assert.strictEqual(note.status, 201);

  const { status, data } = await request('GET', `/api/team/members/${memberId}/overview?range=today`, undefined, ownerToken);
  assert.strictEqual(status, 200);
  assert.deepStrictEqual([data.totals.supplier_orders, data.totals.dispatched, data.actions], [2, 1, 5], 'a re-saved supplier order counts once; eBay\'s own events are no one\'s work');
  assert.strictEqual(data.series.length, 1);
  assert.deepStrictEqual(data.accounts.map((a) => [a.label, a.supplier_orders]), [['Team Test Store', 2]]);
  assert.strictEqual(data.member.id, memberId);

  const feed = await request('GET', `/api/team/members/${memberId}/activity?range=7d&limit=2`, undefined, ownerToken);
  assert.deepStrictEqual(feed.data.items.map((i) => i.kind), ['order.note', 'order.dispatched']);
  assert.ok(feed.data.next, 'more to load');
  const rest = await request('GET', `/api/team/members/${memberId}/activity?range=7d&before=${feed.data.next}`, undefined, ownerToken);
  assert.deepStrictEqual(rest.data.items.map((i) => i.kind).sort(), ['order.supplier_ordered', 'order.supplier_ordered', 'order.supplier_ordered', 'session.login'], 'the rest, and the login that started the sitting');
  const only = await request('GET', `/api/team/members/${memberId}/activity?range=7d&kind=supplier_orders`, undefined, ownerToken);
  assert.deepStrictEqual([only.data.items.length, only.data.items[0].label], [3, 'Placed the supplier order'], 'the log lists every save');

  // History filled in later (a higher id, an earlier time) sorts by when it happened.
  const activityRepository = require('../../src/modules/team/activity.repository');
  const old = await activityRepository.record({ actorUserId: memberId, connectionId, kind: 'order.refunded', subjectType: 'order', subjectId: '44-444' });
  await pool.query(`UPDATE member_activity SET created_at = now() - interval '2 days' WHERE id = $1`, [old.id]);
  const ordered = await request('GET', `/api/team/members/${memberId}/activity?range=7d`, undefined, ownerToken);
  assert.strictEqual(ordered.data.items[ordered.data.items.length - 1].subjectId, '44-444', 'oldest last, whatever its id');
  const overview = await request('GET', `/api/team/members/${memberId}/overview?range=7d`, undefined, ownerToken);
  assert.ok(Date.now() - new Date(overview.data.member.lastActiveAt).getTime() < 60000, 'last active: the latest action, not the latest row');

  const list = await request('GET', '/api/team/members', undefined, ownerToken);
  const card = list.data.members.find((m) => m.id === memberId);
  assert.deepStrictEqual([card.today.supplier_orders, Boolean(card.lastActiveAt)], [2, true]);

  // Another owner can't read this member.
  const other = await signupAndLogin(`owner-${crypto.randomUUID()}@example.com`, 'testpassword123');
  assert.strictEqual((await request('GET', `/api/team/members/${memberId}/overview`, undefined, other.token)).status, 404);
  assert.strictEqual((await request('GET', `/api/team/members/${memberId}/overview`, undefined, memberToken)).status, 403, 'members never see the team');
});

test('PUT /api/team/members/:id/password resets a member login (owner only)', async () => {
  const { ownerToken, memberId, memberToken, memberEmail } = await createOwnerWithMemberAndConnection();

  const asMember = await request('PUT', `/api/team/members/${memberId}/password`, { password: 'newpassword123' }, memberToken);
  assert.strictEqual(asMember.status, 403);

  const short = await request('PUT', `/api/team/members/${memberId}/password`, { password: 'short' }, ownerToken);
  assert.strictEqual(short.status, 400);

  const ok = await request('PUT', `/api/team/members/${memberId}/password`, { password: 'newpassword123' }, ownerToken);
  assert.strictEqual(ok.status, 204);

  const oldLogin = await request('POST', '/api/auth/login', { email: memberEmail, password: 'memberpassword123' });
  assert.strictEqual(oldLogin.status, 401);
  const newLogin = await request('POST', '/api/auth/login', { email: memberEmail, password: 'newpassword123' });
  assert.strictEqual(newLogin.status, 200);
});

test('team activity can be rebuilt from an account\'s order timeline (a copy from before it was recorded)', async () => {
  const { memberId, connectionId, ownerToken } = await createOwnerWithMemberAndConnection();
  const { rebuildOrderActivity } = require('../../src/modules/team/activity-backfill');
  const insert = (orderId, kind, line = null) =>
    pool.query(`INSERT INTO order_events (connection_id, order_id, line_item_id, kind, detail, actor_user_id) VALUES ($1, $2, $3, $4, '{}', $5)`, [connectionId, orderId, line, kind, memberId]);
  await insert('55-1', 'sourcing.ordered', 'L1');
  await insert('55-1', 'ebay.dispatched_by_liston');
  await insert('55-2', 'ebay.return_refund_by_liston');
  await pool.query(`INSERT INTO order_events (connection_id, order_id, kind, detail) VALUES ($1, '55-3', 'ebay.paid', '{}')`, [connectionId]);

  assert.strictEqual(await rebuildOrderActivity(pool, [connectionId]), 3, "eBay's own events aren't anyone's work");
  assert.strictEqual(await rebuildOrderActivity(pool, [connectionId]), 3, 'run again: replaced, not doubled');
  const { data } = await request('GET', `/api/team/members/${memberId}/overview?range=today`, undefined, ownerToken);
  assert.deepStrictEqual([data.totals.supplier_orders, data.totals.dispatched, data.totals.cases], [1, 1, 1]);
});

test('everything a member does lands on their record: logins, draft work (once a sitting), supplier-order updates', async () => {
  const { ownerToken, memberId, memberEmail, connectionId } = await createOwnerWithMemberAndConnection();
  await request('PUT', `/api/team/members/${memberId}/permissions`, { permissions: [{ connectionId: null, feature: 'listings', allowed: true }, { connectionId: null, feature: 'orders', allowed: true }] }, ownerToken);

  // A login, recorded as the start of a sitting (not as work).
  const login = await request('POST', '/api/auth/login', { email: memberEmail, password: 'memberpassword123' });
  const memberToken = login.data.token;

  // Three saves on one draft in a sitting: one "worked on a draft".
  const { rows } = await pool.query(
    `INSERT INTO listings (connection_id, status, generated_data) VALUES ($1, 'pending_review', $2) RETURNING id`,
    [connectionId, { title: 'Garden lamp', description: 'Bright.', price: { value: '9.99', currency: 'GBP' }, quantity: 3, imageUrls: [] }]
  );
  for (const title of ['Garden lamp solar', 'Garden lamp solar LED', 'Garden lamp solar LED UK']) {
    const saved = await request('PATCH', `/api/listings/${rows[0].id}`, { title }, memberToken);
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.data));
  }

  // A supplier order marked delivered: an update, not a second order.
  const orderService = require('../../src/modules/orders/order.service');
  await orderService.saveSourcing(connectionId, null, memberId, '66-1', 'L1', { sourceOrderNo: 'AE-1' });
  await orderService.saveSourcing(connectionId, null, memberId, '66-1', 'L1', { status: 'delivered' });

  await new Promise((r) => setTimeout(r, 100)); // draft work is recorded as each response finishes
  const { data } = await request('GET', `/api/team/members/${memberId}/overview?range=today`, undefined, ownerToken);
  assert.deepStrictEqual([data.totals.draft_work, data.totals.supplier_orders, data.totals.active_days], [1, 1, 1]);
  const feed = await request('GET', `/api/team/members/${memberId}/activity?range=today`, undefined, ownerToken);
  const kinds = feed.data.items.map((i) => i.kind).sort();
  assert.deepStrictEqual(kinds, ['listing.draft_edited', 'order.supplier_ordered', 'order.supplier_updated', 'session.login', 'session.login'], 'the setup\'s login and this one');
  assert.deepStrictEqual(feed.data.items.find((i) => i.kind === 'order.supplier_updated').detail.status, { from: 'ordered', to: 'delivered' });
  assert.strictEqual(data.actions, 3, 'a login is recorded, but it is not work');
});
