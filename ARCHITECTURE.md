# Liston — Phase 1: Architecture & Features (Competitor-to-TikTok-Shop Listing Automation)

## 1. What we're building (in one paragraph)

A multi-tenant SaaS web app. Each user signs up, picks a subscription plan, and connects one or more "**Store Connections**" — a TikTok Shop store (via their own self-generated API credentials) paired with one or more eBay competitor store URLs to track. For each competitor listing, the platform scrapes the data, runs it through an AI pipeline to generate an original title/description/price and a transformed image set, stages it for review, and — once approved — publishes it to the user's TikTok Shop and logs it to a Google Sheet. Multiple users' connections run in parallel, isolated from each other, rate-limited per-connection, gated by plan limits.

---

## 2. Core architectural decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| TikTok Shop access model | **BYOK (bring your own key)** — user registers a Custom app in their own TikTok Shop Partner Center and pastes credentials into our tool | Skips TikTok's Public App review entirely; standard pattern for automation SaaS |
| Backend | **Node.js** (Express or Fastify) | Per your preference |
| Architecture style | **Layered / modular monolith** — feature-based folders, not one giant file | Maintainability, matches how you'll hand this to Claude Code later |
| Job processing | **BullMQ + Redis** | Per-connection queues so one user's job never blocks another's |
| Database | **PostgreSQL** | Relational data (users, plans, connections, listings) with strong integrity needs — better fit than Mongo here |
| Secrets storage | **AES-256-GCM encryption at rest**, decrypted only in-memory at call time | Required — we're holding other people's store credentials |
| Multi-tenancy | Single DB, `user_id` / `connection_id` scoping on every table (not separate DBs per tenant, not needed at this scale) | Simpler ops, standard SaaS pattern |
| Billing | **Stripe** (Billing + Webhooks) | Industry default for subscriptions, handles plan upgrades/downgrades/dunning |
| Platform model | **Platform-agnostic from day one** — `platforms` registry table + generic `source_platform_id`/`destination_platform_id` references, even though only eBay (source) and TikTok Shop (destination) are active in v1 | Phase 2 (AliExpress, Amazon, more) becomes "add a row + write a new module," not a schema rewrite |

---

## 3. High-level system diagram (conceptual)

```
                         ┌─────────────────────┐
                         │   Frontend (SPA)     │
                         │  dashboard / auth /  │
                         │  connections / review│
                         └──────────┬───────────┘
                                    │ REST/GraphQL
                         ┌──────────▼───────────┐
                         │   API Layer (Express) │
                         │  auth, users, billing, │
                         │  connections, listings │
                         └──────────┬───────────┘
                                    │
        ┌───────────────┬──────────┼───────────────┬────────────────┐
        │               │          │               │                │
  ┌─────▼─────┐  ┌──────▼─────┐ ┌──▼─────────┐ ┌───▼────────┐ ┌─────▼──────┐
  │ PostgreSQL │  │   Redis /  │ │  eBay       │ │  AI Content │ │ TikTok Shop │
  │ (users,    │  │   BullMQ   │ │  Scraper    │ │  Generator  │ │  Publisher  │
  │ plans,     │  │  (queues)  │ │  Module     │ │  Module     │ │  Module     │
  │ connections│  │            │ │             │ │(text+image) │ │             │
  │ listings)  │  │            │ └─────────────┘ └─────────────┘ └─────────────┘
  └────────────┘  └────────────┘                                   │
                                                          ┌──────────▼──────────┐
                                                          │  Google Sheets Sync  │
                                                          │      Module          │
                                                          └──────────────────────┘
```

---

## 4. Folder / module structure (clean architecture, feature-based)

