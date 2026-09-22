"use client";

import { useEffect, useRef } from "react";

// Live updates for one account: the server streams a small event whenever
// that account's listings, orders or count were re-read from eBay (after
// an eBay push notification, one of our own publishes, or a Refresh), and
// the page re-fetches what it shows. Uses fetch streaming rather than
// EventSource so the auth token travels in a header, never in the URL.
// Reconnects with backoff if the stream drops.

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export type AccountEvent = { type: "updated"; kind: "listings" | "orders" | "activeCount" | "analytics"; at: string };

export function useAccountEvents(connectionId: string | null | undefined, onEvent: (event: AccountEvent) => void) {
  // The latest handler, so the stream never has to be re-opened because a
  // page's callback identity changed.
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!connectionId) return;
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) return;

    let stopped = false;
    let attempt = 0;
    const controller = new AbortController();

    async function listen() {
      while (!stopped) {
        try {
          const res = await fetch(`${API_URL}/api/connections/${connectionId}/events`, {
            headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          attempt = 0;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let at;
            while ((at = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, at);
              buffer = buffer.slice(at + 2);
              const data = frame
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("");
              if (!data || frame.startsWith("event: ready")) continue;
              try {
                const event = JSON.parse(data) as AccountEvent;
                if (event.type === "updated") handler.current(event);
              } catch {
                // Not for us.
              }
            }
          }
        } catch {
          if (stopped) return;
        }
        // Dropped or refused: wait, then reconnect (2s, 4s, … up to 30s).
        attempt += 1;
        await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * 2 ** (attempt - 1))));
      }
    }

    listen();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [connectionId]);
}
