const { z } = require('zod');
const listingService = require('./listing.service');

// One route, one way to draft: this replaces an earlier hand-typed form
// (title/description/price/category typed in by the user) — that's exactly
// what eBay's own listing tools already do, so it added nothing. Liston's
// value is doing this from two URLs with AI, not re-implementing eBay's form.
const generateDraftSchema = z.object({
  competitorUrl: z
    .string()
    .url('Enter a valid eBay listing URL')
    .refine((u) => /ebay\./.test(u), "That doesn't look like an eBay listing URL"),
  sourceUrl: z
    .string()
    .url('Enter a valid AliExpress listing URL')
    .refine((u) => /aliexpress\./.test(u), "That doesn't look like an AliExpress listing URL"),
});

async function generateDraft(req, res, next) {
  try {
    const parsed = generateDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const listing = await listingService.generateEbayDraftFromUrls(req.params.id, req.ownerId, parsed.data);
    res.status(201).json({ listing });
  } catch (err) {
    next(err);
  }
}

async function listDrafts(req, res, next) {
  try {
    const drafts = await listingService.listPendingDrafts(req.params.id, req.ownerId);
    res.status(200).json({ drafts });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const { listing, policies } = await listingService.getDraftDetail(req.params.listingId, req.ownerId);
    res.status(200).json({ listing, policies });
  } catch (err) {
    next(err);
  }
}

async function publish(req, res, next) {
  try {
    const listing = await listingService.publish(req.params.listingId, req.ownerId);
    res.status(200).json({ listing });
  } catch (err) {
    next(err);
  }
}

module.exports = { generateDraft, listDrafts, getOne, publish };
