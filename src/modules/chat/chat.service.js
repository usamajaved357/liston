const chatRepository = require('./chat.repository');
const rules = require('./chat-rules');
const teamRepository = require('../team/team.repository');
const connectionRepository = require('../connections/connection.repository');
const filesRepository = require('../files/files.repository');
const filesService = require('../files/files.service');
const referencesService = require('../references/references.service');
const { detect } = require('../references/reference-detect');
const userEvents = require('../realtime/user-events');
const notificationsService = require('../notifications/notifications.service');
const logger = require('../../utils/logger');

// Team chat: the owner and their team in direct messages (one per pair),
// small groups (3–8, anyone starts one) and channels (made, renamed,
// archived, deleted and staffed by the owner or members given "Manage
// channels"; public ones anyone in the team can join). A message can carry
// text with @mentions, files, and Liston cards (orders, listings, drafts,
// hunted products from any account, each shown only as far as the viewer's
// access reaches). Every change reaches the people in the conversation on
// their live channel at once; a new message is pushed to their devices
// unless they're reading it, muted it, or it's their quiet hours.

class ChatError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.expose = true;
  }
}

const refuse = (message, code = 403) => {
  throw new ChatError(message, code);
};

const PAGE = 50;
const MAX_FILES = 10;
const MAX_REFS = 10;

// ---- who's who ----------------------------------------------------------------------

async function team(auth) {
  const rows = await chatRepository.people(auth.ownerId);
  return new Map(rows.map((p) => [String(p.id), p]));
}

function person(p, { withOnline = true } = {}) {
  if (!p) return null;
  return {
    id: p.id,
    name: rules.nameOf(p),
    email: p.email,
    avatarUrl: p.avatar_url || null,
    role: p.role,
    removed: Boolean(p.deactivated_at),
    ...(withOnline ? { online: userEvents.isOnline(String(p.id)) } : {}),
  };
}

/** The team to start conversations with: the owner and every member not removed. */
async function people(auth) {
  const everyone = await team(auth);
  return [...everyone.values()].filter((p) => !p.deactivated_at).map((p) => person(p));
}

/** Whether this person runs channels: the owner, or a member given "Manage channels". */
async function canManageChannels(auth) {
  if (auth.role === 'owner') return true;
  return teamRepository.resolvePermission(auth.userId, null, 'chat_manage');
}

// The same auth another person would have, for resolving cards as they'd see them.
const authOf = (p, ownerId) => ({ userId: String(p.id), ownerId, role: p.role === 'member' ? 'member' : 'owner' });

// ---- shaping ------------------------------------------------------------------------

async function accountsById(ownerId) {
  const rows = await connectionRepository.findAllByUser(ownerId);
  return new Map(rows.map((c) => [c.id, { id: c.id, label: c.label }]));
}

function conversationShape(row, members, viewerId, { canManage, accounts }) {
  const mine = members.filter((m) => m.conversation_id === row.id);
  const lastAuthor = mine.find((m) => String(m.user_id) === String(row.last_author));
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    title: rules.titleOf(row, mine, viewerId),
    topic: row.topic,
    private: row.private,
    account: row.connection_id ? accounts.get(row.connection_id) || null : null,
    archived: Boolean(row.archived_at),
    members: mine.map((m) => ({ ...person({ id: m.user_id, name: m.name, email: m.email, avatar_url: m.avatar_url, deactivated_at: m.deactivated_at }), memberRole: m.role, lastReadAt: m.last_read_at })),
    unread: row.unread || 0,
    unreadMentions: row.unread_mentions || 0,
    notify: row.notify,
    myRole: row.my_role,
    lastMessage: row.last_id
      ? {
          id: row.last_id,
          at: row.last_at,
          kind: row.last_kind,
          author: row.last_author ? { id: row.last_author, name: lastAuthor ? rules.nameOf(lastAuthor) : 'Someone' } : null,
          text: row.last_kind === 'system' ? null : rules.previewOf({ body: row.last_body, fileCount: row.last_files, cards: (row.last_ref_list || []).map((r) => ({ kind: r.kind })), deleted: Boolean(row.last_deleted) }),
        }
      : null,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    // What this person may do here.
    permissions: {
      manage: row.kind === 'channel' ? canManage : row.kind === 'group',
      addPeople: row.kind === 'channel' ? canManage : row.kind === 'group',
      leave: row.kind !== 'dm',
    },
  };
}

