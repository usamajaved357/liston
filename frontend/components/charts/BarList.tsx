// Parts of a whole as labelled horizontal bars, largest first: where views
// came from, say. Every bar carries its figure and share as text, so the
// bar length is never the only way to read it.

export function BarList({
  items,
  format,
  empty = "Nothing to show yet.",
}: {
  items: { key: string; label: string; value: number }[];
  format: (v: number) => string;
  empty?: string;
}) {
  const total = items.reduce((sum, i) => sum + i.value, 0);
  if (!total) return <p className="py-6 text-center text-[13px] text-[var(--color-muted)]">{empty}</p>;
  const max = Math.max(...items.map((i) => i.value));
  const sorted = [...items].sort((a, b) => b.value - a.value);
  return (
    <ul className="space-y-2.5">
      {sorted.map((item) => {
        const share = item.value / total;
        return (
          <li key={item.key} title={`${item.label}: ${format(item.value)} (${(share * 100).toFixed(1)}%)`}>
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="truncate text-[var(--color-ink)]">{item.label}</span>
              <span className="flex-shrink-0 tabular-nums">
                <span className="font-semibold text-[var(--color-ink)]">{format(item.value)}</span>
                <span className="ml-1.5 text-[var(--color-muted)]">{(share * 100).toFixed(share < 0.1 ? 1 : 0)}%</span>
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--color-paper)]">
              <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${Math.max(2, (item.value / max) * 100)}%`, opacity: 0.35 + 0.65 * (item.value / max) }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
