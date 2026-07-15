# Liston — Phase 1

Multi-tenant SaaS: scrape competitor listings, generate AI content, publish to destination marketplaces (TikTok Shop in v1; eBay/Amazon publishing and AliExpress/Amazon scraping land in Phase 2).

This is the **foundation** slice, backend and frontend both: auth, users, plans, the platform registry, and the connections/listings schema, with a working signup → login → dashboard flow you can click through in a browser. Scraping, AI generation, TikTok publishing, Sheets sync, and billing are stubbed in the folder structure (per `ARCHITECTURE.md`) but not yet implemented — build order is in `ARCHITECTURE.md` Section 10.

## Project structure

```
tiktok-automation-tool/
  src/            ← backend (Node/Express API)
  frontend/       ← frontend (Next.js)
  tests/          ← backend tests
```

Backend and frontend are two separate Node projects (two `package.json`s, two `npm install`s, run as two separate processes) — not a monorepo tool, just two folders side by side.

## Prerequisites

- Node.js 20+
- PostgreSQL 16 (or compatible) — **or Supabase** (hosted Postgres; works with zero code changes, see below)
- Redis 7 (or compatible) — not yet used by any running code, but required by `ioredis`/`bullmq` once the job queues (Phase 3+) are built

## Using Supabase instead of local Postgres (recommended if you don't want to install Postgres yourself)

Supabase is hosted Postgres, and the backend uses the standard `pg` driver with a plain `DATABASE_URL` connection string — so nothing in the code changes, you just point `DATABASE_URL` at Supabase instead of `localhost`:

1. Create a free project at [supabase.com](https://supabase.com)
2. In your project's Settings → Database, copy the **Connection string** (URI format, "Session pooler" or "Direct connection" both work for this stage)
3. Use that as `DATABASE_URL` in `.env` (step 4 below) instead of the local one
4. Everything else in the setup steps stays the same — `npm run migrate` and `npm run seed` work identically against Supabase

If you'd rather run Postgres locally (Docker or a native install), skip this section and use the local setup below instead.

## Backend setup

1. **Install dependencies**
   ```bash
   cd tiktok-automation-tool
   npm install
   ```

2. **Start Postgres and Redis** (skip Postgres if using Supabase). If you don't already have them running:
   - macOS: `brew install postgresql redis && brew services start postgresql && brew services start redis`
   - Ubuntu/Debian: `apt-get install postgresql redis-server`, then start both services
   - Docker: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=app_password postgres:16` and `docker run -d -p 6379:6379 redis:7`

3. **Create the database and app role** (skip if using Supabase — the database already exists):
   ```sql
   CREATE USER app_user WITH PASSWORD 'app_password';
   CREATE DATABASE listing_automation_dev OWNER app_user;
   ```

4. **Copy the env file and fill it in**
   ```bash
   cp .env.example .env
   ```
   At minimum for Phase 1 you need: `DATABASE_URL` (local connection string, or your Supabase connection string), `REDIS_URL`, `JWT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`.
   Generate the encryption key with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   Everything else in `.env.example` (Anthropic, Bria/Photoroom, Stripe, Google) is for later phases — leave blank for now.

5. **Run migrations**
   ```bash
   npm run migrate
   ```

6. **Seed plans and platforms**
   ```bash
   npm run seed
   ```

7. **Start the backend dev server**
   ```bash
   npm run dev
   ```
   Runs on `http://localhost:3000`.

## Frontend setup

In a **second terminal**, from the project root:

1. **Install dependencies**
   ```bash
   cd frontend
   npm install
   ```

2. **Set up the env file**
   ```bash
   cp .env.local.example .env.local
   ```
   Default (`NEXT_PUBLIC_API_URL=http://localhost:3000`) matches the backend's default port — no changes needed unless you changed the backend's `PORT`.

3. **Start the frontend dev server**
   ```bash
   npm run dev
   ```
   Runs on `http://localhost:3000` by default too — **since the backend is already using port 3000, Next.js will prompt to use 3001 instead** (or start it explicitly with `npm run dev -- -p 3001`).

## Using it in a browser

With both servers running:

1. Open `http://localhost:3001` (or whichever port the frontend started on)
2. You'll be redirected to `/login` — click through to `/signup`
3. Create an account — you'll land on `/dashboard`, showing your plan (starter, by default), connection usage, and listing usage, all pulled live from the backend
4. Refresh the page — you'll stay logged in (token persists in `localStorage`)
5. Click "Log out" — you'll be sent back to `/login`

This whole flow — signup, login, protected dashboard, logout — is real and tested end to end, not a mockup.

## What's actually implemented right now

**Backend:**
- `POST /api/auth/signup`, `POST /api/auth/login` — email/password auth, bcrypt-hashed, JWT-issued
- `GET /api/users/me` — protected route, returns user + plan + usage
- Full DB schema (Section 5 of `ARCHITECTURE.md`): `users`, `plans`, `platforms`, `plan_platform_access`, `connections`, `tracked_stores`, `listings`, `jobs_log`
- Seeded plans (5 tiers) and platforms (eBay/TikTok active, AliExpress/Amazon `coming_soon`)
- AES-256-GCM credential encryption helper — ready for the Connections module to use
- Structured JSON logging, centralized error handling, migration runner (`up`/`down`)

**Frontend:**
- `/signup`, `/login` — forms wired to the real API, with error handling and loading states
- `/dashboard` — protected route (redirects to `/login` if no valid token), shows live plan/usage data
- Token-based auth persisted in `localStorage`, auto-redirect on expired/invalid token

## What's not built yet

Connections CRUD (backend + frontend), eBay scraping, AI generation (text + image), TikTok publishing, Google Sheets sync, Stripe billing, notifications, admin tooling. Backend module folders for all of these already exist under `src/modules/`; frontend pages for them don't exist yet — they'll be added alongside each backend feature per the build order in `ARCHITECTURE.md` Section 10.

## Running tests

Backend:
```bash
npm test
```
(6 tests covering auth flow and credential encryption — needs Postgres running.)

Frontend has no automated tests yet.

