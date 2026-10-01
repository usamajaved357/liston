const { z } = require('zod');
const inboxService = require('./inbox.service');
const quickRepliesService = require('./quick-replies.service');

// The eBay Inbox's requests: an account's (or every account's) folders, one
// conversation, read or unread, archive, reading eBay again now; the
// team's working (assign, Open / Waiting / Done, notes) and "Message buyer".

const listSchema = z.object({
  folder: z.enum(['buyers', 'ebay', 'archived', 'all']).optional(),
  show: z.enum(['all', 'unread', 'waiting', 'mine']).optional(),
  q: z.string().max(120).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  refresh: z.enum(['1', 'true']).optional(),
});
const readSchema = z.object({ read: z.boolean() });
const statusSchema = z.object({ status: z.enum(['ACTIVE', 'ARCHIVE']) });
const replySchema = z.object({ text: z.string().max(2100), fileIds: z.array(z.string().uuid()).max(5).optional(), confirm: z.boolean().optional() });
const quickReplySchema = z.object({ name: z.string().max(200), body: z.string().max(4000) });
const assignSchema = z.object({ userId: z.string().uuid().nullable() });
const workSchema = z.object({ status: z.enum(['open', 'waiting', 'done']) });
const noteSchema = z.object({ body: z.string().max(2100) });
const messageBuyerSchema = z.object({ orderId: z.string().regex(/^[\w-]{3,40}$/, 'That order number isn’t one eBay uses.'), text: z.string().max(2100), confirm: z.boolean().optional() });

const auth = (req) => ({ userId: req.userId, ownerId: req.ownerId, role: req.role });

function parse(schema, body, res) {
  const parsed = schema.safeParse(body || {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0].message });
    return null;
  }
  return parsed.data;
}

const handle = (fn) => async (req, res, next) => {
  try {
    if (req.params.conversationId !== undefined && !/^[\w.:-]{1,120}$/.test(req.params.conversationId)) return res.status(404).json({ error: 'Conversation not found.' });
    if (req.params.replyId !== undefined && !/^[0-9a-f-]{36}$/i.test(req.params.replyId)) return res.status(404).json({ error: 'That quick reply is gone.' });
    if (req.params.noteId !== undefined && !/^\d{1,18}$/.test(req.params.noteId)) return res.status(404).json({ error: 'Note not found.' });
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

const listFor = (connectionId) =>
  handle(async (req, res) => {
    const input = parse(listSchema, req.query, res);
    if (!input) return;
    res.json(await inboxService.list(auth(req), { ...input, refresh: Boolean(input.refresh), connectionId: connectionId(req) }));
  });

module.exports = {
  list: listFor((req) => req.params.id),
  listAll: listFor(() => null),
  thread: handle(async (req, res) => res.json(await inboxService.thread(auth(req), req.params.id, req.params.conversationId))),
  setRead: handle(async (req, res) => {
    const input = parse(readSchema, req.body, res);
    if (input) res.json(await inboxService.setRead(auth(req), req.params.id, req.params.conversationId, input.read));
  }),
  setStatus: handle(async (req, res) => {
    const input = parse(statusSchema, req.body, res);
    if (input) res.json(await inboxService.setStatus(auth(req), req.params.id, req.params.conversationId, input.status));
  }),
  refresh: handle(async (req, res) => res.json(await inboxService.refresh(auth(req), req.params.id))),
  unread: handle(async (req, res) => res.json(await inboxService.unread(auth(req), req.params.id))),
  quickReplies: handle(async (req, res) => res.json(await quickRepliesService.list(auth(req), req.params.id))),
  addQuickReply: handle(async (req, res) => {
    const input = parse(quickReplySchema, req.body, res);
    if (input) res.status(201).json(await quickRepliesService.create(auth(req), req.params.id, input));
  }),
  saveQuickReply: handle(async (req, res) => {
    const input = parse(quickReplySchema, req.body, res);
    if (input) res.json(await quickRepliesService.update(auth(req), req.params.id, req.params.replyId, input));
  }),
  deleteQuickReply: handle(async (req, res) => res.json(await quickRepliesService.remove(auth(req), req.params.id, req.params.replyId))),
  assign: handle(async (req, res) => {
    const input = parse(assignSchema, req.body, res);
    if (input) res.json(await inboxService.assign(auth(req), req.params.id, req.params.conversationId, input.userId));
  }),
  setWork: handle(async (req, res) => {
    const input = parse(workSchema, req.body, res);
    if (input) res.json(await inboxService.setWork(auth(req), req.params.id, req.params.conversationId, input.status));
  }),
  addNote: handle(async (req, res) => {
    const input = parse(noteSchema, req.body, res);
    if (input) res.status(201).json(await inboxService.addNote(auth(req), req.params.id, req.params.conversationId, input.body));
  }),
  deleteNote: handle(async (req, res) => res.json(await inboxService.deleteNote(auth(req), req.params.id, req.params.conversationId, req.params.noteId))),
  messageBuyer: handle(async (req, res) => {
    const input = parse(messageBuyerSchema, req.body, res);
    if (!input) return;
    const out = await inboxService.messageBuyer(auth(req), req.params.id, input);
    res.status(out.sent ? 201 : 200).json(out);
  }),
  reply: handle(async (req, res) => {
    const input = parse(replySchema, req.body, res);
    if (!input) return;
    const out = await inboxService.reply(auth(req), req.params.id, req.params.conversationId, input);
    res.status(out.sent ? 201 : 200).json(out);
  }),
};
