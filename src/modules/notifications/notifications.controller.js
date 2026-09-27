const { z } = require('zod');
const notificationsService = require('./notifications.service');

// The bell's requests and turning browser push on or off for this browser.

const readSchema = z.object({ ids: z.array(z.string().uuid()).max(200).optional() });
const subscribeSchema = z.object({
  endpoint: z.string().url('That browser gave no push address.').max(2000),
  keys: z.object({ p256dh: z.string().min(10).max(500), auth: z.string().min(8).max(200) }),
});
const unsubscribeSchema = z.object({ endpoint: z.string().url().max(2000) });

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
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  list: handle(async (req, res) => {
    res.json(await notificationsService.list(req.userId));
  }),
  read: handle(async (req, res) => {
    const input = parse(readSchema, req.body, res);
    if (input) res.json(await notificationsService.markRead(req.userId, input.ids));
  }),
  test: handle(async (req, res) => {
    res.json(await notificationsService.sendTest(req.userId));
  }),
  subscribe: handle(async (req, res) => {
    const input = parse(subscribeSchema, req.body, res);
    if (!input) return;
    await notificationsService.subscribe(req.userId, { ...input, userAgent: String(req.get('user-agent') || '').slice(0, 300) || null });
    res.status(204).end();
  }),
  unsubscribe: handle(async (req, res) => {
    const input = parse(unsubscribeSchema, req.body, res);
    if (!input) return;
    await notificationsService.unsubscribe(req.userId, input.endpoint);
    res.status(204).end();
  }),
};
