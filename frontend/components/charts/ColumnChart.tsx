"use client";

import { useState } from "react";
import { niceTicks } from "./chart-format";

// Values in order as columns on one axis, with a hover readout: the leading
// listings' sales a month, say, from the best seller down, so a market that
// one listing carries looks different from one many share. Bars grow from
// the baseline with rounded tops, in the brand colour; the axis shows whole
// steps only.

export function ColumnChart({
  items,
  format,
  label,
  height = 150,
}: {
  items: { key: string; label: string; value: number; axis?: string }[];
  format: (v: number) => string;
  label: string;
  height?: number;
}) {
  // Short labels under the columns when every item has one (price bands, say).
  const axis = items.every((i) => i.axis);
  const [active, setActive] = useState<number | null>(null);
  if (!items.length) return null;
  const max = Math.max(...items.map((i) => i.value), 1);
  const ticks = niceTicks(max, 3);
  const top = ticks[ticks.length - 1] || max;
  const shown = active === null ? null : items[active];
  return (
    <div role="img" aria-label={label} className="relative">
      <div className="flex gap-2" style={{ height }}>
        <div className="flex w-9 flex-shrink-0 flex-col-reverse justify-between pb-0 text-right text-[10.5px] tabular-nums text-[var(--color-muted)]">
          {ticks.map((t) => (
            <span key={t} className="leading-none">
              {format(t)}
            </span>
          ))}
        </div>
        <div className="relative flex min-w-0 flex-1 items-end gap-[3px] border-b border-[var(--color-line)]" onMouseLeave={() => setActive(null)}>
          {ticks.slice(1).map((t) => (
            <span key={t} className="pointer-events-none absolute inset-x-0 border-t border-dashed border-[var(--color-line)]" style={{ bottom: `${(t / top) * 100}%` }} />
          ))}
          {items.map((item, i) => (
            <button
              key={item.key}
              type="button"
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              title={`${item.label}: ${format(item.value)}`}
              className="relative flex h-full min-w-0 flex-1 items-end outline-none"
            >
              <span
                className={`block w-full rounded-t-[4px] transition-opacity ${active === null || active === i ? "opacity-100" : "opacity-45"} bg-[var(--color-primary)]`}
                style={{ height: `${Math.max(item.value > 0 ? 2 : 0, (item.value / top) * 100)}%` }}
              />
            </button>
          ))}
        </div>
      </div>
      {axis && (
        <div className="mt-1 flex gap-[3px] pl-11 text-[10.5px] tabular-nums text-[var(--color-muted)]">
          {items.map((item) => (
            <span key={item.key} className="min-w-0 flex-1 truncate text-center">
              {item.axis}
            </span>
          ))}
        </div>
      )}
      <p className="mt-1.5 h-4 truncate pl-11 text-[11.5px] text-[var(--color-muted)]">
        {shown ? (
          <>
            <span className="font-semibold tabular-nums text-[var(--color-ink)]">{format(shown.value)}</span> · {shown.label}
          </>
        ) : (
          "Point at a column for its figure"
        )}
      </p>
    </div>
  );
}
