// Runs only on Liston's own origin (see manifest.json's content_scripts
// matches) — the only thing standing between the web page (which can't call
// chrome.runtime directly) and the extension's background worker. Holds no
// credentials and makes no calls to Liston's backend itself; it only relays
// "please scrape this URL" requests and their results.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== 'liston-page') return;

  chrome.runtime.sendMessage({ type: message.type, url: message.url }, (response) => {
    window.postMessage(
      { source: 'liston-extension', requestId: message.requestId, ...response },
      window.location.origin
    );
  });
});
