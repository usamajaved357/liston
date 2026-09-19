"use client";

// The pinned footer under a paged list: how many are showing, the page
// size, and the pages. One control shared by every list page, so a seller
// reads it the same way on Listings and Orders.

export type PageSize = number | "all";

function pageNumbers(page: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | "…")[] = [1];
  const lo = Math.max(2, page - 1);
  const hi = Math.min(total - 1, page + 1);
  if (lo > 2) out.push("…");
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < total - 1) out.push("…");
  out.push(total);
  return out;
}

function NavBtn({ dir, disabled, onClick }: { dir: "prev" | "next"; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="btn btn-ghost btn-icon" aria-label={dir === "prev" ? "Previous page" : "Next page"}>
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
        <path d={dir === "prev" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export function ListFooter<S extends PageSize>({
  page,
  totalPages,
  totalEntries,
  perPage,
  sizes,
  onPage,
  onPerPage,
}: {
  page: number;
  totalPages: number;
  totalEntries: number;
  perPage: S;
  sizes: readonly S[];
  onPage: (p: number) => void;
  onPerPage: (n: S) => void;
}) {
  const size = perPage === "all" ? totalEntries : (perPage as number);
  const from = totalEntries === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(totalEntries, page * size);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="text-[12px] text-[var(--color-muted)]">
          Showing <span className="font-medium text-[var(--color-ink)]">{from}</span> to <span className="font-medium text-[var(--color-ink)]">{to}</span> of{" "}
          <span className="font-medium text-[var(--color-ink)]">{totalEntries}</span>
        </span>
        <div className="inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
          {sizes.map((s) => (
            <button
              key={String(s)}
              type="button"
              onClick={() => onPerPage(s)}
              className={`h-6 rounded-full px-2.5 text-[11.5px] font-medium transition-colors ${
                perPage === s ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              }`}
            >
              {s === "all" ? "All" : s}
            </button>
          ))}
        </div>
        <span className="text-[12px] text-[var(--color-muted)]">per page</span>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <NavBtn dir="prev" disabled={page <= 1} onClick={() => onPage(page - 1)} />
          {pageNumbers(page, totalPages).map((n, i) =>
            n === "…" ? (
              <span key={`e${i}`} className="px-1 text-[12px] text-[var(--color-muted)]">
                …
              </span>
            ) : (
              <button
                key={n}
                type="button"
                onClick={() => onPage(n)}
                className={`h-7 min-w-7 rounded-full px-2 text-[12px] font-medium transition-colors ${
                  n === page ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-ink)]"
                }`}
              >
                {n}
              </button>
            )
          )}
          <NavBtn dir="next" disabled={page >= totalPages} onClick={() => onPage(page + 1)} />
        </div>
      )}
    </div>
  );
}