```
/src
  /config              # env loading, constants, plan definitions
  /db
    /migrations
    /seeds
    client.js          # pg connection pool
  /modules
    /auth
      auth.controller.js
      auth.service.js
      auth.routes.js
    /users
      user.controller.js
      user.service.js
      user.repository.js
      user.routes.js
    /billing
      stripe.service.js
      webhook.handler.js
      plan.service.js      # enforces plan → max connections
      billing.routes.js
    /connections
      connection.controller.js
      connection.service.js
      connection.repository.js
      connection.routes.js
      credentials.encryption.js   # AES encrypt/decrypt helpers
    /ebay
      ebay.scraper.js
      ebay.parser.js         # normalizes raw data → internal listing shape
      ebay.service.js
    /ai-generation
      text-generator.service.js   # Claude API calls for title/desc/price
      image-transformer.service.js   # Bria (primary) or Photoroom (fallback) product-shot API — background/scene transform on scraped images
      generation.orchestrator.js
    /tiktok
      tiktok.client.js        # low-level API wrapper (auth headers, retries)
      tiktok.publisher.js     # createProduct, updateProduct, etc.
      tiktok.token-refresher.js
    /listings
      listing.controller.js
      listing.service.js
      listing.repository.js
      listing.routes.js       # includes review/approve/reject endpoints
    /sheets
      sheets.service.js       # googleapis wrapper — creates one Sheet per user on first connection, manages a tab per connection (tab name = connection label), appends/updates rows within the relevant tab
    /jobs
      queues.js                # BullMQ queue definitions
      workers/
        scrape.worker.js
        generate.worker.js
        publish.worker.js
        sheet-sync.worker.js
  /middleware
    auth.middleware.js
    planLimit.middleware.js
    errorHandler.middleware.js
  /utils
    logger.js
    rateLimiter.js
  app.js
  server.js
/tests
  /unit
  /integration
```

**Rule of thumb going forward:** every feature gets its own folder with `controller / service / repository / routes` — controllers only handle req/res, services hold business logic, repositories are the only files that touch the DB. This is what will make the handoff to Claude Code clean later — each module is self-contained and testable in isolation.

**Platform module interface (applies even though only 2 platforms exist in v1):**
Every source platform module (`/ebay`, and later `/aliexpress`, `/amazon`) exposes the same shape:
```
scrapeStore(storeUrl) → returns Listing[] in a common normalized shape
```
Every destination platform module (`/tiktok`, and later `/ebay-publisher`, `/amazon-publisher`) exposes the same shape:
```
publishListing(generatedListing, credentials) → returns { externalProductId, status }
```
The `/jobs/workers` and `/listings` modules call these interfaces generically (looked up via the listing's `source_platform_id` / connection's `destination_platform_id`), never hardcoding "eBay" or "TikTok" by name. This costs a small amount of extra discipline in Phase 1 and is the single biggest thing that makes Phase 2 additive instead of a refactor. Final Phase 2 platform roles (see PHASE-2.md for full detail): eBay and Amazon are both source and destination; AliExpress is source-only; TikTok Shop stays destination-only — no TikTok scraper module is planned.

---

## 5. Database schema (v1 — platform-agnostic)

```
users
  id (pk)
  email (unique)
  password_hash
  plan_id (fk → plans)
  stripe_customer_id
  stripe_subscription_id
  google_sheet_id                      # one Sheet per user; sync module manages a tab per connection
  created_at, updated_at

plans
  id (pk)
  name                    # starter / basic / pro / pro_max / pro_ultra
  max_connections          # 1 / 2 / 3 / 4 / 5
  listings_included_per_month   # 150 / 400 / 800 / 1400 / 2200
  overage_price_cents      # per-listing charge beyond included cap (e.g. 5 = $0.05)
  stripe_price_id
  price_cents

platforms                              # registry — NEW
  id (pk)
  key                                  # 'ebay', 'tiktok_shop', 'aliexpress', 'amazon'
  name                                 # display name
  role                                 # 'source' / 'destination' / 'both'
  status                               # 'active' / 'coming_soon'

plan_platform_access                   # which plans can use which platforms — NEW
  plan_id (fk)
  platform_id (fk)

connections                            # one destination-platform store + its settings
  id (pk)
  user_id (fk)
  destination_platform_id (fk → platforms)   # was hardcoded to TikTok, now generic
  label                                # user-friendly name, e.g. "Welxo" — also used as the Sheet tab name
  credentials (encrypted, jsonb)       # shape varies per platform (app_key/secret/tokens etc.)
  status                               # active / expired / error
  created_at, updated_at

tracked_stores                         # competitor stores tracked under a connection
  id (pk)
  connection_id (fk)
  source_platform_id (fk → platforms)  # was hardcoded to eBay, now generic
  source_url
  last_scraped_at
  status

listings
  id (pk)
  tracked_store_id (fk)
  source_data (jsonb)                  # raw scraped: title, price, images, specifics
  generated_data (jsonb)               # AI title, description, price, image urls
  status                               # scraped / generated / pending_review / approved / published / rejected / failed
  external_product_id                  # was tiktok_product_id — now generic across destinations
  error_message
  created_at, updated_at

jobs_log                               # optional audit trail beyond BullMQ's own state
  id (pk)
  connection_id (fk)
  job_type                             # scrape / generate / publish / sheet_sync
  status
  error
  created_at
```

