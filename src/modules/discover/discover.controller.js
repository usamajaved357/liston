const { z } = require('zod');
const discoverService = require('./discover.service');
const focusing = require('./discover-focus');
const teamRepository = require('../team/team.repository');

// Discover's requests (mounted under /api/connections/:id/discover):
// checked here, handed to the service with the account and who's asking.

const subjectSchema = z
  .object({
    categoryId: z.string().regex(/^\d{1,12}$/, 'That category isn’t one eBay knows.').optional(),
    q: z.string().trim().min(2, 'Type at least two letters.').max(80, 'Keep the keyword under 80 characters.').optional(),
  })
  .refine((v) => v.categoryId || v.q, { message: 'Pick a category or type a keyword.' });
const rankSchema = z.object({ categoryId: z.string().regex(/^\d{1,12}$/, 'That category isn’t one eBay knows.') });
const keywordsSchema = z.object({ range: z.enum(['7d', '30d', '90d']).default('30d') });
const flag = z.enum(['1', 'true', '0', 'false', '']).optional().transform((v) => v === '1' || v === 'true');
const amount = z
  .union([z.literal(''), z.coerce.number().min(0).max(100000)])
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : v));
// Loading more with the page's filters: what's worth reading (discover-focus). `fq`: words in the product.
const exploreSchema = subjectSchema.and(
  z.object({
    reads: z.coerce.number().int().min(1).max(discoverService.READS_MAX).optional(),
    fq: z.string().trim().max(80).optional().default(''),
    fit: flag,
    priceMin: amount,
    priceMax: amount,
    brand: z.enum(['any', 'unbranded', 'branded']).optional().default('any'),
    rating: z.enum(['any', 'top', 'good', 'weak']).optional().default('any'),
    size: z.enum(['any', 'small', 'medium', 'large']).optional().default('any'),
    listedWithin: z.coerce.number().int().min(0).max(730).optional().default(0),
  })
);
const winnersSchema = z.object({
  q: z.string().trim().max(80).optional().default(''),
  fit: flag,
  priceMin: amount,
  priceMax: amount,
  brand: z.enum(['any', 'unbranded', 'branded']).optional().default('any'),
  rating: z.enum(['any', 'top', 'good', 'weak']).optional().default('any'),
  size: z.enum(['any', 'small', 'medium', 'large']).optional().default('any'),
  listedWithin: z.coerce.number().int().min(0).max(730).optional().default(0),
  minSales: z.coerce.number().int().min(0).max(100000).optional().default(0),
  newOnly: flag,
  sort: z.enum(['score', 'sales', 'rising', 'new', 'price']).optional().default('score'),
  mine: z.enum(['show', 'hide']).optional().default('show'),
  // VeRO and the owner's eBay history: 'safe' hides a product at risk, 'all' shows it marked.
  safety: z.enum(['safe', 'all']).optional().default('safe'),
  limit: z.coerce.number().int().min(1).max(300).optional().default(60),
});
const siteKeywordsSchema = z.object({
  q: z.string().trim().max(80).optional().default(''),
  sort: z.enum(['sales', 'lift', 'opportunity', 'spread']).optional().default('sales'),
  searchedOnly: flag,
  limit: z.coerce.number().int().min(1).max(400).optional().default(60),
});

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
  // Your own traffic on a keyword is the account's analytics: owners, and members with Analytics.
  const canSeeTraffic = req.role === 'owner' || (await teamRepository.resolvePermission(req.userId, req.params.id, 'analytics'));
  res.status(200).json(await discoverService.explore(req.ownerId, req.params.id, input, { reads: input.reads, canSeeTraffic, focus: focusing.focusOf(input) }));
});

const review = handle(async (req, res) => {
  const input = parse(subjectSchema, req.query, res);
  if (!input) return;
  res.status(200).json(await discoverService.review(req.ownerId, req.params.id, input));
});

const suggest = handle(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
  res.status(200).json(await discoverService.suggest(req.ownerId, req.params.id, q));
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

const winners = handle(async (req, res) => {
  const input = parse(winnersSchema, req.query, res);
  if (!input) return;
  res.status(200).json(await discoverService.winners(req.ownerId, req.params.id, input));
});

// "Find more products for these filters": the Products tab's filters in the body.
const findMore = handle(async (req, res) => {
  const input = parse(winnersSchema, req.body || {}, res);
  if (!input) return;
  res.status(200).json(await discoverService.findMore(req.ownerId, req.params.id, input));
});

const yourKeywords = handle(async (req, res) => {
  const input = parse(keywordsSchema, req.query, res);
  if (!input) return;
  res.status(200).json(await discoverService.yourKeywords(req.ownerId, req.params.id, input));
});

const siteKeywords = handle(async (req, res) => {
  const input = parse(siteKeywordsSchema, req.query, res);
  if (!input) return;
  res.status(200).json(await discoverService.siteKeywords(req.ownerId, req.params.id, input));
});

module.exports = { start, explore, review, suggest, rank, watches, addWatch, removeWatch, winners, findMore, siteKeywords, yourKeywords };
