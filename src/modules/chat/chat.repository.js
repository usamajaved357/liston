const { query, pool } = require('../../db/client');

// Team chat's tables (migration 042): conversations, who's in each, their
// messages, and each person's notification settings; and (migration 047)
// threads: a reply names its thread's first message (thread_id) and stays
// out of the conversation's timeline, unread counts and last line unless
// it was also sent to the conversation; who follows each thread, and how
// far they've read it, in chat_thread_members.

// A message the conversation itself shows: not a thread reply, or one also sent to it.
const IN_TIMELINE = `(x.thread_id IS NULL OR x.also_in_conversation)`;

/**
 * The owner and their team as chat sees them (removed members included,
 * marked). `role` is what each is in this team: its owner, or a member
 * (owner access and removal are this team's, migration 051).
 */
async function people(ownerId) {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.avatar_url, CASE WHEN u.id = $1 THEN 'owner' ELSE 'member' END AS role, m.deactivated_at, m.owner_access_at
       FROM users u LEFT JOIN workspace_members m ON m.user_id = u.id AND m.owner_user_id = $1
      WHERE u.id = $1 OR m.user_id IS NOT NULL
      ORDER BY (u.id = $1) DESC, lower(coalesce(u.name, u.email))`,
    [ownerId]
  );
  return rows;
}

const CONVERSATION_SUMMARY = `
  c.*, m.last_read_at, m.notify, m.role AS my_role,
  (SELECT count(*) FROM chat_messages x
     WHERE x.conversation_id = c.id AND ${IN_TIMELINE} AND x.deleted_at IS NULL AND x.kind = 'text' AND x.author_user_id IS DISTINCT FROM m.user_id
       AND (m.last_read_at IS NULL OR x.created_at > m.last_read_at))::int AS unread,
  (SELECT count(*) FROM chat_messages x
     WHERE x.conversation_id = c.id AND ${IN_TIMELINE} AND x.deleted_at IS NULL AND x.kind = 'text' AND x.author_user_id IS DISTINCT FROM m.user_id
       AND (m.last_read_at IS NULL OR x.created_at > m.last_read_at) AND (m.user_id = ANY(x.mentions) OR x.mention_all))::int AS unread_mentions,
  lm.id AS last_id, lm.body AS last_body, lm.kind AS last_kind, lm.author_user_id AS last_author, lm.created_at AS last_at,
  lm.deleted_at AS last_deleted, cardinality(lm.file_ids) AS last_files, jsonb_array_length(lm.refs) AS last_refs, lm.refs AS last_ref_list,
  lm.detail->'voice'->>'durationMs' AS last_voice_ms`;

const LAST_MESSAGE = `LEFT JOIN LATERAL (
    SELECT id, body, kind, author_user_id, created_at, deleted_at, file_ids, refs, detail FROM chat_messages x
     WHERE x.conversation_id = c.id AND ${IN_TIMELINE} ORDER BY x.created_at DESC LIMIT 1) lm ON true`;

/** The conversations a person is in, newest first, each with its unread counts and last message. */
async function conversationsFor(userId, ownerId) {
  const { rows } = await query(
    `SELECT ${CONVERSATION_SUMMARY}
       FROM chat_conversations c
       JOIN chat_members m ON m.conversation_id = c.id AND m.user_id = $1
       ${LAST_MESSAGE}
      WHERE c.owner_user_id = $2
      ORDER BY coalesce(c.last_message_at, c.created_at) DESC`,
    [userId, ownerId]
  );
  return rows;
}

/** One conversation as its member sees it, or null. */
async function conversationFor(id, userId) {
  const { rows } = await query(
    `SELECT ${CONVERSATION_SUMMARY}
       FROM chat_conversations c
       JOIN chat_members m ON m.conversation_id = c.id AND m.user_id = $2
       ${LAST_MESSAGE}
      WHERE c.id = $1`,
    [id, userId]
  );
  return rows[0] || null;
}

/** The team's public channels this person isn't in (to join). */
async function openChannels(ownerId, userId) {
  const { rows } = await query(
    `SELECT c.*, (SELECT count(*) FROM chat_members x WHERE x.conversation_id = c.id)::int AS member_count
       FROM chat_conversations c
      WHERE c.owner_user_id = $1 AND c.kind = 'channel' AND NOT c.private AND c.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM chat_members m WHERE m.conversation_id = c.id AND m.user_id = $2)
      ORDER BY lower(c.name)`,
    [ownerId, userId]
  );
  return rows;
}

async function findConversation(id, ownerId) {
  const { rows } = await query(`SELECT * FROM chat_conversations WHERE id = $1 AND owner_user_id = $2`, [id, ownerId]);
  return rows[0] || null;
}

async function findDm(ownerId, dmKey) {
  const { rows } = await query(`SELECT * FROM chat_conversations WHERE owner_user_id = $1 AND dm_key = $2`, [ownerId, dmKey]);
  return rows[0] || null;
}

async function findChannelByName(ownerId, name) {
  const { rows } = await query(`SELECT id FROM chat_conversations WHERE owner_user_id = $1 AND kind = 'channel' AND lower(name) = lower($2)`, [ownerId, name]);
  return rows[0] || null;
}

/** Makes a conversation with its first members (everyone's reading starts now). */
async function createConversation({ ownerId, kind, name = null, topic = null, isPrivate = false, connectionId = null, dmKey = null, createdBy, members }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO chat_conversations (owner_user_id, kind, name, topic, private, connection_id, dm_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [ownerId, kind, name, topic, isPrivate, connectionId, dmKey, createdBy]
    );
    const conversation = rows[0];
    // Each joined a moment after the one before (now() is the same all through a transaction):
    // the order they were picked is the order a group's name lists them in, every time.
    for (const m of members) {
      await client.query(`INSERT INTO chat_members (conversation_id, user_id, role, last_read_at, joined_at) VALUES ($1, $2, $3, now(), clock_timestamp()) ON CONFLICT DO NOTHING`, [conversation.id, m.userId, m.role || 'member']);
    }
    await client.query('COMMIT');
    return conversation;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function updateConversation(id, fields) {
  const sets = [];
  const params = [id];
  for (const [column, value] of Object.entries(fields)) {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) return null;
  const { rows } = await query(`UPDATE chat_conversations SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  return rows[0] || null;
}

