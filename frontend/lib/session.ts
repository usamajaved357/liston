import { useSyncExternalStore } from "react";
import type { User } from "@/lib/api";

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

/**
 * This browser's sign-in ended: the API refused it, or the live channel
 * said the login's password changed (`reason: "password"`; every device of
 * the login is signed out then, this one too). `token`: the sign-in that
 * ended; when this browser holds a newer one already (the new password was
 * just used in another tab), the page reloads with that instead. Otherwise
 * it's forgotten and the sign-in page says why.
 */
export function endSession(token: string | null, reason?: unknown) {
  if (typeof window === "undefined") return;
  try {
    const now = localStorage.getItem("token");
    if (token && now && now !== token) {
      window.location.reload();
      return;
    }
    localStorage.removeItem("token");
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the sign-in page still opens
  }
  if (!window.location.pathname.startsWith("/login")) window.location.assign(reason === "password" ? "/login?reason=password" : "/login");
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
