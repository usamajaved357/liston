// What a page shows while its data is on the way: the same shell the real
// page renders, with grey blocks where the content will be. Never a bare
// "Loading…" — the layout should stay put when moving between tabs.
export function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="max-w-3xl space-y-3" aria-busy="true" aria-live="polite">
      <div className="h-4 w-56 animate-pulse rounded-full bg-[var(--color-line)]" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="card p-5">
          <div className="flex items-center gap-4">
            <div className="h-10 w-10 animate-pulse rounded-full bg-[var(--color-paper)]" />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-40 animate-pulse rounded-full bg-[var(--color-line)]" />
              <div className="h-3 w-64 animate-pulse rounded-full bg-[var(--color-paper)]" />
            </div>
            <div className="h-8 w-24 animate-pulse rounded-full bg-[var(--color-paper)]" />
          </div>
        </div>
      ))}
    </div>
  );
}