async function deleteConversation(id) {
  await query(`DELETE FROM chat_conversations WHERE id = $1`, [id]);
}

/** Who's in the conversations: [{ conversation_id, user_id, role, last_read_at, name, email, avatar_url, deactivated_at }]. */
async function membersOf(conversationIds) {
  if (!conversationIds.length) return [];
  const { rows } = await query(
    `SELECT m.conversation_id, m.user_id, m.role, m.last_read_at, m.notify, u.name, u.email, u.avatar_url, wm.deactivated_at
       FROM chat_members m JOIN users u ON u.id = m.user_id
       JOIN chat_conversations c ON c.id = m.conversation_id
       LEFT JOIN workspace_members wm ON wm.owner_user_id = c.owner_user_id AND wm.user_id = m.user_id
      WHERE m.conversation_id = ANY($1::uuid[])
      ORDER BY m.joined_at, m.user_id`,
    [conversationIds]
  );
  return rows;
}

async function membership(conversationId, userId) {
  const { rows } = await query(`SELECT * FROM chat_members WHERE conversation_id = $1 AND user_id = $2`, [conversationId, userId]);
  return rows[0] || null;
}

async function addMembers(conversationId, userIds, role = 'member') {
  const added = [];
  for (const userId of userIds) {
    const { rowCount } = await query(`INSERT INTO chat_members (conversation_id, user_id, role, last_read_at) VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`, [conversationId, userId, role]);
    if (rowCount) added.push(userId);
  }
  return added;
}

async function removeMember(conversationId, userId) {
  const { rowCount } = await query(`DELETE FROM chat_members WHERE conversation_id = $1 AND user_id = $2`, [conversationId, userId]);
  return rowCount > 0;
}

async function setNotify(conversationId, userId, notify) {
  await query(`UPDATE chat_members SET notify = $3 WHERE conversation_id = $1 AND user_id = $2`, [conversationId, userId, notify]);
}

/**
 * Marks everything up to a message (`messageId`) or a time (`at`) read, never
 * moving backwards. A message's time is taken in SQL: Postgres keeps
 * microseconds, a JS Date only milliseconds, and a rounded-down time would
 * leave that very message unread.
 */
