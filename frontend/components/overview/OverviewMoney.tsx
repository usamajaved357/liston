"use client";

import { ListingWork, MoneySummary } from "@/lib/api";
import { currencySymbol } from "@/lib/format";

// The business Overview's money: one tab per figure (sales, fees, earnings,
// source cost, profit) and four cards that break the chosen one down.
// Money is only ever added within one currency; with several markets in view
// a card lists one line per currency, the main one first.

export type Metric = "sales" | "fees" | "earnings" | "sourceCost" | "profit" | "listings";

export const METRICS: { key: Metric; label: string }[] = [
  { key: "sales", label: "Sales" },
  { key: "fees", label: "Fees" },
  { key: "earnings", label: "Earnings" },
  { key: "sourceCost", label: "Source cost" },
  { key: "profit", label: "Profit" },
  { key: "listings", label: "Listings" },
];

/** "£1,234.56", "−A$12.00". */
export function formatAmount(value: number, currency: string): string {
  const symbol = currencySymbol(currency);
  const text = Math.abs(value).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const withSymbol = symbol.length <= 2 && symbol !== currency ? `${symbol}${text}` : `${text} ${currency}`;
  return value < 0 ? `−${withSymbol}` : withSymbol;
}

const count = (n: number) => n.toLocaleString("en-GB");
const per = (total: number, n: number) => (n > 0 ? total / n : 0);
const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : "—");
const uncosted = (m: MoneySummary) => Math.max(0, m.withEarnings - m.withCost);

// A card's figure: money (one line per currency), a count (added across
// markets) or a text/percentage (from the main market).
type Figure = { kind: "money"; of: (m: MoneySummary) => number } | { kind: "count"; of: (m: MoneySummary) => number } | { kind: "text"; of: (m: MoneySummary) => string };

interface Card {
  label: string;
  figure: Figure;
  note?: (m: MoneySummary) => string;
  // Shown in amber: something the total leaves out.
  warn?: (m: MoneySummary) => boolean;
}

const CARDS: Record<Exclude<Metric, "listings">, Card[]> = {
  sales: [
    { label: "Sales", figure: { kind: "money", of: (m) => m.sales }, note: () => "What buyers paid, cancelled orders left out" },
    { label: "Orders", figure: { kind: "count", of: (m) => m.orders }, note: () => "Placed in these dates" },
    { label: "Average order", figure: { kind: "money", of: (m) => per(m.sales, m.orders) }, note: () => "Sales ÷ orders" },
    { label: "Cancelled", figure: { kind: "count", of: (m) => m.cancelled }, note: () => "Left out of sales" },
  ],
  fees: [
    { label: "Total fees", figure: { kind: "money", of: (m) => m.fees }, note: () => "Everything eBay took" },
    { label: "eBay fees", figure: { kind: "money", of: (m) => m.fees - m.adFees }, note: () => "Final value and other selling fees" },
    { label: "Ad fees", figure: { kind: "money", of: (m) => m.adFees }, note: () => "Promoted listings" },
    { label: "Fees of sales", figure: { kind: "text", of: (m) => percent(m.fees, m.settledSales) }, note: () => "Share of what those orders sold for" },
  ],
  earnings: [
    { label: "Earnings", figure: { kind: "money", of: (m) => m.earnings }, note: () => "What reached you, after fees and refunds" },
    { label: "Refunds", figure: { kind: "money", of: (m) => m.refunds }, note: () => "Money returned to buyers" },
    { label: "Average per order", figure: { kind: "money", of: (m) => per(m.earnings, m.withEarnings) }, note: () => "Earnings ÷ settled orders" },
    { label: "Still settling", figure: { kind: "count", of: (m) => m.awaitingEbay }, note: () => "Orders eBay hasn't posted money for yet" },
  ],
  sourceCost: [
    { label: "Source cost", figure: { kind: "money", of: (m) => m.sourceCost }, note: () => "From each order's Source section" },
    { label: "Orders with a cost", figure: { kind: "text", of: (m) => `${count(m.withCost)} of ${count(m.withEarnings)}` }, note: () => "Settled orders with a supplier cost entered" },
    { label: "Average cost per order", figure: { kind: "money", of: (m) => per(m.sourceCost, m.withCost) }, note: () => "Of the orders with a cost" },
    {
      label: "Without a cost",
      figure: { kind: "count", of: uncosted },
      note: () => "Enter it on the order to count it",
      warn: (m) => uncosted(m) > 0,
    },
  ],
  profit: [
    { label: "Profit", figure: { kind: "money", of: (m) => m.profit }, note: () => "Earnings − source cost" },
    { label: "Margin", figure: { kind: "text", of: (m) => (m.margin === null ? "—" : `${m.margin}%`) }, note: () => "Profit ÷ sales" },
    { label: "Average per order", figure: { kind: "money", of: (m) => per(m.profit, m.withEarnings) }, note: () => "Profit ÷ settled orders" },
    {
      label: "Without a cost",
      figure: { kind: "count", of: uncosted },
      note: (m) => (uncosted(m) > 0 ? "Profit reads high until these have a cost" : "Every order has its cost"),
      warn: (m) => uncosted(m) > 0,
    },
  ],
};

