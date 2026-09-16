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
async function withPage(url, fn, { source, currency = 'GBP', region = 'GB' } = {}) {
  const browser = await chromium.launch({
    args: ['--disable-blink-features=AutomationControlled'],
    proxy: parseProxyConfig(config.scraperProxyUrl),
  });
  try {
    const context = await browser.newContext({
      userAgent: DESKTOP_USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: 'en-GB',
    });

    // AliExpress prices in the CURRENCY OF THE VIEWER'S APPARENT LOCATION, and
    // this server's location is not the seller's market — confirmed live, the
    // same product quoted "Rs.849" (Pakistani rupees) from here. A scraped
    // price is now the basis for the eBay sell price, so reading it in the
    // wrong currency wouldn't be a display nit, it would set every price
    // wrong by a factor of ~350. These cookies pin the storefront to the
    // target market; confirmed live to switch the same product to "￡0.99".
    if (source === 'aliexpress') {
      await context.addCookies([
        {
          name: 'aep_usuc_f',
          value: `site=glo&c_tp=${currency}&region=${region}&b_locale=en_GB`,
          domain: '.aliexpress.com',
          path: '/',
        },
        { name: 'xman_us_f', value: 'x_l=0&x_locale=en_GB', domain: '.aliexpress.com', path: '/' },
      ]);
    }

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

    // Pinning the storefront's currency makes AliExpress apply it by
    // reloading, which destroys the execution context out from under whatever
    // is reading the page — and it fires several seconds in, so it lands in
    // the middle of the scraper's polling rather than before it ("Execution
    // context was destroyed", confirmed live the moment the currency cookies
    // went in). Loading a second time sidesteps the race: by then the
    // storefront is already in the right currency, so there's nothing left to
    // redirect for.
    if (source === 'aliexpress') {
      await page.waitForTimeout(2000);
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    return await fn(page);
  } finally {
    await browser.close();
  }
}

module.exports = { withPage, parseProxyConfig };
