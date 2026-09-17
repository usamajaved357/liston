import { useSyncExternalStore } from "react";
import { User } from "@/lib/api";

// The signed-in user, remembered locally so a page can paint its shell and
// skeletons on the very first render instead of a blank "Loading…" while
// /api/users/me round-trips. Always refreshed from the API afterwards; never
// trusted for anything security-related (the API enforces everything).
const KEY = "liston:me";

export function readCachedUser(): User | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function cacheUser(user: User | null) {
  if (typeof window === "undefined") return;
  try {
    if (user) localStorage.setItem(KEY, JSON.stringify(user));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable — nothing to do
  }
}

// Subscribe-free external store: the server (and the hydration pass) see
// `null`, so server and client HTML match; the client then re-renders once
// with whatever localStorage holds. Snapshot is memoised on the raw string so
// React sees a stable reference between reads.
let lastRaw: string | null = null;
let lastParsed: User | null = null;
function snapshot(): User | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== lastRaw) {
      lastRaw = raw;
      lastParsed = raw ? (JSON.parse(raw) as User) : null;
    }
    return lastParsed;
  } catch {
    return null;
  }
}
function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}
export function useCachedUser(): User | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
