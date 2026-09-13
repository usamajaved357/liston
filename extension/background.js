// Classic (non-module) service worker — importScripts makes extractEbayFields/
// extractAliexpressFields available in this file's global scope, so they can
// be passed directly to chrome.scripting.executeScript's `func`, exactly like
// the Node scraper passes the same functions to Playwright's `page.evaluate`.
// These files are copies of src/modules/scraping/dom-extractors/*.js — see
// the comment at the top of each for why (no build step in this repo to
// share them by reference instead).
importScripts('dom-extractors/ebay.js', 'dom-extractors/aliexpress.js');

const TAB_LOAD_TIMEOUT_MS = 20 * 1000;
const EXTRACT_TIMEOUT_MS = 15 * 1000;

function pickExtractor(url) {
  const hostname = new URL(url).hostname;
  if (hostname.includes('ebay.')) return extractEbayFields;
  if (hostname.includes('aliexpress.')) return extractAliexpressFields;
  return null;
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out waiting for the page to load'));
    }, TAB_LOAD_TIMEOUT_MS);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function scrapeUrl(url) {
  const extractor = pickExtractor(url);
  if (!extractor) throw new Error(`Don't know how to read this URL: ${url}`);

  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id);

    const [{ result }] = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractor }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out reading the page')), EXTRACT_TIMEOUT_MS)),
    ]);
    return result;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'SCRAPE_URL') {
    scrapeUrl(message.url)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }

  return false;
});
