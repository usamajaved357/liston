"use client";

import { useEffect, useMemo, useState } from "react";
import type { ListingAnalyticsRow, ListingReportInfo } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { DeltaBadge } from "@/components/charts/DeltaBadge";
import { SegmentedControl } from "@/components/charts/SegmentedControl";
import { compactNumber, fullNumber } from "@/components/charts/chart-format";
import { ListFooter } from "@/components/ListFooter";
import { MetricKey, metricDef } from "./metrics";
import { HintTag } from "./InsightCards";
import { ListingFilter, actionDef, matchesFilter } from "./insights";

// Every live listing over the chosen range: sortable by any figure,
// searchable, filterable to the ones worth a look (or to one group from the
// Growth opportunities card), paged like the Orders list. A row opens the
// listing's own panel. Laid out to fit without sideways scrolling: the
// insight sits under the title, the figures are centred under their
// headings, and each change is a line of small text under its figure.
// Traffic is added up from the stored day-by-day history; a range it
// doesn't reach yet shows "—" (never a made-up zero). Sales, units and
// watchers are always exact.

type SortKey = MetricKey | "title" | "watchers";

const COLUMNS: { key: MetricKey | "watchers"; label: string }[] = [
  { key: "impressions", label: "Impressions" },
  { key: "views", label: "Views" },
  { key: "ctr", label: "Click-through" },
  { key: "sold", label: "Sold" },
  { key: "sales", label: "Sales" },
  { key: "conversion", label: "Conversion" },
  { key: "watchers", label: "Watchers" },
];
const PAGE_SIZES = [25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZES)[number];
const TRAFFIC_KEYS: string[] = ["impressions", "views", "ctr", "conversion"];

function Thumb({ src }: { src: string | null }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className="h-10 w-10 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-contain" loading="lazy" />
  ) : (
    <div className="h-10 w-10 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)]" />
  );
}

function ReportNote({
  report,
  partial,
  todayRead,
  belowCount,
  onLoadAll,
  loadingAll,
}: {
  report: ListingReportInfo;
  partial: boolean;
  todayRead: boolean;
  belowCount: number;
  onLoadAll: () => void;
  loadingAll: boolean;
}) {
  let text: React.ReactNode = null;
  if (partial) {
    text = todayRead ? "Today’s listing figures are from your last Refresh today." : "Press Refresh today for today’s listing traffic. Sales and units below are live.";
  } else if (report.state === "allowance") {
    text = "Listing traffic for this range couldn’t be read: today’s eBay allowance is used up. Sales, units and watchers are exact.";
  } else if (report.state === "error") {
    text = "eBay didn’t return listing traffic for this range. Sales, units and watchers are exact.";
  } else if (report.state === "filling") {
    text = "Listing traffic for this range appears once its days are stored. Sales, units and watchers are exact now.";
  } else if (report.state === "ok" && report.busiest && belowCount > 0) {
    text = `Traffic shown for your busiest listings; the other ${fullNumber(belowCount)} weren’t among eBay’s 200 busiest every day of this range.`;
  } else if (report.state === "ok" && report.cutoff != null && report.scope !== "all" && belowCount > 0) {
    text = `Traffic read for your busiest listings; the other ${fullNumber(belowCount)} had fewer than ${fullNumber(report.cutoff)} impressions each.`;
  }
  if (!text) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-paper)]/60 px-4 py-2 text-[11.5px] text-[var(--color-muted)]">
      <span className="flex-1">{text}</span>
      {report.canLoadAll && !partial && (
        <button type="button" onClick={onLoadAll} disabled={loadingAll} className="btn btn-secondary btn-sm" title={`Reads every listing's figures for this range: ${report.loadAllCalls} calls from today's allowance`}>
          {loadingAll ? "Loading…" : `Load all ${fullNumber(report.live)}`}
          <span className="text-[11px] font-medium text-[var(--color-muted)]">
            {report.loadAllCalls} {report.loadAllCalls === 1 ? "call" : "calls"}
          </span>
        </button>
      )}
    </div>
  );
}