/** Messages as one viewer sees them: cards resolved for their access, files with fresh links. */
async function shapeMessages(viewer, rows) {
  const live = rows.filter((r) => !r.deleted_at);
  const refs = live.flatMap((r) => r.refs || []);
  const cards = refs.length ? await referencesService.resolve(viewer, refs) : [];
  const fileIds = [...new Set(live.flatMap((r) => r.file_ids || []))];
  const files = new Map((await filesRepository.findByIds(fileIds)).map((f) => [f.id, filesService.shape(f)]));
  let at = 0;
  const cardsFor = new Map();
  for (const r of live) {
    const n = (r.refs || []).length;
    cardsFor.set(r.id, cards.slice(at, at + n));
    at += n;
  }
  return rows.map((r) => messageShape(r, cardsFor.get(r.id) || [], files));
}

function messageShape(r, cards, files) {
  const deleted = Boolean(r.deleted_at);
  return {
    id: r.id,
    conversationId: r.conversation_id,
    kind: r.kind,
    body: deleted ? '' : r.body,
    author: r.author_user_id ? { id: r.author_user_id, name: rules.nameOf({ name: r.author_name, email: r.author_email }), avatarUrl: r.author_avatar || null } : null,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deleted,
    replyTo: r.reply_to_id
      ? {
          id: r.reply_to_id,
          author: r.reply_author ? { id: r.reply_author, name: rules.nameOf({ name: r.reply_author_name, email: r.reply_author_email }) } : null,
          text: rules.previewOf({ body: r.reply_body, fileCount: r.reply_files || 0, deleted: Boolean(r.reply_deleted) }),
        }
      : null,
    // A card no longer in Liston shows as gone, with none of its details.
    cards: deleted ? [] : (r.refs || []).map((ref, i) => cards[i] || { kind: ref.kind, id: String(ref.id), key: `${ref.kind}:gone:${ref.id}`, gone: true }),
    files: deleted ? [] : (r.file_ids || []).map((id) => files.get(id)).filter(Boolean),
    links: deleted ? [] : r.links || [],
    mentions: r.mentions || [],
    mentionAll: r.mention_all,
    detail: r.kind === 'system' ? r.detail || {} : {},
  };
}

// ---- conversations ------------------------------------------------------------------

async function list(auth) {
  const [rows, open, canManage, accounts] = await Promise.all([
    chatRepository.conversationsFor(auth.userId, auth.ownerId),
    chatRepository.openChannels(auth.ownerId, auth.userId),
    canManageChannels(auth),
    accountsById(auth.ownerId),
  ]);
  const members = await chatRepository.membersOf(rows.map((r) => r.id));
  return {
    conversations: rows.map((r) => conversationShape(r, members, auth.userId, { canManage, accounts })),
    openChannels: open.map((c) => ({ id: c.id, name: c.name, title: `#${c.name}`, topic: c.topic, memberCount: c.member_count, account: c.connection_id ? accounts.get(c.connection_id) || null : null })),
    canManageChannels: canManage,
    unread: await chatRepository.unreadTotals(auth.userId, auth.ownerId),
  };
}

/** One conversation for a member of it (a public channel's outsider may look before joining). */
async function get(auth, id) {
  const row = await chatRepository.conversationFor(id, auth.userId);
  if (!row) {
    const c = await chatRepository.findConversation(id, auth.ownerId);
    if (c && c.kind === 'channel' && !c.private) refuse('Join this channel to read it.', 403);
    refuse('Conversation not found.', 404);
  }
  const [members, canManage, accounts] = await Promise.all([chatRepository.membersOf([id]), canManageChannels(auth), accountsById(auth.ownerId)]);
  return conversationShape(row, members, auth.userId, { canManage, accounts });
}

async function requireMember(auth, id) {
  const c = await chatRepository.findConversation(id, auth.ownerId);
  if (!c) refuse('Conversation not found.', 404);
  const m = await chatRepository.membership(id, auth.userId);
  if (!m) refuse(c.kind === 'channel' && !c.private ? 'Join this channel first.' : 'Conversation not found.', c.kind === 'channel' && !c.private ? 403 : 404);
  return { conversation: c, member: m };
}

async function requireManage(auth, conversation) {
  if (conversation.kind === 'channel' ? !(await canManageChannels(auth)) : conversation.kind !== 'group') {
    refuse(conversation.kind === 'channel' ? 'Only the owner, or someone given Manage channels, can change channels.' : "A direct message can't be changed.");
  }
}

