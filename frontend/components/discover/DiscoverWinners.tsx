"use client";

import { DiscoverSubjectRef, DiscoverWinners as Winners, DiscoverWinnersFilters } from "@/lib/api";
import { count } from "@/components/research/format";
import { ago } from "@/components/hunting/HuntBits";
import { DiscoverProducts } from "./DiscoverProducts";
import { DiscoverProductFilters } from "./DiscoverProductFilters";

// Discover's Products tab: the best products across everything anyone on
// the site has explored, for this account, with a hunter's filters and
// sort, a page at a time ("Load more"). The pool grows with every category
// or keyword explored and is read again nightly.

export function DiscoverWinnersView({
  data,
  filters,
  onFilters,
  loading,
  onHunt,
  onOpen,
  onMore,
}: {
  data: Winners | null;
  filters: DiscoverWinnersFilters;
  onFilters: (next: DiscoverWinnersFilters) => void;
  loading: boolean;
  onHunt: (url: string) => void;
  onOpen: (subject: DiscoverSubjectRef) => void;
  onMore: () => void;
}) {
  return (
    <section className="card min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <DiscoverProductFilters filters={filters} onChange={onFilters} currency={data?.market.currency || "GBP"} />
        </div>
        <p className="text-[11.5px] text-[var(--color-muted)]">
          {data ? `${count(data.matched)} product${data.matched === 1 ? "" : "s"}${data.mineHidden ? ` · ${count(data.mineHidden)} of yours hidden` : ""} · read ${ago(data.at)}` : ""}
          {loading && data ? " · Updating…" : ""}
        </p>
      </div>
      <div className={loading ? "opacity-60" : ""}>
        {data ? (
          <DiscoverProducts
            products={data.products}
            currency={data.market.currency}
            onHunt={onHunt}
            onOpen={onOpen}
            showFrom
            empty={data.pool.subjects ? "No product matches these filters. Loosen one, or explore more categories and keywords to grow the pool." : "Nothing explored on this site yet. Open a category or search a keyword: every one explored joins the pool."}
          />
        ) : (
          <div className="px-6 py-10 text-center" aria-live="polite">
            <span className="mx-auto block h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-hidden />
            <p className="mt-3 text-[13px] font-medium text-[var(--color-ink)]">Grouping everything explored into products</p>
          </div>
        )}
      </div>
      {data && data.matched > data.products.length && data.products.length < 300 && (
        <div className="flex items-center justify-center border-t border-[var(--color-line)] px-4 py-2.5">
          <button type="button" onClick={onMore} disabled={loading} className="btn btn-secondary btn-sm !h-8 !text-[12.5px] disabled:opacity-60">
            {loading ? "Loading…" : `Load more products (${count(data.matched - data.products.length)} more)`}
          </button>
        </div>
      )}
    </section>
  );
}
