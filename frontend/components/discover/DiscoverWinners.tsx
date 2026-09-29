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
  finding,
  found,
  onFindMore,
}: {
  data: Winners | null;
  filters: DiscoverWinnersFilters;
  onFilters: (next: DiscoverWinnersFilters) => void;
  loading: boolean;
  onHunt: (url: string) => void;
  onOpen: (subject: DiscoverSubjectRef) => void;
  onMore: () => void;
  // "Find more products for these filters": reading now, and what the last one found (`now`: the products matching since).
  finding: boolean;
  found: { before: number; now: number; read: number; subjects: string[]; more: boolean; signInFailed?: boolean; stopped?: boolean; error?: string } | null;
  onFindMore: () => void;
}) {
  const allShown = Boolean(data && !(data.matched > data.products.length && data.products.length < 300));
  const gained = found ? Math.max(0, found.now - found.before) : 0;
  return (
    <section className="card min-w-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-3">
        {/* The whole width on a phone (the count goes under it), sharing the line with the count on wider screens. */}
        <div className="min-w-0 grow basis-full sm:basis-0">
          <DiscoverProductFilters filters={filters} onChange={onFilters} currency={data?.market.currency || "GBP"} delivery={data?.account || null} />
        </div>
        <p
          className="min-w-0 text-[11.5px] leading-snug text-[var(--color-muted)] sm:max-w-[220px] sm:text-right"
          title={data ? `Read ${ago(data.at)}${data.riskHidden ? ". VeRO risk hidden: a VeRO brand on its listings, or like a draft eBay refused you for (Brand and VeRO shows them)" : ""}` : undefined}
        >
          {data ? `${count(data.matched)} product${data.matched === 1 ? "" : "s"}${data.riskHidden ? ` · ${count(data.riskHidden)} VeRO risk hidden` : ""}${data.mineHidden ? ` · ${count(data.mineHidden)} of yours hidden` : ""}` : ""}
          {loading && data ? " · Updating…" : ""}
        </p>
      </div>
      <div className={`overflow-hidden ${data && (!allShown || data.pool.subjects > 0) ? "" : "rounded-b-[var(--radius-card)]"} ${loading ? "opacity-60" : ""}`}>
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
      {data && !allShown && (
        <div className="flex items-center justify-center border-t border-[var(--color-line)] px-4 py-2.5">
          <button type="button" onClick={onMore} disabled={loading} className="btn btn-secondary btn-sm !h-8 !text-[12.5px] disabled:opacity-60">
            {loading ? "Loading…" : `Load more products (${count(data.matched - data.products.length)} more)`}
          </button>
        </div>
      )}
      {/* Every match shown: read more listings for these filters in what's been explored, so more can match. */}
      {data && allShown && data.pool.subjects > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-b-[var(--radius-card)] border-t border-[var(--color-line)] px-4 py-2.5" aria-live="polite">
          <p className="min-w-0 text-[11.5px] text-[var(--color-muted)]">
            {finding ? (
              "Reading more listings that can pass these filters in the categories and keywords explored…"
            ) : found?.error ? (
              <span className="text-rose-600">{found.error}</span>
            ) : found?.signInFailed && !found.read ? (
              <span className="text-amber-700">Sold counts need this account&apos;s eBay sign-in, which didn&apos;t work: reconnect the account, or ask the owner to.</span>
            ) : found?.stopped && !found.read ? (
              <span className="text-amber-700">Today&apos;s sold-count reads have run out. Find more reads again after they reset.</span>
            ) : found && loading ? (
              "Read. Updating the list…"
            ) : found ? (
              <>
                <span className="font-medium text-[var(--color-ink)]">
                  {found.read
                    ? `${count(found.read)} more listing${found.read === 1 ? "" : "s"} read in ${found.subjects.slice(0, 3).join(", ")}: ${gained ? `${count(gained)} new product${gained === 1 ? "" : "s"} match` : "nothing new matches"}.`
                    : "Nothing more to read for these filters in what's been explored."}
                </span>{" "}
                {found.more ? "Find more reads the next ones." : "Explore more categories or keywords to find more."}
              </>
            ) : (
              "That's every product matching these filters so far. Find more reads more listings for them in the categories and keywords explored."
            )}
          </p>
          {(!found || found.more || found.error) && (
            <button type="button" onClick={onFindMore} disabled={finding || loading} className="btn btn-secondary btn-sm !h-8 shrink-0 !text-[12.5px] disabled:opacity-60">
              {finding ? "Reading…" : "Find more products for these filters"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
