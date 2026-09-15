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
  redisUrl: required('REDIS_URL'),

  // Used to build links in emailed tokens (verification/password-reset).
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3001',

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  credentialsEncryptionKey: credentialsEncryptionKey(),

  resend: {
    apiKey: process.env.RESEND_API_KEY || null,
    fromEmail: process.env.EMAIL_FROM || 'Liston <onboarding@resend.dev>',
  },

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  briaApiKey: process.env.BRIA_API_KEY || null,
  openaiApiKey: process.env.OPENAI_API_KEY || null,

  // Listing image generation. 'openai' produces genuine product photography
  // (a person holding the product, pure white background) from the supplier
  // photo as a reference; 'bria' only re-backgrounds the supplier cutout.
  // Selected automatically: openai when its key is set, else bria.
  imageGeneration: {
    provider: process.env.IMAGE_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'bria'),
    // The seller asked for these on the image. eBay's picture policy
    // discourages badges and borders on listing images, so they're each
    // switchable and the draft carries a warning when any are on.
    addUkFlag: process.env.IMAGE_ADD_UK_FLAG !== 'false',
    addFreeShippingLabel: process.env.IMAGE_ADD_FREE_SHIPPING !== 'false',
    addGlowBorder: process.env.IMAGE_ADD_GLOW_BORDER !== 'false',
    showPerson: process.env.IMAGE_SHOW_PERSON !== 'false',
    quality: process.env.IMAGE_QUALITY || 'high',
  },
  photoroomApiKey: process.env.PHOTOROOM_API_KEY || null,

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
