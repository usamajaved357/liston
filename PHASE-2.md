# Liston — Phase 2: Architecture & Features (Multi-Platform Expansion)

Companion to `ARCHITECTURE.md` (Phase 1). This document assumes Phase 1 is built and live with eBay (source + destination) and TikTok Shop (destination) active. Everything here is additive to that foundation — no schema rewrite, no changes to the AI generation or review pipeline, because Phase 1 was deliberately built platform-agnostic (see Phase 1, Sections 4–5).

---

## 1. Final platform matrix

| Source ↓ / Destination → | eBay | Amazon | TikTok Shop |
|---|---|---|---|
| **eBay** | eBay → eBay | eBay → Amazon | eBay → TikTok *(live in Phase 1)* |
| **AliExpress** | AliExpress → eBay | AliExpress → Amazon | AliExpress → TikTok |
| **Amazon** | Amazon → eBay | Amazon → Amazon | Amazon → TikTok |

**Platform roles, final:**
- **eBay** — source and destination
- **Amazon** — source and destination
- **AliExpress** — source only, never a destination
- **TikTok Shop** — destination only, no source/scraper module planned
- **Walmart** — out of scope entirely (see Section 6 for why, kept here so the decision isn't re-litigated without context)

This gives **9 source→destination combinations** from **3 new modules** (AliExpress scraper, Amazon scraper, Amazon publisher) plus the eBay publisher, layered onto what Phase 1 already built. The module count is 4, not 9 — every combination is just routing between whichever pair a user's `tracked_store` (source) and `connection` (destination) reference.

---

## 2. Data access summary per new platform (from research)

| Platform | Role | Data access reality | Risk level |
|---|---|---|---|
| **AliExpress** | Source | Official Open Platform Dropshipping API — product details by ID, structured, stable | Low |
| **eBay** | Destination (new) | Official Trading/Inventory API — same access already used for source in Phase 1 | Low |
| **Amazon** | Source | Official Catalog Items API (SP-API), but only returns data for items already in Amazon's catalog by ASIN — no clean "get everything this seller has listed" endpoint, same structural gap as eBay's Browse API | Medium |
| **Amazon** | Destination | Official Listings Items API (SP-API), BYOK via private-app self-authorization (same pattern as TikTok's Custom app) — but gated per-category by brand registry and approval requirements | Medium-High (approval friction, not data-access risk) |

No scraping-only platforms remain in this phase — that's a deliberate simplification from earlier drafts (TikTok-as-source and Walmart were both scraping-only with no official path, and are excluded; see Section 6).

---

## 3. Schema changes required

None beyond what Phase 1 already has, **if Phase 1 was built as specified** (`platforms` registry, generic `source_platform_id` / `destination_platform_id`, `plan_platform_access`). Phase 2 rollout is:

```sql
-- Activate AliExpress (source only)
UPDATE platforms SET status = 'active' WHERE key = 'aliexpress';

-- Activate Amazon (both roles)
UPDATE platforms SET status = 'active' WHERE key = 'amazon';

-- Gate access by plan (example: AliExpress + Amazon reserved for Pro and above)
INSERT INTO plan_platform_access (plan_id, platform_id)
SELECT p.id, pl.id FROM plans p, platforms pl
WHERE p.name IN ('pro', 'pro_max', 'pro_ultra') AND pl.key IN ('aliexpress', 'amazon');
```

No `ALTER TABLE`, no data migration, no downtime. This is the payoff of the Phase 1 design decision.

---

## 4. New modules to build

Following the Phase 1 module structure (`/src/modules/<platform>/`), each with the shared interface:

```
/src/modules/aliexpress
  aliexpress.client.js       # Open Platform API auth (app_key/secret, session token)
  aliexpress.scraper.js      # implements scrapeStore(storeUrl) → Listing[]
  aliexpress.parser.js       # normalizes AliExpress product schema → internal Listing shape
  aliexpress.service.js

/src/modules/amazon
  amazon.client.js           # SP-API auth (LWA + AWS SigV4), private-app self-authorization flow
  amazon.scraper.js          # implements scrapeStore(storeUrl) → Listing[], via Catalog Items API (ASIN-based)
  amazon.publisher.js        # implements publishListing(listing, credentials) → { externalProductId, status }
  amazon.parser.js
  amazon.category-gate.js    # checks Listings Restrictions API before attempting publish
  amazon.service.js

/src/modules/ebay
  ebay.publisher.js          # NEW — implements publishListing() alongside existing ebay.scraper.js
```

**Key implementation notes:**
- **AliExpress scraper**: since the Dropshipping API returns data by product ID rather than "all products for a store," the scraper needs a strategy for discovering a competitor's product IDs first (likely via the Affiliate API's hot-products/search endpoints, filtered by store) before fetching each product's full detail. Worth prototyping this discovery step early, since it shapes how "add a competitor store" works for AliExpress differently than it does for eBay.
- **Amazon scraper**: inherits the same limitation eBay's Browse API has — no single "all listings for this seller" call. Expect a similar workaround pattern (search/category iteration filtered by seller) as was used for eBay in Phase 1. Budget research time here rather than assuming it's a copy-paste of the eBay approach — Amazon's catalog search filters differ.
- **Amazon publisher**: must call the Listings Restrictions API before attempting to publish, and handle the "approval required" response path gracefully (surface it to the user in the review UI rather than failing silently) — this is a new UX case Phase 1 doesn't have, since TikTok/eBay don't gate categories this way.
- **eBay publisher**: lowest-risk new module — same API family already integrated for source in Phase 1, just the write-side calls (`AddItem`/Inventory API equivalents) instead of read-side.

---

## 5. Recommended build order

1. **AliExpress scraper** — official API, no approval gating, unlocks 2 new live combinations immediately (AliExpress → eBay, AliExpress → TikTok) since both destinations already exist
2. **eBay publisher** — same API family as existing eBay source integration, unlocks eBay → eBay and AliExpress → eBay
3. **Amazon scraper + publisher together** — higher friction (category gating, ASIN-based source limitation, private-app self-authorization flow), budget the most time and treat as its own mini-project rather than a drop-in module. Unlocks the remaining 4 combinations (eBay→Amazon, AliExpress→Amazon, Amazon→eBay, Amazon→Amazon, Amazon→TikTok — 5 total, all gated behind this one integration)

Each step is independently shippable and testable — you don't need Amazon working to ship AliExpress or the eBay publisher, so Phase 2 can go out incrementally rather than as one big release.

---

## 6. Platforms explicitly excluded, and why (kept for future reference)

- **TikTok Shop as a source**: no official data-access path exists (the only relevant API is TikTok's Research API, gated to approved academic/qualified researchers). Would require pure scraping infrastructure, and only unlocks one narrow combination (TikTok → TikTok) since it was already decided not to feed eBay/Amazon from TikTok data. Effort-to-value ratio too low to justify — revisit only if customers specifically request it.
- **Walmart, both directions**: destination requires the user to already be an *approved* Walmart Marketplace seller — a gate outside the product's control. Source is worse: Walmart's own affiliate API terms explicitly prohibit using their official data access for competitive pricing/availability analysis, closing off the legitimate route entirely (not just technically incomplete, like eBay/Amazon's source gaps). The only remaining option is scraping against one of the more aggressive anti-bot systems among major retailers, in direct conflict with the platform's stated terms. Not a "not yet" — a deliberate exclusion, documented here so it isn't re-proposed without this context.

---

## 7. Plan-gating suggestion (ties to Phase 1 Section 7 pricing)

Given Amazon is the highest-effort integration, it's reasonable to reserve it for higher tiers once live — consistent with the "top-tier platforms cost more to build and support, so they're gated to top-tier plans" logic already established in Phase 1:

- **Starter/Basic**: eBay + TikTok Shop only (unchanged from Phase 1)
- **Pro and above**: adds AliExpress as a source
- **Pro Max and above**: adds Amazon (source and destination)

This is a suggestion, not a locked decision the way Section 1's platform matrix is — worth revisiting once you see real usage patterns and know whether Amazon draws enough demand to justify gating it that high, or whether it should be available sooner to drive upgrades into Pro.

---

## 8. Features & UI additions required

Phase 1's UI (Section 11 of ARCHITECTURE.md) was built assuming one fixed source (eBay) and one fixed destination (TikTok Shop). Phase 2 makes both selectable, which touches several screens:

**Connections & tracked stores**
- **Platform selector** on "add connection" (choose destination: eBay / Amazon / TikTok Shop) and "add tracked store" (choose source: eBay / AliExpress / Amazon) — replaces the current implicit "it's eBay/TikTok" assumption
- Platforms gated by the user's plan (Section 7 above) should show as visibly locked/upgrade-prompted in the selector, not just hidden — e.g. "AliExpress — available on Pro and above" with an upgrade link, so it's a visible upsell rather than an invisible limit
- **Amazon BYOK onboarding guide** — same spirit as Phase 1's TikTok Custom-app walkthrough, but for SP-API private-app self-authorization; needs its own guide since the flow differs (LWA + AWS SigV4 vs. TikTok's simpler OAuth)
- **AliExpress connection setup** — since AliExpress requires applying for Open Platform developer access (1–2 business day approval per Phase 1 research), the onboarding guide needs to set that expectation up front rather than the user hitting a confusing wait mid-setup

**Review screen**
- **Amazon category-restriction indicator** — when a generated listing targets a restricted Amazon category, the review screen needs to surface this (per Section 4's `amazon.category-gate.js` note) before the user tries to publish, not as a surprise failure after approval. The open item below decides whether this blocks generation entirely or just flags at review.

**Billing/plan page**
- Plan comparison page (Phase 1, Section 11) needs its platform-access column updated to show which plan tier unlocks AliExpress/Amazon, per Section 7's gating suggestion

---

## 9. Open items to confirm before Phase 2 coding starts

- AliExpress product-discovery strategy for "scrape a competitor store" (Section 4 note) — needs a prototype/spike before committing to an approach
- Amazon SP-API private-app registration process — needs the same kind of research pass Phase 1 did for TikTok's Custom app, since self-authorization limits (10 per selling partner type) may affect onboarding UX
- Whether Amazon's category-gating UX (Section 4 / Section 8) blocks a listing from being generated at all, or lets it generate and only blocks at publish time with a clear error — affects the review UI design
