const { z } = require('zod');
const researchService = require('./research.service');

const searchSchema = z.object({
  q: z.string().trim().min(2, 'Type what you want to research.').max(200),
  condition: z.enum(['any', 'new', 'used']).default('any'),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
});

async function search(req, res, next) {
  try {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    res.status(200).json(await researchService.search(req.ownerId, req.params.id, parsed.data));
  } catch (err) {
    next(err);
  }
}

async function advice(req, res, next) {
  try {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    res.status(200).json(await researchService.advice(req.ownerId, req.params.id, parsed.data));
  } catch (err) {
    next(err);
  }
}

const soldSchema = z.object({
  items: z
    .array(z.object({ itemId: z.string().min(1), legacyItemId: z.string().nullable().optional(), hasVariations: z.boolean().optional(), createdAt: z.string().nullable().optional() }))
    .min(1)
    .max(researchService.SOLD_READS),
});

async function soldCounts(req, res, next) {
  try {
    const parsed = soldSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Pick the listings to read sold counts for.' });
    res.status(200).json(await researchService.soldCounts(req.ownerId, req.params.id, parsed.data.items));
  } catch (err) {
    next(err);
  }
}

async function budget(req, res, next) {
  try {
    res.status(200).json(await researchService.budget());
  } catch (err) {
    next(err);
  }
}

module.exports = { search, advice, soldCounts, budget };
