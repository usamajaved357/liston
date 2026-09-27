"use client";

import { ReactNode, useState } from "react";
import { ViewMenu } from "@/components/ViewMenu";
import { TeamMetricKey, WorkOverview } from "@/lib/api";
import { DeltaBadge } from "@/components/charts/DeltaBadge";
import { TrendChart } from "@/components/charts/TrendChart";
import { dayRangeLabel, fullNumber } from "@/components/charts/chart-format";
import { money } from "@/components/research/format";
import { hoursText } from "@/components/hunting/HuntBits";

// A team member's Performance tab, laid out like the Overview: one card per
// area they work in (what they have access to, or did work in, in this
// period), each with its headline against the period before and the
// details behind it; then one chart of any measure, day by day against the
// period before; then the same by eBay account.
//
// `self`: the member's own Overview on one account — "you" and "your",
// no log links (the log is the owner's), no by-account table, and never any
// money (sales from their finds are units and orders; the server sends no
// amounts).

const change = (now: number, before: number) => (before > 0 ? (now - before) / before : null);

type Tone = "good" | "bad" | "warn" | "info" | "plain";
const TONE: Record<Tone, string> = {
  good: "text-emerald-700",
  bad: "text-rose-700",
  warn: "text-amber-700",
  info: "text-indigo-700",
  plain: "text-[var(--color-ink)]",
};

type Row = { label: string; value: string; tone?: Tone; metric?: TeamMetricKey; hint?: string };

