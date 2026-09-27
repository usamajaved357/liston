"use client";

import { DiscoverSubjectRef, DiscoverWinners as Winners, DiscoverWinnersFilters } from "@/lib/api";
import { SegmentedControl } from "@/components/charts/SegmentedControl";
import { ago } from "@/components/hunting/HuntBits";
import { DiscoverProducts } from "./DiscoverProducts";
import { CardHeader } from "./discover-ui";

// Winners: the best products across everything anyone on the site has
// explored, for this account, with the filters a hunter reaches for —
// delivery it can match, a price band, a minimum of sales a month, new or
// rising lately — and the sort. The pool grows with every category or
// keyword explored and is read again nightly.

type Sort = NonNullable<DiscoverWinnersFilters["sort"]>;
type Price = "any" | "under10" | "10to25" | "25plus";
type Sales = "0" | "10" | "50" | "150";

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
  const set = (patch: DiscoverWinnersFilters) => onFilters({ ...filters, ...patch });
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <span className="sr-only">Filter products</span>
            <svg viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted)]" aria-hidden>
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
              <path d="M16 16l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={filters.q || ""}
              onChange={(e) => set({ q: e.target.value })}
              placeholder="Words in the product"
              className="h-8 w-full rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] pl-8 pr-3 text-[12.5px] text-[var(--color-ink)] placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] focus:outline-none"
            />
          </label>
          <SegmentedControl<Sort>
            label="Sort"
            size="sm"
            value={filters.sort || "score"}
            onChange={(sort) => set({ sort })}
            options={[
              { key: "score", label: "Best to hunt" },
              { key: "sales", label: "Most sales" },
              { key: "rising", label: "Rising" },
              { key: "new", label: "Newest" },
              { key: "price", label: "Priciest" },
            ]}
          />
          <SegmentedControl<"any" | "fit">
            label="Delivery"
            size="sm"
            value={filters.fit ? "fit" : "any"}
            onChange={(v) => set({ fit: v === "fit" })}
            options={[
              { key: "any", label: "Any delivery" },
              { key: "fit", label: "I can match", title: "At least 40% of its sales come from sellers delivering like you or slower" },
            ]}
          />
          <SegmentedControl<Price>
            label="Price"
            size="sm"
            value={filters.price || "any"}
            onChange={(v) => set({ price: v === "any" ? null : v })}
            options={[
              { key: "any", label: "Any price" },
              { key: "under10", label: "Under 10" },
              { key: "10to25", label: "10–25" },
              { key: "25plus", label: "25+" },
            ]}
          />
          <SegmentedControl<Sales>
            label="Sales a month"
            size="sm"
            value={String(filters.minSales || 0) as Sales}
            onChange={(v) => set({ minSales: Number(v) })}
            options={[
              { key: "0", label: "Any sales" },
              { key: "10", label: "10+/mo" },
              { key: "50", label: "50+/mo" },
              { key: "150", label: "150+/mo" },
            ]}
          />
          <SegmentedControl<"all" | "new">
            label="Momentum"
            size="sm"
            value={filters.newOnly ? "new" : "all"}
            onChange={(v) => set({ newOnly: v === "new" })}
            options={[
              { key: "all", label: "All" },
              { key: "new", label: "New or rising", title: "A listing launched in the last 90 days already selling, or selling faster lately than over its life" },
            ]}
          />
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