export function ListingsTable({
  rows,
  currency,
  compared,
  days,
  onOpen,
  report,
  partial,
  todayRead,
  onLoadAll,
  loadingAll,
  filter,
  onFilter,
}: {
  rows: ListingAnalyticsRow[];
  currency: string | null;
  compared: string;
  days: number; // the range's length, for the stock-cover filter
  onOpen: (itemId: string) => void;
  report: ListingReportInfo;
  partial: boolean; // Today: listing traffic only after "Refresh today"
  todayRead: boolean;
  onLoadAll: () => void;
  loadingAll: boolean;
  filter: ListingFilter;
  onFilter: (f: ListingFilter) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "desc" | "asc" }>({ key: "impressions", dir: "desc" });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<PageSize>(25);

  // A new filter, search, sort or range starts again from page one.
  useEffect(() => setPage(1), [filter, search, sort, rows]);

  const counts = useMemo(
    () => ({
      attention: rows.filter((r) => r.hint && r.hint.kind !== "converting").length,
      converting: rows.filter((r) => r.hint?.kind === "converting").length,
    }),
    [rows]
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = rows.filter((r) => (!needle || r.title.toLowerCase().includes(needle) || r.itemId.includes(needle)) && matchesFilter(r, filter, days));
    const dir = sort.dir === "desc" ? -1 : 1;
    return [...list].sort((a, b) => {
      if (sort.key === "title") return a.title.localeCompare(b.title) * dir;
      const av = sort.key === "watchers" ? a.watchers : a[sort.key];
      const bv = sort.key === "watchers" ? b.watchers : b[sort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // unknowns always last
      if (bv == null) return -1;
      return (av - bv) * dir || (b.impressions ?? 0) - (a.impressions ?? 0);
    });
  }, [rows, search, filter, sort, days]);

  const totalPages = Math.max(1, Math.ceil(visible.length / perPage));
  const current = Math.min(page, totalPages);
  const pageRows = visible.slice((current - 1) * perPage, current * perPage);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "title" ? "asc" : "desc" }));
  }

  // The arrow hangs outside the heading's words (absolutely placed), so the
  // words themselves sit centred over the figures below.
  const header = (key: SortKey, label: string, align: "left" | "center" = "center") => {
    const on = sort.key === key;
    const arrow = (
      <svg viewBox="0 0 10 10" className={`absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 ${align === "center" ? "-right-3" : "-right-3.5"} ${on ? "opacity-100" : "opacity-0 group-hover/th:opacity-40"}`} aria-hidden>
        <path d={on && sort.dir === "asc" ? "M5 2.5L8 7H2z" : "M5 7.5L8 3H2z"} fill="currentColor" />
      </svg>
    );
    return (
      <th key={key} scope="col" aria-sort={on ? (sort.dir === "desc" ? "descending" : "ascending") : "none"} className={`group/th px-1.5 py-2.5 font-semibold ${align === "center" ? "text-center" : "pl-4 text-left"}`}>
        <button
          type="button"
          onClick={() => toggleSort(key)}
          className={`relative inline-block text-[11px] leading-tight transition-colors hover:text-[var(--color-ink)] ${on ? "text-[var(--color-primary)]" : ""}`}
        >
          {label}
          {arrow}
        </button>
      </th>
    );
  };

  const figure = (row: ListingAnalyticsRow, key: MetricKey | "watchers") => {
    if (key === "watchers") {
      return <span className="font-semibold tabular-nums text-[var(--color-ink)]">{row.watchers == null ? "—" : fullNumber(row.watchers)}</span>;
    }
    if (row.traffic === "pending" && TRAFFIC_KEYS.includes(key)) {
      return <span className="text-[var(--color-line-strong)]" title="Appears once this range's days are stored">—</span>;
    }
    if (row.traffic === "below" && TRAFFIC_KEYS.includes(key)) {
      return report.cutoff != null && key === "impressions" ? (
        <span className="text-[11.5px] text-[var(--color-muted)]" title={`Fewer than ${fullNumber(report.cutoff)} impressions in this range`}>
          &lt; {compactNumber(report.cutoff)}
        </span>
      ) : (
        <span className="text-[var(--color-muted)]" title="Not among eBay's 200 busiest every day of this range; Load all reads it">
          —
        </span>
      );
    }
    const def = metricDef(key);
    const value = row[key];
    const change = row.changes?.[key];
    // Impressions run to six figures: compact, with the exact figure on hover.
    const text = key === "impressions" && value != null && value >= 100000 ? compactNumber(value) : def.format(value, currency);
    return (
      <span className="inline-flex flex-col items-center leading-tight" title={key === "impressions" && value != null ? `${fullNumber(value)} impressions` : undefined}>
        <span className="font-semibold tabular-nums text-[var(--color-ink)]">{text}</span>
        {/* No change is no news: only a real move gets a line. */}
        {change != null && Math.abs(change) >= 0.005 && <DeltaBadge change={change} compared={compared} size="sm" variant="text" />}
      </span>
    );
  };

  const filterLabel = filter !== "all" && filter !== "attention" && filter !== "converting" ? actionDef(filter).label : null;

  return (
    <section className="card flex flex-col overflow-hidden" id="analytics-listings">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Listings</h2>
          <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">
            {rows.length} live {rows.length === 1 ? "listing" : "listings"} · select one for its day-by-day figures
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {filterLabel ? (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[var(--color-primary-soft)] pl-3 pr-1 text-[11.5px] font-semibold text-[var(--color-primary)]">
              {filterLabel} · {visible.length}
              <button type="button" onClick={() => onFilter("all")} className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-white/70" aria-label="Clear filter">
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          ) : (
            <SegmentedControl
              size="sm"
              label="Show"
              value={filter}
              onChange={onFilter}
              options={[
                { key: "all", label: "All" },
                { key: "attention", label: `Needs attention${counts.attention ? ` · ${counts.attention}` : ""}`, title: "Few clicks, views without sales, or no impressions" },
                { key: "converting", label: `Converting${counts.converting ? ` · ${counts.converting}` : ""}` },
              ]}
            />
          )}
          <div className="relative">
            <svg viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted)]" aria-hidden>
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
              <path d="M16 16l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search listings" aria-label="Search listings" className="input input-sm w-44 !pl-8" />
          </div>
        </div>
      </div>

      <ReportNote report={report} partial={partial} todayRead={todayRead} belowCount={rows.filter((r) => r.traffic === "below").length} onLoadAll={onLoadAll} loadingAll={loadingAll} />

      {/* Rows scroll inside the card under a pinned header; the pages stay at its foot. */}
      {/* Wide enough for every column from ~900px; below that the rows scroll sideways inside the card. */}
      <div className="max-h-[min(640px,calc(100vh-220px))] overflow-auto min-[900px]:overflow-x-hidden">
        <table className="w-full min-w-[660px] table-fixed text-[12.5px]">
          <colgroup>
            <col className="w-[31%]" />
            {COLUMNS.map((c) => (
              <col key={c.key} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-[var(--color-paper)] text-[var(--color-muted)] shadow-[0_1px_0_var(--color-line)]">
            <tr>
              {header("title", "Listing", "left")}
              {COLUMNS.map((c) => header(c.key, c.label))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => (
              <tr
                key={row.itemId}
                tabIndex={0}
                onClick={() => onOpen(row.itemId)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(row.itemId))}
                className="group cursor-pointer border-b border-[var(--color-line)]/70 transition-colors last:border-0 hover:bg-[var(--color-primary-soft)]/40 focus-visible:bg-[var(--color-primary-soft)] focus-visible:outline-none"
              >
                <td className="py-2 pl-4 pr-2">
                  <div className="flex items-center gap-2.5">
                    <Thumb src={row.imageUrl} />
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]" title={row.title}>
                        {row.title}
                      </p>
                      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
                        <span className="whitespace-nowrap tabular-nums">{formatMoney(row.price)}</span>
                        {row.quantityAvailable != null && (
                          <>
                            <span aria-hidden>·</span>
                            <span className={`whitespace-nowrap ${row.quantityAvailable <= 2 ? "font-semibold text-[var(--color-danger)]" : ""}`}>{row.quantityAvailable} in stock</span>
                          </>
                        )}
                        {row.hint && <HintTag hint={row.hint} />}
                      </p>
                    </div>
                  </div>
                </td>
                {COLUMNS.map((c) => (
                  <td key={c.key} className="px-1.5 py-2 text-center align-middle">
                    {figure(row, c.key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className="px-5 py-10 text-center text-[13px] text-[var(--color-muted)]">{search ? "No listings match that search." : filter !== "all" ? "No listings in this group for this range." : "No listings to show."}</p>
        )}
      </div>

      {visible.length > 0 && (
        <div className="border-t border-[var(--color-line)] bg-[var(--color-panel)] px-4">
          <ListFooter
            page={current}
            totalPages={totalPages}
            totalEntries={visible.length}
            perPage={perPage}
            sizes={PAGE_SIZES}
            onPage={(p) => {
              setPage(p);
              document.getElementById("analytics-listings")?.querySelector(".overflow-auto")?.scrollTo({ top: 0, behavior: "smooth" });
            }}
            onPerPage={(n) => {
              setPerPage(n);
              setPage(1);
            }}
          />
        </div>
      )}
    </section>
  );
}
