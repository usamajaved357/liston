"use client";

import { ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

// Chat bubbles the way WhatsApp draws them, shared by team chat and eBay
// messages: theirs white on the left, yours tinted on the right, the first
// of a run with a tail at its top corner and the rest tucked under it 2px
// apart. The time sits inside the bubble's bottom corner; the text keeps
// room for it on its last line (an invisible copy of the time at the end
// of the text), so a short message stays one line and a long one wraps
// around it. Also the day chip, the round "to the latest" button and the
// small menu a bubble's chevron opens.

// A bubble's widest: most of a phone's width, about two thirds of a chat pane, never a wall of text.
export const BUBBLE_MAX = "max-w-[85%] sm:max-w-[min(65%,440px)]";

/**
 * The row a bubble sits in: its side, and the gap above it (a new run gets
 * more room). `roomy` (eBay messages): 8px between one person's messages in
 * a run, 16px before the next run, where team chat keeps WhatsApp's 2px / 10px.
 */
export function BubbleRow({ mine, first, roomy = false, children, className = "", ...rest }: { mine: boolean; first: boolean; roomy?: boolean; children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  const gap = roomy ? (first ? "mt-4" : "mt-2") : first ? "mt-2.5" : "mt-0.5";
  return (
    <div className={`flex px-[clamp(14px,4%,48px)] ${mine ? "justify-end" : "justify-start"} ${gap} ${className}`} {...rest}>
      {children}
    </div>
  );
}

function Tail({ mine }: { mine: boolean }) {
  return mine ? (
    <svg viewBox="0 0 8 13" width="8" height="13" className="absolute -right-2 top-0 text-[var(--color-bubble-out)]" aria-hidden>
      <path d="M0 1h5c1.8 0 2.5 1.3 1.4 2.7L0 12z" fill="rgb(15 23 42 / 0.13)" />
      <path d="M0 0h5c1.8 0 2.5 1.3 1.4 2.7L0 11z" fill="currentColor" />
    </svg>
  ) : (
    <svg viewBox="0 0 8 13" width="8" height="13" className="absolute -left-2 top-0 text-[var(--color-panel)]" aria-hidden>
      <path d="M8 1H3C1.2 1 .5 2.3 1.6 3.7L8 12z" fill="rgb(15 23 42 / 0.13)" />
      <path d="M8 0H3C1.2 0 .5 1.3 1.6 2.7L8 11z" fill="currentColor" />
    </svg>
  );
}

/** The bubble itself: its colour, corner, shadow and tail. What's inside brings its own padding. */
export function Bubble({ mine, tail, children, className = "" }: { mine: boolean; tail: boolean; children: ReactNode; className?: string }) {
  return (
    <div
      className={`relative min-w-0 max-w-full rounded-lg text-[13.5px] leading-[19px] text-[var(--color-ink)] shadow-[var(--shadow-bubble)] ${mine ? "bg-[var(--color-bubble-out)]" : "bg-[var(--color-panel)]"} ${
        tail ? (mine ? "rounded-tr-none" : "rounded-tl-none") : ""
      } ${className}`}
    >
      {tail && <Tail mine={mine} />}
      {children}
    </div>
  );
}

/** The time (and anything beside it: "Edited", ticks) as it sits in a bubble's corner. */
export function Meta({ children, onPhoto = false }: { children: ReactNode; onPhoto?: boolean }) {
  return (
    <span className={`flex items-center gap-1 whitespace-nowrap text-[10.5px] leading-none tabular-nums ${onPhoto ? "text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.45)]" : "text-[var(--color-bubble-meta)]"}`}>{children}</span>
  );
}

/** A bubble's text with its time in the corner; the time keeps its room on the text's last line. */
export function BubbleText({ children, meta, className = "" }: { children: ReactNode; meta: ReactNode; className?: string }) {
  return (
    <div className={`relative px-[9px] pb-[7px] pt-[6px] ${className}`}>
      <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{children}</span>
      <span className="invisible inline-block h-0 pl-3 align-baseline" aria-hidden>
        <Meta>{meta}</Meta>
      </span>
      <span className="absolute bottom-[5px] right-[8px]">
        <Meta>{meta}</Meta>
      </span>
    </div>
  );
}

/** Read receipts: two ticks, blue once everyone it went to has read it. */
export function Ticks({ read }: { read: boolean }) {
  return (
    <svg viewBox="0 0 18 11" width="16" height="10" className={read ? "text-sky-500" : "text-[var(--color-bubble-meta)]"} aria-label={read ? "Read" : "Sent"}>
      <path d="M1 5.8l3 3L11 1.5M7.5 8l.8.8L15.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The day between messages, as a small chip in the middle ("Today", "Monday", "23 Sep"). */
export function DayChip({ label, sticky = false }: { label: string; sticky?: boolean }) {
  return (
    <div className={`pointer-events-none flex justify-center py-2 ${sticky ? "sticky top-0 z-10" : ""}`}>
      <span className="rounded-lg bg-[var(--color-panel)] px-3 py-[5px] text-[11.5px] font-medium text-[var(--color-muted)] shadow-[var(--shadow-bubble)]">{label}</span>
    </div>
  );
}

/** A line about the conversation itself ("Sara added Tom"), as WhatsApp shows it: a quiet chip in the middle. */
export function NoteChip({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center px-6 py-1.5">
      <span className="max-w-[85%] rounded-lg bg-[var(--color-panel)]/90 px-3 py-[5px] text-center text-[11.5px] leading-4 text-[var(--color-muted)] shadow-[var(--shadow-bubble)]">{children}</span>
    </div>
  );
}

/** The round button that takes you back down to the latest message, with how many came in meanwhile. */
export function LatestButton({ onClick, count = 0 }: { onClick: () => void; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={count ? `${count} new ${count === 1 ? "message" : "messages"}: go to the latest` : "Go to the latest message"}
      className="absolute bottom-3 right-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-panel)] text-[var(--color-muted)] shadow-[0_2px_8px_rgba(15,23,42,0.18)] transition-colors hover:text-[var(--color-ink)]"
    >
      {count > 0 && <span className="absolute -left-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-primary)] px-1 text-[10.5px] font-semibold text-white">{count > 99 ? "99+" : count}</span>}
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
        <path d="M6 9.5l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; icon?: ReactNode };

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
    <div
      ref={menu}
      role="menu"
      className="fixed z-[70] min-w-[176px] rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] py-1.5 shadow-[var(--shadow-pop)]"
      style={{ top: -9999, left: -9999 }}
    >
      {items.map((item) => (
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
        </button>
      ))}
    </div>,
    document.body
  );
}
