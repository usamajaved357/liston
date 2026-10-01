const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();
const ebayMessage = require('../../src/modules/ebay/api/ebay.message');

// eBay's Message API names folders ARCHIVED / DELETED when listing them and
// ARCHIVE / DELETE when moving one; Liston asks each the documented way,
// tries the other spelling if eBay refuses it, and keeps one name.

function fakeEbay(handler) {
  const seen = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    const out = handler(String(url), init.body ? JSON.parse(init.body) : null);
    const status = out.status || 200;
    return new Response(status === 204 ? null : JSON.stringify(out.body || {}), { status, headers: { 'Content-Type': 'application/json' } });
  });
  return seen;
}

test('the archive is listed as ARCHIVED (ARCHIVE if eBay refuses that), and comes back as ARCHIVE', async () => {
  try {
    const seen = fakeEbay((url) =>
      url.includes('conversation_status=ARCHIVED')
        ? { body: { total: 1, conversations: [{ conversationId: '9', conversationStatus: 'ARCHIVED', conversationType: 'FROM_MEMBERS', unreadCount: 0 }] } }
        : { status: 400, body: { errors: [{ message: 'Invalid conversationStatus value. Please see documentation for valid values.' }] } }
    );
    const out = await ebayMessage.getConversations('t', { type: 'FROM_MEMBERS', status: 'ARCHIVE' }, 'EBAY_GB');
    assert.deepStrictEqual([out.total, out.conversations[0].status], [1, 'ARCHIVE']);
    assert.strictEqual(seen.length, 1);
    mock.restoreAll();

    const retried = fakeEbay((url) =>
      url.includes('conversation_status=ARCHIVE&') ? { body: { total: 0, conversations: [] } } : { status: 400, body: { errors: [{ message: 'Invalid conversationStatus value.' }] } }
    );
    await ebayMessage.getConversations('t', { type: 'FROM_MEMBERS', status: 'ARCHIVE' }, 'EBAY_GB');
    assert.deepStrictEqual(retried.map((r) => new URL(r.url).searchParams.get('conversation_status')), ['ARCHIVED', 'ARCHIVE']);
    mock.restoreAll();

    // Another error isn't retried.
    fakeEbay(() => ({ status: 500, body: { errors: [{ message: 'System error' }] } }));
    await assert.rejects(ebayMessage.getConversations('t', { type: 'FROM_EBAY', status: 'ACTIVE' }, 'EBAY_GB'), /System error/);
  } finally {
    mock.restoreAll();
  }
});

test('moving a conversation to the archive sends ARCHIVE; marking it read sends read', async () => {
  try {
    const seen = fakeEbay(() => ({ status: 204 }));
    await ebayMessage.updateConversation('t', { conversationId: '9', type: 'FROM_MEMBERS', status: 'ARCHIVE' }, 'EBAY_GB');
    await ebayMessage.updateConversation('t', { conversationId: '9', type: 'FROM_EBAY', read: true }, 'EBAY_GB');
    assert.deepStrictEqual(seen.map((s) => s.body), [
      { conversationId: '9', conversationType: 'FROM_MEMBERS', conversationStatus: 'ARCHIVE' },
      { conversationId: '9', conversationType: 'FROM_EBAY', read: true },
    ]);
  } finally {
    mock.restoreAll();
  }
});
