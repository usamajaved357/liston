"use client";

import { DiscoverSubjectRef, DiscoverWinners as Winners, DiscoverWinnersFilters } from "@/lib/api";
import { ago } from "@/components/hunting/HuntBits";
import { DiscoverProducts } from "./DiscoverProducts";
import { DiscoverProductFilters } from "./DiscoverProductFilters";
import { CardHeader } from "./discover-ui";

// Winners: the best products across everything anyone on the site has
// explored, for this account, with a hunter's filters and sort. The pool
// grows with every category or keyword explored and is read again nightly.

export function DiscoverWinnersView({
  data,
  filters,
  onFilters,
  loading,
  onHunt,
  onOpen,
}: {
  data: Winners | null;
  filters: DiscoverWinnersFilters;
  onFilters: (next: DiscoverWinnersFilters) => void;
  loading: boolean;
  onHunt: (url: string) => void;
  onOpen: (subject: DiscoverSubjectRef) => void;
}) {
  return (
    <div className="space-y-4">
      <section className="card p-4">
        <CardHeader
          title="Winning products"
          note={
            data
              ? `The best products to hunt across everything explored on ${data.market.name}: ${data.pool.subjects} categories and keywords, ${data.pool.listings.toLocaleString("en-GB")} leading listings, ${data.pool.read.toLocaleString("en-GB")} with sold counts. The same product under several sellers is one row. Read ${ago(data.at)}; the pool grows with every category or keyword anyone explores.`
              : "The best products to hunt across everything explored on this site."
          }
        />
        <div className="mt-3 border-t border-[var(--color-line)] pt-3">
          <DiscoverProductFilters filters={filters} onChange={onFilters} currency={data?.market.currency || "GBP"} />
        </div>
      </section>

      <section className="card min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-2 p-4 pb-3">
          <CardHeader title={data ? `${data.matched} product${data.matched === 1 ? "" : "s"}${data.matched > data.products.length ? `, the best ${data.products.length} shown` : ""}` : "Products"} note="Best to hunt first: sales, how many sellers make a living from it, whether you can match their delivery, the price room, and momentum. Each says why." />
          {loading && <span className="text-[12px] text-[var(--color-muted)]">Updating…</span>}
        </div>
        <div className={`border-t border-[var(--color-line)] ${loading ? "opacity-60" : ""}`}>
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
      </section>
    </div>
  );
}
