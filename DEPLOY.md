# Deploying Liston to Railway

Two services from this one repo, plus a Postgres database.

## 1. Create the project

1. Railway → New Project → **Deploy from GitHub repo** → pick this repo (the `main` branch).
2. On the canvas: **+ Create → Database → PostgreSQL**. Its `DATABASE_URL` is referenced from the API service's variables.

## 2. API service (the service Railway created from the repo)

Click its box on the canvas → **Settings**:

- **Source → Root Directory:** `/` (leave as is).
- **Build → Builder:** Railpack (default). Leave *Custom Build Command* empty.
- **Deploy → Custom Start Command:** `npm run migrate && npm run seed && npm start`
- **Deploy → Healthcheck Path:** `/health`
- **Networking → Public Networking → Generate Domain** (port `3000` if asked). Note the URL — `API_URL` below.

**Variables tab → Raw Editor**, paste (values from your local `.env`):

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (use your database service's name inside the braces) |
| `NODE_ENV` | `production` |
| `API_URL` | `https://API_URL` — used to build the approve/reject links in emails |
| `ADMIN_EMAILS` | your email(s), comma-separated — auto-approved, receive access requests |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | `1` (the DS API needs no browser; skips a 300MB download) |
| `FRONTEND_URL` | the frontend's public URL (step 3) — also locks CORS to it |
| `JWT_SECRET` | a fresh random string for production |
| `CREDENTIALS_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` — **generate a new one; existing dev connections won't decrypt with a different key** |
| `RESEND_API_KEY`, `EMAIL_FROM` | as local |
| `ANTHROPIC_API_KEY` | as local |
| `AI_MODEL` | `claude-haiku-4-5-20251001` (optional; that's the default) |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME`, `EBAY_ENVIRONMENT=PRODUCTION` | as local |
| `EBAY_DELETION_VERIFICATION_TOKEN` | as local |
| `EBAY_DELETION_ENDPOINT_URL` | `https://API_URL/api/ebay/account-deletion` |
| `ALIEXPRESS_SOURCE` | `ds-api` |
| `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET`, `ALIEXPRESS_CALLBACK` | as local |
| `IMAGE_ADD_UK_FLAG` etc. | optional, default off |

Don't set `PORT` (Railway injects it). Not needed: `REDIS_URL`, `OPENAI_API_KEY`, `BRIA_API_KEY`.

## 3. Frontend service

On the project **canvas** (not inside a service): **+ Create** (top-right, or right-click the canvas) → **GitHub Repo** → pick the same repo. A second box appears. Click it → **Settings**:

- **Source → Root Directory:** `/frontend`
- Build/Start: leave defaults (Railpack detects Next.js: `npm run build` / `npm start`).
- **Healthcheck Path:** `/login`
- **Generate Domain** — this is your app URL. Put it in the API service's `FRONTEND_URL`.

**Variables:** `NEXT_PUBLIC_API_URL` = `https://API_URL` (no trailing slash). `NEXT_PUBLIC_*` is baked in at build time — redeploy the frontend after changing it.

## 4. Third-party callbacks to update

- **eBay Developer Portal → your production keyset → RuName:** set the *Your auth accepted URL* to `https://API_URL/api/ebay/oauth/callback`, and the account-deletion notification endpoint to `https://API_URL/api/ebay/account-deletion` (then click "Send test notification").
- **AliExpress Open Platform:** the callback (`ALIEXPRESS_CALLBACK`) can stay on the GitHub page — it only displays the code.

## 5. AliExpress consent on production

Tokens are stored in the `app_state` table, so run the consent once **against the production database**:

```bash
DATABASE_URL="<Postgres public URL from Railway>" node scripts/aliexpress-auth.js
DATABASE_URL="<same>" node scripts/aliexpress-auth.js <code>
```

Then click **Apply Online** on the app in the AliExpress console. Until the app is formally approved, its refresh token is only valid for 48 hours from consent (this is fixed by AliExpress, not something we can extend) — a Test app needs this consent repeated every two days. An approved app's tokens last months.

## 5b. Copying an account from local to production

`scripts/copy-account-to-prod.js <email>` copies one owner (team members, connections with re-encrypted credentials, listings, permissions) and the AliExpress token. Needs `TARGET_DATABASE_URL` (the Postgres public URL) and `TARGET_CREDENTIALS_ENCRYPTION_KEY` (the backend's key). Run `DATABASE_URL=<public url> node src/db/migrate.js up` first if the schema is behind.

## 6. After the first deploy

1. Sign up on the frontend with an address listed in `ADMIN_EMAILS` (auto-approved), verify the email (Resend), connect the eBay account(s) — plan limits are off (`ENFORCE_PLAN_LIMITS` unset).
   Anyone else who signs up lands on "under review": you get an email with Approve/Reject links, and there's an **Access requests** page in the sidebar for admins.
2. Settings → Listing settings, policies, shipping location, description template ("Fill from my eBay store").
3. Draft one listing end to end.

## Notes

- The filesystem is ephemeral: `.cache/` (taxonomy cache) rebuilds itself; the AliExpress token lives in Postgres.
- `sharp` builds fine on Railway's Node 20 image. Playwright's browser download is skipped (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`); set `ALIEXPRESS_SOURCE=scraper` only if you also install it.
- Logs: Railway → service → Deployments → View logs. Request bodies and credentials are never logged.
