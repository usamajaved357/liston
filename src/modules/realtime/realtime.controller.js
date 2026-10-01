const { z } = require('zod');
const userEvents = require('./user-events');

// The signed-in person's live channel: a server-sent event stream, and what
// their tab is looking at.

const HEARTBEAT_MS = 25 * 1000;
const presenceSchema = z.object({
  tabId: z.string().min(4).max(64),
  view: z.string().max(200).nullable().optional(),
  focused: z.boolean().optional(),
});

function events(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: ready\ndata: {}\n\n`);
  const unsubscribe = userEvents.subscribe(req.userId, (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`));
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function presence(req, res) {
  const parsed = presenceSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
  userEvents.setView(req.userId, parsed.data.tabId, { view: parsed.data.view || null, focused: parsed.data.focused });
  res.status(204).end();
}

module.exports = { events, presence };
