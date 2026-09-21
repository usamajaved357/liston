// The change from the previous period: an arrow and a figure, coloured by
// direction. Never colour alone — the arrow and sign carry it too.
// `higherIsBetter` false flips the colours (for costs, return rates…).

export function DeltaBadge({
  change,
  higherIsBetter = true,
  compared,
  size = "md",
}: {
  change: number | null | undefined;
  higherIsBetter?: boolean;
  compared?: string; // "vs previous 7 days", for the tooltip
  size?: "sm" | "md";
}) {
  const text = size === "sm" ? "text-[11px] h-[18px] px-1.5" : "text-[11.5px] h-5 px-2";
  if (change == null || Number.isNaN(change)) {
    return (
      <span className={`inline-flex items-center rounded-full bg-[var(--color-paper)] font-medium text-[var(--color-muted)] ${text}`} title={compared ? `No figure to compare ${compared}` : undefined}>
        —
      </span>
    );
  }
  const flat = Math.abs(change) < 0.005;
  const good = flat ? null : change > 0 === higherIsBetter;
  const tone = flat
    ? "bg-[var(--color-paper)] text-[var(--color-muted)]"
    : good
      ? "bg-emerald-50 text-emerald-700"
      : "bg-[var(--color-danger-soft)] text-[var(--color-danger)]";
  const pct = Math.abs(change * 100);
  const figure = pct >= 1000 ? `${Math.round(pct / 100) / 10}k%` : pct >= 100 ? `${Math.round(pct)}%` : `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
  return (
    <span className={`relative inline-flex items-center gap-0.5 rounded-full font-semibold tabular-nums ${tone} ${text}`} title={compared ? (flat ? `No change ${compared}` : `${change > 0 ? "Up" : "Down"} ${figure} ${compared}`) : undefined}>
      {!flat && (
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden>
          <path d={change > 0 ? "M6 2.5l3.5 4H7v3H5v-3H2.5z" : "M6 9.5l3.5-4H7v-3H5v3H2.5z"} fill="currentColor" />
        </svg>
      )}
      <span className="sr-only">{flat ? "no change" : change > 0 ? "up" : "down"}</span>
      {flat ? "0%" : figure}
    </span>
  );
}