/** The team people among `ids` (not removed), as a set of ids. */
async function teamIds(auth, ids) {
  const everyone = await team(auth);
  const out = [];
  for (const id of ids || []) {
    const p = everyone.get(String(id));
    if (!p || p.deactivated_at) refuse("That person isn't in your team.", 400);
    out.push(String(p.id));
  }
  return [...new Set(out)];
}

/** Tells everyone in a conversation it changed (their lists re-read it). */
async function announce(conversationId, extra = {}, alsoTo = []) {
  const members = await chatRepository.membersOf([conversationId]);
  userEvents.emitMany([...members.map((m) => String(m.user_id)), ...alsoTo], { type: 'chat.conversation', conversationId, ...extra });
}

/** Opens the direct message with someone, making it the first time. */
async function openDm(auth, userId) {
  const [other] = await teamIds(auth, [userId]);
  const key = rules.dmKey(auth.userId, other);
  let c = await chatRepository.findDm(auth.ownerId, key);
  if (!c) {
    try {
      c = await chatRepository.createConversation({ ownerId: auth.ownerId, kind: 'dm', dmKey: key, createdBy: auth.userId, members: other === String(auth.userId) ? [{ userId: auth.userId }] : [{ userId: auth.userId }, { userId: other }] });
    } catch (err) {
      // Both opened it at once: the other request made it.
      if (err.code !== '23505') throw err;
      c = await chatRepository.findDm(auth.ownerId, key);
    }
    await announce(c.id);
  }
  return get(auth, c.id);
}

/** Starts a group of 3 to 8 (the starter included). */
async function createGroup(auth, { userIds, name = null }) {
  const ids = (await teamIds(auth, userIds)).filter((id) => id !== String(auth.userId));
  if (ids.length < 2) refuse('A group needs at least two other people. For one, send a direct message.', 400);
  if (ids.length + 1 > rules.GROUP_MAX) refuse(`A group is up to ${rules.GROUP_MAX} people. For more, make a channel.`, 400);
  const c = await chatRepository.createConversation({
    ownerId: auth.ownerId,
    kind: 'group',
    name: name ? String(name).trim().slice(0, 80) || null : null,
    createdBy: auth.userId,
    members: [{ userId: auth.userId, role: 'admin' }, ...ids.map((id) => ({ userId: id }))],
  });
  await system(c.id, auth.userId, { action: 'created_group' });
  await announce(c.id);
  return get(auth, c.id);
}

async function validAccount(auth, connectionId) {
  if (!connectionId) return null;
  const c = await connectionRepository.findByIdForUser(connectionId, auth.ownerId);
  if (!c) refuse('That eBay account isn\'t yours.', 400);
  return c.id;
}

/** Makes a channel (owner or Manage channels): its name, topic, public or private, an account it's about, its first people. */
async function createChannel(auth, { name, topic = null, isPrivate = false, connectionId = null, userIds = [] }) {
  if (!(await canManageChannels(auth))) refuse('Only the owner, or someone given Manage channels, can make channels.');
  const clean = rules.channelName(name);
  if (!rules.validChannelName(clean)) refuse('Name the channel with letters, numbers and hyphens (e.g. flipx-orders).', 400);
  if (await chatRepository.findChannelByName(auth.ownerId, clean)) refuse(`There's already a #${clean}.`, 409);
  const ids = (await teamIds(auth, userIds)).filter((id) => id !== String(auth.userId));
  const account = await validAccount(auth, connectionId);
  let c;
  try {
    c = await chatRepository.createConversation({
      ownerId: auth.ownerId,
      kind: 'channel',
      name: clean,
      topic: topic ? String(topic).trim().slice(0, 250) || null : null,
      isPrivate: Boolean(isPrivate),
      connectionId: account,
      createdBy: auth.userId,
      members: [{ userId: auth.userId, role: 'admin' }, ...ids.map((id) => ({ userId: id }))],
    });
  } catch (err) {
    if (err.code === '23505') refuse(`There's already a #${clean}.`, 409);
    throw err;
  }
  await system(c.id, auth.userId, { action: 'created_channel' });
  await announce(c.id);
  return get(auth, c.id);
}

