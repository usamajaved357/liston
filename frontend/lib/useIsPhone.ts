"use client";

import { useSyncExternalStore } from "react";

// Whether the screen is phone-sized (under Tailwind's `sm`, 640px), for the
// few controls that change shape there rather than just size (a menu
// becoming a bottom sheet). Follows the screen as it rotates.
const QUERY = "(max-width: 639px)";

function subscribe(onChange: () => void) {
  const list = window.matchMedia(QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false
  );
}
