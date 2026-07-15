# Liston

Multi-tenant SaaS: scrape competitor listings, generate AI content, publish to destination marketplaces.

## Read first

- `ARCHITECTURE.md` — Phase 1 architecture, database schema, module structure, feature checklist, build order (Section 10 is the authoritative next-steps list)
- `PHASE-2.md` — multi-platform expansion plan (AliExpress/Amazon), not yet started, later phase

## Stack

- Backend: Node.js/Express, PostgreSQL (`pg`, raw SQL — no ORM), Redis/BullMQ (not wired up yet), JWT auth
- Frontend: Next.js (App Router), TypeScript, Tailwind CSS
- Two separate `package.json`s: `/` (backend) and `/frontend` (frontend) — not a monorepo tool, run as two processes

## Conventions (follow these for every new module)

- Feature-based folders under `src/modules/<feature>/`, each with `*.controller.js` (req/res only), `*.service.js` (business logic), `*.repository.js` (only files touching the DB), `*.routes.js`
- Source platform modules implement `scrapeStore(storeUrl) → Listing[]`; destination platform modules implement `publishListing(listing, credentials) → { externalProductId, status }` — see `ARCHITECTURE.md` Section 4
- Zod for request validation in controllers (see `auth.controller.js`)
- Errors: throw `Error` with `.statusCode` set; the central `errorHandler.middleware.js` handles the response
- Never log request bodies or credentials (see `errorHandler.middleware.js`, `app.js` request logger)
- All platform credentials must be encrypted at rest via `src/modules/connections/credentials.encryption.js` (AES-256-GCM) — never store raw

## Commands

Backend (from repo root):
- `npm run dev` — start with auto-restart
- `npm run migrate` / `npm run migrate:down` — schema migrations
- `npm run seed` — seed plans + platforms
- `npm test` — run test suite (needs Postgres running)

Frontend (from `/frontend`):
- `npm run dev -- -p 3001` — start dev server (backend already uses 3000)
- `npm run build` — verify production build compiles

## Current state (update this section as phases complete)

**Done:** Auth (signup/login/JWT), users/plans/platforms schema, `/dashboard` frontend showing live plan+usage, full DB schema for connections/tracked_stores/listings/jobs_log (tables exist, no CRUD yet).

**Not started:** Connections module (backend CRUD + TikTok BYOK credential form + frontend pages) — this is next per `ARCHITECTURE.md` Section 10, Phase 2 (of the Phase 1 build order, not to be confused with `PHASE-2.md` which is a different, later phase). After that: eBay scraping, AI generation, TikTok publishing, Sheets sync, billing.

## Before making DB schema changes

Add a new migration file (`00N_description.up.sql` / `.down.sql`) — never edit an already-applied migration. Update the schema documented in `ARCHITECTURE.md` Section 5 to match.

## Testing expectations

Every new backend feature should get real tests (see `tests/integration/auth.test.js` for the pattern — hits the real local DB, not mocked). Verify frontend changes with `npm run build` at minimum; a browser check is expected before considering a feature done.