/** Renames, re-topics, archives or brings back a channel (or names a group). */
async function update(auth, id, { name, topic, isPrivate, connectionId, archived }) {
  const { conversation } = await requireMember(auth, id).catch(async (err) => {
    // A manager may change a channel they aren't in.
    const c = await chatRepository.findConversation(id, auth.ownerId);
    if (c && c.kind === 'channel' && (await canManageChannels(auth))) return { conversation: c };
    throw err;
  });
  await requireManage(auth, conversation);
  const fields = {};
  const said = [];
  if (name !== undefined) {
    if (conversation.kind === 'channel') {
      const clean = rules.channelName(name);
      if (!rules.validChannelName(clean)) refuse('Name the channel with letters, numbers and hyphens (e.g. flipx-orders).', 400);
      const taken = await chatRepository.findChannelByName(auth.ownerId, clean);
      if (taken && taken.id !== id) refuse(`There's already a #${clean}.`, 409);
      if (clean !== conversation.name) {
        fields.name = clean;
        said.push({ action: 'renamed', from: conversation.name, to: clean });
      }
    } else {
      fields.name = String(name || '').trim().slice(0, 80) || null;
      said.push({ action: 'renamed', to: fields.name });
    }
  }
  if (topic !== undefined && conversation.kind === 'channel') {
    fields.topic = String(topic || '').trim().slice(0, 250) || null;
    said.push({ action: 'topic', to: fields.topic });
  }
  if (isPrivate !== undefined && conversation.kind === 'channel') fields.private = Boolean(isPrivate);
  if (connectionId !== undefined && conversation.kind === 'channel') fields.connection_id = await validAccount(auth, connectionId);
  if (archived !== undefined && conversation.kind === 'channel') {
    fields.archived_at = archived ? new Date() : null;
    said.push({ action: archived ? 'archived' : 'unarchived' });
  }
  await chatRepository.updateConversation(id, fields);
  for (const detail of said) await system(id, auth.userId, detail);
  await announce(id);
  return (await chatRepository.membership(id, auth.userId)) ? get(auth, id) : { id, ...fields };
}

/** Deletes a channel and everything said in it (owner or Manage channels). */
async function remove(auth, id) {
  const c = await chatRepository.findConversation(id, auth.ownerId);
  if (!c) refuse('Conversation not found.', 404);
  if (c.kind !== 'channel') refuse('Only channels can be deleted.', 400);
  if (!(await canManageChannels(auth))) refuse('Only the owner, or someone given Manage channels, can delete channels.');
  const members = await chatRepository.membersOf([id]);
  await chatRepository.deleteConversation(id);
  userEvents.emitMany(members.map((m) => String(m.user_id)), { type: 'chat.conversation', conversationId: id, removed: true });
}

/** Adds people to a channel (managers) or a group (its members, up to 8). */
async function addPeople(auth, id, userIds) {
  const c = await chatRepository.findConversation(id, auth.ownerId);
  if (!c) refuse('Conversation not found.', 404);
  if (c.kind === 'group') await requireMember(auth, id);
  await requireManage(auth, c);
  const ids = await teamIds(auth, userIds);
  if (c.kind === 'group') {
    const now = await chatRepository.membersOf([id]);
    if (new Set([...now.map((m) => String(m.user_id)), ...ids]).size > rules.GROUP_MAX) refuse(`A group is up to ${rules.GROUP_MAX} people. For more, make a channel.`, 400);
  }
  const added = await chatRepository.addMembers(id, ids);
  if (added.length) {
    await system(id, auth.userId, { action: 'added', userIds: added });
    await announce(id);
  }
  return get(auth, id).catch(() => ({ id }));
}

/** Takes someone out of a channel (managers) or a group (its members); anyone may leave. */
async function removePerson(auth, id, userId) {
  const c = await chatRepository.findConversation(id, auth.ownerId);
  if (!c) refuse('Conversation not found.', 404);
  if (c.kind === 'dm') refuse("You can't leave a direct message.", 400);
  const self = String(userId) === String(auth.userId);
  if (!self) {
    if (c.kind === 'group') await requireMember(auth, id);
    await requireManage(auth, c);
  }
  const was = await chatRepository.membership(id, userId);
  if (!was) refuse("They aren't in this conversation.", 404);
  await chatRepository.removeMember(id, userId);
  await system(id, auth.userId, self ? { action: 'left' } : { action: 'removed', userIds: [String(userId)] });
  await announce(id, {}, [String(userId)]);
}

