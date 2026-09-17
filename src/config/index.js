require('dotenv').config();
const crypto = require('crypto');

function required(name, { devFallback } = {}) {
  const value = process.env[name];
  if (!value) {
    if (process.env.NODE_ENV !== 'production' && devFallback !== undefined) {
      return devFallback;
    }
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// CREDENTIALS_ENCRYPTION_KEY is deliberately left blank in .env.example (shipping
// a shared placeholder secret would be worse than not having one). In development,
// auto-generate a throwaway key so `npm run dev` works out of the box — this key
// is NOT persisted, so anything encrypted with it becomes unreadable on restart.
// That's fine for local dev before the Connections module exists; once you're
// actually storing platform credentials, set a real key in .env yourself.
// Production always requires a real key set in the environment — never falls back.
let devEncryptionKeyWarningShown = false;
function credentialsEncryptionKey() {
  const value = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (value) return value;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Missing required environment variable: CREDENTIALS_ENCRYPTION_KEY');
  }

  if (!devEncryptionKeyWarningShown) {
    console.warn(
      '\x1b[33m⚠ CREDENTIALS_ENCRYPTION_KEY not set — using a random dev-only key ' +
        'that will NOT persist across restarts. Set a real value in .env once you ' +
        'start storing platform credentials. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\x1b[0m'
    );
    devEncryptionKeyWarningShown = true;
  }
  return crypto.randomBytes(32).toString('base64');
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),

  databaseUrl: required('DATABASE_URL'),
  // Redis/BullMQ isn't wired up yet — optional so a deploy doesn't need a Redis service.
  redisUrl: process.env.REDIS_URL || null,

  // Used to build links in emailed tokens (verification/password-reset).
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3001',
  // Where this API is reachable from a browser — used for one-click links in emails.
  apiUrl: (process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  credentialsEncryptionKey: credentialsEncryptionKey(),

  resend: {
    apiKey: process.env.RESEND_API_KEY || null,
    fromEmail: process.env.EMAIL_FROM || 'Liston <onboarding@resend.dev>',
  },

  // Who approves new owner accounts (comma-separated). These addresses are
  // auto-approved at signup and receive every access request.
  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  // One model for every Claude call (draft writing, editor revisions, image
  // screening). Haiku handles all three at roughly a third of Sonnet's
  // price; set AI_MODEL to a larger one only if draft quality needs it.
  aiModel: process.env.AI_MODEL || 'claude-haiku-4-5-20251001',

  // Listing images are the supplier's own photos, untouched; the seller
  // replaces them from the editor. Optional badges on the MAIN image only —
  // all off unless set; the draft warns when any are on (eBay's picture
  // policy discourages badges and borders).
  imageGeneration: {
    addUkFlag: process.env.IMAGE_ADD_UK_FLAG === 'true',
    addFreeShippingLabel: process.env.IMAGE_ADD_FREE_SHIPPING === 'true',
    addGlowBorder: process.env.IMAGE_ADD_GLOW_BORDER === 'true',
  },

  // How source products are read from AliExpress. 'scraper' drives a real
  // browser (works today, no registration, but slow — ~30s — and exposed to
  // anti-bot measures). 'ds-api' uses AliExpress's official Dropshipping API,
  // which is far faster and more reliable but needs an approved Open Platform
  // app: set ALIEXPRESS_SOURCE=ds-api along with the key/secret once you have
  // one. eBay deliberately has no such switch — it's API-only.
  aliexpress: {
    source: process.env.ALIEXPRESS_SOURCE === 'ds-api' ? 'ds-api' : 'scraper',
    appKey: process.env.ALIEXPRESS_APP_KEY || null,
    appSecret: process.env.ALIEXPRESS_APP_SECRET || null,
    accessToken: process.env.ALIEXPRESS_ACCESS_TOKEN || null,
    // Access tokens are short-lived; the refresh token is what keeps the
    // integration alive without re-consenting. Set at least this one.
    refreshToken: process.env.ALIEXPRESS_REFRESH_TOKEN || null,
    // The redirect URL registered on the Open Platform app — used only to
    // build the one-time consent link and exchange its code.
    callbackUrl: process.env.ALIEXPRESS_CALLBACK || null,
    // Epoch ms, if known (from the friend's token file: access_expire_ms).
    // Unknown = treated as expired, so the first call refreshes.
    accessTokenExpiresMs: Number(process.env.ALIEXPRESS_ACCESS_TOKEN_EXPIRES_MS) || 0,
    shipToCountry: process.env.ALIEXPRESS_SHIP_TO || 'GB',
    targetCurrency: process.env.ALIEXPRESS_CURRENCY || 'GBP',
  },

  // Optional rotating-proxy service for the eBay/AliExpress scrapers (e.g.
  // Bright Data, Oxylabs, ScraperAPI). Without one, scraping requests come
  // from this server's own IP, which real-world anti-bot systems can rate-
  // limit/block under sustained use — a proxy provider's rotating IP pool is
  // the standard mitigation for that. Format: a full proxy URL, credentials
  // included if required, e.g. "http://user:pass@proxy.host:port".
  scraperProxyUrl: process.env.SCRAPER_PROXY_URL || null,

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || null,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
  },

  ebay: {
    clientId: process.env.EBAY_CLIENT_ID || null,
    clientSecret: process.env.EBAY_CLIENT_SECRET || null,
    // RuName ("redirect URL name") — registered in the eBay Developer Portal,
    // maps to the actual callback URL configured there.
    ruName: process.env.EBAY_RU_NAME || null,
    environment: process.env.EBAY_ENVIRONMENT || 'SANDBOX', // SANDBOX | PRODUCTION
    // Marketplace Account Deletion/Closure Notification compliance (mandatory
    // for every production keyset). Must match exactly what's saved in the
    // Developer Portal's "Alerts & Notifications" tab: 32-80 chars, only
    // alphanumeric/underscore/hyphen.
    deletionVerificationToken: process.env.EBAY_DELETION_VERIFICATION_TOKEN || null,
    // The full public HTTPS endpoint URL exactly as registered with eBay —
    // used as one of the three inputs to the challenge-response hash, so it
    // must match byte-for-byte (no trailing slash mismatch, etc).
    deletionEndpointUrl: process.env.EBAY_DELETION_ENDPOINT_URL || null,
  },

  google: {
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || null,
    serviceAccountPrivateKey: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || null,
  },
};

module.exports = config;
