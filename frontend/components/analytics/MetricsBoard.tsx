"use client";

import { useState } from "react";
import type { AnalyticsChanges, AnalyticsDay, AnalyticsMetrics, AnalyticsRange } from "@/lib/api";
import { KpiTile } from "@/components/charts/KpiTile";
import { TrendChart, TrendTable } from "@/components/charts/TrendChart";
import { SegmentedControl } from "@/components/charts/SegmentedControl";
import { dayRangeLabel } from "@/components/charts/chart-format";
import { METRICS, MetricKey, comparedFor, metricDef, metricValue, trendPoints } from "./metrics";

// The headline figures as tiles, and the chart of whichever one is
// selected, with its day-by-day table one click away. Used by the
// Analytics tab (whole account) and the listing panel (one listing).

export function MetricsBoard({
  totals,
  changes,
  series,
  previousSeries,
  currency,
  range,
  rangeLabel,
  previousRange,
  loading,
  compact = false,
  trafficUnavailable,
}: {
  totals: AnalyticsMetrics | null;
  changes: AnalyticsChanges | null;
  series: AnalyticsDay[];
  previousSeries: AnalyticsDay[] | null;
  currency: string | null;
  range: AnalyticsRange;
  rangeLabel: string;
  previousRange?: { from: string; to: string } | null;
  loading?: boolean;
  compact?: boolean;
  trafficUnavailable?: boolean; // no eBay traffic yet: show sales, dim the rest
}) {
  const [selected, setSelected] = useState<MetricKey>("views");
  const [view, setView] = useState<"chart" | "table">("chart");
  const def = metricDef(selected);
  const compared = comparedFor(range);
  const points = trendPoints(series, previousSeries, def);
  const single = series.length <= 1;

  return (
    <div className={compact ? "space-y-4" : "space-y-5"}>
      <div role="tablist" aria-label="Measure shown in the chart" className={`grid gap-3 ${compact ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 md:grid-cols-3 xl:grid-cols-6"}`}>
        {METRICS.map((m) => {
          const traffic = m.key === "impressions" || m.key === "views" || m.key === "ctr" || m.key === "conversion";
          return (
            <KpiTile
              key={m.key}
              label={m.label}
              info={m.info}
              value={trafficUnavailable && traffic ? "—" : m.format(metricValue(totals, m.key), currency)}
              change={changes ? changes[m.key] : null}
              compared={compared}
              spark={single ? undefined : series.map(m.daily)}
              selected={selected === m.key}
              onSelect={() => setSelected(m.key)}
              loading={loading}
            />
          );
        })}
      </div>

      <section className="card p-5" aria-label={`${def.label} by day`}>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">{def.label} by day</h2>
            <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">
              {rangeLabel}
              {previousRange && <> · compared with {dayRangeLabel(previousRange.from, previousRange.to)}</>}
            </p>
          </div>
          <SegmentedControl
            size="sm"
            label="Show as"
            value={view}
            onChange={setView}
            options={[
              { key: "chart", label: "Chart" },
              { key: "table", label: "Table" },
            ]}
          />
        </div>
        {loading && !series.length ? (
          <div className="h-[276px] animate-pulse rounded-xl bg-[var(--color-paper)]" />
        ) : view === "chart" ? (
          <TrendChart
            points={points}
            label={`${def.label} per day, ${rangeLabel}`}
            format={(v) => def.format(v, currency)}
            axisFormat={(v) => def.axis(v, currency)}
            variant={single ? "bars" : def.variant}
            currentLabel={rangeLabel}
            previousLabel="Previous period"
          />
        ) : (
          <TrendTable points={points} format={(v) => def.format(v, currency)} currentLabel={def.label} previousLabel="Previous period" />
        )}
      </section>
    </div>
  );
}
