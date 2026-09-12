const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler.middleware');

const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/user.routes');
const connectionRoutes = require('./modules/connections/connection.routes');
const ebayRoutes = require('./modules/ebay/ebay.routes');

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  // 2mb accommodates base64 profile-photo uploads (src/modules/users) on top of normal JSON bodies
  app.use(express.json({ limit: '2mb' }));

  // Lightweight request log — no bodies (may contain passwords/credentials)
  app.use((req, res, next) => {
    logger.info(`${req.method} ${req.path}`);
    next();
  });

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/connections', connectionRoutes);
  app.use('/api/ebay', ebayRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);

  return app;
}

module.exports = createApp;
