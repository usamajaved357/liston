const { z } = require('zod');
const inboxService = require('./inbox.service');

// The eBay Inbox's requests: an account's (or every account's) folders, one
// conversation, read or unread, archive, and reading eBay again now.

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
  reply: handle(async (req, res) => {
    const input = parse(replySchema, req.body, res);
    if (!input) return;
    const out = await inboxService.reply(auth(req), req.params.id, req.params.conversationId, input);
    res.status(out.sent ? 201 : 200).json(out);
  }),
};
