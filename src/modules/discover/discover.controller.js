const { z } = require('zod');
const discoverService = require('./discover.service');

// Discover's requests (mounted under /api/connections/:id/discover):
// checked here, handed to the service with the account and who's asking.

const subjectSchema = z
  .object({
    categoryId: z.string().regex(/^\d{1,12}$/, 'That category isn’t one eBay knows.').optional(),
    q: z.string().trim().min(2, 'Type at least two letters.').max(80, 'Keep the keyword under 80 characters.').optional(),
  })
  .refine((v) => v.categoryId || v.q, { message: 'Pick a category or type a keyword.' });
const exploreSchema = subjectSchema.and(z.object({ reads: z.coerce.number().int().min(1).max(discoverService.READS_MAX).optional() }));
const rankSchema = z.object({ categoryId: z.string().regex(/^\d{1,12}$/, 'That category isn’t one eBay knows.') });
const keywordsSchema = z.object({ range: z.enum(['7d', '30d', '90d']).default('30d') });

function parse(schema, input, res) {
  const parsed = schema.safeParse(input || {});
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

const start = handle(async (req, res) => {
  res.status(200).json(await discoverService.start(req.ownerId, req.params.id));
});

const explore = handle(async (req, res) => {
  const input = parse(exploreSchema, req.query, res);
  if (!input) return;
  res.status(200).json(await discoverService.explore(req.ownerId, req.params.id, input, { reads: input.reads }));
});

const rank = handle(async (req, res) => {
  const input = parse(rankSchema, req.body, res);
  if (!input) return;
  // Answers at once; the ranking runs on and explore shows its progress.
  res.status(202).json(await discoverService.rankChildren(req.ownerId, req.params.id, input.categoryId));
});

const watches = handle(async (req, res) => {
  res.status(200).json(await discoverService.watches(req.ownerId, req.params.id));
});

const addWatch = handle(async (req, res) => {
  const input = parse(subjectSchema, req.body, res);
  if (!input) return;
  res.status(201).json(await discoverService.addWatch(req.ownerId, req.params.id, req.userId, input));
});

const removeWatch = handle(async (req, res) => {
  await discoverService.removeWatch(req.params.id, req.params.watchId);
  res.status(204).end();
});

const yourKeywords = handle(async (req, res) => {
  const input = parse(keywordsSchema, req.query, res);
  if (!input) return;
  res.status(200).json(await discoverService.yourKeywords(req.ownerId, req.params.id, input));
});

module.exports = { start, explore, rank, watches, addWatch, removeWatch, yourKeywords };
