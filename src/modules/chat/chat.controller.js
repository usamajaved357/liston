const { z } = require('zod');
const chatService = require('./chat.service');
const rules = require('./chat-rules');

// Team chat's requests: Zod checks, then one service call.

const uuid = z.string().uuid();
const ref = z.object({ kind: z.enum(['order', 'listing', 'draft', 'hunt', 'conversation']), id: z.string().min(1).max(64), connectionId: uuid.optional() });
const schemas = {
  dm: z.object({ userId: uuid }),
  group: z.object({ userIds: z.array(uuid).min(1).max(20), name: z.string().max(80).nullable().optional() }),
  channel: z.object({
    name: z.string().min(1, 'Name the channel.').max(80),
    topic: z.string().max(250).nullable().optional(),
    private: z.boolean().optional(),
    connectionId: uuid.nullable().optional(),
    userIds: z.array(uuid).max(200).optional(),
  }),
  update: z.object({
    name: z.string().max(80).nullable().optional(),
    topic: z.string().max(250).nullable().optional(),
    private: z.boolean().optional(),
    connectionId: uuid.nullable().optional(),
    archived: z.boolean().optional(),
  }),
  people: z.object({ userIds: z.array(uuid).min(1).max(200) }),
  notify: z.object({ notify: z.enum(['all', 'mentions', 'none']) }),
  send: z.object({
    body: z.string().max(rules.MAX_BODY + 100).optional(),
    mentions: z.array(uuid).max(50).optional(),
    fileIds: z.array(uuid).max(10).optional(),
    refs: z.array(ref).max(10).optional(),
    replyToId: uuid.nullable().optional(),
    // A reply in a thread (its first message), and whether the conversation shows it too.
    threadId: uuid.nullable().optional(),
    alsoInConversation: z.boolean().optional(),
    // A voice note: one of the files, its length and the shape of its sound.
    voice: z
      .object({ fileId: uuid, durationMs: z.number().positive().max(rules.VOICE_MAX_MS + 5000), peaks: z.array(z.number()).max(rules.VOICE_BARS) })
      .nullable()
      .optional(),
  }),
  typing: z.object({ threadId: uuid.nullable().optional() }),
  follow: z.object({ following: z.boolean() }),
  edit: z.object({ body: z.string().max(rules.MAX_BODY + 100), mentions: z.array(uuid).max(50).optional() }),
  read: z.object({ messageId: uuid.nullable().optional() }),
  page: z.object({ before: uuid.optional(), after: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).optional() }),
  search: z.object({ q: z.string().max(120) }),
  settings: z.object({
    chat: z.enum(['all', 'mentions', 'none']).optional(),
    ebay: z.enum(['all', 'chosen', 'none']).optional(),
    ebayAccounts: z.array(uuid).max(100).optional(),
    quietFrom: z.number().int().min(0).max(1439).nullable().optional(),
    quietTo: z.number().int().min(0).max(1439).nullable().optional(),
    timeZone: z.string().max(64).nullable().optional(),
    hideText: z.boolean().optional(),
  }),
};

const auth = (req) => ({ userId: req.userId, ownerId: req.ownerId, role: req.role });