async function markRead(conversationId, userId, { at = null, messageId = null } = {}) {
  const { rows } = await query(
    `UPDATE chat_members SET last_read_at = GREATEST(coalesce(last_read_at, 'epoch'::timestamptz),
        coalesce((SELECT created_at FROM chat_messages WHERE id = $4::uuid AND conversation_id = $1), $3::timestamptz, now()))
      WHERE conversation_id = $1 AND user_id = $2 RETURNING last_read_at`,
    [conversationId, userId, at, messageId]
  );
  return rows[0]?.last_read_at || null;
}

const MESSAGE_COLUMNS = `x.*, u.name AS author_name, u.email AS author_email, u.avatar_url AS author_avatar,
  r.body AS reply_body, r.author_user_id AS reply_author, r.deleted_at AS reply_deleted, cardinality(r.file_ids) AS reply_files, r.detail->'voice'->>'durationMs' AS reply_voice_ms,
  ru.name AS reply_author_name, ru.email AS reply_author_email`;
const MESSAGE_JOINS = `LEFT JOIN users u ON u.id = x.author_user_id
  LEFT JOIN chat_messages r ON r.id = x.reply_to_id
  LEFT JOIN users ru ON ru.id = r.author_user_id`;

/**
 * Saves a message. A thread reply (`threadId`) moves its thread's count and
 * last reply time, and its author reads the thread up to it; the
 * conversation's last message and its author's read mark move only for
 * what the conversation shows (not a thread reply, unless also sent to it).
 */
async function insertMessage(m) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inTimeline = !m.threadId || Boolean(m.alsoInConversation);
    const { rows } = await client.query(
      `INSERT INTO chat_messages (conversation_id, author_user_id, kind, body, reply_to_id, refs, file_ids, mentions, mention_all, detail, thread_id, also_in_conversation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, created_at`,
      [
        m.conversationId,
        m.authorId,
        m.kind || 'text',
        m.body || '',
        m.replyToId || null,
        JSON.stringify(m.refs || []),
        m.fileIds || [],
        m.mentions || [],
        Boolean(m.mentionAll),
        JSON.stringify(m.detail || {}),
        m.threadId || null,
        Boolean(m.threadId && m.alsoInConversation),
      ]
    );
    // Times copied in SQL, at full precision (see markRead).
    if (m.threadId) {
      await client.query(`UPDATE chat_messages SET reply_count = reply_count + 1, last_reply_at = (SELECT created_at FROM chat_messages WHERE id = $2) WHERE id = $1`, [m.threadId, rows[0].id]);
      if (m.authorId) {
        await client.query(
          `INSERT INTO chat_thread_members (root_id, user_id, last_read_at, following) VALUES ($1, $2, (SELECT created_at FROM chat_messages WHERE id = $3), true)
           ON CONFLICT (root_id, user_id) DO UPDATE SET last_read_at = GREATEST(coalesce(chat_thread_members.last_read_at, 'epoch'::timestamptz), EXCLUDED.last_read_at), following = true`,
          [m.threadId, m.authorId, rows[0].id]
        );
      }
    }
    if (inTimeline) {
      await client.query(`UPDATE chat_conversations SET last_message_at = (SELECT created_at FROM chat_messages WHERE id = $2) WHERE id = $1`, [m.conversationId, rows[0].id]);
      // The author has read their own conversation up to what they just said.
      if (m.authorId) await client.query(`UPDATE chat_members SET last_read_at = (SELECT created_at FROM chat_messages WHERE id = $3) WHERE conversation_id = $1 AND user_id = $2`, [m.conversationId, m.authorId, rows[0].id]);
    }
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function findMessage(id) {
  const { rows } = await query(`SELECT ${MESSAGE_COLUMNS} FROM chat_messages x ${MESSAGE_JOINS} WHERE x.id = $1`, [id]);
  return rows[0] || null;
}

