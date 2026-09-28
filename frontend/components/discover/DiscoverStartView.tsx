"use client";

import { useState } from "react";
import { DiscoverBestCategory, DiscoverCategoryCard, DiscoverStart, DiscoverSubjectRef } from "@/lib/api";
import { count, money } from "@/components/research/format";
import { PillTabs } from "@/components/PillTabs";
import { AccountDelivery, BudgetLine, CardHeader, Chevron, FlagTag, Quiet, ScoreBadge } from "./discover-ui";

// Where Discover starts (the search box above is on every screen): a slim
// header with the size of what's been explored, then tabs (DiscoverPanel)
// for the products, the keywords, the categories, and the watchlist with
// what the team explored lately. These are the header and two tabs' bodies.

const SCORE_DOT = { strong: "bg-emerald-500", fair: "bg-amber-500", weak: "bg-rose-500" } as const;

// 49,899,944 -> "49.9M", 9,714 -> "9.7k": a live count that fits a capsule.
function compact(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(n);
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

// The Categories tab: one card, its tabs showing the categories each way —
// All (eBay's top-level ones, to browse), the ones explored ranked by sales,
// opportunity, live listings or trend (new and rising products: eBay doesn't
// share buyers' search volume with apps, so momentum stands in for it), and
// the account's own. Ranked ones share one table with the ranking column
// picked out; colour is kept for the opportunity score alone.

type CatTab = "all" | "sales" | "score" | "listings" | "trending" | "yours";
type Ranked = Exclude<CatTab, "all" | "yours">;
const RANKED: Record<Ranked, { label: string; note: string; by: (a: DiscoverBestCategory, b: DiscoverBestCategory) => number; keep?: (c: DiscoverBestCategory) => boolean }> = {
  sales: { label: "Best selling", note: "Every category explored on this site, at any depth, by what its leading listings sell a month.", by: (a, b) => b.monthlySales - a.monthlySales || b.score - a.score },
  score: { label: "Best opportunity", note: "By opportunity: demand, how many sell, competition, delivery you can match and price room.", by: (a, b) => b.score - a.score || b.monthlySales - a.monthlySales },
  listings: { label: "Most listings", note: "The biggest markets by live listings: the most buyers, and the most competition.", by: (a, b) => b.total - a.total || b.monthlySales - a.monthlySales },
  trending: {
    label: "Trending",
    note: "Where the most products are new or selling faster lately. eBay doesn't share buyers' search volume, so momentum stands in for it.",
    by: (a, b) => b.rising - a.rising || b.monthlySales - a.monthlySales,
    keep: (c) => c.rising > 0,
  },
};
const RANKED_SHOWN = 10;
const COLUMN_OF: Record<Ranked, string> = { sales: "sales", score: "score", listings: "live", trending: "trend" };

function Dot({ band }: { band: DiscoverBestCategory["band"] }) {
  return <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${SCORE_DOT[band]}`} aria-hidden />;
}

function PhraseChip({ term, onOpen }: { term: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className="mt-1 inline-flex h-5 max-w-full items-center rounded-full bg-[var(--color-paper)] px-2 text-[11px] text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)] hover:text-[var(--color-primary)] hover:ring-[var(--color-primary)]/30"
      title={`“${term}”: the phrase its selling titles share most. Open it.`}
    >
      <span className="truncate">{term}</span>
    </button>
  );
}

// eBay's top-level categories as a quiet grid: the name, its live listings and, once explored, its score.
function AllCategories({ rows, onOpen }: { rows: DiscoverCategoryCard[]; onOpen: (subject: DiscoverSubjectRef) => void }) {
  return (
    <ul className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {rows.map((c) => {
        const s = c.scanned;
        return (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onOpen({ categoryId: c.id })}
              title={s ? `${c.name}: ${count(s.total)} live listings, opportunity ${s.score} of 100` : `${c.name}: not explored yet`}
              className="group flex h-full w-full items-center gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2.5 text-left transition-colors hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-paper)]/60"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-semibold leading-snug text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{c.name}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
                  {s ? (
                    <>
                      <span className="tabular-nums">{compact(s.total)} live</span>
                      <span aria-hidden>·</span>
                      <Dot band={s.band} />
                      <span className="tabular-nums">Opportunity {s.score}</span>
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
      })}
    </ul>
  );
}

// The explored categories ranked one way, top ten first. The ranking column's header and figures stand out.
function RankedCategories({ rows, rank, currency, onOpen }: { rows: DiscoverBestCategory[]; rank: Ranked; currency: string; onOpen: (subject: DiscoverSubjectRef) => void }) {
  const [all, setAll] = useState(false);
  const r = RANKED[rank];
  const sorted = rows.filter(r.keep || (() => true)).sort(r.by);
  const shown = all ? sorted : sorted.slice(0, RANKED_SHOWN);
  const col = COLUMN_OF[rank];
  const head = (key: string) => `px-3 py-2 text-center ${key === col ? "text-[var(--color-primary)]" : ""}`;
  const cell = (key: string) => `px-3 py-3 text-center tabular-nums ${key === col ? "font-semibold text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`;
  if (!sorted.length) {
    return (
      <div className="px-4 pb-4">
        <Quiet>{rank === "trending" ? "No explored category has new or rising products yet." : "Nothing explored on this site yet. Open a category under All and it joins these rankings."}</Quiet>
      </div>
    );
  }
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[780px] table-fixed text-[12.5px]">
          <thead className="whitespace-nowrap border-y border-[var(--color-line)] bg-[var(--color-paper)] text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            <tr>
              <th className="w-12 px-3 py-2 text-center">#</th>
              <th className="w-[34%] px-3 py-2 text-left">Category</th>
              <th className={head("sales")} title="What its leading listings sell between them a month">
                Sales a month
              </th>
              <th className={head("live")} title="Every live listing eBay has in it">
                Live listings
              </th>
              <th className={head("price")}>Price</th>
              <th className={head("score")}>Opportunity</th>
              <th className={head("trend")} title="Of its products in the Products tab, how many are new or selling faster lately">
                New or rising
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {shown.map((c, i) => (
              <tr key={c.id} onClick={() => onOpen({ categoryId: c.id })} className="group cursor-pointer align-top transition-colors hover:bg-[var(--color-paper)]/60" title={`Open ${c.name}`}>
                <td className="px-3 py-3 text-center text-[11.5px] font-semibold tabular-nums text-[var(--color-muted)]">{i + 1}</td>
                <td className="px-3 py-3 text-left">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{c.name}</span>
                    <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-line-strong)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--color-primary)]" />
                  </span>
                  {c.path.length > 0 && <span className="mt-0.5 block truncate text-[11px] text-[var(--color-muted)]">{c.path.join(" › ")}</span>}
                  {c.keyword && <PhraseChip term={c.keyword} onOpen={() => onOpen({ q: c.keyword! })} />}
                </td>
                <td className={cell("sales")}>{count(c.monthlySales)}</td>
                <td className={cell("live")}>{compact(c.total)}</td>
                <td className={cell("price")}>{c.price !== null ? money(c.price, currency) : "—"}</td>
                <td className="px-3 py-3 text-center">
                  <span className={`inline-flex items-center gap-1.5 tabular-nums ${col === "score" ? "font-semibold text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>
                    <Dot band={c.band} />
                    {c.score}
                  </span>
                </td>
                <td className={cell("trend")}>{c.products ? `${c.rising} of ${c.products}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > RANKED_SHOWN && (
        <div className="flex justify-center border-t border-[var(--color-line)] px-4 py-2.5">
          <button type="button" onClick={() => setAll((v) => !v)} className="btn btn-secondary btn-sm !h-8 !text-[12.5px]">
            {all ? "Show the top 10" : `Show all ${sorted.length}`}
          </button>
        </div>
      )}
    </>
  );
}

// The account's own categories: where the listings Liston made for it sit.
function YourCategories({ rows, onOpen }: { rows: DiscoverCategoryCard[]; onOpen: (subject: DiscoverSubjectRef) => void }) {
  if (!rows.length) {
    return (
      <div className="px-4 pb-4">
        <Quiet>The categories of the listings Liston makes for this account show here.</Quiet>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] table-fixed text-[12.5px]">
        <thead className="whitespace-nowrap border-y border-[var(--color-line)] bg-[var(--color-paper)] text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          <tr>
            <th className="w-[46%] px-4 py-2 text-left">Category</th>
            <th className="px-3 py-2 text-center text-[var(--color-primary)]">Your listings</th>
            <th className="px-3 py-2 text-center">Live listings</th>
            <th className="px-3 py-2 text-center">Opportunity</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-line)]">
          {rows.map((c) => (
            <tr key={c.id} onClick={() => onOpen({ categoryId: c.id })} className="group cursor-pointer transition-colors hover:bg-[var(--color-paper)]/60">
              <td className="px-4 py-2.5 text-left">
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{c.name}</span>
                  <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-line-strong)]" />
                </span>
                {c.path && c.path.length > 0 && <span className="mt-0.5 block truncate text-[11px] text-[var(--color-muted)]">{c.path.join(" › ")}</span>}
              </td>
              <td className="px-3 py-2.5 text-center font-semibold tabular-nums text-[var(--color-ink)]">{count(c.listings ?? 0)}</td>
              <td className="px-3 py-2.5 text-center tabular-nums text-[var(--color-muted)]">{c.scanned ? compact(c.scanned.total) : "—"}</td>
              <td className="px-3 py-2.5 text-center text-[var(--color-muted)]">
                {c.scanned ? (
                  <span className="inline-flex items-center gap-1.5 tabular-nums">
                    <Dot band={c.scanned.band} />
                    {c.scanned.score}
                  </span>
                ) : (
                  <span className="text-[11.5px]">Open to score</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TAB_NOTES: Record<"all" | "yours", string> = {
  all: "eBay's top-level categories. Open one for its products, keywords and its own subcategories, best selling first.",
  yours: "Where the listings Liston made for this account sit: a good place to find the next product.",
};

/** The Categories tab: every way to look at the categories, one tab each. */
export function DiscoverCategoriesTab({ data, onOpen }: { data: DiscoverStart; onOpen: (subject: DiscoverSubjectRef) => void }) {
  const [tab, setTab] = useState<CatTab>("all");
  const best = data.bestCategories || [];
  const tabs: { key: CatTab; label: string; count?: string }[] = [
    { key: "all", label: "All", count: count(data.topCategories.length) },
    { key: "sales", label: RANKED.sales.label, count: best.length ? count(best.length) : undefined },
    { key: "score", label: RANKED.score.label },
    { key: "listings", label: RANKED.listings.label },
    { key: "trending", label: RANKED.trending.label, count: best.length ? count(best.filter((c) => c.rising > 0).length) : undefined },
    ...(data.yourCategories.length ? [{ key: "yours" as CatTab, label: "Yours", count: count(data.yourCategories.length) }] : []),
  ];
  const note = tab === "all" || tab === "yours" ? TAB_NOTES[tab] : RANKED[tab].note;
  return (
    <div className="space-y-4">
      <section className="card min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <PillTabs label="Categories" tabs={tabs} value={tab} onChange={setTab} />
          <p className="min-w-[220px] flex-1 text-[11.5px] leading-snug text-[var(--color-muted)]">{note}</p>
        </div>
        <div className={tab === "all" ? "border-t border-[var(--color-line)]" : "rounded-b-[var(--radius-card)]"}>
          {tab === "all" ? (
            <AllCategories rows={data.topCategories} onOpen={onOpen} />
          ) : tab === "yours" ? (
            <YourCategories rows={data.yourCategories} onOpen={onOpen} />
          ) : (
            <RankedCategories key={tab} rows={best} rank={tab} currency={data.market.currency} onOpen={onOpen} />
          )}
        </div>
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