function parse(schema, body, res) {
  const parsed = schema.safeParse(body || {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0].message });
    return null;
  }
  return parsed.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const handle = (fn) => async (req, res, next) => {
  try {
    for (const key of ['id', 'userId', 'rootId']) {
      if (req.params[key] !== undefined && !UUID.test(req.params[key])) return res.status(404).json({ error: 'Not found.' });
    }
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  people: handle(async (req, res) => res.json({ people: await chatService.people(auth(req)) })),
  list: handle(async (req, res) => res.json(await chatService.list(auth(req)))),
  unread: handle(async (req, res) => res.json(await chatService.unread(auth(req)))),
  search: handle(async (req, res) => {
    const input = parse(schemas.search, req.query, res);
    if (input) res.json(await chatService.search(auth(req), input.q));
  }),
  openDm: handle(async (req, res) => {
    const input = parse(schemas.dm, req.body, res);
    if (input) res.json(await chatService.openDm(auth(req), input.userId));
  }),
  createGroup: handle(async (req, res) => {
    const input = parse(schemas.group, req.body, res);
    if (input) res.status(201).json(await chatService.createGroup(auth(req), input));
  }),
  createChannel: handle(async (req, res) => {
    const input = parse(schemas.channel, req.body, res);
    if (input) res.status(201).json(await chatService.createChannel(auth(req), { ...input, isPrivate: input.private }));
  }),
  get: handle(async (req, res) => res.json(await chatService.get(auth(req), req.params.id))),
  update: handle(async (req, res) => {
    const input = parse(schemas.update, req.body, res);
    if (input) res.json(await chatService.update(auth(req), req.params.id, { ...input, isPrivate: input.private }));
  }),
  remove: handle(async (req, res) => {
    await chatService.remove(auth(req), req.params.id);
    res.status(204).end();
  }),
  addPeople: handle(async (req, res) => {
    const input = parse(schemas.people, req.body, res);
    if (input) res.json(await chatService.addPeople(auth(req), req.params.id, input.userIds));
  }),
  removePerson: handle(async (req, res) => {
    await chatService.removePerson(auth(req), req.params.id, req.params.userId);
    res.status(204).end();
  }),
  join: handle(async (req, res) => res.json(await chatService.join(auth(req), req.params.id))),
  setNotify: handle(async (req, res) => {
    const input = parse(schemas.notify, req.body, res);
    if (input) res.json(await chatService.setNotify(auth(req), req.params.id, input.notify));
  }),
  messages: handle(async (req, res) => {
    const input = parse(schemas.page, req.query, res);
    if (input) res.json(await chatService.messages(auth(req), req.params.id, input));
  }),
  send: handle(async (req, res) => {
    const input = parse(schemas.send, req.body, res);
    if (input) res.status(201).json(await chatService.send(auth(req), req.params.id, input));
  }),
  read: handle(async (req, res) => {
    const input = parse(schemas.read, req.body, res);
    if (input) res.json(await chatService.markRead(auth(req), req.params.id, input));
  }),
  typing: handle(async (req, res) => {
    const input = parse(schemas.typing, req.body, res);
    if (!input) return;
    await chatService.typing(auth(req), req.params.id, input);
    res.status(204).end();
  }),
  threads: handle(async (req, res) => res.json(await chatService.threads(auth(req)))),
  conversationThreads: handle(async (req, res) => res.json(await chatService.conversationThreads(auth(req), req.params.id))),
  conversationFiles: handle(async (req, res) => res.json(await chatService.conversationFiles(auth(req), req.params.id))),
  thread: handle(async (req, res) => res.json(await chatService.thread(auth(req), req.params.rootId))),
  threadRead: handle(async (req, res) => {
    const input = parse(schemas.read, req.body, res);
    if (input) res.json(await chatService.threadRead(auth(req), req.params.rootId, input));
  }),
  follow: handle(async (req, res) => {
    const input = parse(schemas.follow, req.body, res);
    if (input) res.json(await chatService.follow(auth(req), req.params.rootId, input.following));
  }),
  edit: handle(async (req, res) => {
    const input = parse(schemas.edit, req.body, res);
    if (input) res.json(await chatService.edit(auth(req), req.params.id, input));
  }),
  deleteMessage: handle(async (req, res) => {
    await chatService.deleteMessage(auth(req), req.params.id);
    res.status(204).end();
  }),
  getSettings: handle(async (req, res) => res.json(await chatService.getSettings(auth(req)))),
  saveSettings: handle(async (req, res) => {
    const input = parse(schemas.settings, req.body, res);
    if (input) res.json(await chatService.saveSettings(auth(req), input));
  }),
};
