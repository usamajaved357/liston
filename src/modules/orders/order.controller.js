const { z } = require('zod');
const orderService = require('./order.service');

const moneySchema = z.object({ value: z.union([z.number(), z.string()]), currency: z.string().min(3).max(3) }).nullable();

const sourcingSchema = z.object({
  status: z.enum(['to_order', 'ordered', 'shipped', 'delivered', 'problem']).optional(),
  sourcePlatform: z.string().max(40).optional(),
  sourceAccountId: z.string().uuid().nullable().optional(),
  sourceOrderNo: z.string().max(80).optional(),
  placedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  placedBy: z.string().uuid().nullable().optional(),
  cardLabel: z.string().max(80).optional(),
  cost: moneySchema.optional(),
  trackingNumber: z.string().max(80).optional(),
  carrier: z.string().max(60).optional(),
  notes: z.string().max(4000).optional(),
  quantity: z.number().int().positive().optional(),
  dispatchOnEbay: z.boolean().optional(),
});

async function getOrder(req, res, next) {
  try {
    res.status(200).json(await orderService.getOrder(req.params.id, req.ownerId, req.params.orderId));
  } catch (err) {
    next(err);
  }
}

async function saveSourcing(req, res, next) {
  try {
    const parsed = sourcingSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid sourcing details' });
    const result = await orderService.saveSourcing(req.params.id, req.ownerId, req.userId, req.params.orderId, req.params.lineKey, parsed.data);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function addNote(req, res, next) {
  try {
    const event = await orderService.addNote(req.params.id, req.userId, req.params.orderId, req.body?.text);
    res.status(201).json({ event });
  } catch (err) {
    next(err);
  }
}

const accountSchema = z.object({
  platform: z.string().max(40).optional(),
  label: z.string().trim().min(1, 'Give the account a name').max(80),
  email: z.string().trim().min(1, 'Email is required').max(200),
  password: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

async function listSourceAccounts(req, res, next) {
  try {
    res.status(200).json({ accounts: await orderService.listSourceAccounts(req.ownerId, { includeArchived: req.query.archived === '1' }) });
  } catch (err) {
    next(err);
  }
}

async function createSourceAccount(req, res, next) {
  try {
    const parsed = accountSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid account' });
    res.status(201).json({ account: await orderService.createSourceAccount(req.ownerId, parsed.data) });
  } catch (err) {
    next(err);
  }
}

async function updateSourceAccount(req, res, next) {
  try {
    const parsed = accountSchema.partial().extend({ archived: z.boolean().optional() }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid account' });
    res.status(200).json({ account: await orderService.updateSourceAccount(req.ownerId, req.params.accountId, parsed.data) });
  } catch (err) {
    next(err);
  }
}

module.exports = { getOrder, saveSourcing, addNote, listSourceAccounts, createSourceAccount, updateSourceAccount };
