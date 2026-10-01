const inboxService = require('./inbox.service');
const quickRepliesRepository = require('./quick-replies.repository');
const rules = require('./quick-replies');

const { InboxError } = inboxService;

// An account's quick replies: read by anyone with its Inbox (for the reply
// box's "/"), changed only by the owner (Settings → Messages). The first
// read gives the account Liston's starter set, once.

async function requireInbox(auth, connectionId) {
  const accounts = await inboxService.accountsFor(auth);
  if (!accounts.some((a) => a.id === connectionId)) throw new InboxError("You don't have access to this account's messages.", 403);
}

function requireOwner(auth) {
  if (auth.role !== 'owner') throw new InboxError('Only the owner can change quick replies.', 403);
}

async function started(connectionId) {
  if (await quickRepliesRepository.startOnce(connectionId)) await quickRepliesRepository.add(connectionId, rules.STARTERS);
}

const shape = (r) => ({ id: r.id, name: r.name, body: r.body, updatedAt: r.updated_at });

function valid(input) {
  const reply = rules.clean(input);
  if (!reply.name) throw new InboxError('Give the quick reply a name.', 400);
  if (!reply.body) throw new InboxError('Write the message.', 400);
  return reply;
}

/** { replies, tokens, canEdit, limits } for the reply box and Settings. */
async function list(auth, connectionId) {
  await requireInbox(auth, connectionId);
  await started(connectionId);
  return {
    replies: (await quickRepliesRepository.list(connectionId)).map(shape),
    tokens: rules.TOKENS,
    canEdit: auth.role === 'owner',
    limits: { name: rules.MAX_NAME, body: rules.MAX_BODY, count: rules.MAX_PER_ACCOUNT },
  };
}

async function create(auth, connectionId, input) {
  requireOwner(auth);
  await requireInbox(auth, connectionId);
  await started(connectionId);
  const reply = valid(input);
  if ((await quickRepliesRepository.count(connectionId)) >= rules.MAX_PER_ACCOUNT) throw new InboxError(`An account can keep up to ${rules.MAX_PER_ACCOUNT} quick replies.`, 400);
  const [saved] = await quickRepliesRepository.add(connectionId, [reply], auth.userId);
  return shape(saved);
}

async function update(auth, connectionId, id, input) {
  requireOwner(auth);
  await requireInbox(auth, connectionId);
  const saved = await quickRepliesRepository.update(connectionId, id, valid(input));
  if (!saved) throw new InboxError('That quick reply is gone.', 404);
  return shape(saved);
}

async function remove(auth, connectionId, id) {
  requireOwner(auth);
  await requireInbox(auth, connectionId);
  if (!(await quickRepliesRepository.remove(connectionId, id))) throw new InboxError('That quick reply is gone.', 404);
  return { ok: true };
}

module.exports = { list, create, update, remove };
