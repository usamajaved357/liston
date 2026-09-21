"use client";

import { useMemo, useState } from "react";
import type { AnalyticsHint, ListingAnalyticsRow } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { DeltaBadge } from "@/components/charts/DeltaBadge";
import { SegmentedControl } from "@/components/charts/SegmentedControl";
import { MetricKey, metricDef } from "./metrics";

// Every live listing over the chosen range: sortable by any figure,
// searchable, filterable to the ones worth a look. A row opens the
// listing's own panel.

type SortKey = MetricKey | "title";
type Filter = "all" | "attention" | "converting";

const COLUMNS: MetricKey[] = ["impressions", "views", "ctr", "sold", "sales", "conversion"];
const PAGE = 25;

const HINT_TONE: Record<AnalyticsHint["kind"], string> = {
  no_impressions: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
  low_ctr: "bg-[var(--color-warning-soft)] text-[#92400e]",
  no_sales: "bg-[var(--color-warning-soft)] text-[#92400e]",
  converting: "bg-emerald-50 text-emerald-700",
};

const HINT_ICON: Record<AnalyticsHint["kind"], string> = {
  no_impressions: "M8 3.5v5M8 11.2v.05",
  low_ctr: "M8 3.5v5M8 11.2v.05",
  no_sales: "M8 3.5v5M8 11.2v.05",
  converting: "M4.5 8.3l2.2 2.2 4.8-5",
};

