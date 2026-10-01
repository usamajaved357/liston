const { z } = require('zod');
const referencesService = require('./references.service');

// Liston cards: resolving references, finding them in text, and the "/" picker.

const kind = z.enum(['order', 'listing', 'draft', 'hunt']);
const resolveSchema = z.object({
  refs: z.array(z.object({ kind, id: z.string().min(1).max(64), connectionId: z.string().uuid().optional() })).max(20),
});
const detectSchema = z.object({ text: z.string().max(8000) });
const searchSchema = z.object({ q: z.string().max(120), kinds: z.string().max(60).optional() });

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
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  resolve: handle(async (req, res) => {
    const input = parse(resolveSchema, req.body, res);
    if (input) res.json({ cards: await referencesService.resolve(auth(req), input.refs) });
  }),
  detect: handle(async (req, res) => {
    const input = parse(detectSchema, req.body, res);
    if (input) res.json({ cards: await referencesService.fromText(auth(req), input.text) });
  }),
  search: handle(async (req, res) => {
    const input = parse(searchSchema, req.query, res);
    if (!input) return;
    const kinds = input.kinds ? input.kinds.split(',').filter((k) => referencesService.KINDS.includes(k)) : undefined;
    res.json({ cards: await referencesService.search(auth(req), input.q, kinds ? { kinds } : {}) });
  }),
};
