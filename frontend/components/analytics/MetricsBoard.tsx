"use client";

import { useState } from "react";
import type { AnalyticsChanges, AnalyticsDay, AnalyticsMetrics, AnalyticsRange } from "@/lib/api";
import { KpiTile } from "@/components/charts/KpiTile";
import { ChartLegend, TrendChart, TrendTable } from "@/components/charts/TrendChart";
import { dayRangeLabel } from "@/components/charts/chart-format";
import { METRICS, MetricKey, comparedFor, metricDef, metricValue, trendPoints } from "./metrics";

// The headline figures as tiles, and the chart of whichever one is
// selected. Used by the Analytics tab (whole account) and the listing panel
// (one listing).

export function MetricsBoard({
  totals,
  changes,
  series,
  previousSeries,
  leadInSeries,
  currency,
  range,
  rangeLabel,
  previousRange,
  loading,
  compact = false,
  trafficUnavailable,
  emptyDailyMessage,
}: {
  totals: AnalyticsMetrics | null;
  changes: AnalyticsChanges | null;
  series: AnalyticsDay[];
  previousSeries: AnalyticsDay[] | null;
  // A single-day range (Today) is charted at the end of the days leading up
  // to it rather than as one lone bar.
  leadInSeries?: AnalyticsDay[] | null;
  currency: string | null;
  range: AnalyticsRange;
  rangeLabel: string;
  previousRange?: { from: string; to: string } | null;
  loading?: boolean;
  compact?: boolean;
  trafficUnavailable?: boolean; // no eBay traffic yet: show sales, dim the rest
  // Shown instead of an empty chart when the selected measure has no daily
  // figures in the range (a listing's traffic is kept day by day only while
  // it's among the account's busiest).
  emptyDailyMessage?: string;
}) {
  const [selected, setSelected] = useState<MetricKey>("views");
  const def = metricDef(selected);
  const compared = comparedFor(range);
  const leadIn = series.length <= 1 && leadInSeries && leadInSeries.length > 1 ? leadInSeries : null;
  const shown = leadIn ?? series;
  const points = trendPoints(shown, leadIn ? null : previousSeries, def);
  const single = shown.length <= 1;
  const shownLabel = leadIn ? dayRangeLabel(leadIn[0].day, leadIn[leadIn.length - 1].day) : rangeLabel;
  const hasPrevious = points.some((p) => p.previous != null);
  const salesMetric = selected === "sold" || selected === "sales";
  const drawn = !(loading && !shown.length) && points.some((p) => p.value != null);
  const note = leadIn
    ? salesMetric
      ? "Today so far (live), after the 13 days before it"
      : "The 13 days before today · today’s traffic arrives once eBay closes the day"
    : hasPrevious
      ? "Each day against the same day of the previous period"
      : previousRange && salesMetric
        ? "No earlier period to compare: eBay keeps 90 days of orders"
        : null;

  return (
    <div className={compact ? "space-y-4" : "space-y-5"}>
      <div role="tablist" aria-label="Measure shown in the chart" className={`grid gap-2.5 ${compact ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-3 xl:grid-cols-6"}`}>
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
              spark={single ? undefined : shown.map(m.daily)}
              selected={selected === m.key}
              onSelect={() => setSelected(m.key)}
              loading={loading}
            />
          );
        })}
      </div>

      <section className="card p-5" aria-label={`${def.label} by day`}>
        {/* The heading on the left; on the right, which line is which, each
            with its own dates. */}
        <div className="mb-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">{def.label} by day</h2>
            {note && <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">{note}</p>}
          </div>
          {drawn && (
            <ChartLegend
              current={shownLabel}
              currentCaption={leadIn ? `Last ${leadIn.length} days` : "This period"}
              previous={hasPrevious && previousRange ? dayRangeLabel(previousRange.from, previousRange.to) : null}
              today={points.some((p) => p.partial && p.value != null)}
              bars={single}
            />
          )}
        </div>
        {loading && !shown.length ? (
          <div className="h-[276px] animate-pulse rounded-xl bg-[var(--color-paper)]" />
        ) : points.every((p) => p.value == null) ? (
          <div className="flex h-[248px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-[var(--color-line)] px-6 text-center">
            <p className="text-[13px] font-medium text-[var(--color-ink)]">No day-by-day {def.label.toLowerCase()} for this range</p>
            <p className="max-w-md text-[12px] leading-relaxed text-[var(--color-muted)]">{emptyDailyMessage || "eBay hasn't reported these days yet."}</p>
          </div>
        ) : (
          <>
            <TrendChart
              points={points}
              label={`${def.label} per day, ${shownLabel}`}
              format={(v) => def.format(v, currency)}
              axisFormat={(v) => def.axis(v, currency)}
              variant={single ? "bars" : def.variant}
              currentLabel={shownLabel}
              previousLabel="Previous period"
              legend={false}
            />
            {/* The same days as a table, for screen readers. */}
            <div className="sr-only">
              <TrendTable points={points} format={(v) => def.format(v, currency)} currentLabel={def.label} previousLabel="Previous period" />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
