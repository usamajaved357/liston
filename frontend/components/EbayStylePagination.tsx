"use client";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

function pageNumbers(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = new Set<number>([1, 2, total - 1, total, current - 1, current, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);

  const result: (number | "ellipsis")[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) result.push("ellipsis");
    result.push(p);
    prev = p;
  }
  return result;
}

interface EbayStylePaginationProps {
  page: number;
  totalPages: number;
  perPage: number;
  totalEntries: number;
  onPage: (page: number) => void;
  onPerPage: (perPage: number) => void;
}

export function EbayStylePagination({
  page,
  totalPages,
  perPage,
  totalEntries,
  onPage,
  onPerPage,
}: EbayStylePaginationProps) {
  const start = totalEntries === 0 ? 0 : (page - 1) * perPage + 1;
  const end = Math.min(totalEntries, page * perPage);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 border-t border-[var(--color-line)]">
      <span className="text-xs text-[var(--color-muted)]">
        {totalEntries === 0 ? "No results" : `Results: ${start}-${end} of ${totalEntries}`}
      </span>

      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
        >
          ←
        </button>
        {pageNumbers(page, totalPages).map((p, i) =>
          p === "ellipsis" ? (
            <span key={`e-${i}`} className="px-1 text-xs text-[var(--color-muted)]">
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPage(p)}
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                p === page
                  ? "bg-[var(--color-primary)] text-white"
                  : "text-[var(--color-ink)] hover:bg-[var(--color-paper)]"
              }`}
            >
              {p}
            </button>
          )
        )}
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages}
          aria-label="Next page"
          className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
        >
          →
        </button>
      </div>

      <label className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
        Items per page:
        <select
          value={perPage}
          onChange={(e) => onPerPage(Number(e.target.value))}
          className="rounded-md border border-[var(--color-line)] px-2 py-1 text-xs font-medium text-[var(--color-ink)] bg-[var(--color-panel)]"
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
