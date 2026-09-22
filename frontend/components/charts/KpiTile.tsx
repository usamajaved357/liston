"use client";

import { DeltaBadge } from "./DeltaBadge";
import { Sparkline } from "./Sparkline";

// A headline figure: label, value, change from the previous period and a
// sparkline of the period filling the space beside the change. Selectable tiles act as the tabs of the chart
// below them (pressing one shows that measure in the chart). The change
// sits on its own line under the value, as coloured text, so it never
// crowds the label however long the figure.

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
      <span className="flex min-w-0 items-center gap-1 text-[12px] font-medium text-[var(--color-muted)]">
        <span className="truncate">{label}</span>
        {info && (
          <span title={info} className="flex-shrink-0 cursor-help text-[var(--color-line-strong)] hover:text-[var(--color-muted)]" aria-label={info}>
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
              <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 7.25v3.5M8 5.2v.05" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
        )}
      </span>
      {loading ? (
        <>
          <div className="mt-2.5 h-6 w-20 animate-pulse rounded-md bg-[var(--color-line)]" />
          <div className="mt-2 h-3 w-14 animate-pulse rounded bg-[var(--color-line)]" />
        </>
      ) : (
        <>
          <p className="mt-1.5 truncate text-[22px] font-semibold leading-tight tracking-tight tabular-nums text-[var(--color-ink)]">{value}</p>
          <div className="mt-1.5 flex h-[30px] items-end gap-3">
            <span className="flex-shrink-0 pb-0.5">{change !== undefined && <DeltaBadge change={change} compared={compared} higherIsBetter={higherIsBetter} size="md" variant="text" />}</span>
            {spark && <Sparkline values={spark} height={30} className={`ml-auto w-full max-w-[128px] flex-1 ${selected ? "text-[var(--color-primary)]" : "text-[#a5b4fc]"}`} />}
          </div>
        </>
      )}
    </>
  );
  const base = "relative flex min-w-0 flex-col rounded-[var(--radius-card)] border px-3.5 py-3 text-left transition-all";
  if (!onSelect) return <div className={`${base} border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-card)]`}>{body}</div>;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`${base} w-full shadow-[var(--shadow-card)] ${
        selected
          ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] ring-1 ring-[var(--color-primary)]/15"
          : "border-[var(--color-line)] bg-[var(--color-panel)] hover:-translate-y-px hover:border-[var(--color-line-strong)]"
      }`}
    >
      {body}
    </button>
  );
}
