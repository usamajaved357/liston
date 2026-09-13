const { z } = require('zod');
const listingService = require('./listing.service');

// One route, one way to draft: this replaces an earlier hand-typed form
// (title/description/price/category typed in by the user) — that's exactly
// what eBay's own listing tools already do, so it added nothing. Liston's
// value is doing this from two URLs with AI, not re-implementing eBay's form.
//
// competitorRaw/sourceRaw are optional: when the Liston browser extension is
// installed, the frontend pre-fetches the raw page fields through the user's
// own browser (see dom-extractors/) and attaches them here so the backend
// skips server-side scraping for that side entirely — see Part 4 of the
// session plan. Validated loosely (just enough to reject obvious garbage);
// the real shaping/validation happens in each scraper's `normalize()`.
const rawEbayFieldsSchema = z.object({
  title: z.string().nullable(),
  priceText: z.string().nullable().optional(),
  imageUrls: z.array(z.string()).optional(),
  specifics: z.record(z.string()).optional(),
  categoryBreadcrumb: z.array(z.string()).optional(),
  categoryId: z.string().nullable().optional(),
});

const rawAliexpressFieldsSchema = z.object({
  title: z.string().nullable(),
  priceText: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  imageUrls: z.array(z.string()).optional(),
  specifics: z.record(z.string()).optional(),
  variantGroups: z
    .array(
      z.object({
        name: z.string().nullable(),
        options: z.array(z.object({ label: z.string(), imageUrl: z.string().nullable() })),
      })
    )
    .optional(),
});

const generateDraftSchema = z.object({
  competitorUrl: z
    .string()
    .url('Enter a valid eBay listing URL')
    .refine((u) => /ebay\./.test(u), "That doesn't look like an eBay listing URL"),
  sourceUrl: z
    .string()
    .url('Enter a valid AliExpress listing URL')
    .refine((u) => /aliexpress\./.test(u), "That doesn't look like an AliExpress listing URL"),
  competitorRaw: rawEbayFieldsSchema.optional(),
  sourceRaw: rawAliexpressFieldsSchema.optional(),
  costPrice: z.coerce.number().positive('Cost price must be greater than 0'),
  sellPrice: z.coerce.number().positive('Sell price must be greater than 0'),
  currency: z.string().min(1).default('GBP'),
});

async function generateDraft(req, res, next) {
  try {
    const parsed = generateDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const listing = await listingService.generateEbayDraftFromUrls(req.params.id, req.userId, parsed.data);
    res.status(201).json({ listing });
  } catch (err) {
    next(err);
  }
}

async function listDrafts(req, res, next) {
  try {
    const drafts = await listingService.listPendingDrafts(req.params.id, req.userId);
    res.status(200).json({ drafts });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const { listing, policies } = await listingService.getDraftDetail(req.params.listingId, req.userId);
    res.status(200).json({ listing, policies });
  } catch (err) {
    next(err);
  }
}

async function publish(req, res, next) {
  try {
    const listing = await listingService.publish(req.params.listingId, req.userId);
    res.status(200).json({ listing });
  } catch (err) {
    next(err);
  }
}

module.exports = { generateDraft, listDrafts, getOne, publish };