**v1 seed data:** `platforms` gets two active rows — `ebay` (role: both — source active, destination active) and `tiktok_shop` (role: destination — active). Two more rows exist from day one with `status: coming_soon` so Phase 2 is pure activation, not schema work: `aliexpress` (role: source only — this is final, not a placeholder; AliExpress is never a destination in this product) and `amazon` (role: both — source and destination, activated together in Phase 2). `plan_platform_access` maps every v1 plan to the two active platforms; Phase 2 activation is: flip `status` to `active`, then insert `plan_platform_access` rows for whichever plans should get access — no migration required.

---

## 6. The pipeline, as jobs

Each stage is its own BullMQ queue, keyed so jobs are traceable back to a `connection_id`:

1. **`scrape` queue** — input: `tracked_store_id` → looks up its `source_platform_id`, calls that platform module's `scrapeStore()` → writes rows to `listings` with `status = scraped`
2. **`generate` queue** — input: `listing_id` → calls text generator + image transformer → writes `generated_data`, sets `status = pending_review`
3. **(manual step)** — user reviews in dashboard, approves/edits/rejects → `status = approved` or `rejected`
4. **`publish` queue** — input: `listing_id` where `status = approved` → looks up the connection's `destination_platform_id`, calls that platform module's `publishListing()` → sets `external_product_id`, `status = published`
5. **`sheet_sync` queue** — triggered after any status change → appends/updates the row in the connection's Google Sheet

Each queue has its own concurrency limit and retry/backoff policy — this is where per-connection rate limiting lives, so one user hammering TikTok's API doesn't throttle everyone else.

---

## 7. Plans (finalized pricing, v1)

Cost basis: **$0.01 AI cost per listing generated**, kept to roughly 10–13% of revenue on every tier so margin stays healthy and consistent as tiers scale up.

| Plan | Price/mo | Connected accounts | Listings included/mo | AI cost | Gross margin | Margin % |
|---|---|---|---|---|---|---|
| **Starter** | $15 | 1 | 150 | $1.50 | $13.50 | 90% |
| **Basic** | $35 | 2 | 400 | $4.00 | $31.00 | 89% |
| **Pro** | $65 | 3 | 800 | $8.00 | $57.00 | 88% |
| **Pro Max** | $109 | 4 | 1,400 | $14.00 | $95.00 | 87% |
| **Pro Ultra** | $169 | 5 | 2,200 | $22.00 | $147.00 | 87% |

*(Before Stripe fees ~2.9% + $0.30/transaction — net margin still 82–88%.)*

- **Overage**: once a user hits their monthly listing cap, charge **$0.05/listing** beyond it (5x cost) instead of hard-blocking — captures revenue from active users and nudges toward upgrade.
- **Connected accounts** = number of `connections` (destination-platform stores) a user can add. Each connection can track multiple `tracked_stores` (competitor URLs) underneath it — that's not separately limited in v1.

## 8. Plan enforcement

