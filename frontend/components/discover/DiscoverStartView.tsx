"use client";

import { DiscoverCategoryCard, DiscoverStart, DiscoverSubjectRef } from "@/lib/api";
import { count } from "@/components/research/format";
import { AccountDelivery, BudgetLine, CardHeader, Chevron, FlagTag, Quiet, ScoreBadge } from "./discover-ui";

// Where Discover starts (the search box above is on every screen): a slim
// header with the size of what's been explored, then tabs (DiscoverPanel)
// for the products, the keywords, the categories, and the watchlist with
// what the team explored lately. These are the header and two tabs' bodies.

const TILE_TONES = [
  "bg-indigo-50 text-indigo-700 ring-indigo-100",
  "bg-sky-50 text-sky-700 ring-sky-100",
  "bg-emerald-50 text-emerald-700 ring-emerald-100",
  "bg-amber-50 text-amber-700 ring-amber-100",
  "bg-rose-50 text-rose-700 ring-rose-100",
  "bg-violet-50 text-violet-700 ring-violet-100",
  "bg-teal-50 text-teal-700 ring-teal-100",
  "bg-orange-50 text-orange-700 ring-orange-100",
];
const toneOf = (name: string) => TILE_TONES[[...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % TILE_TONES.length];
const SCORE_DOT = { strong: "bg-emerald-500", fair: "bg-amber-500", weak: "bg-rose-500" } as const;
const SCORE_TEXT = { strong: "text-emerald-700", fair: "text-amber-700", weak: "text-rose-700" } as const;

// 49,899,944 -> "49.9M", 9,714 -> "9.7k": a live count that fits a capsule.
function compact(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(n);
}

// One of eBay's top-level categories as a capsule: a round initial, the
// whole name on its own line, and under it the live listings and, once
// explored, its opportunity (a dot and the score) — so the name never
// shares its line with anything and isn't cut short.
function CategoryTile({ category, onOpen }: { category: DiscoverCategoryCard; onOpen: () => void }) {
  const initials = category.name
    .split(/[\s,&/]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  const s = category.scanned;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={s ? `${category.name}: ${count(s.total)} live listings, opportunity ${s.score} of 100` : `${category.name}: not explored yet`}
        className="group flex h-full w-full items-center gap-2.5 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] py-1.5 pl-1.5 pr-3.5 text-left transition-all hover:-translate-y-px hover:border-[var(--color-primary)]/40 hover:shadow-[var(--shadow-card)]"
      >
        <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold ring-1 ring-inset ${toneOf(category.name)}`}>{initials}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-semibold leading-snug text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{category.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-none text-[var(--color-muted)]">
            {s ? (
              <>
                <span className="tabular-nums">{compact(s.total)} live</span>
                <span aria-hidden>·</span>
                <span className={`inline-flex items-center gap-1 font-semibold tabular-nums ${SCORE_TEXT[s.band]}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${SCORE_DOT[s.band]}`} aria-hidden />
                  {s.score}
                </span>
              </>
            ) : (
              "Not explored yet"
            )}
          </span>
        </span>
        <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-line-strong)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--color-primary)]" />
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

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/60 bg-white/70 px-3 py-2 backdrop-blur">
      <p className="text-[17px] font-semibold leading-tight tracking-tight tabular-nums text-[var(--color-ink)]">{value}</p>
      <p className="truncate text-[11px] text-[var(--color-muted)]">{label}</p>
    </div>
  );
}

/** What Discover does, in two lines, and the size of what's been explored on the site. */
export function DiscoverHero({ data }: { data: DiscoverStart }) {
  const w = data.winners;
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-col gap-3 bg-[linear-gradient(135deg,#eef2ff_0%,#f8fafc_55%,#ecfdf5_100%)] px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 max-w-2xl">
          <h2 className="text-[16px] font-semibold leading-tight text-[var(--color-ink)]">Find the next product to sell on {data.market.name}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-muted)]">
            Search or open a category: Liston reads its leading listings and sold counts, groups the same product across sellers and scores it for you. Everything explored
            joins one pool of products and keywords. <AccountDelivery account={data.account} />
          </p>
        </div>
        <div className="grid flex-shrink-0 grid-cols-3 gap-2 lg:w-[400px]">
          <Stat value={w ? count(w.total) : "—"} label="products found" />
          <Stat value={w?.keywords !== undefined ? count(w.keywords) : "—"} label="keywords that sell" />
          <Stat value={w ? count(w.pool.subjects) : "—"} label="explored" />
        </div>
      </div>
    </section>
  );
}

/** The Categories tab: the account's own categories, then eBay's top-level ones to browse. */
export function DiscoverCategoriesTab({ data, onOpen }: { data: DiscoverStart; onOpen: (subject: DiscoverSubjectRef) => void }) {
  return (
    <div className="space-y-4">
      {data.yourCategories.length > 0 && (
        <section className="card p-4">
          <CardHeader title="Your categories" note="Where the listings Liston made for this account sit: a good place to find the next product" />
          <ul className="-mx-2 mt-2 grid grid-cols-1 gap-x-4 md:grid-cols-2 xl:grid-cols-3">
            {data.yourCategories.map((c) => (
              <CategoryRow key={c.id} category={c} note={`${c.listings} of your listings`} onOpen={() => onOpen({ categoryId: c.id })} />
            ))}
          </ul>
        </section>
      )}
      <section className="card p-4">
        <CardHeader title="Browse eBay's categories" note="Open one for its products, keywords and subcategories; each subcategory has its own, more specific the deeper you go" />
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data.topCategories.map((c) => (
            <CategoryTile key={c.id} category={c} onOpen={() => onOpen({ categoryId: c.id })} />
          ))}
        </ul>
      </section>
      <BudgetLine budget={data.budget} />
    </div>
  );
}

/** What anyone on the site explored in the last three days, with its opportunity. */
export function DiscoverRecent({ data, onOpen }: { data: DiscoverStart; onOpen: (subject: DiscoverSubjectRef) => void }) {
  return (
    <section className="card p-4">
      <CardHeader title="Recently explored" note={`What your team opened on ${data.market.name} in the last 3 days, read again nightly`} />
      {data.recent.length ? (
        <ul className="-mx-2 mt-2 grid grid-cols-1 gap-x-4 md:grid-cols-2 xl:grid-cols-3">
          {data.recent.map((r) => (
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
  );
}
