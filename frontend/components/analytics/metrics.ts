// What each analytics figure is, how it reads, and how it's charted — one
// place, so the tiles, the chart, the table and the listing panel agree.
import type { AnalyticsDay, AnalyticsRange, AnalyticsMetrics } from "@/lib/api";
import type { TrendPoint } from "@/components/charts/TrendChart";
import { compactNumber, fullNumber, moneyAmount, percent } from "@/components/charts/chart-format";

export type MetricKey = "impressions" | "views" | "ctr" | "sold" | "sales" | "conversion";

export interface MetricDef {
  key: MetricKey;
  label: string;
  info: string;
  variant: "area" | "bars";
  format: (v: number | null, currency: string | null) => string;
  axis: (v: number, currency: string | null) => string;
  // The figure for one day of the series (rates are recomputed per day).
  daily: (d: AnalyticsDay) => number | null;
}

export const METRICS: MetricDef[] = [
  {
    key: "impressions",
    label: "Impressions",
    info: "How many times your listings were shown anywhere on eBay: search, your store and every other page. The same total Seller Hub shows.",
    variant: "area",
    format: (v) => fullNumber(v),
    axis: (v) => compactNumber(v),
    daily: (d) => d.impressions,
  },
  {
    key: "views",
    label: "Views",
    info: "How many times buyers opened a listing's page.",
    variant: "area",
    format: (v) => fullNumber(v),
    axis: (v) => compactNumber(v),
    daily: (d) => d.views,
  },
  {
    key: "ctr",
    label: "Click-through",
    info: "Of the times a listing appeared in eBay search, how often a buyer clicked into it (eBay's definition).",
    variant: "area",
    format: (v) => percent(v),
    axis: (v) => percent(v),
    daily: (d) => d.ctr,
  },
  {
    key: "sold",
    label: "Units sold",
    info: "Items sold, from your orders (cancelled orders don't count).",
    variant: "area",
    format: (v) => fullNumber(v),
    axis: (v) => compactNumber(v),
    daily: (d) => d.sold,
  },
  {
    key: "sales",
    label: "Sales",
    info: "Item price × quantity from your orders, before eBay fees and excluding postage.",
    variant: "area",
    format: (v, c) => moneyAmount(v, c),
    axis: (v, c) => moneyAmount(v, c, { compact: true }).replace(/\.00$/, ""),
    daily: (d) => d.sales,
  },
  {
    key: "conversion",
    label: "Conversion",
    info: "Units sold for every listing view.",
    variant: "area",
    format: (v) => percent(v),
    axis: (v) => percent(v),
    daily: (d) => (d.views == null || d.sold == null ? null : d.views > 0 ? d.sold / d.views : null),
  },
];

export const metricDef = (key: MetricKey) => METRICS.find((m) => m.key === key)!;

export function metricValue(m: AnalyticsMetrics | null | undefined, key: MetricKey): number | null {
  if (!m) return null;
  return m[key] ?? null;
}

/** Current days with the previous period's matching day alongside. */
export function trendPoints(series: AnalyticsDay[], previous: AnalyticsDay[] | null | undefined, def: MetricDef): TrendPoint[] {
  return series.map((d, i) => ({
    day: d.day,
    value: def.daily(d),
    previous: previous?.[i] ? def.daily(previous[i]) : null,
    previousDay: previous?.[i]?.day ?? null,
    partial: d.partial,
  }));
}

export const RANGE_OPTIONS: { key: AnalyticsRange; label: string; compared: string }[] = [
  { key: "7d", label: "7 days", compared: "vs the 7 days before" },
  { key: "30d", label: "30 days", compared: "vs the 30 days before" },
  { key: "this_month", label: "This month", compared: "vs the same days last month" },
  { key: "last_month", label: "Last month", compared: "vs the month before" },
  { key: "90d", label: "90 days", compared: "vs the 90 days before" },
];

export const comparedFor = (range: AnalyticsRange) => RANGE_OPTIONS.find((r) => r.key === range)?.compared ?? "vs the previous period";