- `planLimit.middleware.js` checks `connections.count(user_id) < plan.max_connections` before allowing `POST /connections`
- A second check validates the requested `source_platform_id` / `destination_platform_id` against `plan_platform_access` — in v1 this always passes (all plans get eBay + TikTok Shop), but the check exists now so Phase 2 platform gating (e.g. "AliExpress requires Pro or higher") requires zero new enforcement code, just new rows in `plan_platform_access`
- A `listings_used_this_month` counter (reset monthly, likely via a scheduled job or tracked against billing cycle start) gates the `generate` queue — once `listings_used >= plan.listings_included_per_month`, new generations bill at `overage_price_cents` instead of being blocked
- Stripe webhook (`billing/webhook.handler.js`) listens for subscription changes and updates `users.plan_id` — if a user downgrades below their current connection count, connections beyond the new limit get `status = suspended` (not deleted) until they upgrade again or remove some

---

## 9. Security checklist (non-negotiable for v1)

- All TikTok credentials encrypted at rest (AES-256-GCM), decrypted only in-memory per request
- No credentials ever logged, including in error logs/stack traces
- Rate limiting per connection to respect TikTok's API limits and avoid account flags
- Token refresh handled automatically before expiry, not reactively on failure
- Standard web security basics: hashed passwords (bcrypt/argon2), HTTPS only, input validation on every route, helmet.js headers

---

## 10. Build order (phased, so early phases are testable without waiting on anything)

**Phase 0 — Infra & environments**
Hosting decision, dev/staging/prod environments, CI/CD pipeline, Postgres/Redis provisioning, base logging/error-tracking wired in from day one (not bolted on later — see Section 14)

**Phase 1 — Foundation**
Auth (signup, login, email verification, password reset), users, DB schema/migrations, plans table (no Stripe yet, just manual plan assignment for testing)

**Phase 2 — Connections**
CRUD for connections with encrypted credential storage, plan-limit enforcement, TikTok BYOK onboarding flow (see Section 11)

**Phase 3 — eBay ingestion**
Scraper module, normalize into `listings` table, testable standalone against any public eBay store URL

**Phase 4 — AI generation**
Text generation via Claude API, image transformation module — testable standalone against scraped data from Phase 3

**Phase 5 — Review UI + approval flow**
Dashboard views for staged listings (see Section 11 for full screen spec), approve/reject/edit endpoints

**Phase 6 — TikTok publishing**
Using your own test store's Custom app credentials, wire up create/update product calls

**Phase 7 — Google Sheets sync**

**Phase 8 — Billing**
Stripe integration, webhook handling, plan enforcement going live, billing/plan management UI

**Phase 9 — Notifications & transactional emails**
In-app alerts (job failures, expired tokens, approaching listing cap) and transactional emails (welcome, payment failed/succeeded, subscription changes) — see Section 12

**Phase 10 — Admin tooling**
Internal panel for user lookup, usage inspection, manual plan/connection overrides, stuck-job debugging — see Section 13

**Phase 11 — Queue/scale hardening & observability**
Concurrency tuning, retry policies, structured logging, error tracking, uptime monitoring, alerting on failed jobs

**Phase 12 — Multi-platform expansion → see separate PHASE-2.md**
Because the Phase 1 schema (Section 5) and module interfaces (Section 4) are already platform-agnostic, this phase is additive: new `platforms` rows, new scraper/publisher modules implementing the existing shared interface, new `plan_platform_access` gating rules.

Each phase is independently testable — you don't need TikTok credentials to build/test Phases 1–4, which unblocks starting immediately.

---

## 11. Feature & screen checklist

This is the user-facing surface area implied by the architecture above — every screen/flow a user (or you, as admin) will actually touch.

**Auth & account**
- Sign up / log in / log out
- Email verification
- Password reset
- Account settings (change email/password)

**Connections**
- Connections list (shows each destination-platform store, status, plan-limit usage e.g. "2 of 3 used")
- Add connection flow, gated by `plan.max_connections`
- **TikTok BYOK onboarding guide** — step-by-step walkthrough (with screenshots/copy) for generating a Custom app + credentials in TikTok Shop Partner Center, since this is real friction for non-technical users and was flagged specifically as needing a guided flow, not just a raw "paste your API key" field
- Edit/remove connection
- Per-connection status indicator (active / token expired / error) with a re-auth action when needed

**Tracked stores**
- Add a competitor source URL under a connection
- List of tracked stores per connection, last-scraped timestamp, manual "scrape now" trigger in addition to any scheduled run

