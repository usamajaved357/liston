"use client";

import { DiscoverSiteKeywordSort, DiscoverSiteKeywords as SiteKeywords, DiscoverSubjectRef } from "@/lib/api";
import { count } from "@/components/research/format";
import { ViewMenu } from "@/components/ViewMenu";
import { Chevron, Quiet, ScoreBadge } from "./discover-ui";

// The keywords worth hunting across everything explored on the site: the
// phrases of the titles that sell (their sales a month where they sell
// most, and how much better those titles sell than the rest), and the
// keywords already searched with their own market (live listings, the
// opportunity). Open one to see its products, keywords and categories.
// Its words come from the search beside the tabs.
// eBay doesn't share buyers' search volume with apps, so demand is the
// sales themselves; "Your searches" (the account's own impressions) sits
// beside this for whoever sees its analytics.

const SORTS: { key: DiscoverSiteKeywordSort; label: string; short: string }[] = [
  { key: "sales", label: "Most sales a month", short: "Most sales" },
  { key: "lift", label: "Sells best for its titles (lift)", short: "Best lift" },
  { key: "opportunity", label: "Best opportunity (searched ones first)", short: "Best opportunity" },
  { key: "spread", label: "In the most categories and keywords", short: "Most widespread" },
];

export interface SiteKeywordsQuery {
  q: string;
  sort: DiscoverSiteKeywordSort;
  searchedOnly: boolean;
}

export function DiscoverSiteKeywords({
  data,
  query,
  onQuery,
  loading,
  onOpen,
  onMore,
}: {
  data: SiteKeywords | null;
  query: SiteKeywordsQuery;
  onQuery: (next: SiteKeywordsQuery) => void;
  loading: boolean;
  onOpen: (subject: DiscoverSubjectRef) => void;
  onMore: () => void;
}) {
  const set = (patch: Partial<SiteKeywordsQuery>) => onQuery({ ...query, ...patch });
  return (
    <section className="card min-w-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-3">
        <ViewMenu
          title="Sort and show"
          sections={[
            { label: "Sort by", value: query.sort, onChange: (k) => set({ sort: k as DiscoverSiteKeywordSort }), options: SORTS.map((s) => ({ key: s.key, label: s.label, short: s.short })) },
            {
              label: "Show",
              value: query.searchedOnly ? "searched" : "all",
              hideInSummary: !query.searchedOnly,
              onChange: (k) => set({ searchedOnly: k === "searched" }),
              options: [
                { key: "all", label: "Every keyword" },
                { key: "searched", label: "Only ones searched, with their own market", short: "Searched only" },
              ],
            },
          ]}
        />
        <p className="ml-auto text-[11.5px] text-[var(--color-muted)]">
          {data ? `${count(data.matched)} keyword${data.matched === 1 ? "" : "s"}${data.searched ? `, ${count(data.searched)} searched` : ""}` : ""}
          {loading && data ? " · Updating…" : ""}
        </p>
      </div>

      {!data ? (
        <div className="px-6 py-10 text-center" aria-live="polite">
          <span className="mx-auto block h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-hidden />
          <p className="mt-3 text-[13px] font-medium text-[var(--color-ink)]">Gathering the keywords that sell</p>
        </div>
      ) : data.keywords.length === 0 ? (
        <div className="px-4">
          <Quiet>
            {data.pool.subjects
              ? "No keyword matches. Clear the words, or explore more categories and keywords: every one explored adds its keywords."
              : "Nothing explored on this site yet. Open a category or search a keyword: the keywords of the titles that sell there show here."}
          </Quiet>
        </div>
      ) : (
        <div className={`overflow-x-auto rounded-b-[var(--radius-card)] ${loading ? "opacity-60" : ""}`}>
          <table className="w-full min-w-[820px] table-fixed text-[12.5px]">
            <thead className="whitespace-nowrap bg-[var(--color-paper)] text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              <tr>
                <th className="w-[30%] px-4 py-2 text-left">Keyword</th>
                <th className="px-3 py-2 text-center" title="Searched: what its leading listings sell a month. Otherwise the titles with it, where it sells most">
                  Sales a month
                </th>
                <th className="px-3 py-2 text-center" title="How much better titles with it sell than the rest: its share of the sales over its share of the titles">
                  Lift
                </th>
                <th className="px-3 py-2 text-center" title="Once searched: every live listing for it, the competition">
                  Live listings
                </th>
                <th className="px-3 py-2 text-center" title="Once searched: demand to price room, out of 100">
                  Opportunity
                </th>
                <th className="w-[22%] px-4 py-2 text-left">Sells most in</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {data.keywords.map((k) => (
                <tr key={k.term} onClick={() => onOpen({ q: k.term })} className="group cursor-pointer hover:bg-[var(--color-paper)]/60" title={`Open “${k.term}”: its products, keywords and categories`}>
                  <td className="px-4 py-2.5 text-left">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{k.term}</span>
                      <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-line-strong)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--color-primary)]" />
                    </span>
                    {k.subjects > 1 && <span className="mt-0.5 block text-[11px] text-[var(--color-muted)]">In {k.subjects} categories and keywords</span>}
                  </td>
                  <td className="px-3 py-2.5 text-center tabular-nums">
                    <span className="font-semibold text-[var(--color-ink)]">{count(Math.round(k.perMonth))}</span>
                    {k.sold !== null && <span className="block text-[11px] text-[var(--color-muted)]">{count(k.sold)} sold</span>}
                  </td>
                  <td className={`px-3 py-2.5 text-center font-semibold tabular-nums ${k.lift !== null && k.lift >= 1.3 ? "text-emerald-700" : "text-[var(--color-muted)]"}`}>{k.lift !== null ? `${k.lift}×` : "—"}</td>
                  <td className="px-3 py-2.5 text-center tabular-nums">{k.searched ? count(k.searched.live) : <span className="text-[11.5px] text-[var(--color-muted)]">Open to see</span>}</td>
                  <td className="px-3 py-2.5 text-center">{k.searched ? <ScoreBadge score={k.searched.score} band={k.searched.band} size="sm" /> : <span className="text-[11.5px] text-[var(--color-muted)]">Open to score</span>}</td>
                  <td className="px-4 py-2.5 text-left">
                    {k.from ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(k.from!.kind === "category" ? { categoryId: k.from!.value } : { q: k.from!.value });
                        }}
                        className="max-w-full truncate text-[12px] text-[var(--color-primary)] hover:underline"
                      >
                        {k.from.kind === "keyword" ? `“${k.from.name}”` : k.from.name}
                      </button>
                    ) : (
                      <span className="text-[11.5px] text-[var(--color-muted)]">Searched itself</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.matched > data.keywords.length && data.keywords.length < 400 && (
        <div className="flex items-center justify-center border-t border-[var(--color-line)] px-4 py-2.5">
          <button type="button" onClick={onMore} disabled={loading} className="btn btn-secondary btn-sm !h-8 !text-[12.5px] disabled:opacity-60">
            {loading ? "Loading…" : `Load more keywords (${count(data.matched - data.keywords.length)} more)`}
          </button>
        </div>
      )}
    </section>
  );
}
