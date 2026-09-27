"use client";

// Parts of one whole as a single segmented bar with a legend beneath, the
// way the Overview splits the order queue: every part keeps its colour, its
// figure and its share as text, so colour is never the only way to read it.
// Parts with nothing are left out; a thin surface gap separates segments.

export const SHARE_TONES = {
  indigo: "bg-[var(--color-primary)]",
  indigoSoft: "bg-[#a5b4fc]",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  sky: "bg-sky-500",
  rose: "bg-rose-400",
  slate: "bg-slate-300",
} as const;
export type ShareTone = keyof typeof SHARE_TONES;

export function ShareBar({
  items,
  format,
  empty = "Nothing to show yet.",
  columns = 2,
}: {
  items: { key: string; label: string; value: number; tone: ShareTone; note?: string }[];
  format: (v: number) => string;
  empty?: string;
  columns?: 1 | 2 | 3;
}) {
  const shown = items.filter((i) => i.value > 0);
  const total = shown.reduce((sum, i) => sum + i.value, 0);
  if (!total) return <p className="py-6 text-center text-[12.5px] text-[var(--color-muted)]">{empty}</p>;
  const pct = (v: number) => {
    const p = (v / total) * 100;
    return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
  };
  return (
    <div>
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={shown.map((i) => `${i.label} ${pct(i.value)}`).join(", ")}>
        {shown.map((i) => (
          <span key={i.key} className={`${SHARE_TONES[i.tone]} h-full first:rounded-l-full last:rounded-r-full`} style={{ width: `${(i.value / total) * 100}%` }} title={`${i.label}: ${format(i.value)} (${pct(i.value)})`} />
        ))}
      </div>
      <ul className={`mt-3 grid gap-x-4 gap-y-2 ${columns === 1 ? "grid-cols-1" : columns === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2"}`}>
        {shown.map((i) => (
          <li key={i.key} className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-[11.5px] text-[var(--color-muted)]">
              <span className={`h-2 w-2 flex-shrink-0 rounded-full ${SHARE_TONES[i.tone]}`} aria-hidden />
              <span className="truncate">{i.label}</span>
            </p>
            <p className="mt-0.5 pl-3.5 text-[12.5px] tabular-nums">
              <span className="font-semibold text-[var(--color-ink)]">{format(i.value)}</span>
              <span className="ml-1.5 text-[var(--color-muted)]">{pct(i.value)}</span>
              {i.note && <span className="ml-1.5 text-[11px] text-[var(--color-muted)]">{i.note}</span>}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