export function HintChip({ hint, size = "sm" }: { hint: AnalyticsHint; size?: "sm" | "md" }) {
  return (
    <span
      title={hint.detail}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full font-semibold ${HINT_TONE[hint.kind]} ${size === "sm" ? "h-5 px-2 text-[11px]" : "h-6 px-2.5 text-[12px]"}`}
    >
      <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
        <path d={HINT_ICON[hint.kind]} stroke="currentColor" strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {hint.label}
    </span>
  );
}

function Thumb({ src }: { src: string | null }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className="h-11 w-11 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-contain" loading="lazy" />
  ) : (
    <div className="h-11 w-11 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)]" />
  );
}

export function ListingsTable({
  rows,
  currency,
  compared,
  onOpen,
  complete,
}: {
  rows: ListingAnalyticsRow[];
  currency: string | null;
  compared: string;
  onOpen: (itemId: string) => void;
  complete: boolean; // per-listing figures cover the whole range
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "desc" | "asc" }>({ key: "impressions", dir: "desc" });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);

  const counts = useMemo(
    () => ({
      attention: rows.filter((r) => r.hint && r.hint.kind !== "converting").length,
      converting: rows.filter((r) => r.hint?.kind === "converting").length,
    }),
    [rows]
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (needle && !r.title.toLowerCase().includes(needle) && !r.itemId.includes(needle)) return false;
      if (filter === "attention") return r.hint != null && r.hint.kind !== "converting";
      if (filter === "converting") return r.hint?.kind === "converting";
      return true;
    });
    const dir = sort.dir === "desc" ? -1 : 1;
    return [...list].sort((a, b) => {
      if (sort.key === "title") return a.title.localeCompare(b.title) * dir;
      const av = a[sort.key];
      const bv = b[sort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // unknowns always last
      if (bv == null) return -1;
      return (av - bv) * dir || (b.impressions ?? 0) - (a.impressions ?? 0);
    });
  }, [rows, search, filter, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "title" ? "asc" : "desc" }));
  }

  const header = (key: SortKey, label: string, align: "left" | "right" = "right") => {
    const on = sort.key === key;
    return (
      <th key={key} scope="col" aria-sort={on ? (sort.dir === "desc" ? "descending" : "ascending") : "none"} className={`px-3 py-2.5 font-semibold ${align === "right" ? "text-right" : "text-left"}`}>
        <button type="button" onClick={() => toggleSort(key)} className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-[var(--color-ink)] ${on ? "text-[var(--color-ink)]" : ""}`}>
          {label}
          <svg viewBox="0 0 10 10" className={`h-2.5 w-2.5 ${on ? "opacity-100" : "opacity-30"}`} aria-hidden>
            <path d={on && sort.dir === "asc" ? "M5 2.5L8 7H2z" : "M5 7.5L8 3H2z"} fill="currentColor" />
          </svg>
        </button>
      </th>
    );
  };

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-5 py-4">
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Listings</h2>
          <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">
            {rows.length} live {rows.length === 1 ? "listing" : "listings"} · select one for its day-by-day figures
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            size="sm"
            label="Show"
            value={filter}
            onChange={(f) => {
              setFilter(f);
              setShown(PAGE);
            }}
            options={[
              { key: "all", label: "All" },
              { key: "attention", label: `Needs attention${counts.attention ? ` · ${counts.attention}` : ""}`, title: "Listings with few clicks, views without sales, or no impressions" },
              { key: "converting", label: `Converting well${counts.converting ? ` · ${counts.converting}` : ""}` },
            ]}
          />
          <div className="relative">
            <svg viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted)]" aria-hidden>
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
              <path d="M16 16l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setShown(PAGE);
              }}
              placeholder="Search listings"
              aria-label="Search listings"
              className="input input-sm w-52 !pl-8"
            />
          </div>
        </div>
      </div>

      {!complete && (
        <p className="border-b border-[var(--color-line)] bg-[var(--color-paper)]/60 px-5 py-2 text-[12px] text-[var(--color-muted)]">
          Per-listing traffic is still filling in for part of this range. Sales are complete; insights appear once every day is in.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-[13px]">
          <thead className="bg-[var(--color-paper)]/70 text-[11px] text-[var(--color-muted)]">
            <tr>
              {header("title", "Listing", "left")}
              {COLUMNS.map((key) => header(key, metricDef(key).label))}
              <th scope="col" className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">
                Insight
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {visible.slice(0, shown).map((row) => (
              <tr
                key={row.itemId}
                tabIndex={0}
                onClick={() => onOpen(row.itemId)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(row.itemId))}
                className="group cursor-pointer transition-colors hover:bg-[var(--color-paper)] focus-visible:bg-[var(--color-primary-soft)] focus-visible:outline-none"
              >
                <td className="max-w-[340px] px-3 py-2.5 pl-5">
                  <div className="flex items-center gap-3">
                    <Thumb src={row.imageUrl} />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{row.title}</p>
                      <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">
                        {formatMoney(row.price)}
                        {row.quantityAvailable != null && <> · {row.quantityAvailable} in stock</>}
                      </p>
                    </div>
                  </div>
                </td>
                {COLUMNS.map((key) => {
                  const def = metricDef(key);
                  const change = row.changes?.[key];
                  return (
                    <td key={key} className="px-3 py-2.5 text-right align-middle">
                      <div className="font-medium tabular-nums text-[var(--color-ink)]">{def.format(row[key], currency)}</div>
                      {change != null && (
                        <div className="mt-1 flex justify-end">
                          <DeltaBadge change={change} compared={compared} size="sm" />
                        </div>
                      )}
                    </td>
                  );
                })}
                <td className="px-3 py-2.5 pr-5">{row.hint ? <HintChip hint={row.hint} /> : <span className="text-[12px] text-[var(--color-line-strong)]">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <p className="px-5 py-10 text-center text-[13px] text-[var(--color-muted)]">{search ? "No listings match that search." : "No listings to show."}</p>}
      </div>

      {visible.length > shown && (
        <div className="border-t border-[var(--color-line)] px-5 py-3 text-center">
          <button type="button" onClick={() => setShown((s) => s + PAGE)} className="btn btn-secondary btn-sm">
            Show {Math.min(PAGE, visible.length - shown)} more · {visible.length - shown} left
          </button>
        </div>
      )}
    </section>
  );
}
