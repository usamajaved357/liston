"use client";

import { DiscoverCategoryCard, DiscoverStart, DiscoverSubjectRef, DiscoverWatch } from "@/lib/api";
import { count } from "@/components/research/format";
import { AccountDelivery, BudgetLine, CardHeader, Chevron, perMonth, Quiet, ScoreBadge } from "./discover-ui";

// Where Discover starts (the search box above is on every screen): what the
// team watches, the account's own categories, and eBay's top-level
// categories to browse — each with its opportunity once read.

function CategoryRow({ category, note, onOpen }: { category: DiscoverCategoryCard; note?: string; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--color-paper)]">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{category.name}</span>
          <span className="block truncate text-[11px] text-[var(--color-muted)]">
            {category.path && category.path.length > 0 ? `${category.path.join(" › ")} · ` : ""}
            {category.scanned ? `${count(category.scanned.total)} live` : note || "Not read yet"}
          </span>
        </span>
        {category.scanned && <ScoreBadge score={category.scanned.score} band={category.scanned.band} size="sm" />}
        <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-line-strong)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--color-primary)]" />
      </button>
    </li>
  );
}

function WatchRow({ watch, onOpen }: { watch: DiscoverWatch; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--color-paper)]">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{watch.kind === "keyword" ? `“${watch.label}”` : watch.label}</span>
          <span className="block truncate text-[11px] text-[var(--color-muted)]">
            {watch.recent ? (
              <span className="font-medium text-emerald-700">
                {count(watch.recent.sold)} sold in {watch.recent.days} day{watch.recent.days === 1 ? "" : "s"}
              </span>
            ) : watch.figures ? (
              `${perMonth(watch.figures.medianPerMonth)} · ${count(watch.figures.total)} live`
            ) : (
              "Read tonight"
            )}
          </span>
        </span>
        {watch.opportunity && <ScoreBadge score={watch.opportunity.score} band={watch.opportunity.band} size="sm" />}
        <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-line-strong)]" />
      </button>
    </li>
  );
}

export function DiscoverStartView({ data, onOpen, onWatchlist }: { data: DiscoverStart; onOpen: (subject: DiscoverSubjectRef) => void; onWatchlist: () => void }) {
  const subjectOf = (w: DiscoverWatch): DiscoverSubjectRef => (w.kind === "category" ? { categoryId: w.value } : { q: w.value });
  return (
    <div className="space-y-5">
      <section className="card flex flex-col gap-3 p-4 md:flex-row md:items-center md:gap-5">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
            <path d="M4 19V9M10 19V5M16 19v-6M22 19H2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Find what to hunt on {data.market.name}</h2>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            Search a product or keyword, or open a category. Liston reads its leading listings and how many each has sold, then shows its monthly sales, competition,
            prices, whether you can match the sellers&apos; delivery, the keywords that sell, and your own traffic on it.
          </p>
          <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">
            <AccountDelivery account={data.account} />
          </p>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="card flex flex-col p-4">
          <CardHeader
            title="Your watchlist"
            note="Read again every night"
            aside={
              data.watches > 0 ? (
                <button type="button" onClick={onWatchlist} className="text-[12px] font-medium text-[var(--color-primary)] hover:underline">
                  See all {data.watches}
                </button>
              ) : undefined
            }
          />
          {data.watchPreview.length ? (
            <ul className="-mx-2 mt-2">{data.watchPreview.map((w) => <WatchRow key={w.id} watch={w} onOpen={() => onOpen(subjectOf(w))} />)}</ul>
          ) : (
            <Quiet>Open a category or keyword and press Watch: Liston reads it every night and charts its sales day by day.</Quiet>
          )}
        </section>

        <section className="card flex flex-col p-4">
          <CardHeader title="Your categories" note="Where the listings Liston made for this account sit" />
          {data.yourCategories.length ? (
            <ul className="-mx-2 mt-2">{data.yourCategories.slice(0, 6).map((c) => <CategoryRow key={c.id} category={c} note={`${c.listings} of your listings`} onOpen={() => onOpen({ categoryId: c.id })} />)}</ul>
          ) : (
            <Quiet>Your categories show here once Liston has made listings for this account.</Quiet>
          )}
        </section>
      </div>

      <section className="card p-4">
        <CardHeader title="Browse eBay categories" note="Open one to see it as a whole, then rank its subcategories" />
        <ul className="-mx-2 mt-2 grid grid-cols-1 gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.topCategories.map((c) => (
            <CategoryRow key={c.id} category={c} onOpen={() => onOpen({ categoryId: c.id })} />
          ))}
        </ul>
      </section>

      <BudgetLine budget={data.budget} />
    </div>
  );
}
