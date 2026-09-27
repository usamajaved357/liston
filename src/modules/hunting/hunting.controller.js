const { z } = require('zod');
const huntingService = require('./hunting.service');

// Product hunting's requests: checked here, handed to the service with who
// is asking (the service decides what they may do: hunt, review, draft).

const auth = (req) => ({ userId: req.userId, ownerId: req.ownerId, role: req.role });

const blankToUndefined = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v);
const competitorUrl = z
  .string({ required_error: "Paste the competitor's eBay listing link." })
  .url("That isn't a link. Paste the competitor's eBay listing link.")
  .refine((u) => /ebay\./i.test(u) && /\/itm\/(?:[^/?#]+\/)?\d{6,}/.test(u), "That doesn't look like an eBay listing link (it should have /itm/ and the item number).");
const sourceUrl = z
  .string({ required_error: "Paste the supplier's AliExpress product link." })
  .url("That isn't a link. Paste the supplier's AliExpress product link.")
  .refine((u) => /aliexpress\./i.test(u) && /\/item\/(?:[^/?#]*?)\d{6,}/.test(u), "That doesn't look like an AliExpress product link (it should have /item/ and the product number).");
const note = z.string().max(1000, 'Keep the note under 1,000 characters.');

// The competitor is optional, as in drafting.
const checkSchema = z.object({ competitorUrl: z.preprocess(blankToUndefined, competitorUrl.optional()), sourceUrl: z.preprocess(blankToUndefined, sourceUrl) });
const addSchema = z.object({ checkId: z.string().uuid('Check the product first.'), note: note.optional() });
// A blank or null competitor takes it away; leaving it out keeps it.
const blankToNull = (v) => (v === null || (typeof v === 'string' && v.trim() === '') ? null : typeof v === 'string' ? v.trim() : v);
const updateSchema = z.object({
  competitorUrl: z.preprocess(blankToNull, competitorUrl.nullable().optional()),
  sourceUrl: z.preprocess(blankToUndefined, sourceUrl.optional()),
  note: note.optional(),
});
const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'send_back'], { errorMap: () => ({ message: 'Approve, reject or send it back.' }) }),
  reason: z.string().max(40).optional(),
  note: note.optional(),
});
const resubmitSchema = z.object({ note: note.optional() });

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
  check: handle(async (req, res) => {
    const input = parse(checkSchema, req.body, res);
    if (input) res.json(await huntingService.check(auth(req), req.params.id, input));
  }),
  add: handle(async (req, res) => {
    const input = parse(addSchema, req.body, res);
    if (input) res.status(201).json(await huntingService.add(auth(req), req.params.id, input));
  }),
  list: handle(async (req, res) => {
    const { view, mine, hunter, q, sort, page } = req.query;
    res.json(await huntingService.list(auth(req), req.params.id, { view, mine: mine === '1' || mine === 'true', hunter, q, sort, page }));
  }),
  badge: handle(async (req, res) => {
    res.json(await huntingService.badge(auth(req), req.params.id));
  }),
  team: handle(async (req, res) => {
    const { range, from, to } = req.query;
    res.json(await huntingService.team(auth(req), req.params.id, { range, from, to }));
  }),
  detail: handle(async (req, res) => {
    res.json(await huntingService.detail(auth(req), req.params.huntId));
  }),
  recheck: handle(async (req, res) => {
    res.json(await huntingService.recheck(auth(req), req.params.huntId));
  }),
  update: handle(async (req, res) => {
    const input = parse(updateSchema, req.body, res);
    if (input) res.json(await huntingService.update(auth(req), req.params.huntId, input));
  }),
  resubmit: handle(async (req, res) => {
    const input = parse(resubmitSchema, req.body, res);
    if (input) res.json(await huntingService.resubmit(auth(req), req.params.huntId, input));
  }),
  decide: handle(async (req, res) => {
    const input = parse(decisionSchema, req.body, res);
    if (input) res.json(await huntingService.decide(auth(req), req.params.huntId, input));
  }),
  withdraw: handle(async (req, res) => {
    await huntingService.withdraw(auth(req), req.params.huntId);
    res.status(204).send();
  }),
  draftStart: handle(async (req, res) => {
    res.json(await huntingService.draftStart(auth(req), req.params.huntId));
  }),
};
