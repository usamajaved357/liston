"use client";

import { ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

// `separated`: a rule above it, setting it apart (an End or a Delete after the rest).
export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; icon?: ReactNode; separated?: boolean };

/**
 * A small menu opened from a button (a bubble's chevron, a header's "…"),
 * drawn at the end of the page so no scrolling list clips it, below the
 * button or above it when there's no room, and closed by a pick, a click
 * elsewhere, Escape or scrolling.
 */
export function PopMenu({ anchor, items, onClose, align = "right" }: { anchor: HTMLElement | null; items: MenuItem[]; onClose: () => void; align?: "left" | "right" }) {
  const menu = useRef<HTMLDivElement>(null);

  // Placed once it's measured (drawn off-screen first).
  useLayoutEffect(() => {
    const el = menu.current;
    if (!anchor || !el) return;
    const a = anchor.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    const below = a.bottom + 4 + m.height <= window.innerHeight - 8;
    el.style.top = `${below ? a.bottom + 4 : Math.max(8, a.top - 4 - m.height)}px`;
    el.style.left = `${Math.min(Math.max(8, align === "right" ? a.right - m.width : a.left), window.innerWidth - m.width - 8)}px`;
  }, [anchor, align]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menu.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onScroll = (e: Event) => !menu.current?.contains(e.target as Node) && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    // React passes a portal's clicks up to the button's own parents: a pick
    // stops here, so it never reaches a clickable row behind the menu.
    <div
      ref={menu}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      className="fixed z-[70] min-w-[176px] rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] py-1.5 shadow-[var(--shadow-pop)]"
      style={{ top: -9999, left: -9999 }}
    >
      {items.map((item) => [
        item.separated ? <div key={`${item.label}-rule`} className="my-1.5 border-t border-[var(--color-line)]" role="separator" /> : null,
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition-colors hover:bg-[var(--color-paper)] ${item.danger ? "text-rose-600" : "text-[var(--color-ink)]"}`}
        >
          {item.icon && <span className={`flex h-4 w-4 items-center justify-center ${item.danger ? "" : "text-[var(--color-muted)]"}`}>{item.icon}</span>}
          {item.label}
        </button>,
      ])}
    </div>,
    document.body
  );
}
