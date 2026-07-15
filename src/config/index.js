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
  photoroomApiKey: process.env.PHOTOROOM_API_KEY || null,

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || null,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
  },

  google: {
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || null,
    serviceAccountPrivateKey: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || null,
  },
};

module.exports = config;
