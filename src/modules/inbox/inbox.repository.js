const { query, pool } = require('../../db/client');

// The eBay Inbox's tables (migration 043): each account's conversations and
// messages as read from eBay, and how far each account is read; and the
// team's own (046): who has a conversation, where it stands, its notes.

/** Keeps conversations as eBay gave them (Liston's own columns left as they are): the ids that were new or changed. */
async function upsertConversations(connectionId, rows) {
  const changed = [];
  for (const c of rows) {
    const { rows: out } = await query(
      `INSERT INTO ebay_conversations (connection_id, conversation_id, type, status, title, reference_type, reference_id, other_party, unread_count,
         latest_message_id, latest_preview, latest_subject, latest_at, latest_from_seller, started_at, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
       ON CONFLICT (connection_id, conversation_id) DO UPDATE SET
         type = EXCLUDED.type, status = EXCLUDED.status, title = EXCLUDED.title, reference_type = EXCLUDED.reference_type,
         reference_id = EXCLUDED.reference_id, other_party = coalesce(EXCLUDED.other_party, ebay_conversations.other_party),
         -- Read here up to its latest message (or the seller has the last word since): eBay's "unread" doesn't bring it back (inbox-rules.unreadAfterRead).
         unread_count = CASE WHEN ebay_conversations.read_at IS NOT NULL AND (EXCLUDED.latest_from_seller OR EXCLUDED.latest_at IS NULL OR EXCLUDED.latest_at <= ebay_conversations.read_at)
           THEN 0 ELSE EXCLUDED.unread_count END,
         latest_message_id = EXCLUDED.latest_message_id, latest_preview = EXCLUDED.latest_preview,
         latest_subject = EXCLUDED.latest_subject, latest_at = EXCLUDED.latest_at, latest_from_seller = EXCLUDED.latest_from_seller,
         started_at = coalesce(ebay_conversations.started_at, EXCLUDED.started_at), synced_at = now()
       RETURNING (xmax = 0) AS inserted,
         (SELECT latest_message_id FROM ebay_conversations p WHERE p.connection_id = $1 AND p.conversation_id = $2) AS before`,
      [connectionId, c.conversationId, c.type, c.status, c.title, c.referenceType, c.referenceId, c.otherParty, c.unreadCount, c.latestMessageId, c.latestPreview, c.latestSubject, c.latestAt, c.latestFromSeller, c.startedAt]
    );
    if (out[0]?.inserted) changed.push(c.conversationId);
    else if (out[0] && out[0].before !== c.latestMessageId) changed.push(c.conversationId);
  }
  return changed;
}

/** The stored latest message id of each of these conversations: Map(id -> latest_message_id). */
async function latestIds(connectionId, conversationIds) {
  if (!conversationIds.length) return new Map();
  const { rows } = await query(`SELECT conversation_id, latest_message_id, status, unread_count, read_at FROM ebay_conversations WHERE connection_id = $1 AND conversation_id = ANY($2)`, [connectionId, conversationIds]);
  return new Map(rows.map((r) => [r.conversation_id, r]));
}

