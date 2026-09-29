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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The competitor is optional, as in drafting.
const checkSchema = z.object({ competitorUrl: z.preprocess(blankToUndefined, competitorUrl.optional()), sourceUrl: z.preprocess(blankToUndefined, sourceUrl) });
// Discover's Hunt: the eBay listing added on its own, its supplier added on its page.
// `from`: the tool it was hunted from, Discover (new products by category) or Product research (one product's market).
const huntListingSchema = z.object({ competitorUrl, from: z.enum(['discover', 'research']).default('discover') });
// A supplier link added to a product.
const sourceSchema = z.object({ sourceUrl });
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
  huntListing: handle(async (req, res) => {
    const input = parse(huntListingSchema, req.body, res);
    if (!input) return;
    const out = await huntingService.huntListing(auth(req), req.params.id, input);
    res.status(out.added ? 201 : 200).json(out);
  }),
  addSource: handle(async (req, res) => {
    const input = parse(sourceSchema, req.body, res);
    if (input) res.status(201).json(await huntingService.addSource(auth(req), req.params.huntId, input));
  }),
  makeMainSource: handle(async (req, res) => {
    if (!UUID.test(req.params.sourceId)) return res.status(404).json({ error: 'That supplier link is no longer on this product.' });
    res.json(await huntingService.makeMainSource(auth(req), req.params.huntId, req.params.sourceId));
  }),
  removeSource: handle(async (req, res) => {
    if (!UUID.test(req.params.sourceId)) return res.status(404).json({ error: 'That supplier link is no longer on this product.' });
    res.json(await huntingService.removeSource(auth(req), req.params.huntId, req.params.sourceId));
  }),
  check: handle(async (req, res) => {
    const input = parse(checkSchema, req.body, res);
    if (input) res.json(await huntingService.check(auth(req), req.params.id, input));
  }),
  add: handle(async (req, res) => {
    const input = parse(addSchema, req.body, res);
    if (input) res.status(201).json(await huntingService.add(auth(req), req.params.id, input));
  }),
  list: handle(async (req, res) => {
    const { view, mine, hunter, q, sort, page, profit, demand, added, unique } = req.query;
    // The filters: numbers from a short list, anything else ignored.
    const pick = (value, allowed) => (allowed.includes(Number(value)) ? Number(value) : null);
    res.json(
      await huntingService.list(auth(req), req.params.id, {
        view,
        mine: mine === '1' || mine === 'true',
        hunter,
        q,
        sort,
        page,
        minProfit: pick(profit, [1, 2, 3, 5, 10]),
        minDemand: pick(demand, [5, 10, 30, 100]),
        addedDays: pick(added, [7, 30, 90]),
        unique: unique === '1' || unique === 'true',
      })
    );
  }),
  badge: handle(async (req, res) => {
    res.json(await huntingService.badge(auth(req), req.params.id));
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
  remove: handle(async (req, res) => {
    await huntingService.remove(auth(req), req.params.huntId);
    res.status(204).send();
  }),
  draftStart: handle(async (req, res) => {
    res.json(await huntingService.draftStart(auth(req), req.params.huntId));
  }),
  // Drafts an approved product in the background (its automatic draft failed, or never ran).
  draftAgain: handle(async (req, res) => {
    res.status(202).json(await huntingService.draftAgain(auth(req), req.params.huntId));
  }),
};