/** A page of what a conversation shows (thread replies only when also sent to it), oldest first: before a message (older), after one (newer), or the latest. */
async function messages(conversationId, { before = null, after = null, limit = 50 } = {}) {
  const params = [conversationId, limit];
  let where = '';
  let order = 'DESC';
  if (before) {
    params.push(before);
    where = `AND (x.created_at, x.id) < (SELECT created_at, id FROM chat_messages WHERE id = $3)`;
  } else if (after) {
    params.push(after);
    where = `AND (x.created_at, x.id) > (SELECT created_at, id FROM chat_messages WHERE id = $3)`;
    order = 'ASC';
  }
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS} FROM chat_messages x ${MESSAGE_JOINS}
      WHERE x.conversation_id = $1 AND ${IN_TIMELINE} ${where}
      ORDER BY x.created_at ${order}, x.id ${order} LIMIT $2`,
    params
  );
  return order === 'DESC' ? rows.reverse() : rows;
}

async function updateMessage(id, fields) {
  const sets = [];
  const params = [id];
  for (const [column, value] of Object.entries(fields)) {
    params.push(column === 'refs' ? JSON.stringify(value) : value);
    sets.push(`${column} = $${params.length}`);
  }
  await query(`UPDATE chat_messages SET ${sets.join(', ')} WHERE id = $1`, params);
}

/** Messages in the person's conversations whose words match (newest first). */
async function searchMessages(userId, ownerId, q, limit = 30) {
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS}, c.kind AS conversation_kind, c.name AS conversation_name
       FROM chat_messages x
       JOIN chat_conversations c ON c.id = x.conversation_id AND c.owner_user_id = $2
       JOIN chat_members m ON m.conversation_id = c.id AND m.user_id = $1
       ${MESSAGE_JOINS}
      WHERE x.deleted_at IS NULL AND x.kind = 'text'
        AND (x.search @@ plainto_tsquery('simple', $3) OR x.body ILIKE $4
             OR EXISTS (SELECT 1 FROM files f WHERE f.id = ANY(x.file_ids) AND f.name ILIKE $4))
      ORDER BY x.created_at DESC LIMIT $5`,
    [userId, ownerId, q, `%${String(q).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`, limit]
  );
  return rows;
}

/** Everything unread for a person: { unread, mentions } across their conversations, and `threads`: new replies in the threads they follow. */
async function unreadTotals(userId, ownerId) {
  const [{ rows }, threads] = await Promise.all([
    query(
      `SELECT count(*)::int AS unread, count(*) FILTER (WHERE $1 = ANY(x.mentions) OR x.mention_all OR c.kind = 'dm')::int AS mentions
         FROM chat_members m
         JOIN chat_conversations c ON c.id = m.conversation_id AND c.owner_user_id = $2
         JOIN chat_messages x ON x.conversation_id = c.id
        WHERE m.user_id = $1 AND m.notify <> 'none' AND ${IN_TIMELINE} AND x.deleted_at IS NULL AND x.kind = 'text' AND x.author_user_id IS DISTINCT FROM $1
          AND (m.last_read_at IS NULL OR x.created_at > m.last_read_at)`,
      [userId, ownerId]
    ),
    threadUnreadTotal(userId, ownerId),
  ]);
  return { ...(rows[0] || { unread: 0, mentions: 0 }), threads };
}

// ---- threads ------------------------------------------------------------------------