/** Joins a public channel. */
async function join(auth, id) {
  const c = await chatRepository.findConversation(id, auth.ownerId);
  if (!c || c.kind !== 'channel' || c.private || c.archived_at) refuse('Channel not found.', 404);
  const added = await chatRepository.addMembers(id, [String(auth.userId)]);
  if (added.length) {
    await system(id, auth.userId, { action: 'joined' });
    await announce(id);
  }
  return get(auth, id);
}

/** This person's notifications for one conversation: all, mentions, none. */
async function setNotify(auth, id, notify) {
  await requireMember(auth, id);
  await chatRepository.setNotify(id, auth.userId, notify);
  userEvents.emit(String(auth.userId), { type: 'chat.conversation', conversationId: id });
  return get(auth, id);
}

// ---- messages -----------------------------------------------------------------------

async function system(conversationId, authorId, detail) {
  await chatRepository.insertMessage({ conversationId, authorId: null, kind: 'system', body: '', detail: { ...detail, by: authorId ? String(authorId) : null } });
}

async function messages(auth, id, { before = null, after = null, limit = PAGE } = {}) {
  await requireMember(auth, id);
  const rows = await chatRepository.messages(id, { before, after, limit: Math.min(100, Math.max(1, limit)) });
  return { messages: await shapeMessages(auth, rows), hasMore: !after && rows.length >= Math.min(100, Math.max(1, limit)) };
}

