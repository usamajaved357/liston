"use client";

import { DiscoverCategoryCard, DiscoverStart, DiscoverSubjectRef, DiscoverWatch } from "@/lib/api";
import { count } from "@/components/research/format";
import { DiscoverProducts } from "./DiscoverProducts";
import { AccountDelivery, BudgetLine, CardHeader, Chevron, FlagTag, perMonth, Quiet, ScoreBadge } from "./discover-ui";

// Where Discover starts (the search box above is on every screen): the
// best products across everything explored on the site, what the team
// explored lately and watches, the account's own categories, and eBay's
// top-level categories to browse.

const TILE_TONES = ["bg-indigo-50 text-indigo-700", "bg-sky-50 text-sky-700", "bg-emerald-50 text-emerald-700", "bg-amber-50 text-amber-700", "bg-rose-50 text-rose-700", "bg-violet-50 text-violet-700", "bg-teal-50 text-teal-700", "bg-orange-50 text-orange-700"];
const toneOf = (name: string) => TILE_TONES[[...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % TILE_TONES.length];

function CategoryTile({ category, onOpen }: { category: DiscoverCategoryCard; onOpen: () => void }) {
  const initials = category.name
    .split(/[\s,&]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  return (
    <li>
      <button type="button" onClick={onOpen} className="group flex w-full items-center gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-3 text-left transition-all hover:-translate-y-px hover:border-[var(--color-primary)]/40 hover:shadow-[var(--shadow-card)]">
        <span className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold ${toneOf(category.name)}`}>{initials}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{category.name}</span>
          <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{category.scanned ? `${count(category.scanned.total)} live listings` : "Not explored yet"}</span>
        </span>
        {category.scanned ? <ScoreBadge score={category.scanned.score} band={category.scanned.band} size="sm" /> : <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-line-strong)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--color-primary)]" />}
      </button>
    </li>
  );
}

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

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border border-white/60 bg-white/70 px-3.5 py-2.5 backdrop-blur">
      <p className="text-[20px] font-semibold leading-tight tracking-tight tabular-nums text-[var(--color-ink)]">{value}</p>
      <p className="text-[11.5px] text-[var(--color-muted)]">{label}</p>
    </div>
  );
}

export function DiscoverStartView({
  data,
  onOpen,
  onWatchlist,
  onWinners,
  onHunt,
}: {
  data: DiscoverStart;
  onOpen: (subject: DiscoverSubjectRef) => void;
  onWatchlist: () => void;
  onWinners: () => void;
  onHunt: (url: string) => void;
}) {
  const subjectOf = (w: DiscoverWatch): DiscoverSubjectRef => (w.kind === "category" ? { categoryId: w.value } : { q: w.value });
  const winners = data.winners;
  return (
    <div className="space-y-5">
      {/* The way in: what Discover does, the size of what's been explored, and the winners. */}
      <section className="card overflow-hidden">
        <div className="bg-[linear-gradient(135deg,#eef2ff_0%,#f8fafc_55%,#ecfdf5_100%)] p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 max-w-2xl">
              <p className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-primary)]">Discover</p>
              <h2 className="mt-0.5 text-[20px] font-semibold leading-tight text-[var(--color-ink)]">Find the next product to sell on {data.market.name}</h2>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                Search a product or keyword, or open a category. Liston reads its leading listings and how many each has sold, groups the same product across sellers, and tells
                you which ones sell, whether you can match their delivery, what they leave after fees, and whether they&apos;re rising. Everything explored joins one pool of
                winning products.
              </p>
              <p className="mt-1.5 text-[11.5px] text-[var(--color-muted)]">
                <AccountDelivery account={data.account} />
              </p>
            </div>
            <div className="grid flex-shrink-0 grid-cols-3 gap-2 lg:w-[380px]">
              <Stat value={winners ? count(winners.total) : "—"} label="products found" />
              <Stat value={winners ? count(winners.pool.subjects) : "—"} label="categories and keywords" />
              <Stat value={winners ? count(winners.pool.read) : "—"} label="listings with sold counts" />
            </div>
          </div>
        </div>
        {winners && winners.products.length > 0 && (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-[var(--color-line)] px-4 pb-2 pt-3">
              <CardHeader title="Winning products right now" note="The best to hunt across everything your team has explored, for this account. The same product under several sellers is one row." />
              <button type="button" onClick={onWinners} className="text-[12.5px] font-semibold text-[var(--color-primary)] hover:underline">
                See all {count(winners.total)} with filters
              </button>
            </div>
            <div className="border-t border-[var(--color-line)]">
              <DiscoverProducts products={winners.products} currency={data.market.currency} onHunt={onHunt} onOpen={onOpen} showFrom empty="" />
            </div>
          </>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <section className="card flex flex-col p-4">
          <CardHeader title="Recently explored" note={`What your team opened on ${data.market.name} in the last 3 days, read again nightly`} />
          {data.recent.length ? (
            <ul className="-mx-2 mt-2">
              {data.recent.slice(0, 6).map((r) => (
                <li key={`${r.kind}:${r.value}`}>
                  <button type="button" onClick={() => onOpen(r.kind === "category" ? { categoryId: r.value } : { q: r.value })} className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--color-paper)]">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{r.kind === "keyword" ? `“${r.name}”` : r.name}</span>
                        <FlagTag flag={r.flag} />
                      </span>
                      <span className="block truncate text-[11px] text-[var(--color-muted)]">
                        {r.kind === "keyword" ? "Keyword" : r.path.join(" › ") || "Category"}
                        {r.scanned && ` · ${count(Math.round(r.scanned.monthlySales))} sales a month`}
                      </span>
                    </span>
                    {r.scanned && <ScoreBadge score={r.scanned.score} band={r.scanned.band} size="sm" />}
                    <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-line-strong)]" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Quiet>Categories and keywords anyone opens show here for three days.</Quiet>
          )}
        </section>

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

        <section className="card flex flex-col p-4 lg:col-span-2 xl:col-span-1">
          <CardHeader title="Your categories" note="Where the listings Liston made for this account sit" />
          {data.yourCategories.length ? (
            <ul className="-mx-2 mt-2">{data.yourCategories.slice(0, 6).map((c) => <CategoryRow key={c.id} category={c} note={`${c.listings} of your listings`} onOpen={() => onOpen({ categoryId: c.id })} />)}</ul>
          ) : (
            <Quiet>Your categories show here once Liston has made listings for this account.</Quiet>
          )}
        </section>
      </div>

      <section className="card p-4">
        <CardHeader title="Browse eBay's categories" note="Open one to see its products and rank its subcategories; go deeper for more specific products and keywords" />
        <ul className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data.topCategories.map((c) => (
            <CategoryTile key={c.id} category={c} onOpen={() => onOpen({ categoryId: c.id })} />
          ))}
        </ul>
      </section>

      <BudgetLine budget={data.budget} />
    </div>
  );
}
