const { query, pool } = require('../../db/client');

// The eBay Inbox's tables (migration 043): each account's conversations and
// messages as read from eBay, and how far each account is read.

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
    `SELECT c.*, u.name AS assignee_name, u.email AS assignee_email FROM ebay_conversations c LEFT JOIN users u ON u.id = c.assigned_to
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
  otherConversations,
  syncState,
  syncStates,
  recordSync,
  forgetMember,
  addSent,
  FOLDERS,
};
