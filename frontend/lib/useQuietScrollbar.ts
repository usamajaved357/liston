"use client";

import { RefObject, useCallback } from "react";

// A scroll area whose scrollbar shows only while someone is scrolling it
// (wheel or trackpad, touch, the keyboard, dragging the bar) and goes again
// a moment after they stop, the way a phone's does. Liston's own scrolling
// (opening a chat at its latest message, keeping it there) doesn't show it.
// Returns a callback ref for the scroll area, which also wears the
// `scroll-quiet` class; `target` gets the element too, for code that
// scrolls it. Marks the element with data-scrolling, so scrolling doesn't
// re-render anything.
const HIDE_MS = 900;
// How long after a wheel turn, touch or key a scroll still counts as theirs
// (a trackpad's glide keeps sending wheel turns until it stops).
const INPUT_MS = 800;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function useQuietScrollbar<T extends HTMLElement>(target?: RefObject<T | null>) {
  return useCallback(
    (el: T | null) => {
      if (target) target.current = el;
      if (!el) return;
      let inputAt = 0;
      let held = false;
      let hide: ReturnType<typeof setTimeout> | undefined;
      const input = () => (inputAt = Date.now());
      const key = (e: KeyboardEvent) => {
        const t = e.target as HTMLElement | null;
        if (t?.closest("input, textarea, select, [contenteditable]")) return;
        if (SCROLL_KEYS.has(e.key)) input();
      };
      const down = () => {
        held = true;
        input();
      };
      const up = () => {
        if (!held) return;
        held = false;
        input();
      };
      const scrolled = () => {
        if (!held && Date.now() - inputAt > INPUT_MS) return;
        el.dataset.scrolling = "";
        clearTimeout(hide);
        hide = setTimeout(function fade() {
          if (held) hide = setTimeout(fade, HIDE_MS);
          else delete el.dataset.scrolling;
        }, HIDE_MS);
      };
      el.addEventListener("wheel", input, { passive: true });
      el.addEventListener("touchmove", input, { passive: true });
      el.addEventListener("pointerdown", down);
      window.addEventListener("pointerup", up);
      window.addEventListener("keydown", key);
      el.addEventListener("scroll", scrolled, { passive: true });
      return () => {
        clearTimeout(hide);
        delete el.dataset.scrolling;
        el.removeEventListener("wheel", input);
        el.removeEventListener("touchmove", input);
        el.removeEventListener("pointerdown", down);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("keydown", key);
        el.removeEventListener("scroll", scrolled);
        if (target) target.current = null;
      };
    },
    [target]
  );
}
