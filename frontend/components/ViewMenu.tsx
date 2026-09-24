"use client";

import { useEffect, useRef, useState } from "react";

// One compact button for how a list is shown ("Last 7 days · Newest"),
// opening a small menu with a section per choice (period, sort…). Keeps a
// page's toolbar to one control instead of a dropdown per setting. The menu
// stays open while choosing, so both can be set in one go; a click outside
// or Escape closes it.

export interface ViewMenuSection {
  label: string;
  value: string;
  // `short`: the option's name on the button ("7 days" for "Last 7 days");
  // `count`: how many rows it would show, listed beside it in the menu.
  options: { key: string; label: string; short?: string; count?: number }[];
  onChange: (key: string) => void;
  // Leave this section off the button (a filter set to "Any", say).
  hideInSummary?: boolean;
}

export function ViewMenu({ sections, title = "View" }: { sections: ViewMenuSection[]; title?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const summary = sections
    .filter((s) => !s.hideInSummary)
    .map((s) => {
      const option = s.options.find((o) => o.key === s.value);
      return option?.short ?? option?.label ?? s.value;
    })
    .join(" · ");

  return (
    <div ref={wrap} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        className={`flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[12px] font-medium transition-colors ${
          open ? "border-[var(--color-primary)] text-[var(--color-ink)]" : "border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-ink)] hover:border-slate-300"
        }`}
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 text-[var(--color-muted)]" aria-hidden>
          <path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="16" cy="7" r="2" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="10" cy="17" r="2" stroke="currentColor" strokeWidth="1.8" />
        </svg>
        {summary}
        <svg viewBox="0 0 24 24" fill="none" className={`h-3.5 w-3.5 text-[var(--color-muted)] transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1.5 w-60 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] py-1 shadow-lg">
          {sections.map((s, i) => (
            <div key={s.label} className={i > 0 ? "mt-1 border-t border-[var(--color-line)] pt-1" : undefined}>
              <p className="px-3 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{s.label}</p>
              {s.options.map((o) => {
                const active = o.key === s.value;
                return (
                  <button
                    key={o.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => s.onChange(o.key)}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--color-paper)] ${
                      active ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-ink)]"
                    }`}
                  >
                    {o.label}
                    <span className="flex items-center gap-2">
                      {o.count !== undefined && <span className="text-[11.5px] font-normal tabular-nums text-[var(--color-muted)]">{o.count}</span>}
                      {active ? (
                        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
                          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <span className="w-3.5" aria-hidden />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
