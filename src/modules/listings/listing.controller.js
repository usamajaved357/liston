const { z } = require('zod');
const listingService = require('./listing.service');

// One route, one way to draft: this replaces an earlier hand-typed form
// (title/description/price/category typed in by the user) — that's exactly
// what eBay's own listing tools already do, so it added nothing. Liston's
// value is doing this from two URLs with AI, not re-implementing eBay's form.
const urlsSchema = z.object({
  competitorUrl: z
    .string()
    .url('Enter a valid eBay listing URL')
    .refine((u) => /ebay\./.test(u), "That doesn't look like an eBay listing URL"),
  sourceUrl: z
    .string()
    .url('Enter a valid AliExpress listing URL')
    .refine((u) => /aliexpress\./.test(u), "That doesn't look like an AliExpress listing URL"),
});

// Two ways in: URLs directly (single-call path), or a preview id from step
// one plus the variations the seller ticked.
const generateDraftSchema = z.union([
  urlsSchema,
  z.object({
    previewId: z.string().min(1),
    // { axisName: [value, ...] } — only combinations whose value on every
    // listed axis was chosen are drafted.
    variantSelection: z.record(z.array(z.string().min(1))).optional(),
  }),
]);

async function previewDraft(req, res, next) {
  try {
    const parsed = urlsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const preview = await listingService.previewDraftSources(req.params.id, req.ownerId, parsed.data);
    res.status(200).json(preview);
  } catch (err) {
    next(err);
  }
}

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

// Opens a live eBay listing in the editor. Returns the working copy's id.
async function startLiveEdit(req, res, next) {
  try {
    if (!/^\d{9,15}$/.test(String(req.params.itemId))) {
      return res.status(400).json({ error: 'That does not look like an eBay item number.' });
    }
    const listing = await listingService.startLiveEdit(req.params.id, req.ownerId, String(req.params.itemId));
    res.status(200).json({ listing });
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

// The branded HTML a draft will publish with — for the editor's preview.
async function descriptionPreview(req, res, next) {
  try {
    const html = await listingService.previewDescription(req.params.listingId, req.ownerId);
    res.status(200).json({ html });
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

const offerPriceSchema = z.object({ value: z.string().min(1), currency: z.string().min(1) });

// Every field is optional: a patch carries only what the editor changed.
// Deliberately NOT accepting a whole replacement variants array — edits may
// remove variations or change their price, never invent new ones, so
// additions are expressed as removals of what exists instead.
const updateDraftSchema = z
  .object({
    title: z.string().min(1).max(80, 'eBay titles are limited to 80 characters').optional(),
    commonTitle: z.string().min(1).max(80, 'eBay titles are limited to 80 characters').optional(),
    description: z.string().optional(),
    commonDescription: z.string().optional(),
    condition: z.enum(['NEW', 'USED_EXCELLENT', 'USED_GOOD', 'USED_ACCEPTABLE']).optional(),
    aspects: z.record(z.array(z.string())).optional(),
    // Order matters: position 0 is the search thumbnail.
    imageUrls: z.array(z.string().url()).optional(),
    price: offerPriceSchema.optional(),
    quantity: z.number().int().min(0).optional(),
    // Policies can differ per listing (a fragile item ships differently);
    // the IDs must be ones this account actually has — checked in the service.
    listingPolicies: z
      .object({
        fulfillmentPolicyId: z.string().min(1),
        paymentPolicyId: z.string().min(1),
        returnPolicyId: z.string().min(1),
      })
      .optional(),
    // Keyed by the variant's index in the current draft — a local draft has
    // no SKUs yet to key on.
    variants: z
      .record(
        z.object({
          price: offerPriceSchema.optional(),
          quantity: z.number().int().min(0).optional(),
          imageUrls: z.array(z.string().url()).optional(),
        })
      )
      .optional(),
    removeAxisValues: z.array(z.object({ axis: z.string().min(1), value: z.string().min(1) })).optional(),
    variantSkusToRemove: z.array(z.string()).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to update');

async function update(req, res, next) {
  try {
    const parsed = updateDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { listing, imageCheck } = await listingService.updateDraft(req.params.listingId, req.ownerId, parsed.data);
    res.status(200).json({ listing, imageCheck });
  } catch (err) {
    next(err);
  }
}

const reviseTextSchema = z.object({ instruction: z.string().min(3, 'Tell me what to change').max(500) });
const reviseImageSchema = z.object({
  imageUrl: z.string().url(),
  instruction: z.string().min(3, 'Tell me what to change').max(500),
});
const acceptImageSchema = z.object({ proposalId: z.string().min(1), replaces: z.string().url() });

// Revisions PROPOSE; they never write. The seller accepts a text change by
// sending it back through PATCH, and an image change through /images/accept.
async function reviseText(req, res, next) {
  try {
    const parsed = reviseTextSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

    const proposal = await listingService.proposeTextRevision(req.params.listingId, req.ownerId, parsed.data.instruction);
    res.status(200).json(proposal);
  } catch (err) {
    next(err);
  }
}

async function reviseImage(req, res, next) {
  try {
    const parsed = reviseImageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

    const proposal = await listingService.proposeImageRevision(req.params.listingId, req.ownerId, parsed.data);
    res.status(200).json(proposal);
  } catch (err) {
    next(err);
  }
}

async function acceptImage(req, res, next) {
  try {
    const parsed = acceptImageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

    const result = await listingService.acceptImageRevision(req.params.listingId, req.ownerId, parsed.data);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

const uploadImageSchema = z.object({
  // A data: URL. JSON rather than multipart so no extra parser is needed;
  // the route carries its own larger body limit.
  dataUrl: z.string().min(30).max(20 * 1024 * 1024),
  replaces: z.string().url().optional(),
  variantIndex: z.number().int().min(0).optional(),
});

async function uploadImage(req, res, next) {
  try {
    const parsed = uploadImageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    const result = await listingService.uploadDraftImage(req.params.listingId, req.ownerId, parsed.data);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function downloadImage(req, res, next) {
  try {
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    const index = Math.max(1, parseInt(req.query.n, 10) || 1);
    const { buffer, contentType, extension } = await listingService.fetchDraftImage(req.params.listingId, req.ownerId, url);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="listing-${req.params.listingId.slice(0, 8)}-image-${index}.${extension}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await listingService.removeDraft(req.params.listingId, req.ownerId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { generateDraft, previewDraft, listDrafts, startLiveEdit, getOne, descriptionPreview, update, remove, reviseText, reviseImage, acceptImage, uploadImage, downloadImage, publish };
