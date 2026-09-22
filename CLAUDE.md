# Liston

Multi-tenant SaaS for eBay dropshipping teams: AI-drafted listings from a competitor + supplier link, publish to eBay, then run the orders (sourcing, dispatch, refunds, cases) from Liston.

## Read first

- `ARCHITECTURE.md` — the system as built, the layering rules (§4) every change follows, the schema (§5), and the roadmap (§9). Keep it in step with the code: a change that adds a table, module or flow updates it in the same commit.
- `PHASE-2.md` — old multi-platform notes (AliExpress/Amazon as destinations); superseded by the roadmap in ARCHITECTURE.md.

## Stack

- Backend: Node.js/Express (CommonJS), PostgreSQL via `pg` + raw SQL (no ORM), JWT auth. `bullmq`/`ioredis` installed but not wired.
- Frontend: Next.js (App Router), TypeScript, Tailwind — `frontend/`, talks to the backend only through `frontend/lib/api.ts`.
- Two separate `package.json`s (`/` and `/frontend`), run as two processes.

## Layout (see ARCHITECTURE.md §4 for the rules)

- `src/modules/<feature>/` with `*.routes.js` → `*.controller.js` (req/res + Zod) → `*.service.js` (rules) → `*.repository.js` (DB only). Pure helpers sit beside them.
- Platform adapters: `src/modules/ebay/` (with `api/` holding one thin client per eBay API) and `src/modules/sourcing/aliexpress/`. Nothing else calls an external API.
- Frontend pages in `app/` stay thin; reusable UI in `components/`, per-area subfolders (`components/orders/`, `components/analytics/`). Charts use the kit in `components/charts/` (one axis, brand indigo for the current period, dashed slate for the previous).
- Errors: throw `Error` with `.statusCode`; `errorHandler.middleware.js` responds. Never log bodies or credentials. Credentials encrypted via `credentials.encryption.js`, used only inside `withDecryptedCredentials`.

## Commands

Backend (repo root): `npm run dev` · `npm run migrate` / `migrate:down` · `npm run seed` · `npm test` (needs local Postgres; runs unit + integration + cleanup).
Frontend (`/frontend`): `npm run dev -- -p 3001` · `npm run build` (typecheck + lint).

## Working rules

- Restart the backend after backend edits (a stale process has caused phantom bugs). If a stray `.next/**/* 2.*` duplicate breaks `tsc`, delete it: `find .next -name "* [0-9].*" -delete`.
- Never commit or push; the owner does all git work. Leave changes in the working tree and give a commit line when asked.
- Never publish, revise, dispatch, refund or end anything on a live eBay account without asking; read-only eBay calls are fine.
- Schema changes: new `NNN_name.up.sql`/`.down.sql`, never edit an applied migration; update ARCHITECTURE.md §5.
- Every backend feature gets real tests (`tests/unit`, `tests/integration` against the local DB, fixtures `@example.com`). Frontend: `npm run build` clean and a browser check before "done".

## Current state (update as phases land)

**Built:** auth + team/member permissions; eBay connect/reconnect with all 24 seller scopes; AI listing drafts (Browse + AliExpress DS + Taxonomy + Anthropic + pricing + image pipeline), draft editor with autosave, publish with unique SKUs / identifiers / policy-word handling, live-listing editing; orders list (new orders and listing changes pushed by eBay's Notification API: orders read via Fulfillment, a changed listing via one trimmed GetItem) + order page matching Seller Hub (variation photo, specifics, fees/earnings, buyer contact), sourcing panel with auto-dispatch, dispatch/refund/cancel/decline, returns, item-not-received, payment disputes, archive; Shop categories incl. creating departments; listing analytics (account + every listing's traffic stored per day, 92 days of history filled once from allowance left over before eBay's daily reset, filters added up locally and never call eBay, ~2 eBay calls/account/night within the ~100/day allowance, seller-time-zone days, sales from orders, watchers; Analytics tab, per-listing panel, Load all, admin Trading/Traffic tabs); description editor with bullet/numbering library and the AI description layout.

**Next (ARCHITECTURE.md §9):** analytics UI fixes, then Inbox (messaging — planned in §9.1), Campaigns (Promoted Listings), inline sourcing on the order list, AliExpress order automation, `ebay.service.js` split, background jobs, Stripe, TikTok Shop.
