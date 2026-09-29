require('dotenv').config();
const crypto = require('crypto');
const { pool } = require('./src/db/client');
const authService = require('./src/modules/auth/auth.service');
const connectionService = require('./src/modules/connections/connection.service');
const mirror = require('./src/modules/ebay/ebay-mirror.repository');
const OUT = '/private/tmp/claude-501/-Users-apple-Documents-DevStackWorkspace-Projects-liston/8884e1ee-9d28-4e88-8312-ecad535239a9/scratchpad/overview-token.txt';
(async () => {
  const email = `overview-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = crypto.randomBytes(16).toString('hex');
  await authService.signup({ email, password, name: 'Overview Check' });
  await pool.query("UPDATE users SET access_status = 'active', email_verified_at = now() WHERE email = $1", [email]);
  const { token, user } = await authService.login({ email, password });
  const mk = async (label, live) => {
    const c = await connectionService.createConnection(user.id, { platformKey: 'ebay', label, credentials: { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: Date.now() + 30 * 86400000, marketplaceId: 'EBAY_GB' }, settings: { ebay: { marketplaceId: 'EBAY_GB' } } }, { planChecked: true });
    await mirror.saveSnapshot(c.id, 'active_count', { count: live });
    await mirror.saveSnapshot(c.id, 'orders', { count: 0 }, { shape: 7 });
    await mirror.saveSnapshot(c.id, 'listings:active', { items: [] });
    return c.id;
  };
  const w = await mk('Walexo', 201);
  await mk('Selvora Ltd', 29);
  for (let i = 0; i < 12; i++) await pool.query(`INSERT INTO listings (connection_id, status, generated_data) VALUES ($1, 'pending_review', '{}')`, [w]);
  await pool.query(
    `INSERT INTO hunted_products (owner_user_id, connection_id, hunter_user_id, competitor_url, competitor_item_id, source_url, source_product_id, title, currency, check_result, status, reviewer_user_id, decided_at)
     VALUES ($1, $2, $1, 'https://www.ebay.co.uk/itm/1', '1', 'https://www.aliexpress.com/item/1.html', '1', 'Product', 'GBP', '{}', 'approved', $1, now())`,
    [user.id, w]
  );
  require('fs').writeFileSync(OUT, token);
  console.log('seeded');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