/** A thread: its first message then every reply, oldest first. */
async function threadMessages(rootId, limit = 500) {
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS} FROM chat_messages x ${MESSAGE_JOINS}
      WHERE x.id = $1 OR x.thread_id = $1
      ORDER BY (x.id = $1) DESC, x.created_at, x.id LIMIT $2`,
    [rootId, limit]
  );
  return rows;
}

/** The latest repliers of each thread (who's in it), newest first: Map(rootId -> [{ id, name, email, avatar_url }]). */
async function threadPeople(rootIds, perThread = 3) {
  if (!rootIds.length) return new Map();
  const { rows } = await query(
    `SELECT t.thread_id, t.author_user_id, t.at, u.name, u.email, u.avatar_url FROM (
       SELECT thread_id, author_user_id, max(created_at) AS at FROM chat_messages
        WHERE thread_id = ANY($1::uuid[]) AND author_user_id IS NOT NULL AND deleted_at IS NULL
        GROUP BY thread_id, author_user_id) t
       JOIN users u ON u.id = t.author_user_id
      ORDER BY t.thread_id, t.at DESC`,
    [rootIds]
  );
  const out = new Map();
  for (const r of rows) {
    const list = out.get(r.thread_id) || [];
    if (list.length < perThread) list.push({ id: r.author_user_id, name: r.name, email: r.email, avatar_url: r.avatar_url });
    out.set(r.thread_id, list);
  }
  return out;
}

/** The last few replies of each thread, oldest first: Map(rootId -> rows). */
async function latestReplies(rootIds, perThread = 2) {
  if (!rootIds.length) return new Map();
  const { rows } = await query(
    `SELECT * FROM (
       SELECT ${MESSAGE_COLUMNS}, row_number() OVER (PARTITION BY x.thread_id ORDER BY x.created_at DESC, x.id DESC) AS n
         FROM chat_messages x ${MESSAGE_JOINS}
        WHERE x.thread_id = ANY($1::uuid[])) r
      WHERE r.n <= $2 ORDER BY r.created_at, r.id`,
    [rootIds, perThread]
  );
  const out = new Map();
  for (const r of rows) out.set(r.thread_id, [...(out.get(r.thread_id) || []), r]);
  return out;
}

/** Makes these people followers of a thread (those already in it keep where they are). */
async function addThreadFollowers(rootId, userIds) {
  for (const userId of [...new Set(userIds.map(String))]) {
    await query(`INSERT INTO chat_thread_members (root_id, user_id, following) VALUES ($1, $2, true) ON CONFLICT (root_id, user_id) DO NOTHING`, [rootId, userId]);
  }
}

/** Follows or stops following a thread. */
async function setFollowing(rootId, userId, following) {
  await query(
    `INSERT INTO chat_thread_members (root_id, user_id, following) VALUES ($1, $2, $3)
     ON CONFLICT (root_id, user_id) DO UPDATE SET following = EXCLUDED.following`,
    [rootId, userId, Boolean(following)]
  );
}

/**
 * Reads a thread up to a reply (or now), never backwards (the time taken in
 * SQL, as markRead does). Someone reading a thread they had no place in
 * isn't made a follower by it, unless it's their own message's.
 */
async function markThreadRead(rootId, userId, { messageId = null } = {}) {
  const { rows } = await query(
    `INSERT INTO chat_thread_members (root_id, user_id, last_read_at, following)
     VALUES ($1, $2, coalesce((SELECT created_at FROM chat_messages WHERE id = $3::uuid AND thread_id = $1), now()),
             coalesce((SELECT author_user_id = $2 FROM chat_messages WHERE id = $1), false))
     ON CONFLICT (root_id, user_id) DO UPDATE SET last_read_at = GREATEST(coalesce(chat_thread_members.last_read_at, 'epoch'::timestamptz), EXCLUDED.last_read_at)
     RETURNING last_read_at`,
    [rootId, userId, messageId]
  );
  return rows[0]?.last_read_at || null;
}

/** One person's place in a thread ({ following, last_read_at }), or null. */
async function threadMembership(rootId, userId) {
  const { rows } = await query(`SELECT * FROM chat_thread_members WHERE root_id = $1 AND user_id = $2`, [rootId, userId]);
  return rows[0] || null;
}

/** Who follows a thread: [{ user_id, last_read_at }]. */
async function threadFollowers(rootId) {
  const { rows } = await query(`SELECT user_id, last_read_at FROM chat_thread_members WHERE root_id = $1 AND following`, [rootId]);
  return rows;
}

/**
 * The threads a person follows in conversations they're still in, the
 * latest reply first: each first message (as messages come) with
 * `thread_read_at`, `thread_unread` and the conversation's kind and name.
 */
async function threadsFor(userId, ownerId, limit = 50) {
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS}, t.last_read_at AS thread_read_at, c.kind AS conversation_kind, c.name AS conversation_name,
            (SELECT count(*) FROM chat_messages y
              WHERE y.thread_id = x.id AND y.deleted_at IS NULL AND y.author_user_id IS DISTINCT FROM $1
                AND (t.last_read_at IS NULL OR y.created_at > t.last_read_at))::int AS thread_unread
       FROM chat_thread_members t
       JOIN chat_messages x ON x.id = t.root_id
       JOIN chat_conversations c ON c.id = x.conversation_id AND c.owner_user_id = $2
       JOIN chat_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
       ${MESSAGE_JOINS}
      WHERE t.user_id = $1 AND t.following AND x.reply_count > 0
      ORDER BY x.last_reply_at DESC NULLS LAST LIMIT $3`,
    [userId, ownerId, limit]
  );
  return rows;
}

