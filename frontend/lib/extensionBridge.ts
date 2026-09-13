// Talks to the Liston browser extension (see /extension) via postMessage —
// the extension's content script relays these to its background worker,
// which fetches a URL through the user's own browser instead of this
// server's IP. Extension not installed? Every call here just resolves
// false/failed quickly, and callers fall back to server-side scraping.

interface BridgeResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function postAndAwait(type: string, payload: Record<string, unknown> = {}, timeoutMs: number): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const requestId = Math.random().toString(36).slice(2);
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("The Liston extension did not respond in time"));
    }, timeoutMs);

    function handler(event: MessageEvent) {
      if (event.source !== window) return;
      const message = event.data;
      if (!message || message.source !== "liston-extension" || message.requestId !== requestId) return;
      clearTimeout(timeout);
      window.removeEventListener("message", handler);
      resolve(message);
    }

    window.addEventListener("message", handler);
    window.postMessage({ source: "liston-page", requestId, type, ...payload }, window.location.origin);
  });
}

export async function pingExtension(): Promise<boolean> {
  try {
    const response = await postAndAwait("PING", {}, 500);
    return response.ok === true;
  } catch {
    return false;
  }
}

export async function scrapeViaExtension(url: string): Promise<BridgeResponse> {
  try {
    return await postAndAwait("SCRAPE_URL", { url }, 25000);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Extension request failed" };
  }
}
