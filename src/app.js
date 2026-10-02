const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const logger = require('./utils/logger');
const config = require('./config');
const errorHandler = require('./middleware/errorHandler.middleware');
const { requireAuth, requireAccess } = require('./middleware/auth.middleware');

const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/user.routes');
const connectionRoutes = require('./modules/connections/connection.routes');
const ebayRoutes = require('./modules/ebay/ebay.routes');
const listingRoutes = require('./modules/listings/listing.routes');
const teamRoutes = require('./modules/team/team.routes');
const overviewRoutes = require('./modules/overview/overview.routes');

function createApp() {
  const app = express();

  app.use(helmet());
  // Open in development; in production only the deployed frontend may call
  // the API with a browser (server-to-server callers like eBay's
  // notifications don't send an Origin and are unaffected).
  // FRONTEND_URL plus any extra CORS_ORIGINS (comma-separated, e.g. a custom
  // domain), trailing slashes ignored — a stray "/" silently blocked every
  // browser call once.
  const allowedOrigins = [config.frontendUrl, ...(process.env.CORS_ORIGINS || '').split(',')]
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  app.use(
    cors({
      origin: config.env === 'production' ? allowedOrigins : true,
      // X-Liston-Token: a sign-in renewed while in use (auth.middleware).
      exposedHeaders: ['Content-Disposition', 'X-Liston-Token'],
    })
  );
  // 2mb accommodates base64 profile-photo uploads (src/modules/users) on top of normal JSON bodies
  const jsonBody = express.json({
    limit: '2mb',
    // eBay's REST push is verified against the exact bytes it signed.
    verify: (req, res, buf) => {
      if (req.originalUrl.startsWith('/api/ebay/commerce-notifications')) req.rawBody = buf.toString('utf8');
    },
  });
  // A listing photo upload parses its own, larger body (a base64 photo runs
  // to ~16MB for eBay's 12MB cap). Parsed here first, anything over 2MB was
  // refused before it reached that route — every AI-made PNG, in practice.
  // A shared file (/api/files) arrives as raw bytes, up to 25MB, parsed by its own route.
  const OWN_BODY = /^\/api\/(?:listings\/[^/]+\/images\/upload|files)(?:\?|$)/;
  app.use((req, res, next) => (OWN_BODY.test(req.originalUrl) ? next() : jsonBody(req, res, next)));

  // Lightweight request log — no bodies (may contain passwords/credentials)
  app.use((req, res, next) => {
    logger.info(`${req.method} ${req.path}`);
    next();
  });

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Static legal pages (e.g. the privacy policy URL required by eBay's
  // "User Tokens (eBay Sign-In)" OAuth setup).
  app.use(express.static(path.join(__dirname, 'public')));

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  // Everything below the approval gate needs an approved owner (members
  // inherit their owner's status). /api/auth and /api/users stay open so a
  // pending user can log in, see the review screen, and manage their login.
  // eBay's own callbacks (/api/ebay/*) carry no user session and stay open.
  app.use('/api/connections', requireAuth, requireAccess, connectionRoutes);
  app.use('/api/ebay', ebayRoutes);
  app.use('/api/listings', requireAuth, requireAccess, listingRoutes);
  app.use('/api/hunting', requireAuth, requireAccess, require('./modules/hunting/hunting.routes'));
  app.use('/api/team', requireAuth, requireAccess, teamRoutes);
  app.use('/api/notifications', requireAuth, requireAccess, require('./modules/notifications/notifications.routes'));
  app.use('/api/source-accounts', requireAuth, requireAccess, require('./modules/orders/source-account.routes'));
  app.use('/api/overview', overviewRoutes);
  // The Inbox's foundations: a person's live channel, shared files, and Liston cards.
  app.use('/api/me', requireAuth, requireAccess, require('./modules/realtime/realtime.routes'));
  app.use('/api/files', requireAuth, requireAccess, require('./modules/files/files.routes'));
  app.use('/api/references', requireAuth, requireAccess, require('./modules/references/references.routes'));
  app.use('/api/chat', requireAuth, requireAccess, require('./modules/chat/chat.routes'));
  // Every account's eBay messages the person may read (the Inbox outside an account).
  app.get('/api/inbox', requireAuth, requireAccess, require('./modules/inbox/inbox.controller').listAll);
  // How many unread conversations each of those accounts has (the account rail's counts).
  app.get('/api/inbox/unread', requireAuth, requireAccess, require('./modules/inbox/inbox.controller').unreadAll);
  // The bytes of shared files, by signed or unguessable link (an <img> sends no sign-in).
  app.use('/media', require('./modules/files/media.routes'));

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);

  return app;
}

module.exports = createApp;
