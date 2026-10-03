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
| `RESEND_API_KEY`, `EMAIL_FROM` | as local; `EMAIL_FROM` on the domain verified in Resend, e.g. `Liston <team@snagai.pro>` (see "Emails reaching the inbox") |
| `EMAIL_REPLY_TO` | a mailbox someone reads (e.g. `support@snagai.pro`); replies to Liston's emails go there. Optional |
| `ANTHROPIC_API_KEY` | as local |
| `AI_MODEL` | `claude-haiku-4-5-20251001` (optional; that's the default) |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME`, `EBAY_ENVIRONMENT=PRODUCTION` | as local |
| `EBAY_DELETION_VERIFICATION_TOKEN` | as local |
| `EBAY_DELETION_ENDPOINT_URL` | `https://API_URL/api/ebay/account-deletion` |
| `ALIEXPRESS_SOURCE` | `ds-api` |
| `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET`, `ALIEXPRESS_CALLBACK` | as local |
| `IMAGE_ADD_UK_FLAG` etc. | optional, default off |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | where shared files are kept (see 5d) — **without these, or a volume, every redeploy deletes the team's voice notes, photos and files** |

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

`node scripts/copy-account.js <email> --to-prod` copies one owner (team members, connections with re-encrypted credentials, listings, permissions) and the AliExpress token up to production; `--from-prod` pulls an account down to the local database to reproduce its data. Needs `PROD_DATABASE_URL` (the Postgres public URL) and `PROD_CREDENTIALS_ENCRYPTION_KEY` (the backend's key) in `.env`. Run `DATABASE_URL=<public url> node src/db/migrate.js up` first if the schema is behind.

## 5c. Emails reaching the inbox, not spam

Liston's emails (invitations, email confirmations, password resets, access requests) are sent through Resend from `EMAIL_FROM`'s domain. Every email goes with a plain-text copy, a Reply-To when `EMAIL_REPLY_TO` is set, and its own ID. What decides inbox or spam beyond that is the domain:

1. **Resend → Domains:** the sending domain shows *Verified* (DKIM `resend._domainkey`, and the `send.` subdomain's SPF and MX). Checked 3 Oct 2026 for snagai.pro: all present.
2. **DMARC** (`_dmarc` TXT): snagai.pro has `v=DMARC1; p=none;`. Once a week of reports looks clean, tighten it to `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc@snagai.pro`. Gmail and Yahoo trust a domain that enforces DMARC more.
3. **Links on the same domain as the sender.** An email from snagai.pro whose buttons go to a `*.up.railway.app` address looks like phishing to filters. Give the app a subdomain (Railway → Settings → Networking → Custom Domain, e.g. `app.snagai.pro` for the frontend and `api.snagai.pro` for the API, each a CNAME), then set `FRONTEND_URL`, `API_URL` and the frontend's `NEXT_PUBLIC_API_URL` to them.
4. **Resend → Domains → Configuration:** click and open tracking off. Tracking rewrites every link to a tracking domain, which filters distrust.
5. **The From address** reads as a person or team (`team@`, `hello@`) rather than `noreply@`, with the name "Liston".
6. **A new domain earns trust slowly.** Ask the first members to mark Liston's email "Not spam" (and add the sender to contacts); each one teaches their mail provider.
7. **Check a real send:** send one email to the address mail-tester.com gives you, and fix whatever it scores down.

## 5d. Files that survive a redeploy

Voice notes, photos and files shared in workspace chat, and the documents sent to eBay buyers, are kept by `src/lib/storage.js`. Without either option below they go in a folder on the API server's own disk, and **Railway starts every deploy with that disk empty**: everything shared before the deploy is gone (the chat shows "No longer on the server. Ask … to send it again." and the logs "Media: a file's bytes are gone from storage"). This happened on 3 Oct 2026. At each start the API logs where files are kept: `Files: kept on Cloudflare R2 …` or `… the mounted volume …` is right; an **error** `Files: kept on this server's own disk … which every redeploy empties` means neither is set up.

Pick one:

**A. Cloudflare R2 (recommended: no size limit to manage, the browser downloads from Cloudflare directly).**
1. Cloudflare dashboard → **R2 Object Storage** → *Create bucket*, e.g. `liston-files` (location Automatic; keep it private — Liston hands out its own expiring links).
2. R2 → **Manage API tokens** → *Create API token*: permission **Object Read & Write**, applied to that bucket only. Copy the *Access Key ID* and *Secret Access Key* (shown once).
3. The **Account ID** is on the R2 overview page (right-hand side).
4. API service → Variables: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (the bucket's name). Redeploy, and check the log line says Cloudflare R2.

**B. A Railway volume (quickest; files stay on Railway).**
1. API service → right-click → **Attach volume**, mount path `/data`.
2. Nothing else to set: Railway gives the service `RAILWAY_VOLUME_MOUNT_PATH`, and Liston keeps files in `/data/storage` by itself (or set `STORAGE_DIR` to a folder inside the volume). Redeploy, and check the log line says the mounted volume.

Files lost before either is set up can't be brought back; whoever shared them sends them again.

## 6. After the first deploy

1. Sign up on the frontend with an address listed in `ADMIN_EMAILS` (auto-approved), verify the email (Resend), connect the eBay account(s) — plan limits are off (`ENFORCE_PLAN_LIMITS` unset).
   Anyone else who signs up lands on "under review": you get an email with Approve/Reject links, and there's an **Access requests** page in the sidebar for admins.
2. Settings → Listing settings, policies, shipping location, description template ("Fill from my eBay store").
3. Draft one listing end to end.

## Notes

- The filesystem is ephemeral: `.cache/` (taxonomy cache) rebuilds itself; the AliExpress token lives in Postgres; shared files need R2 or a volume (5d).
- `sharp` builds fine on Railway's Node 20 image. Playwright's browser download is skipped (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`); set `ALIEXPRESS_SOURCE=scraper` only if you also install it.
- Logs: Railway → service → Deployments → View logs. Request bodies and credentials are never logged.
