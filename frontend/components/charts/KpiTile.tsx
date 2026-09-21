"use client";

import { DeltaBadge } from "./DeltaBadge";
import { Sparkline } from "./Sparkline";

// A headline figure: label, value, change from the previous period and a
// sparkline of the period. Selectable tiles act as the tabs of the chart
// below them (pressing one shows that measure in the chart).

export function KpiTile({
  label,
  value,
  change,
  compared,
  spark,
  selected,
  onSelect,
  info,
  loading,
  higherIsBetter = true,
}: {
  label: string;
  value: string;
  change?: number | null;
  compared?: string;
  spark?: (number | null)[];
  selected?: boolean;
  onSelect?: () => void;
  info?: string;
  loading?: boolean;
  higherIsBetter?: boolean;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 whitespace-nowrap text-[12.5px] font-medium text-[var(--color-muted)]">
          {label}
          {info && (
            <span title={info} className="cursor-help text-[var(--color-line-strong)] hover:text-[var(--color-muted)]" aria-label={info}>
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
                <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8 7.25v3.5M8 5.2v.05" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
          )}
        </span>
        {change !== undefined && !loading && <DeltaBadge change={change} compared={compared} higherIsBetter={higherIsBetter} size="sm" />}
      </div>
      {loading ? (
        <div className="mt-3 h-7 w-20 animate-pulse rounded-md bg-[var(--color-line)]" />
      ) : (
        <div className="mt-2 flex items-end justify-between gap-2">
          <p className="text-[26px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">{value}</p>
          {spark && <Sparkline values={spark} width={72} height={26} className={selected ? "text-[var(--color-primary)]" : "text-[var(--color-line-strong)]"} />}
        </div>
      )}
    </>
  );
  const base = "relative rounded-[var(--radius-card)] border p-4 text-left transition-colors";
  if (!onSelect) return <div className={`${base} border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-card)]`}>{body}</div>;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`${base} w-full shadow-[var(--shadow-card)] ${
        selected ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]" : "border-[var(--color-line)] bg-[var(--color-panel)] hover:border-[var(--color-line-strong)]"
      }`}
    >
      {body}
    </button>
  );
}