function AreaCard({
  title,
  accent,
  value,
  unit,
  delta,
  compared,
  note,
  rows,
  onOpenLog,
  headlineMetric,
}: {
  title: string;
  accent: string;
  value: string;
  unit?: string;
  delta?: number | null;
  compared: string;
  note: ReactNode;
  rows: Row[];
  onOpenLog?: (kind: TeamMetricKey) => void;
  headlineMetric?: TeamMetricKey;
}) {
  return (
    <section className="card flex min-w-0 flex-col px-4 pb-2 pt-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[12.5px] font-semibold text-[var(--color-muted)]">
          <span className={`h-2 w-2 rounded-full ${accent}`} aria-hidden />
          {title}
        </span>
        {headlineMetric && onOpenLog && (
          <button type="button" onClick={() => onOpenLog(headlineMetric)} className="text-[11.5px] font-medium text-[var(--color-primary)] hover:underline">
            Log
          </button>
        )}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-[26px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">{value}</span>
        {unit && <span className="text-[12px] text-[var(--color-muted)]">{unit}</span>}
        {delta !== undefined && (
          <span className="ml-auto">
            <DeltaBadge change={delta} compared={compared} size="sm" />
          </span>
        )}
      </div>
      <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">{note}</p>
      <dl className="mt-3 divide-y divide-[var(--color-line)] border-t border-[var(--color-line)]">
        {rows.map((r) => {
          const content = (
            <>
              <dt className="truncate text-[12.5px] text-[var(--color-muted)]">{r.label}</dt>
              <dd className={`flex-shrink-0 text-[12.5px] font-semibold tabular-nums ${TONE[r.tone || "plain"]}`}>{r.value}</dd>
            </>
          );
          return r.metric && onOpenLog ? (
            <button
              key={r.label}
              type="button"
              onClick={() => onOpenLog(r.metric!)}
              title={r.hint || `See each one in the log`}
              className="-mx-1.5 flex w-[calc(100%+12px)] items-center justify-between gap-3 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-[var(--color-paper)]"
            >
              {content}
            </button>
          ) : (
            <div key={r.label} className="flex items-center justify-between gap-3 py-1.5" title={r.hint}>
              {content}
            </div>
          );
        })}
      </dl>
    </section>
  );
}

export function MemberPerformance({ data, onOpenLog, self = false }: { data: WorkOverview; onOpenLog?: (kind: TeamMetricKey) => void; self?: boolean }) {
  // Their words, or yours.
  const they = self ? "you" : "they";
  const Their = self ? "Your" : "Their";
  const compared = `vs ${dayRangeLabel(data.range.previous.from, data.range.previous.to)}`;
  const t = data.totals;
  const p = data.previous;
  const has = (feature: string) => data.permissions.some((x) => x.feature === feature && x.allowed);
  const any = (keys: TeamMetricKey[]) => keys.some((k) => t[k] > 0 || p[k] > 0);
  const h = data.hunting;

  const ORDER_KEYS: TeamMetricKey[] = ["supplier_orders", "dispatched", "cases"];
  const LISTING_KEYS: TeamMetricKey[] = ["published", "drafted", "draft_work", "edited", "relisted", "ended"];
  const showOrders = has("orders") || any(ORDER_KEYS);
  const showListings = has("listings") || any(LISTING_KEYS);
  const showHunting = has("hunting") || has("hunting_review") || Boolean(h && (h.hunter.hunted || h.previousHunter.hunted)) || any(["hunted"]);
  const showReviews = has("hunting_review") || Boolean(h && (h.reviewer.reviewed || h.previousReviewer.reviewed));

  // The chart's measures, a few that matter, for the areas shown: orders
  // placed and shipped, listings drafted and published, products hunted and
  // (decided by a reviewer, on the day decided) approved and rejected, and
  // converting (their finds with a sale that day).
  type ChartKey = "supplier_orders" | "dispatched" | "drafted" | "published" | "hunted" | "approved" | "rejected" | "converting";
  type OutcomeKey = "approved" | "rejected" | "converting";
  const isOutcome = (k: ChartKey): k is OutcomeKey => k === "approved" || k === "rejected" || k === "converting";
  const CHART: { key: ChartKey; label: string; area: "orders" | "listings" | "hunting"; log?: TeamMetricKey }[] = [
    { key: "supplier_orders", label: "Orders placed", area: "orders", log: "supplier_orders" },
    { key: "dispatched", label: "Orders shipped", area: "orders", log: "dispatched" },
    { key: "drafted", label: "Listings drafted", area: "listings", log: "drafted" },
    { key: "published", label: "Listings published", area: "listings", log: "published" },
    { key: "hunted", label: "Products hunted", area: "hunting", log: "hunted" },
    { key: "approved", label: "Products approved", area: "hunting" },
    { key: "rejected", label: "Products rejected", area: "hunting" },
    // Their finds that sold: how many different products had an order that day.
    { key: "converting", label: "Converting products", area: "hunting" },
  ];
  const o = data.huntOutcomes;
  const chartOptions = CHART.filter((c) => (c.area === "orders" ? showOrders : c.area === "listings" ? showListings : showHunting));
  const options = chartOptions.length ? chartOptions : CHART.slice(0, 1);
  const valueAt = (k: ChartKey, i: number, before = false): number | null => {
    if (isOutcome(k)) return (before ? o?.previousSeries : o?.series)?.[i]?.[k] ?? null;
    const row = (before ? data.previousSeries : data.series)[i];
    return row ? row[k] : null;
  };
  const totalOf = (k: ChartKey, before = false) => (isOutcome(k) ? (before ? o?.previous[k] : o?.totals[k]) ?? 0 : before ? p[k] : t[k]);
  const [metric, setMetric] = useState<ChartKey>(() => options.find((c) => totalOf(c.key) > 0)?.key || options[0].key);
  const chosen = options.find((c) => c.key === metric) || options[0];
  const label = (k: TeamMetricKey) => data.metrics.find((m) => m.key === k)?.label || k;
  const points = data.series.map((s, i) => ({ day: s.day, value: valueAt(chosen.key, i), previous: valueAt(chosen.key, i, true), previousDay: data.previousSeries[i]?.day ?? null }));
  const nothing = data.actions === 0 && Object.values(p).every((v) => v === 0);

  const sales = h?.sales[0];
  const prevSales = h?.previousSales[0];
  const accountKeys: TeamMetricKey[] = [...(showOrders ? ORDER_KEYS : []), ...(showListings ? LISTING_KEYS : []), ...(showHunting ? (["hunted"] as TeamMetricKey[]) : []), ...(showReviews ? (["hunts_reviewed"] as TeamMetricKey[]) : [])];
  const accountColumns = accountKeys.filter((k) => data.accounts.some((a) => a[k] > 0));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AreaCard
          title="Work"
          accent="bg-[var(--color-primary)]"
          value={fullNumber(t.active_days)}
          unit={`of ${data.range.days} day${data.range.days === 1 ? "" : "s"}`}
          delta={change(t.active_days, p.active_days)}
          compared={compared}
          note={self ? "Days you worked on this account in Liston" : "Days with work done in Liston"}
          onOpenLog={onOpenLog}
          rows={[
            { label: "Actions", value: fullNumber(data.actions), hint: `Everything ${they} did in Liston in this period` },
            ...(self ? [] : [{ label: "eBay accounts worked on", value: fullNumber(data.accounts.filter((a) => a.actions > 0).length) }]),
            { label: "A day, on days worked", value: t.active_days ? String(Math.round((data.actions / t.active_days) * 10) / 10) : "—", hint: "Actions per day worked" },
          ]}
        />
        {showOrders && (
          <AreaCard
            title="Orders"
            accent="bg-sky-500"
            value={fullNumber(t.supplier_orders)}
            unit="supplier orders"
            delta={change(t.supplier_orders, p.supplier_orders)}
            compared={compared}
            note="Placed with suppliers from an order"
            headlineMetric="supplier_orders"
            onOpenLog={onOpenLog}
            rows={[
              { label: "Orders dispatched", value: fullNumber(t.dispatched), metric: "dispatched" },
              { label: "Refunds, cancellations & cases", value: fullNumber(t.cases), metric: "cases", tone: t.cases ? "warn" : "plain" },
            ]}
          />
        )}
        {showListings && (
          <AreaCard
            title="Listings"
            accent="bg-violet-500"
            value={fullNumber(t.published)}
            unit="published"
            delta={change(t.published, p.published)}
            compared={compared}
            note="New listings put live on eBay"
            headlineMetric="published"
            onOpenLog={onOpenLog}
            rows={[
              { label: "Drafts created", value: fullNumber(t.drafted), metric: "drafted" },
              { label: "Drafts worked on", value: fullNumber(t.draft_work), metric: "draft_work" },
              { label: "Live listings edited", value: fullNumber(t.edited), metric: "edited" },
              { label: "Relisted · ended", value: `${fullNumber(t.relisted)} · ${fullNumber(t.ended)}`, metric: "relisted" },
            ]}
          />
        )}
        {showHunting && (
          <AreaCard
            title="Hunting"
            accent="bg-amber-500"
            value={fullNumber(h?.hunter.hunted ?? t.hunted)}
            unit="products hunted"
            delta={h ? change(h.hunter.hunted, h.previousHunter.hunted) : change(t.hunted, p.hunted)}
            compared={compared}
            note={h?.hunter.approvalRate !== null && h?.hunter.approvalRate !== undefined ? `${h.hunter.approvalRate}% approved of those decided` : `${Their} finds, by when hunted`}
            headlineMetric="hunted"
            onOpenLog={onOpenLog}
            rows={[
              { label: "Approved", value: fullNumber(h?.hunter.approved ?? 0), tone: h?.hunter.approved ? "good" : "plain" },
              { label: "Rejected", value: fullNumber(h?.hunter.rejected ?? 0), tone: h?.hunter.rejected ? "bad" : "plain" },
              { label: "Sent back · waiting", value: `${fullNumber(h?.hunter.sentBack ?? 0)} · ${fullNumber(h?.hunter.waiting ?? 0)}`, tone: h?.hunter.sentBack ? "warn" : "plain" },
              { label: "Drafted · listed", value: `${fullNumber(h?.hunter.drafted ?? 0)} · ${fullNumber(h?.hunter.listed ?? 0)}`, tone: h?.hunter.listed ? "info" : "plain" },
              self
                ? {
                    label: "Sold from your finds",
                    value: sales?.units ? `${fullNumber(sales.units)} sold` : "—",
                    tone: sales?.units ? "good" : "plain",
                    hint: prevSales?.units ? `${fullNumber(prevSales.units)} sold ${compared}` : "Units sold in this period from listings made from your finds",
                  }
                : {
                    label: "Sales from their finds",
                    value: sales?.sales !== undefined ? money(sales.sales, sales.currency || "GBP") : "—",
                    tone: sales?.sales ? "good" : "plain",
                    hint: prevSales?.sales !== undefined ? `${money(prevSales.sales, prevSales.currency || "GBP")} ${compared}` : "Sales in this period from listings made from their finds",
                  },
            ]}
          />
        )}
        {showReviews && (
          <AreaCard
            title="Reviewing"
            accent="bg-emerald-500"
            value={fullNumber(h?.reviewer.reviewed ?? t.hunts_reviewed)}
            unit="decisions"
            delta={h ? change(h.reviewer.reviewed, h.previousReviewer.reviewed) : change(t.hunts_reviewed, p.hunts_reviewed)}
            compared={compared}
            note={`Other people's finds ${they} decided on`}
            headlineMetric="hunts_reviewed"
            onOpenLog={onOpenLog}
            rows={[
              { label: "Approved", value: fullNumber(h?.reviewer.approved ?? 0), tone: h?.reviewer.approved ? "good" : "plain" },
              { label: "Rejected", value: fullNumber(h?.reviewer.rejected ?? 0), tone: h?.reviewer.rejected ? "bad" : "plain" },
              { label: "Sent back", value: fullNumber(h?.reviewer.sentBack ?? 0), tone: h?.reviewer.sentBack ? "warn" : "plain" },
              { label: "Average wait", value: hoursText(h?.reviewer.avgHoursToDecide), hint: "From submitted to decided" },
            ]}
          />
        )}
      </div>

      {h && h.reasons.length > 0 && (
        <p className="text-[12px] text-[var(--color-muted)]">
          {Their} finds were rejected for: <span className="text-[var(--color-ink)]">{h.reasons.map((r) => `${r.label} (${r.count})`).join(", ")}</span>
        </p>
      )}

      {nothing ? (
        <div className="card px-6 py-10 text-center">
          <p className="text-[13px] font-semibold text-[var(--color-ink)]">No recorded work in this period</p>
          <p className="mx-auto mt-1 max-w-xl text-[12px] leading-relaxed text-[var(--color-muted)]">
            Work counts when it&apos;s done in Liston: supplier orders, dispatches, refunds and cases from an order, listings drafted, published, edited, relisted or ended, and
            products hunted or reviewed. Work done straight on eBay or AliExpress can&apos;t be seen.
          </p>
        </div>
      ) : (
        data.series.length > 1 && (
          <section className="card p-4">
            {/* One measure at a time, as the Analytics chart does: the figure on the left, the key and the choice on the right. */}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-[var(--color-muted)]">{chosen.label} per day</p>
                <p className="mt-0.5 flex items-baseline gap-2">
                  <span className="text-[22px] font-semibold leading-none tabular-nums text-[var(--color-ink)]">{fullNumber(totalOf(chosen.key))}</span>
                  <DeltaBadge change={change(totalOf(chosen.key), totalOf(chosen.key, true))} compared={compared} size="sm" variant="text" />
                  <span className="text-[11.5px] text-[var(--color-muted)]">{fullNumber(totalOf(chosen.key, true))} before</span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="flex items-center gap-3 text-[11px] text-[var(--color-muted)]">
                  <span className="flex items-center gap-1.5">
                    <span className="h-0.5 w-4 rounded-full bg-[var(--color-primary)]" aria-hidden />
                    {dayRangeLabel(data.range.from, data.range.to)}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-4 border-t-2 border-dashed border-slate-400" aria-hidden />
                    {dayRangeLabel(data.range.previous.from, data.range.previous.to)}
                  </span>
                </span>
                <ViewMenu title="Measure" sections={[{ label: "Show", value: chosen.key, options: options.map((c) => ({ key: c.key, label: c.label })), onChange: (k) => setMetric(k as ChartKey) }]} />
              </div>
            </div>
            <div className="mt-3">
              <TrendChart
                points={points}
                format={(v) => (v == null ? "—" : fullNumber(v))}
                // Counts: only whole numbers on the side, so small ranges don't read 1, 1, 1, 0.
                axisFormat={(v) => (Number.isInteger(v) ? fullNumber(v) : "")}
                label={chosen.label}
                currentLabel={dayRangeLabel(data.range.from, data.range.to)}
                previousLabel={dayRangeLabel(data.range.previous.from, data.range.previous.to)}
                legend={false}
                height={220}
              />
            </div>
            {chosen.log && onOpenLog && (
              <div className="mt-1 text-right">
                <button type="button" onClick={() => onOpenLog?.(chosen.log!)} className="text-[12px] font-medium text-[var(--color-primary)] hover:underline">
                  See each one in the log
                </button>
              </div>
            )}
          </section>
        )
      )}

      {!self && data.accounts.some((a) => a.actions > 0) && (
        <section className="card overflow-hidden">
          <div className="flex items-baseline justify-between gap-2 px-4 py-3">
            <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">By eBay account</h2>
            <span className="text-[11.5px] text-[var(--color-muted)]">
              {fullNumber(data.actions)} action{data.actions === 1 ? "" : "s"} in all
            </span>
          </div>
          <div className="overflow-x-auto border-t border-[var(--color-line)]">
            <table className="w-full min-w-[480px] table-fixed text-[12.5px]">
              <thead>
                <tr className="bg-[var(--color-paper)] text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
                  <th className="w-[34%] px-4 py-2 text-left font-semibold">Account</th>
                  <th className="px-3 py-2 text-center font-semibold">Actions</th>
                  {accountColumns.map((k) => (
                    <th key={k} className="px-3 py-2 text-center font-semibold">
                      {label(k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {data.accounts
                  .filter((a) => a.actions > 0)
                  .map((a) => (
                    <tr key={a.connectionId || a.label}>
                      <td className="px-4 py-2 font-medium text-[var(--color-ink)]">
                        {a.label}
                        {!a.connectionId && <span className="ml-1.5 text-[11px] font-normal text-[var(--color-muted)]">(disconnected)</span>}
                      </td>
                      <td className="px-3 py-2 text-center tabular-nums text-[var(--color-ink)]">{fullNumber(a.actions)}</td>
                      {accountColumns.map((k) => (
                        <td key={k} className={`px-3 py-2 text-center tabular-nums ${a[k] ? "text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>
                          {fullNumber(a[k])}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">
        Days run midnight to midnight in {data.range.timeZone.replace("_", " ")}. An order line or listing counts once per period however many times it was touched; edits, drafts
        and cases count each time. Hunting figures count products by when they were hunted, and decisions by when they were made.
      </p>
    </div>
  );
}
