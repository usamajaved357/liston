"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { teamHeaders } from "@/lib/team";

// The signed-in person's live channel (GET /api/me/events): one stream per
// tab, shared by everything that listens (the Inbox, the sidebar's unread
// badge), opened with the first listener and closed with the last. Uses
// fetch streaming so the token travels in a header, never in the URL, and
// reconnects with backoff. Also tells the server which conversation this tab
// shows, so nobody is pushed about a conversation they're reading.

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export type MyEvent = { type: string; [key: string]: unknown };
type Listener = (event: MyEvent) => void;

const listeners = new Set<Listener>();
// Told when the stream (re)connects, so a page can catch up on what it missed.
const reconnectListeners = new Set<() => void>();
let controller: AbortController | null = null;

function start() {
  if (controller || typeof window === "undefined") return;
  const token = localStorage.getItem("token");
  if (!token) return;
  controller = new AbortController();
  const signal = controller.signal;
  let attempt = 0;
  let first = true;
  (async () => {
    while (!signal.aborted) {
      try {
        const res = await fetch(`${API_URL}/api/me/events`, { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream", ...teamHeaders() }, signal });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        attempt = 0;
        if (!first) reconnectListeners.forEach((fn) => fn());
        first = false;
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
            if (frame.startsWith("event: ready")) continue;
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("");
            if (!data) continue;
            try {
              const event = JSON.parse(data) as MyEvent;
              listeners.forEach((fn) => fn(event));
            } catch {
              // Not for us.
            }
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      attempt += 1;
      await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * 2 ** (attempt - 1))));
    }
  })();
}

function stop() {
  controller?.abort();
  controller = null;
}

/** Calls `onEvent` with each of the person's live events while mounted. */
export function useMyEvents(onEvent: Listener, onReconnect?: () => void) {
  const handler = useRef(onEvent);
  const reconnect = useRef(onReconnect);
  useEffect(() => {
    handler.current = onEvent;
    reconnect.current = onReconnect;
  });
  useEffect(() => {
    const fn: Listener = (e) => handler.current(e);
    const re = () => reconnect.current?.();
    listeners.add(fn);
    reconnectListeners.add(re);
    start();
    return () => {
      listeners.delete(fn);
      reconnectListeners.delete(re);
      if (!listeners.size) stop();
    };
  }, []);
}

// ---- what this tab shows ------------------------------------------------------------

const TAB_ID = typeof window !== "undefined" ? (window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`) : "server";

function report(view: string | null) {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  if (!token) return;
  fetch(`${API_URL}/api/me/presence`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...teamHeaders() },
    body: JSON.stringify({ tabId: TAB_ID, view, focused: document.visibilityState === "visible" && document.hasFocus() }),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Tells the server this tab shows `view` ("chat:<id>", "ebay:<account>:<id>")
 * while it's mounted, again when the tab gains or loses focus, and every
 * minute so the server knows it's still there.
 */
export function useViewing(view: string | null) {
  useEffect(() => {
    if (!view) return;
    report(view);
    const again = () => report(view);
    window.addEventListener("focus", again);
    window.addEventListener("blur", again);
    document.addEventListener("visibilitychange", again);
    const beat = setInterval(again, 60 * 1000);
    return () => {
      window.removeEventListener("focus", again);
      window.removeEventListener("blur", again);
      document.removeEventListener("visibilitychange", again);
      clearInterval(beat);
      report(null);
    };
  }, [view]);
}

// ---- unread, for the sidebar --------------------------------------------------------

// Team chat's unread: messages in conversations, those that are mentions, and new replies in threads they follow.
type Unread = { unread: number; mentions: number; threads: number };
let unread: Unread = { unread: 0, mentions: 0, threads: 0 };
const unreadListeners = new Set<() => void>();

/** Sets the person's unread team chat (the Inbox refreshes it as it reads). */
export function setChatUnread(next: { unread: number; mentions: number; threads?: number }) {
  const value = { unread: next.unread, mentions: next.mentions, threads: next.threads ?? 0 };
  if (value.unread === unread.unread && value.mentions === unread.mentions && value.threads === unread.threads) return;
  unread = value;
  unreadListeners.forEach((fn) => fn());
}

export function useChatUnreadValue(): Unread {
  return useSyncExternalStore(
    (fn) => {
      unreadListeners.add(fn);
      return () => unreadListeners.delete(fn);
    },
    () => unread,
    () => unread
  );
}

// ---- the time, for "waiting 3h" ------------------------------------------------------

/** The time now, moving on every minute (for labels like "Waiting 3h"). */
export function useNow(everyMs = 60 * 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