export function MetricTabs({ metric, onMetric }: { metric: Metric; onMetric: (m: Metric) => void }) {
  return (
    <div role="tablist" aria-label="Figure" className="flex flex-wrap gap-x-1 border-b border-[var(--color-line)]">
      {METRICS.map(({ key, label }) => {
        const on = key === metric;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onMetric(key)}
            className={`-mb-px shrink-0 border-b-2 px-3.5 py-2.5 text-[14px] font-medium transition-colors ${
              on ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function MetricCards({ metric, summaries, loading }: { metric: Exclude<Metric, "listings">; summaries: MoneySummary[]; loading?: boolean }) {
  const [main, ...others] = summaries;
  const total = (of: (m: MoneySummary) => number) => summaries.reduce((sum, m) => sum + of(m), 0);
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {CARDS[metric].map((card) => {
        const figure = card.figure;
        const warn = main ? card.warn?.(main) : false;
        const negative = main && figure.kind === "money" && figure.of(main) < 0;
        return (
          <div key={card.label} className="card flex min-h-[136px] flex-col p-5">
            <span className="text-[13px] font-medium text-[var(--color-muted)]">{card.label}</span>
            {loading || !main ? (
              <span className="mt-3 h-8 w-32 animate-pulse rounded-md bg-[var(--color-line)]" />
            ) : (
              <>
                <span
                  className={`mt-2.5 text-[28px] font-semibold leading-none tracking-tight tabular-nums ${
                    warn ? "text-amber-700" : negative ? "text-[var(--color-danger)]" : "text-[var(--color-ink)]"
                  }`}
                >
                  {figure.kind === "money" ? formatAmount(figure.of(main), main.currency) : figure.kind === "count" ? count(total(figure.of)) : figure.of(main)}
                </span>
                {figure.kind === "money" &&
                  // Only when no exchange rate could be had: each other currency
                  // apart. A market with nothing in these dates, or one eBay has
                  // no figures for yet, isn't worth a "+ $0.00" line.
                  others.filter((o) => (metric === "sales" || o.withEarnings > 0) && figure.of(o) !== 0).map((o) => (
                    <span key={o.currency} className="mt-1 text-[12.5px] font-medium tabular-nums text-[var(--color-muted)]">
                      + {formatAmount(figure.of(o), o.currency)}
                    </span>
                  ))}
                {card.note && <span className="mt-auto pt-3 text-[12px] text-[var(--color-muted)]">{card.note(main)}</span>}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// The listing pipeline, stage by stage: products hunted, approved or rejected
// (the product-hunting feature, still to come), then drafted and published
// in Liston in the chosen dates. What's live and waiting right now sits
// underneath.
const STAGES: { label: string; note: string; of?: (w: ListingWork) => number }[] = [
  { label: "Hunted", note: "Products found to list" },
  { label: "Approved", note: "Picked to draft" },
  { label: "Rejected", note: "Passed over" },
  { label: "Drafted", note: "Drafts created in Liston", of: (w) => w.drafted },
  { label: "Published", note: "Went live from Liston", of: (w) => w.published },
];

export function ListingCards({ work, loading }: { work: ListingWork | null; loading?: boolean }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {STAGES.map((stage) => {
          const soon = !stage.of;
          return (
            <div key={stage.label} className={`card flex min-h-[136px] flex-col p-5 ${soon ? "border-dashed bg-transparent shadow-none" : ""}`}>
              <span className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-[var(--color-muted)]">{stage.label}</span>
                {soon && (
                  <span className="rounded-full bg-[var(--color-paper)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)]">
                    Coming soon
                  </span>
                )}
              </span>
              {loading || (!soon && !work) ? (
                <span className="mt-3 h-8 w-20 animate-pulse rounded-md bg-[var(--color-line)]" />
              ) : (
                <span className={`mt-2.5 text-[28px] font-semibold leading-none tracking-tight tabular-nums ${soon ? "text-[var(--color-line-strong)]" : "text-[var(--color-ink)]"}`}>
                  {soon ? "—" : count(stage.of!(work!))}
                </span>
              )}
              <span className="mt-auto pt-3 text-[12px] text-[var(--color-muted)]">{stage.note}</span>
            </div>
          );
        })}
      </div>
      {work && (
        <p className="mt-4 text-[13px] text-[var(--color-muted)]">
          Right now: <span className="font-medium text-[var(--color-ink)]">{count(work.live)}</span> live on eBay ·{" "}
          <span className="font-medium text-[var(--color-ink)]">{count(work.waiting)}</span> drafts waiting to publish
        </p>
      )}
    </>
  );
}
