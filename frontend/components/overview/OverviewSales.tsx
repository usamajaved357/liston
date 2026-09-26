"use client";

import { OverviewBestSeller, OverviewTrendPoint } from "@/lib/api";
import { TrendChart } from "@/components/charts/TrendChart";
import { moneyAmount } from "@/components/charts/chart-format";
import { formatAmount, maskAmount } from "./OverviewMoney";

// Under the business Overview's money cards: how sales moved day by day
// over the chosen dates, and the listings selling most across every
// account. Kept compact so the whole Overview fits a laptop screen without
// scrolling. Amounts follow the show/hide choice (lib/useAmounts); units and
// orders always show.

const CHART_HEIGHT = 164;
export const BEST_SELLERS_SHOWN = 5;

// Which line is which, on one line: the chosen dates (solid), the stretch
// before (dashed) and today so far (hollow point).
function InlineLegend({ current, previous, today }: { current: string; previous: boolean; today: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--color-muted)]">
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-[3px] w-3.5 rounded-full bg-[var(--color-primary)]" aria-hidden />
        {current}
      </span>
      {previous && (
        <span className="inline-flex items-center gap-1.5">
          <svg width="14" height="4" aria-hidden>
            <line x1="1" y1="2" x2="13" y2="2" stroke="var(--color-muted)" strokeWidth="2" strokeDasharray="3 2.5" strokeLinecap="round" />
          </svg>
          Previous period
        </span>
      )}
      {today && (
        <span className="inline-flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden>
            <circle cx="5" cy="5" r="3.5" fill="var(--color-panel)" stroke="var(--color-primary)" strokeWidth="1.8" />
          </svg>
          Today so far
        </span>
      )}
    </span>
  );
}

export function SalesTrendCard({
  points,
  currency,
  hidden,
  caption,
  note,
}: {
  points: OverviewTrendPoint[] | null;
  currency: string;
  hidden: boolean;
  // "Last 7 days", "This month"…
  caption: string;
  // Why there's no chart (several currencies without a rate, say).
  note?: string | null;
}) {
  const list = points ?? [];
  const total = list.reduce((sum, p) => sum + p.value, 0);
  const hasPrevious = list.some((p) => p.previous != null);
  const previous = hasPrevious ? list.reduce((sum, p) => sum + (p.previous ?? 0), 0) : null;
  const change = previous ? (total - previous) / previous : null;
  return (
    <section className="card flex h-full min-w-0 flex-col px-4 pb-3 pt-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Sales by day</h2>
          <div className="mt-1">
            <InlineLegend current={caption} previous={hasPrevious} today={list.some((p) => p.partial)} />
          </div>
        </div>
        {list.length > 0 && !note && (
          <p className="text-right text-[12.5px] text-[var(--color-muted)]">
            <b className="text-[15px] font-semibold tabular-nums text-[var(--color-ink)]">{hidden ? maskAmount(currency) : formatAmount(total, currency)}</b>
            {change !== null && (
              <span className={`mt-0.5 block text-[12px] font-medium tabular-nums ${change >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {change >= 0 ? "▲" : "▼"} {Math.abs(Math.round(change * 100))}% vs previous
              </span>
            )}
          </p>
        )}
      </div>
      <div className="mt-2 min-w-0">
        {note || !points ? (
          <p className="flex items-center justify-center text-center text-[13px] text-[var(--color-muted)]" style={{ height: CHART_HEIGHT }}>
            {note ?? "No sales to chart yet."}
          </p>
        ) : (
          <TrendChart
            points={points}
            height={CHART_HEIGHT}
            legend={false}
            label={`Sales per day, ${caption.toLowerCase()}`}
            format={(v) => (v == null ? "—" : hidden ? maskAmount(currency) : moneyAmount(v, currency))}
            axisFormat={(v) => (hidden ? "" : moneyAmount(v, currency, { compact: true }).replace(/\.00$/, ""))}
            currentLabel={caption}
            previousLabel="Previous period"
          />
        )}
      </div>
    </section>
  );
}

export function BestSellersCard({ items, hidden, showMarket, flagOf }: { items: OverviewBestSeller[] | null; hidden: boolean; showMarket: boolean; flagOf: (marketplaceId: string) => string }) {
  const shown = (items ?? []).slice(0, BEST_SELLERS_SHOWN);
  return (
    <section className="card flex h-full min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-2 px-4 pt-3.5">
        <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Best sellers</h2>
        <span className="text-[11.5px] text-[var(--color-muted)]">Most units sold</span>
      </div>
      {shown.length === 0 ? (
        <p className="flex flex-1 items-center justify-center px-4 py-8 text-center text-[13px] text-[var(--color-muted)]">Nothing sold in these dates yet.</p>
      ) : (
        <ol className="mt-1.5 divide-y divide-[var(--color-line)]">
          {shown.map((item, i) => (
            <li key={`${item.marketplaceId}-${item.itemId}`}>
              <a href={item.url} target="_blank" rel="noreferrer" className="group flex items-center gap-2.5 px-4 py-[5px] transition-colors hover:bg-[var(--color-paper)]/70" title={item.title ?? undefined}>
                <span className="w-3 shrink-0 text-center text-[11.5px] font-semibold tabular-nums text-[var(--color-muted)]">{i + 1}</span>
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.image} alt="" loading="lazy" className="h-7 w-7 shrink-0 rounded-md border border-[var(--color-line)] bg-white object-contain" />
                ) : (
                  <span className="h-7 w-7 shrink-0 rounded-md border border-dashed border-[var(--color-line)] bg-[var(--color-paper)]" />
                )}
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[12.5px] font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{item.title ?? `Item ${item.itemId}`}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--color-muted)]">
                    {showMarket && `${flagOf(item.marketplaceId)} `}
                    {item.account}
                    {!item.live && " · ended"}
                  </span>
                </span>
                <span className="shrink-0 text-right leading-tight">
                  <span className="block text-[12.5px] font-semibold tabular-nums text-[var(--color-ink)]">{item.units.toLocaleString("en-GB")} sold</span>
                  <span className="block text-[11px] tabular-nums text-[var(--color-muted)]">{hidden ? maskAmount(item.currency ?? "GBP") : formatAmount(item.sales, item.currency ?? "GBP")}</span>
                </span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
