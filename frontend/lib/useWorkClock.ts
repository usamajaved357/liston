"use client";

import { useEffect, useRef } from "react";
import { teamHeaders } from "@/lib/team";
import { usePathname } from "next/navigation";

// A team member's time in Liston: once a minute each open tab says whether
// they're working (a click, key press, scroll or touch in it within the last
// couple of minutes, time to read what's on screen) or idle (open, nothing
// done), and where they are (the area and the eBay account in the address).
// After half an hour with nothing done the tab goes quiet: they're away, and
// a tab left open overnight isn't counted. The server keeps one row a minute
// (working if any tab was) and keeps members' only; the owner sees it on the
// member's Team page. Mounted once, by the shell every signed-in page uses,
// and on only for a member.

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
const BEAT_MS = 60 * 1000;
const WORKING_WITHIN_MS = 2 * 60 * 1000;
const IDLE_UP_TO_MS = 30 * 60 * 1000;
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "mousemove", "scroll"] as const;

// An account page's section, as the server's area.
const SECTIONS: Record<string, string> = {
  "": "overview",
  hunting: "hunting",
  research: "research",
  listings: "listings",
  orders: "orders",
  inbox: "inbox",
  analytics: "analytics",
  campaigns: "campaigns",
  settings: "settings",
};

/** Where in Liston a page is: its area, and the eBay account in its address. */
export function whereIs(path: string): { area: string; connectionId: string | null } {
  const account = path.match(/^\/accounts\/([0-9a-f-]{36})(?:\/([a-z-]+))?/i);
  if (account) return { area: SECTIONS[account[2] || ""] ?? "other", connectionId: account[1] };
  if (path.startsWith("/inbox")) return { area: "inbox", connectionId: null };
  if (path === "/" || path.startsWith("/dashboard")) return { area: "dashboard", connectionId: null };
  if (path.startsWith("/settings") || path.startsWith("/account")) return { area: "settings", connectionId: null };
  return { area: "other", connectionId: null };
}

export function useWorkClock(member: boolean) {
  const path = usePathname();
  const where = useRef(whereIs(path || "/"));
  useEffect(() => {
    where.current = whereIs(path || "/");
  }, [path]);

  useEffect(() => {
    if (!member) return;
    let lastInput = Date.now();
    const onInput = () => {
      lastInput = Date.now();
    };
    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { passive: true, capture: true });
    const beat = () => {
      const since = Date.now() - lastInput;
      const token = localStorage.getItem("token");
      if (since > IDLE_UP_TO_MS || !token) return;
      fetch(`${API_URL}/api/team/clock`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...teamHeaders() },
        body: JSON.stringify({ working: since <= WORKING_WITHIN_MS, ...where.current }),
        keepalive: true,
      }).catch(() => {});
    };
    beat();
    const timer = setInterval(beat, BEAT_MS);
    return () => {
      clearInterval(timer);
      for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput, { capture: true });
    };
  }, [member]);
}
