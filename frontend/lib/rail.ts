"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { ebayInboxApi } from "@/lib/api";
import { useMyEvents } from "@/lib/useMyEvents";

// The account rail beside the sidebar (Slack's workspace column): shown or
// hidden by the button at the top of the sidebar, hidden until someone
// shows it, and remembered on this browser for every page and tab.

const KEY = "liston:rail";
const EVENT = "liston:rail";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "shown";
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void) {
  const onStorage = (e: StorageEvent) => e.key === KEY && onChange();
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setRailShown(shown: boolean) {
  try {
    localStorage.setItem(KEY, shown ? "shown" : "hidden");
  } catch {
    // storage unavailable: it still changes on this page
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Whether the account rail is shown (false on the server and until someone shows it). */
export function useRailShown(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}

// Each account's unread eBay conversations, for the rail's tiles: read once
// for every account in one call, kept between pages, read again when
// Liston hears an account's messages changed, and set at once when the
// open Inbox reads conversations ("liston:inbox-unread").

type Counts = Record<string, number>;
const EMPTY: Counts = {};
let counts: Counts = EMPTY;
let readAt = 0;
const listeners = new Set<() => void>();

function setCounts(next: Counts) {
  counts = next;
  listeners.forEach((l) => l());
}

function load() {
  readAt = Date.now();
  ebayInboxApi
    .unreadByAccount()
    .then((r) => setCounts(r.accounts))
    .catch(() => {});
}

function subscribeCounts(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function useAccountsUnread(): Counts {
  const value = useSyncExternalStore(subscribeCounts, () => counts, () => EMPTY);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soon = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 400);
  };
  useEffect(() => {
    // A page change re-reads only when the last read is a little old.
    if (Date.now() - readAt > 20000) load();
    const onCounts = (e: Event) => {
      const detail = (e as CustomEvent<{ connectionId: string; unread: number }>).detail;
      if (detail?.connectionId) setCounts({ ...counts, [detail.connectionId]: detail.unread });
    };
    window.addEventListener("liston:inbox-unread", onCounts);
    return () => {
      window.removeEventListener("liston:inbox-unread", onCounts);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useMyEvents((e) => {
    if (e.type === "inbox.updated") soon();
  }, soon);
  return value;
}

// The account finder (components/AccountFinder.tsx): opened from the rail's
// Search, the search button at the top of the sidebar, or Ctrl/Cmd+K.
export const FIND_EVENT = "liston:find-account";
export function openFinder() {
  window.dispatchEvent(new Event(FIND_EVENT));
}