async function upsertMessages(connectionId, conversationId, messages) {
  if (!messages.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of messages) {
      await client.query(
        `INSERT INTO ebay_messages (connection_id, conversation_id, message_id, sender, recipient, from_seller, subject, body, media, read, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (connection_id, message_id) DO UPDATE SET read = EXCLUDED.read, body = EXCLUDED.body, media = EXCLUDED.media`,
        [connectionId, conversationId, m.messageId, m.sender, m.recipient, m.fromSeller, m.subject, m.body || '', JSON.stringify(m.media || []), m.read, m.createdAt]
      );
    }
    await client.query(`UPDATE ebay_conversations SET messages_synced_at = now() WHERE connection_id = $1 AND conversation_id = $2`, [connectionId, conversationId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const FOLDERS = {
  buyers: `c.type = 'FROM_MEMBERS' AND c.status = 'ACTIVE'`,
  ebay: `c.type = 'FROM_EBAY' AND c.status = 'ACTIVE'`,
  archived: `c.status = 'ARCHIVE'`,
  all: `c.status = 'ACTIVE'`,
};

/**
 * A page of conversations on these accounts, newest first. `folder`:
 * buyers, ebay, archived, all; `show`: all, unread, waiting (the buyer
 * spoke last), mine (assigned to `userId`); `q`: a buyer, an item number,
 * or words in the conversation.
 */
async function listConversations(connectionIds, { folder = 'buyers', show = 'all', q = '', userId = null, before = null, limit = 50 } = {}) {
  if (!connectionIds.length) return [];
  const params = [connectionIds, limit];
  const where = [FOLDERS[folder] || FOLDERS.buyers];
  if (show === 'unread') where.push('c.unread_count > 0');
  if (show === 'waiting') where.push(`c.type = 'FROM_MEMBERS' AND NOT c.latest_from_seller AND c.work_status <> 'done'`);
  if (show === 'mine' && userId) {
    params.push(userId);
    where.push(`c.assigned_to = $${params.length}`);
  }
  const words = String(q || '').trim();
  if (words) {
    params.push(`%${words.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`, words);
    const like = `$${params.length - 1}`;
    const exact = `$${params.length}`;
    where.push(`(c.other_party ILIKE ${like} OR c.reference_id = ${exact} OR c.title ILIKE ${like} OR c.latest_preview ILIKE ${like}
      OR EXISTS (SELECT 1 FROM ebay_messages m WHERE m.connection_id = c.connection_id AND m.conversation_id = c.conversation_id AND m.search @@ plainto_tsquery('simple', ${exact})))`);
  }
  if (before) {
    params.push(before);
    where.push(`c.latest_at < $${params.length}`);
  }
  const { rows } = await query(
    `SELECT c.*, u.name AS assignee_name, u.email AS assignee_email
       FROM ebay_conversations c LEFT JOIN users u ON u.id = c.assigned_to
      WHERE c.connection_id = ANY($1::uuid[]) AND ${where.join(' AND ')}
      ORDER BY c.latest_at DESC NULLS LAST, c.conversation_id LIMIT $2`,
    params
  );
  return rows;
}

/** Unread conversations per folder on these accounts, and how many are archived: { buyers, ebay, waiting, archived }. */
async function counts(connectionIds) {
  if (!connectionIds.length) return { buyers: 0, ebay: 0, waiting: 0, archived: 0 };
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE type = 'FROM_MEMBERS' AND status = 'ACTIVE' AND unread_count > 0)::int AS buyers,
       count(*) FILTER (WHERE type = 'FROM_EBAY' AND status = 'ACTIVE' AND unread_count > 0)::int AS ebay,
       count(*) FILTER (WHERE type = 'FROM_MEMBERS' AND status = 'ACTIVE' AND NOT latest_from_seller AND work_status <> 'done')::int AS waiting,
       count(*) FILTER (WHERE status = 'ARCHIVE')::int AS archived
     FROM ebay_conversations WHERE connection_id = ANY($1::uuid[])`,
    [connectionIds]
  );
  return rows[0];
}

async function findConversation(connectionId, conversationId) {
  const { rows } = await query(
    `SELECT c.*, u.name AS assignee_name, u.email AS assignee_email, w.name AS work_status_by_name, w.email AS work_status_by_email
       FROM ebay_conversations c LEFT JOIN users u ON u.id = c.assigned_to LEFT JOIN users w ON w.id = c.work_status_by
      WHERE c.connection_id = $1 AND c.conversation_id = $2`,
    [connectionId, conversationId]
  );
  return rows[0] || null;
}

async function messagesOf(connectionId, conversationId) {
  const { rows } = await query(`SELECT * FROM ebay_messages WHERE connection_id = $1 AND conversation_id = $2 ORDER BY created_at, message_id`, [connectionId, conversationId]);
  return rows;
}

async function hasMessage(connectionId, messageId) {
  if (!messageId) return false;
  const { rows } = await query(`SELECT 1 FROM ebay_messages WHERE connection_id = $1 AND message_id = $2`, [connectionId, messageId]);
  return rows.length > 0;
}

/**
 * Read in Liston: nothing unread, and read up to its latest message (that
 * message's time, from what's kept, never the clock: a buyer's message
 * eBay hasn't handed over yet stays unread when it comes).
 */
async function markReadHere(connectionId, conversationId) {
  await query(
    `UPDATE ebay_conversations SET unread_count = 0,
       read_at = GREATEST(read_at, latest_at, (SELECT max(created_at) FROM ebay_messages m WHERE m.connection_id = $1 AND m.conversation_id = $2))
      WHERE connection_id = $1 AND conversation_id = $2`,
    [connectionId, conversationId]
  );
}

/** Marked unread by someone: at least one unread, and not read here (eBay's count rules again). */
async function markUnreadHere(connectionId, conversationId) {
  await query(`UPDATE ebay_conversations SET unread_count = GREATEST(unread_count, 1), read_at = NULL WHERE connection_id = $1 AND conversation_id = $2`, [connectionId, conversationId]);
}

async function updateConversation(connectionId, conversationId, fields) {
  const sets = [];
  const params = [connectionId, conversationId];
  for (const [column, value] of Object.entries(fields)) {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) return;
  await query(`UPDATE ebay_conversations SET ${sets.join(', ')} WHERE connection_id = $1 AND conversation_id = $2`, params);
}

/** These buyers' orders on this account: order id, buyer (lower case), eBay's cancel status and the items, newest first. */
async function orderFactsByBuyers(connectionId, buyers) {
  const names = [...new Set(buyers.filter(Boolean).map((b) => String(b).toLowerCase()))];
  if (!names.length) return [];
  const { rows } = await query(
    `SELECT order_id, lower(data->>'buyerUserId') AS buyer, data->>'cancelStatus' AS cancel_status,
            ARRAY(SELECT li->>'itemId' FROM jsonb_array_elements(coalesce(data->'lineItems', '[]'::jsonb)) li) AS item_ids
       FROM ebay_orders WHERE connection_id = $1 AND lower(data->>'buyerUserId') = ANY($2) ORDER BY created_at DESC`,
    [connectionId, names]
  );
  return rows;
}

/** The buyer's orders on this account, newest first (the thread's side panel). */
async function ordersByBuyer(connectionId, buyer, limit = 10) {
  if (!buyer) return [];
  const { rows } = await query(
    `SELECT data FROM ebay_orders WHERE connection_id = $1 AND lower(data->>'buyerUserId') = lower($2) ORDER BY created_at DESC LIMIT $3`,
    [connectionId, buyer, limit]
  );
  return rows.map((r) => r.data);
}

// ---- what the details panel adds about the listing (Liston's own copies, no eBay call) ----

/** The listing as the account's kept listings have it: { item, live }, the live copy first; null in neither. */
async function listingSnapshotItem(connectionId, itemId) {
  const { rows } = await query(
    `SELECT s.kind, item FROM ebay_snapshots s
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.data->'items', '[]'::jsonb)) item
      WHERE s.connection_id = $1 AND s.kind IN ('listings:active', 'listings:inactive') AND item->>'itemId' = $2
      ORDER BY s.kind = 'listings:active' DESC LIMIT 1`,
    [connectionId, String(itemId)]
  );
  return rows[0] ? { item: rows[0].item, live: rows[0].kind === 'listings:active' } : null;
}

/** The listing's views and impressions over the stored days since `since` (a date), and how many days are stored. */
async function listingTrafficSince(connectionId, itemId, since) {
  const { rows } = await query(
    `SELECT COALESCE(sum(views), 0)::int AS views, COALESCE(sum(total_impressions), 0)::int AS impressions, count(*)::int AS days
       FROM ebay_traffic_days WHERE connection_id = $1 AND listing_id = $2 AND day >= $3`,
    [connectionId, String(itemId), since]
  );
  return rows[0];
}

/** The account's orders since a time with a line for the item (Liston's copy). */
async function ordersForItemSince(connectionId, itemId, since) {
  const { rows } = await query(
    `SELECT o.data FROM ebay_orders o
      WHERE o.connection_id = $1 AND o.created_at >= $3
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(o.data->'lineItems', '[]'::jsonb)) li WHERE li->>'itemId' = $2)`,
    [connectionId, String(itemId), since]
  );
  return rows.map((r) => r.data);
}

/** Where the listing's product is bought: the supplier link of the draft it was published from, else of the hunted product it went live as. */
async function supplierUrlFor(connectionId, itemId) {
  const { rows } = await query(
    `SELECT url FROM (
       SELECT source_data->'source'->>'sourceUrl' AS url, 1 AS rank, updated_at FROM listings
        WHERE connection_id = $1 AND external_product_id = $2 AND source_data->'source'->>'sourceUrl' IS NOT NULL
       UNION ALL
       SELECT source_url, 2, updated_at FROM hunted_products
        WHERE connection_id = $1 AND $2 = ANY(item_ids) AND source_url IS NOT NULL
     ) found ORDER BY rank, updated_at DESC LIMIT 1`,
    [connectionId, String(itemId)]
  );
  return rows[0]?.url || null;
}

/** The buyer's other conversations on this account. */
async function otherConversations(connectionId, buyer, exceptId, limit = 6) {
  if (!buyer) return [];
  const { rows } = await query(
    `SELECT conversation_id, title, reference_id, latest_preview, latest_at FROM ebay_conversations
      WHERE connection_id = $1 AND lower(other_party) = lower($2) AND conversation_id <> $3 ORDER BY latest_at DESC NULLS LAST LIMIT $4`,
    [connectionId, buyer, exceptId, limit]
  );
  return rows;
}

async function syncState(connectionId) {
  const { rows } = await query(`SELECT * FROM ebay_inbox_sync WHERE connection_id = $1`, [connectionId]);
  return rows[0] || null;
}

async function syncStates(connectionIds) {
  if (!connectionIds.length) return [];
  const { rows } = await query(`SELECT * FROM ebay_inbox_sync WHERE connection_id = ANY($1::uuid[])`, [connectionIds]);
  return rows;
}

async function recordSync(connectionId, { full = false, error = null } = {}) {
  await query(
    `INSERT INTO ebay_inbox_sync (connection_id, last_sync_at, last_full_sync_at, last_error, last_error_at)
     VALUES ($1, CASE WHEN $3::text IS NULL THEN now() END, CASE WHEN $2 AND $3::text IS NULL THEN now() END, $3, CASE WHEN $3::text IS NOT NULL THEN now() END)
     ON CONFLICT (connection_id) DO UPDATE SET
       last_sync_at = CASE WHEN $3::text IS NULL THEN now() ELSE ebay_inbox_sync.last_sync_at END,
       last_full_sync_at = CASE WHEN $2 AND $3::text IS NULL THEN now() ELSE ebay_inbox_sync.last_full_sync_at END,
       last_error = $3, last_error_at = CASE WHEN $3::text IS NOT NULL THEN now() ELSE ebay_inbox_sync.last_error_at END`,
    [connectionId, full, error]
  );
}

/** What the seller just sent, kept at once (eBay's copy replaces it on the next read): the conversation's last word is theirs. */
async function addSent(connectionId, conversationId, m) {
  await upsertMessages(connectionId, conversationId, [{ ...m, fromSeller: true, read: true }]);
  await query(
    `UPDATE ebay_conversations SET latest_message_id = $3, latest_preview = $4, latest_at = $5, latest_from_seller = true, unread_count = 0,
       read_at = GREATEST(read_at, $5::timestamptz)
      WHERE connection_id = $1 AND conversation_id = $2`,
    [connectionId, conversationId, m.messageId, m.preview, m.createdAt]
  );
}

/**
 * A message eBay pushed (NEW_MESSAGE), kept so opening the conversation
 * reads nothing more: only into a conversation whose messages were read
 * before (one never opened is read whole the first time). Its time of
 * reading is left alone. Whether it was kept.
 */
async function keepPushed(connectionId, conversationId, m) {
  if (!m.messageId || !m.createdAt) return false;
  const { rowCount } = await query(
    `INSERT INTO ebay_messages (connection_id, conversation_id, message_id, sender, recipient, from_seller, subject, body, media, read, created_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      WHERE EXISTS (SELECT 1 FROM ebay_conversations c WHERE c.connection_id = $1 AND c.conversation_id = $2 AND c.messages_synced_at IS NOT NULL)
     ON CONFLICT (connection_id, message_id) DO NOTHING`,
    [connectionId, conversationId, m.messageId, m.sender, m.recipient, Boolean(m.fromSeller), m.subject, m.body || '', JSON.stringify(m.media || []), m.read, m.createdAt]
  );
  return rowCount > 0;
}

/** Gives a conversation to someone (null: no one). */
async function assign(connectionId, conversationId, userId) {
  await query(`UPDATE ebay_conversations SET assigned_to = $3, assigned_at = CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END WHERE connection_id = $1 AND conversation_id = $2`, [
    connectionId,
    conversationId,
    userId || null,
  ]);
}

/** Where a conversation stands for the team (open, waiting, done), and who said so. */
async function setWorkStatus(connectionId, conversationId, status, userId) {
  await query(`UPDATE ebay_conversations SET work_status = $3, work_status_at = now(), work_status_by = $4 WHERE connection_id = $1 AND conversation_id = $2`, [connectionId, conversationId, status, userId || null]);
}

/** The buyer wrote again: waiting or done conversations are open again (by no one). The ids reopened. */
async function reopen(connectionId, conversationIds) {
  if (!conversationIds.length) return [];
  const { rows } = await query(
    `UPDATE ebay_conversations SET work_status = 'open', work_status_at = now(), work_status_by = NULL
      WHERE connection_id = $1 AND conversation_id = ANY($2) AND work_status <> 'open' RETURNING conversation_id`,
    [connectionId, conversationIds]
  );
  return rows.map((r) => r.conversation_id);
}

/** A conversation's notes (deleted ones left out), oldest first, with who wrote each. */
async function notesOf(connectionId, conversationId) {
  const { rows } = await query(
    `SELECT n.id, n.body, n.author_user_id, n.created_at, u.name AS author_name, u.email AS author_email
       FROM ebay_conversation_notes n LEFT JOIN users u ON u.id = n.author_user_id
      WHERE n.connection_id = $1 AND n.conversation_id = $2 AND n.deleted_at IS NULL ORDER BY n.created_at, n.id`,
    [connectionId, conversationId]
  );
  return rows;
}

async function addNote(connectionId, conversationId, authorId, body) {
  const { rows } = await query(
    `INSERT INTO ebay_conversation_notes (connection_id, conversation_id, author_user_id, body) VALUES ($1, $2, $3, $4) RETURNING id`,
    [connectionId, conversationId, authorId, body]
  );
  return (await notesOf(connectionId, conversationId)).find((n) => String(n.id) === String(rows[0].id)) || null;
}

async function findNote(connectionId, conversationId, noteId) {
  const { rows } = await query(`SELECT * FROM ebay_conversation_notes WHERE id = $3 AND connection_id = $1 AND conversation_id = $2 AND deleted_at IS NULL`, [connectionId, conversationId, noteId]);
  return rows[0] || null;
}

async function deleteNote(noteId) {
  await query(`UPDATE ebay_conversation_notes SET deleted_at = now() WHERE id = $1`, [noteId]);
}

/** The buyers (lower case) of these orders on this account. */
async function buyersOfOrders(connectionId, orderIds) {
  const ids = [...new Set(orderIds.filter(Boolean).map(String))];
  if (!ids.length) return [];
  const { rows } = await query(`SELECT DISTINCT lower(data->>'buyerUserId') AS buyer FROM ebay_orders WHERE connection_id = $1 AND order_id = ANY($2) AND data->>'buyerUserId' IS NOT NULL`, [connectionId, ids]);
  return rows.map((r) => r.buyer);
}

/** The buyers (lower case) with an order on this account whose cancellation they asked for (`statuses`: eBay's cancel states for that). */
async function cancelRequestBuyers(connectionId, statuses) {
  const { rows } = await query(`SELECT DISTINCT lower(data->>'buyerUserId') AS buyer FROM ebay_orders WHERE connection_id = $1 AND data->>'cancelStatus' = ANY($2) AND data->>'buyerUserId' IS NOT NULL`, [connectionId, statuses]);
  return rows.map((r) => r.buyer);
}

/** These buyers' conversations about an item on this account, in the inbox or the archive, with who has each. */
async function buyerConversations(connectionId, buyers) {
  const names = [...new Set(buyers.filter(Boolean).map((b) => String(b).toLowerCase()))];
  if (!names.length) return [];
  const { rows } = await query(
    `SELECT c.*, u.name AS assignee_name, u.email AS assignee_email
       FROM ebay_conversations c LEFT JOIN users u ON u.id = c.assigned_to
      WHERE c.connection_id = $1 AND c.type = 'FROM_MEMBERS' AND c.status IN ('ACTIVE', 'ARCHIVE') AND c.reference_id IS NOT NULL AND lower(c.other_party) = ANY($2)`,
    [connectionId, names]
  );
  return rows;
}

/** People by id: { id, name, email } (for names beside their work). */
async function peopleByIds(ids) {
  if (!ids.length) return [];
  const { rows } = await query(`SELECT id, name, email FROM users WHERE id = ANY($1::uuid[])`, [ids]);
  return rows;
}

/** One order from the account's orders mirror (its data), or null. */
async function orderById(connectionId, orderId) {
  const { rows } = await query(`SELECT data FROM ebay_orders WHERE connection_id = $1 AND order_id = $2`, [connectionId, orderId]);
  return rows[0]?.data || null;
}

/** The newest conversation with this buyer about this item, or null. */
async function latestWith(connectionId, buyer, itemId) {
  const { rows } = await query(
    `SELECT conversation_id FROM ebay_conversations WHERE connection_id = $1 AND type = 'FROM_MEMBERS' AND lower(other_party) = lower($2) AND reference_id = $3 ORDER BY latest_at DESC NULLS LAST LIMIT 1`,
    [connectionId, buyer, itemId]
  );
  return rows[0] || null;
}

/** A buyer's conversations and messages on every account, when eBay says they closed their eBay account. */
async function forgetMember(username) {
  if (!username) return 0;
  const { rowCount } = await query(`DELETE FROM ebay_conversations WHERE lower(other_party) = lower($1)`, [username]);
  return rowCount;
}

module.exports = {
  orderFactsByBuyers,
  markReadHere,
  markUnreadHere,
  upsertConversations,
  latestIds,
  upsertMessages,
  listConversations,
  counts,
  findConversation,
  messagesOf,
  hasMessage,
  updateConversation,
  ordersByBuyer,
  listingSnapshotItem,
  listingTrafficSince,
  ordersForItemSince,
  supplierUrlFor,
  otherConversations,
  syncState,
  syncStates,
  recordSync,
  forgetMember,
  addSent,
  keepPushed,
  assign,
  setWorkStatus,
  reopen,
  notesOf,
  addNote,
  findNote,
  deleteNote,
  peopleByIds,
  buyersOfOrders,
  cancelRequestBuyers,
  buyerConversations,
  orderById,
  latestWith,
  FOLDERS,
};
