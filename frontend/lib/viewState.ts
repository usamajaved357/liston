"use client";

// Where a page was left — its filters, sort, page and scroll — so coming
// back to it (the browser's Back, or its sidebar link) shows the same
// view instead of starting over. Kept in memory for moves inside the app
// and in sessionStorage for a reload; per tab, gone when the tab closes.
// Storage can be unavailable (private windows, blocked site data): every
// read and write is guarded, and the page simply starts fresh.

const memory = new Map<string, unknown>();
const PREFIX = "liston:view:";

export function readView<T>(key: string): Partial<T> {
  if (memory.has(key)) return memory.get(key) as Partial<T>;
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    if (raw) {
      const value = JSON.parse(raw) as Partial<T>;
      memory.set(key, value);
      return value;
    }
  } catch {
    // no storage: start fresh
  }
  return {};
}

/** Merges `patch` into the saved view for `key`. */
export function writeView<T>(key: string, patch: Partial<T>) {
  const next = { ...(memory.get(key) as object | undefined), ...patch };
  memory.set(key, next);
  try {
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify(next));
  } catch {
    // no storage: memory still covers moves inside the app
  }
}

// The last response a page showed, for an instant first paint when it's
// opened again (it is re-read straight after). Memory only.
const responses = new Map<string, unknown>();
export const cachedResponse = <T,>(key: string) => responses.get(key) as T | undefined;
export const cacheResponse = (key: string, value: unknown) => void responses.set(key, value);
