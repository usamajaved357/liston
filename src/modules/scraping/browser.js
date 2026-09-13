const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
const config = require('../../config');
const logger = require('../../utils/logger');
const { ScrapingError } = require('./scraping.errors');

// eBay/AliExpress both bot-check aggressively (PerimeterX-style fingerprinting)
// and serve a soft "error"/challenge page instead of the real listing to a
// vanilla headless Playwright session — confirmed live this session. The
// stealth plugin patches the much broader set of automation tells (chrome
// runtime, permissions.query, WebGL vendor, iframe contentWindow, etc.) that
// hand-rolled property overrides don't cover.
chromium.use(stealthPlugin());

const NAV_TIMEOUT_MS = 30 * 1000;
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let warnedNoProxy = false;

// Playwright's `proxy` launch option wants credentials split out of the URL
// (`server` is bare host:port), not embedded — parse a plain
// "http://user:pass@host:port" string into that shape.
function parseProxyConfig(proxyUrl) {
  if (!proxyUrl) {
    if (!warnedNoProxy) {
      logger.warn(
        'SCRAPER_PROXY_URL not set — scraping eBay/AliExpress from this server\'s own IP, which real anti-bot systems can rate-limit under sustained use.'
      );
      warnedNoProxy = true;
    }
    return undefined;
  }
  const parsed = new URL(proxyUrl);
  return {
    server: `${parsed.protocol}//${parsed.host}`,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
  };
}

// Launches a real (headless) browser per call rather than pooling — scrapes
// are infrequent (user-triggered, not a crawler), and a fresh context avoids
// any state leaking between unrelated scrapes. Always closes, even on error.
async function withPage(url, fn, { source } = {}) {
  const browser = await chromium.launch({
    args: ['--disable-blink-features=AutomationControlled'],
    proxy: parseProxyConfig(config.scraperProxyUrl),
  });
  try {
    const context = await browser.newContext({
      userAgent: DESKTOP_USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch {
      throw new ScrapingError(
        `Couldn't load ${source === 'aliexpress' ? 'the AliExpress product page' : 'the eBay listing'} — it may be down or blocking automated requests.`,
        { source }
      );
    }

    return await fn(page);
  } finally {
    await browser.close();
  }
}

module.exports = { withPage, parseProxyConfig };
