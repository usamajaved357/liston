"use client";

import { ReactNode, useEffect, useRef } from "react";

// Liston's tabs: one rounded capsule, the chosen tab filled in the brand
// colour — the Orders page's size (22px pills, 11.5px text, the count a touch
// smaller and dimmed), used for every page's tabs, filters and date ranges
// so they all read alike. On a narrow screen the row scrolls sideways
// (no scrollbar) and keeps the chosen tab in view.
//
// `role`: "tablist" for tabs that switch what the page lists, "radiogroup"
// for a choice of one (dates, markets). A tab can carry a `count`, an
// `icon` before its label (a flag), and `attention` (an amber dot).

export interface PillTab<T extends string> {
  key: T;
  label: ReactNode;
  count?: ReactNode;
  icon?: ReactNode;
  attention?: boolean;
  title?: string;
  // Tints the count when it asks for action (a queue waiting).
  countTone?: "default" | "alert";
}

export function PillTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  role = "tablist",
  disabled = false,
  className = "",
}: {
  tabs: PillTab<T>[];
  value: T;
  onChange: (key: T) => void;
  label?: string;
  role?: "tablist" | "radiogroup";
  disabled?: boolean;
  className?: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  const itemRole = role === "tablist" ? "tab" : "radio";

  // The chosen tab stays in view when the row is wider than the screen.
  useEffect(() => {
    const el = row.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    el.querySelector<HTMLElement>("[data-on]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);

  return (
    <div
      ref={row}
      role={role}
      aria-label={label}
      className={`inline-flex max-w-full flex-shrink-0 items-center overflow-x-auto rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
    >
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            role={itemRole}
            {...(itemRole === "tab" ? { "aria-selected": on } : { "aria-checked": on })}
            data-on={on || undefined}
            title={t.title}
            disabled={disabled}
            onClick={() => !on && onChange(t.key)}
            className={`flex h-[22px] flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[11.5px] font-medium transition-colors disabled:opacity-60 ${
              on ? "bg-[var(--color-primary)] text-white shadow-sm" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            }`}
          >
            {t.icon && <span aria-hidden>{t.icon}</span>}
            {t.label}
            {t.count !== undefined && t.count !== null && (
              <span className={`text-[10.5px] tabular-nums ${on ? "text-white/70" : t.countTone === "alert" ? "font-semibold text-indigo-600" : "text-[var(--color-muted)]/70"}`}>{t.count}</span>
            )}
            {t.attention && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label="Needs attention" />}
          </button>
        );
      })}
    </div>
  );
}