/**
 * A conversation's threads, the latest reply first: each first message (as
 * messages come) with whether this person follows it and, if so, how many
 * replies are new to them (`thread_following`, `thread_unread`).
 */
async function threadsIn(conversationId, userId, limit = 100) {
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS}, coalesce(tm.following, false) AS thread_following,
            (CASE WHEN tm.following THEN
              (SELECT count(*) FROM chat_messages y
                WHERE y.thread_id = x.id AND y.deleted_at IS NULL AND y.author_user_id IS DISTINCT FROM $2
                  AND (tm.last_read_at IS NULL OR y.created_at > tm.last_read_at))
             ELSE 0 END)::int AS thread_unread
       FROM chat_messages x
       LEFT JOIN chat_thread_members tm ON tm.root_id = x.id AND tm.user_id = $2
       ${MESSAGE_JOINS}
      WHERE x.conversation_id = $1 AND x.thread_id IS NULL AND x.reply_count > 0
      ORDER BY x.last_reply_at DESC NULLS LAST LIMIT $3`,
    [conversationId, userId, limit]
  );
  return rows;
}

/**
 * What's been shared in a conversation, newest first: its messages (thread
 * replies too) that carry files or links to other sites, not deleted, as
 * messages come. Voice notes are left out (they're messages, not files).
 */
async function sharedIn(conversationId, limit = 200) {
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS}
       FROM chat_messages x
       ${MESSAGE_JOINS}
      WHERE x.conversation_id = $1 AND x.deleted_at IS NULL AND x.kind = 'text'
        AND ((cardinality(x.file_ids) > 0 AND x.detail->'voice' IS NULL) OR jsonb_array_length(x.links) > 0)
      ORDER BY x.created_at DESC LIMIT $2`,
    [conversationId, limit]
  );
  return rows;
}

/** New replies, not theirs, in the threads a person follows (in conversations they're in and haven't muted). */
async function threadUnreadTotal(userId, ownerId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n
       FROM chat_thread_members t
       JOIN chat_messages r ON r.id = t.root_id
       JOIN chat_conversations c ON c.id = r.conversation_id AND c.owner_user_id = $2
       JOIN chat_members cm ON cm.conversation_id = c.id AND cm.user_id = $1 AND cm.notify <> 'none'
       JOIN chat_messages y ON y.thread_id = r.id
      WHERE t.user_id = $1 AND t.following AND y.deleted_at IS NULL AND y.author_user_id IS DISTINCT FROM $1
        AND (t.last_read_at IS NULL OR y.created_at > t.last_read_at)`,
    [userId, ownerId]
  );
  return rows[0]?.n || 0;
}

async function settingsFor(userId) {
  const { rows } = await query(`SELECT * FROM notification_settings WHERE user_id = $1`, [userId]);
  return rows[0] || null;
}

async function settingsForMany(userIds) {
  if (!userIds.length) return [];
  const { rows } = await query(`SELECT * FROM notification_settings WHERE user_id = ANY($1::uuid[])`, [userIds]);
  return rows;
}

async function saveSettings(userId, s) {
  const { rows } = await query(
    `INSERT INTO notification_settings (user_id, chat, ebay, ebay_accounts, quiet_from, quiet_to, time_zone, hide_text, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (user_id) DO UPDATE SET chat = $2, ebay = $3, ebay_accounts = $4, quiet_from = $5, quiet_to = $6, time_zone = $7, hide_text = $8, updated_at = now()
     RETURNING *`,
    [userId, s.chat, s.ebay, s.ebayAccounts, s.quietFrom, s.quietTo, s.timeZone, s.hideText]
  );
  return rows[0];
}

module.exports = {
  people,
  conversationsFor,
  conversationFor,
  openChannels,
  findConversation,
  findDm,
  findChannelByName,
  createConversation,
  updateConversation,
  deleteConversation,
  membersOf,
  membership,
  addMembers,
  removeMember,
  setNotify,
  markRead,
  insertMessage,
  findMessage,
  messages,
  updateMessage,
  searchMessages,
  unreadTotals,
  threadMessages,
  threadPeople,
  latestReplies,
  addThreadFollowers,
  setFollowing,
  markThreadRead,
  threadMembership,
  threadFollowers,
  threadsFor,
  threadsIn,
  sharedIn,
  threadUnreadTotal,
  settingsFor,
  settingsForMany,
  saveSettings,
};
