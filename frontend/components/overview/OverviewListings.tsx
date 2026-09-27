"use client";

import { useState } from "react";
import { ListingTrendKey, ListingTrendPoint, RecentListing } from "@/lib/api";
import { TrendChart } from "@/components/charts/TrendChart";
import { ViewMenu } from "@/components/ViewMenu";
import { InlineLegend } from "./OverviewSales";

// Under the Overview's Listings cards, as the Sales tab has its chart and
// best sellers: the listing pipeline day by day (one measure at a time,
// the stretch before alongside) and the newest listings put live from
// Liston, each with what it has sold in the dates.

const CHART_HEIGHT = 164;
const MEASURES: { key: ListingTrendKey; label: string }[] = [
  { key: "published", label: "Listings published" },
  { key: "drafted", label: "Listings drafted" },
  { key: "hunted", label: "Products hunted" },
  { key: "approved", label: "Products approved" },
  { key: "rejected", label: "Products rejected" },
];
const count = (n: number) => n.toLocaleString("en-GB");

export function ListingTrendCard({ points, caption }: { points: ListingTrendPoint[] | null; caption: string }) {
  const [measure, setMeasure] = useState<ListingTrendKey>("published");
  const chosen = MEASURES.find((m) => m.key === measure) || MEASURES[0];
  const list = points ?? [];
  const total = list.reduce((n, p) => n + p.values[measure], 0);
  const previous = list.reduce((n, p) => n + (p.previous?.[measure] ?? 0), 0);
  const change = previous ? (total - previous) / previous : null;
  return (
    <section className="card flex h-full min-w-0 flex-col px-4 pb-3 pt-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">{chosen.label} by day</h2>
          <div className="mt-1">
            <InlineLegend current={caption} previous={list.length > 0} today={list.some((p) => p.partial)} />
          </div>
        </div>
        <div className="flex items-start gap-3">
          {list.length > 0 && (
            <p className="text-right text-[12.5px] text-[var(--color-muted)]">
              <b className="text-[15px] font-semibold tabular-nums text-[var(--color-ink)]">{count(total)}</b>
              {change !== null ? (
                <span className={`mt-0.5 block text-[12px] font-medium tabular-nums ${change >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {change >= 0 ? "▲" : "▼"} {Math.abs(Math.round(change * 100))}% vs previous
                </span>
              ) : (
                <span className="mt-0.5 block text-[11.5px]">{count(previous)} before</span>
              )}
            </p>
          )}
          <ViewMenu title="Measure" sections={[{ label: "Show", value: measure, options: MEASURES.map((m) => ({ key: m.key, label: m.label })), onChange: (k) => setMeasure(k as ListingTrendKey) }]} />
        </div>
      </div>
      <div className="mt-2 min-w-0">
        {!points || list.length === 0 ? (
          <p className="flex items-center justify-center text-center text-[13px] text-[var(--color-muted)]" style={{ height: CHART_HEIGHT }}>
            Nothing to chart yet.
          </p>
        ) : (
          <TrendChart
            points={list.map((p) => ({ day: p.day, value: p.values[measure], previous: p.previous ? p.previous[measure] : null, previousDay: p.previousDay, partial: p.partial }))}
            height={CHART_HEIGHT}
            legend={false}
            label={`${chosen.label} per day, ${caption.toLowerCase()}`}
            format={(v) => (v == null ? "—" : count(v))}
            // Counts: whole numbers only on the side.
            axisFormat={(v) => (Number.isInteger(v) ? count(v) : "")}
            currentLabel={caption}
            previousLabel="Previous period"
          />
        )}
      </div>
    </section>
  );
}

/** Several markets' trends added up day by day (they share the same days). */
export function addListingTrends(trends: (ListingTrendPoint[] | null | undefined)[]): ListingTrendPoint[] | null {
  const list = trends.filter((t): t is ListingTrendPoint[] => Array.isArray(t) && t.length > 0);
  if (!list.length) return null;
  const keys = MEASURES.map((m) => m.key);
  return list[0].map((point, i) => ({
    ...point,
    values: Object.fromEntries(keys.map((k) => [k, list.reduce((n, t) => n + (t[i]?.values[k] || 0), 0)])) as Record<ListingTrendKey, number>,
    previous: Object.fromEntries(keys.map((k) => [k, list.reduce((n, t) => n + (t[i]?.previous?.[k] || 0), 0)])) as Record<ListingTrendKey, number>,
  }));
}

function when(iso: string) {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return d.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function RecentListingsCard({ items, showMarket, flagOf }: { items: RecentListing[] | null; showMarket: boolean; flagOf: (marketplaceId: string) => string }) {
  const shown = (items ?? []).slice(0, 5);
  return (
    <section className="card flex h-full min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-2 px-4 pt-3.5">
        <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Recently published</h2>
        <span className="text-[11.5px] text-[var(--color-muted)]">From Liston, with sales since</span>
      </div>
      {shown.length === 0 ? (
        <p className="flex flex-1 items-center justify-center px-4 py-8 text-center text-[13px] text-[var(--color-muted)]">Nothing published from Liston in these dates yet.</p>
      ) : (
        <ol className="mt-1.5 divide-y divide-[var(--color-line)]">
          {shown.map((item) => {
            const row = (
              <>
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.image} alt="" loading="lazy" className="h-7 w-7 shrink-0 rounded-md border border-[var(--color-line)] bg-white object-contain" />
                ) : (
                  <span className="h-7 w-7 shrink-0 rounded-md border border-dashed border-[var(--color-line)] bg-[var(--color-paper)]" />
                )}
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[12.5px] font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{item.title ?? (item.itemId ? `Item ${item.itemId}` : "Listing")}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--color-muted)]">
                    {showMarket && `${flagOf(item.marketplaceId)} `}
                    {item.account} · {when(item.publishedAt)}
                  </span>
                </span>
                <span className="shrink-0 text-right leading-tight">
                  <span className={`block text-[12.5px] font-semibold tabular-nums ${item.units ? "text-emerald-600" : "text-[var(--color-muted)]"}`}>{item.units ? `${count(item.units)} sold` : "No sales yet"}</span>
                </span>
              </>
            );
            return (
              <li key={item.id}>
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer" className="group flex items-center gap-2.5 px-4 py-[5px] transition-colors hover:bg-[var(--color-paper)]/70" title={item.title ?? undefined}>
                    {row}
                  </a>
                ) : (
                  <div className="flex items-center gap-2.5 px-4 py-[5px]">{row}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