**Listings & review**
- Listings table/board, filterable by status (`scraped / generated / pending_review / approved / published / rejected / failed`)
- Review screen: **original scraped data next to AI-generated data**, side by side — title, description, price, images
- Inline edit of generated content before approving (not just approve/reject as a binary)
- Bulk approve/reject for users comfortable trusting the AI output at volume
- Published listing detail (links to the live TikTok Shop listing, `external_product_id`)

**Billing**
- Plan comparison / upgrade-downgrade page
- Current usage vs. plan limits (connections used, listings generated this month vs. cap, overage charges accrued)
- Stripe-hosted checkout/billing portal integration (don't build custom card-collection UI — use Stripe's)

**Google Sheet**
- A visible link/button in the dashboard to the user's synced Sheet (opens their Drive file directly)

---

## 12. Notifications & transactional emails

**In-app / dashboard alerts** (surfaced from `jobs_log`/`error_message`, not just sitting silently in the DB):
- Scrape failed for a tracked store
- TikTok (or future platform) token expired or needs re-auth
- User is approaching their monthly listing cap (e.g. at 80%)
- A listing failed to publish (with the reason surfaced, not just "failed")

**Transactional emails** (Stripe webhook events need to actually notify the user, not just update `plan_id` silently):
- Welcome / getting-started email on signup
- Payment succeeded / payment failed
- Subscription upgraded / downgraded / canceled
- Connection needs re-authentication (in case the user isn't actively checking the dashboard)

A simple transactional email provider (e.g. Postmark, SendGrid, Resend) is enough for v1 — this doesn't need to be sophisticated, just present, since right now the architecture has no path from "something went wrong" to "the user finds out."

---

## 13. Admin tooling (internal use, not customer-facing)

Every SaaS ends up needing this — cheaper to plan a minimal version now than retrofit once you have real users and no way to help them:
- Look up a user by email, see their plan, connections, and usage
- Manually adjust a user's plan (for support cases, refunds, etc.)
- Inspect a stuck/failed job and its error detail
- View aggregate usage (total listings generated, active connections, MRR) — even a basic version helps you sanity-check the margin assumptions from Section 7 against real usage

A simple internal-only route group behind admin auth is sufficient for v1 — doesn't need its own polished UI immediately, could even start as authenticated API endpoints you hit directly while the business is small.

---

## 14. Deployment & observability

Not discussed in earlier drafts — worth deciding before Phase 0 starts, not after:
- **Hosting**: pick a provider for the Node backend, Postgres, and Redis (e.g. Railway/Render for simplicity early on, or AWS/GCP if you want more control from the start) — this is a real decision to make, not a default
- **Environments**: separate dev/staging/production, with separate credentials for every third-party service (Stripe test mode, TikTok sandbox if available, etc.)
- **CI/CD**: automated tests + deploy on merge, even a simple GitHub Actions pipeline is enough for v1
- **Structured logging**: `logger.js` should output structured (JSON) logs from day one, not just `console.log` — makes Phase 11's observability work much easier since you're not retrofitting log format later
- **Error tracking**: a service like Sentry wired in early, so Phase 9's "job failed" notifications and Phase 13's admin debugging have something to actually point to
- **Uptime monitoring**: basic external ping/monitoring on the API once anything is live for real users

---

## 15. Decisions locked from initial open items

- **Frontend**: React/Next.js, confirmed.
- **Image transformation**: **Bria's Product Shot Editing API** as primary provider (cutout + AI-generated background/scene from text or reference image) — chosen specifically because it's trained on licensed data and marketed for commercial-safety, which matters given the source images originate from a competitor's scraped listing. **Photoroom** as the fallback/alternative if Bria's pricing or output quality doesn't hold up in testing (broader feature set: backgrounds, shadows, relighting, virtual model placement). Recommend prototyping both against real scraped images before committing.
- **Google Sheets model**: **one Sheet per user**, created on their first connection, with **a tab per connection** (tab name = connection label). Rejected alternatives: a separate Sheet per connection (too many Drive files to manage/authorize per user) and one shared sheet with a "store" column (unwieldy once a user has multiple active connections generating daily). `google_sheet_id` lives on `users`, not `connections` (see Section 5).