/** Cards a sender may attach: what they can see, from the text and anything dropped in. */
async function cardsFor(auth, body, explicit = []) {
  const seen = new Set();
  const refs = [...(explicit || []), ...detect(body)].filter((r) => {
    const key = `${r.kind}:${String(r.id).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!refs.length) return [];
  const cards = await referencesService.resolve(auth, refs.slice(0, MAX_REFS * 2));
  // Kept as references only: each viewer's access decides what they see.
  return cards
    .filter((c) => c && !c.locked)
    .slice(0, MAX_REFS)
    .map((c) => ({ kind: c.kind, id: String(c.id), connectionId: c.account.id }));
}

async function sendableFiles(auth, fileIds) {
  const ids = [...new Set(fileIds || [])];
  if (ids.length > MAX_FILES) refuse(`Up to ${MAX_FILES} files a message.`, 400);
  if (!ids.length) return [];
  const rows = await filesRepository.findByIds(ids);
  if (rows.length !== ids.length || rows.some((f) => f.owner_user_id !== auth.ownerId || f.purpose !== 'chat' || String(f.uploaded_by) !== String(auth.userId))) {
    refuse('One of those files isn\'t yours to send.', 400);
  }
  // In the order they were picked.
  return ids;
}

/**
 * Sends a message: text (with @mentions: the people's ids in `mentions`,
 * "@channel" for everyone), files uploaded first, Liston cards found in the
 * text or dropped in (`refs`), and the message it replies to.
 */
async function send(auth, id, { body = '', mentions = [], fileIds = [], refs = [], replyToId = null }) {
  const { conversation } = await requireMember(auth, id);
  if (conversation.archived_at) refuse('This channel is archived.', 400);
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (text.length > rules.MAX_BODY) refuse(`A message is up to ${rules.MAX_BODY.toLocaleString('en-GB')} characters.`, 400);
  const files = await sendableFiles(auth, fileIds);
  const cards = await cardsFor(auth, text, refs);
  if (!text && !files.length && !cards.length) refuse('Write something, or attach a file.', 400);
  if (replyToId) {
    const original = await chatRepository.findMessage(replyToId);
    if (!original || original.conversation_id !== id) refuse("That message isn't in this conversation.", 400);
  }
  const members = await chatRepository.membersOf([id]);
  const inIt = new Set(members.map((m) => String(m.user_id)));
  const mentioned = [...new Set((mentions || []).map(String))].filter((u) => inIt.has(u) && u !== String(auth.userId));
  const everyone = conversation.kind !== 'dm' && rules.mentionsEveryone(text);
  const saved = await chatRepository.insertMessage({
    conversationId: id,
    authorId: auth.userId,
    body: text,
    replyToId,
    refs: cards,
    fileIds: files,
    mentions: mentioned,
    mentionAll: everyone,
    detail: { explicitRefs: (refs || []).slice(0, MAX_REFS) },
  });
  const row = await chatRepository.findMessage(saved.id);
  const [mine] = await shapeMessages(auth, [row]);
  // Everyone in it sees it at once (each with cards as far as their access reaches); then the pushes.
  deliver(auth, conversation, members, row).catch((err) => logger.warn('Chat: message not delivered to everyone', { conversationId: id, error: err.message }));
  return mine;
}

async function deliver(auth, conversation, members, row) {
  const everyone = await team(auth);
  const settings = new Map((await chatRepository.settingsForMany(members.map((m) => String(m.user_id)))).map((s) => [String(s.user_id), s]));
  const accounts = await accountsById(auth.ownerId);
  const author = everyone.get(String(auth.userId));
  const authorName = rules.nameOf(author);
  for (const m of members) {
    const userId = String(m.user_id);
    const p = everyone.get(userId);
    if (!p) continue;
    const viewer = authOf(p, auth.ownerId);
    const [message] = await shapeMessages(viewer, [row]);
    userEvents.emit(userId, { type: 'chat.message', conversationId: conversation.id, message });
    if (userId === String(auth.userId) || p.deactivated_at) continue;
    if (!rules.wantsPush({ member: m, settings: settings.get(userId), conversation, message: row })) continue;
    // Reading it right now: nothing to tell them.
    if (userEvents.isViewing(userId, `chat:${conversation.id}`)) continue;
    const s = settings.get(userId);
    const where = conversation.kind === 'channel' ? `#${conversation.name}` : conversation.kind === 'group' ? rules.titleOf(conversation, members, userId) : null;
    const title = where ? `${authorName} in ${where}` : authorName;
    const preview = rules.previewOf({ body: row.body, fileCount: message.files.length, imageCount: message.files.filter((f) => f.image).length, cards: message.cards.filter((c) => !c.locked && !c.gone) });
    const shown = s?.hide_text ? `New message from ${authorName}` : preview;
    const quiet = rules.inQuietHours(s);
    await notificationsService.notifyGrouped({
      userId,
      actorUserId: auth.userId,
      kind: 'chat.message',
      title,
      body: shown,
      url: `/inbox?c=${conversation.id}`,
      subjectType: 'chat',
      subjectId: conversation.id,
      detail: { conversation: where || authorName, account: conversation.connection_id ? accounts.get(conversation.connection_id)?.label || null : null },
      push: quiet ? null : { title, body: shown, tag: `chat-${conversation.id}` },
    });
  }
}

async function ownMessage(auth, messageId, { allowOwner = false } = {}) {
  const row = await chatRepository.findMessage(messageId);
  if (!row) refuse('Message not found.', 404);
  await requireMember(auth, row.conversation_id).catch((err) => {
    if (!(allowOwner && auth.role === 'owner')) throw err;
  });
  const c = await chatRepository.findConversation(row.conversation_id, auth.ownerId);
  if (!c) refuse('Message not found.', 404);
  const mine = String(row.author_user_id) === String(auth.userId);
  if (row.kind !== 'text' || row.deleted_at) refuse("That message can't be changed.", 400);
  if (!mine && !(allowOwner && auth.role === 'owner')) refuse('Only its author can change a message.');
  return { row, conversation: c, mine };
}

async function broadcastUpdate(auth, row) {
  const members = await chatRepository.membersOf([row.conversation_id]);
  const everyone = await team(auth);
  const fresh = await chatRepository.findMessage(row.id);
  for (const m of members) {
    const p = everyone.get(String(m.user_id));
    if (!p) continue;
    const [message] = await shapeMessages(authOf(p, auth.ownerId), [fresh]);
    userEvents.emit(String(m.user_id), { type: 'chat.updated', conversationId: row.conversation_id, message });
  }
}

/** Changes the text of your own message (its cards follow the new text). */
async function edit(auth, messageId, { body, mentions = [] }) {
  const { row } = await ownMessage(auth, messageId);
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (text.length > rules.MAX_BODY) refuse(`A message is up to ${rules.MAX_BODY.toLocaleString('en-GB')} characters.`, 400);
  const cards = await cardsFor(auth, text, row.detail?.explicitRefs || []);
  if (!text && !(row.file_ids || []).length && !cards.length) refuse('A message needs some text or a file. Delete it instead.', 400);
  const members = await chatRepository.membersOf([row.conversation_id]);
  const inIt = new Set(members.map((m) => String(m.user_id)));
  await chatRepository.updateMessage(messageId, {
    body: text,
    refs: cards,
    mentions: [...new Set((mentions || []).map(String))].filter((u) => inIt.has(u) && u !== String(auth.userId)),
    edited_at: new Date(),
  });
  await broadcastUpdate(auth, row);
  const [shaped] = await shapeMessages(auth, [await chatRepository.findMessage(messageId)]);
  return shaped;
}

/** Deletes a message (its author, or the owner): it shows as deleted, its text and files gone from view. */
async function deleteMessage(auth, messageId) {
  const { row } = await ownMessage(auth, messageId, { allowOwner: true });
  await chatRepository.updateMessage(messageId, { deleted_at: new Date(), body: '' });
  await broadcastUpdate(auth, row);
}

/** Reads a conversation up to a message (or now): unread counts drop, "Seen by" moves, its bell line clears. */
async function markRead(auth, id, { messageId = null } = {}) {
  await requireMember(auth, id);
  let at = new Date();
  if (messageId) {
    const m = await chatRepository.findMessage(messageId);
    if (m && m.conversation_id === id) at = m.created_at;
  }
  const readAt = await chatRepository.markRead(id, auth.userId, at);
  await notificationsService.readSubject(auth.userId, 'chat.message', id);
  const members = await chatRepository.membersOf([id]);
  userEvents.emitMany(members.map((m) => String(m.user_id)), { type: 'chat.read', conversationId: id, userId: String(auth.userId), at: readAt });
  return { readAt, unread: await chatRepository.unreadTotals(auth.userId, auth.ownerId) };
}

/** "Sara is typing…" for everyone else in it. */
async function typing(auth, id) {
  const { conversation } = await requireMember(auth, id);
  const members = await chatRepository.membersOf([id]);
  const me = members.find((m) => String(m.user_id) === String(auth.userId));
  userEvents.emitMany(
    members.map((m) => String(m.user_id)).filter((u) => u !== String(auth.userId)),
    { type: 'chat.typing', conversationId: conversation.id, user: { id: String(auth.userId), name: rules.nameOf(me) } }
  );
}

/** Messages in this person's conversations whose words (or file names) match. */
async function search(auth, q) {
  const words = String(q || '').trim();
  if (words.length < 2) return { results: [] };
  const rows = await chatRepository.searchMessages(auth.userId, auth.ownerId, words);
  const shaped = await shapeMessages(auth, rows);
  const convIds = [...new Set(rows.map((r) => r.conversation_id))];
  const members = await chatRepository.membersOf(convIds);
  return {
    results: rows.map((r, i) => ({
      message: shaped[i],
      conversation: { id: r.conversation_id, kind: r.conversation_kind, title: rules.titleOf({ kind: r.conversation_kind, name: r.conversation_name }, members.filter((m) => m.conversation_id === r.conversation_id), auth.userId) },
    })),
  };
}

async function unread(auth) {
  return chatRepository.unreadTotals(auth.userId, auth.ownerId);
}

// ---- notification settings ----------------------------------------------------------

const DEFAULT_SETTINGS = { chat: 'all', ebay: 'all', ebayAccounts: [], quietFrom: null, quietTo: null, timeZone: null, hideText: false };

function settingsShape(row) {
  if (!row) return { ...DEFAULT_SETTINGS };
  return { chat: row.chat, ebay: row.ebay, ebayAccounts: row.ebay_accounts || [], quietFrom: row.quiet_from, quietTo: row.quiet_to, timeZone: row.time_zone, hideText: row.hide_text };
}

async function getSettings(auth) {
  return settingsShape(await chatRepository.settingsFor(auth.userId));
}

async function saveSettings(auth, input) {
  const current = await getSettings(auth);
  const next = { ...current, ...input };
  if (next.ebayAccounts?.length) {
    const own = new Set((await connectionRepository.findAllByUser(auth.ownerId)).map((c) => c.id));
    next.ebayAccounts = next.ebayAccounts.filter((id) => own.has(id));
  }
  if ((next.quietFrom === null) !== (next.quietTo === null)) refuse('Quiet hours need a start and an end.', 400);
  return settingsShape(await chatRepository.saveSettings(auth.userId, next));
}

module.exports = {
  people,
  list,
  get,
  openDm,
  createGroup,
  createChannel,
  update,
  remove,
  addPeople,
  removePerson,
  join,
  setNotify,
  messages,
  send,
  edit,
  deleteMessage,
  markRead,
  typing,
  search,
  unread,
  getSettings,
  saveSettings,
  canManageChannels,
  ChatError,
};
