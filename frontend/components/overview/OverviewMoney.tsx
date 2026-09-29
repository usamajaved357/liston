"use client";

import { ReactNode } from "react";
import Link from "next/link";
import { ListingWork, MoneySummary } from "@/lib/api";
import { currencySymbol } from "@/lib/format";

// The business Overview: two tabs. Sales shows the money end to end in
// one view, one card per step (sales, fees, earnings, source cost, profit),
// each with its figure and the details behind it; Listings shows the
// listing pipeline. Money is only ever added within one currency; with
// several markets in view a card lists one line per currency, the main one
// first.

export type Metric = "sales" | "listings";

export const METRICS: { key: Metric; label: string }[] = [
  { key: "sales", label: "Sales" },
  { key: "listings", label: "Listings" },
];

/** "£1,234.56", "−A$12.00". */
export function formatAmount(value: number, currency: string): string {
  const symbol = currencySymbol(currency);
  const text = Math.abs(value).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const withSymbol = symbol.length <= 2 && symbol !== currency ? `${symbol}${text}` : `${text} ${currency}`;
  return value < 0 ? `−${withSymbol}` : withSymbol;
}

/** An amount kept private: "£••••", "•••• EUR". */
export function maskAmount(currency: string): string {
  const symbol = currencySymbol(currency);
  return symbol.length <= 2 && symbol !== currency ? `${symbol}••••` : `•••• ${currency}`;
}

const count = (n: number) => n.toLocaleString("en-GB");
const per = (total: number, n: number) => (n > 0 ? total / n : 0);
const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : "—");
const uncosted = (m: MoneySummary) => Math.max(0, m.withEarnings - m.withCost);

// A figure: money (one line per currency on a card's headline), a count
// (added across markets) or a text/percentage (from the main market).
type Figure = { kind: "money"; of: (m: MoneySummary) => number } | { kind: "count"; of: (m: MoneySummary) => number } | { kind: "text"; of: (m: MoneySummary) => string };

// What a figure means, for its colour: money coming in (green), going out
// (red), a result that can go either way (green, or red below zero), or
// plain (ink). Zero is always plain.
type Tone = "in" | "out" | "result" | "plain";
const INK = { in: "text-emerald-600", out: "text-rose-600", plain: "text-[var(--color-ink)]" };
function inkOf(tone: Tone | undefined, value: number | null): string {
  if (!tone || tone === "plain" || value === null || value === 0) return INK.plain;
  if (tone === "result") return value < 0 ? INK.out : INK.in;
  return INK[tone];
}

interface Detail {
  label: string;
  figure: Figure;
  tone?: Tone;
  // Needs eBay's finances: "—" when the account can't read them.
  fromEbay?: boolean;
  // Shown in amber: something the total leaves out.
  warn?: (m: MoneySummary) => boolean;
  // Only when this says so (a line that's usually nothing).
  shown?: (m: MoneySummary) => boolean;
}

interface Step {
  label: string;
  figure: Figure;
  tone: Tone;
  // The small marker beside the card's name.
  accent: string;
  note: string | ((m: MoneySummary) => string);
  // The longer explanation, on hover.
  hint: string;
  fromEbay?: boolean;
  details: Detail[];
}

const STEPS: Step[] = [
  {
    label: "Sales",
    figure: { kind: "money", of: (m) => m.sales },
    tone: "plain",
    accent: "bg-[var(--color-primary)]",
    note: "Paid by buyers",
    hint: "What buyers paid, cancelled orders left out",
    details: [
      { label: "Orders", figure: { kind: "count", of: (m) => m.orders } },
      { label: "Avg. order", figure: { kind: "money", of: (m) => per(m.sales, m.orders) } },
      { label: "Cancelled", figure: { kind: "count", of: (m) => m.cancelled }, tone: "out" },
    ],
  },
  {
    label: "Fees",
    figure: { kind: "money", of: (m) => m.fees },
    tone: "out",
    accent: "bg-rose-400",
    note: (m) => (m.settledSales > 0 ? `${percent(m.fees, m.settledSales)} of sales` : "Taken by eBay"),
    hint: "Everything eBay took: the fees on each order, ads, listing fees and the eBay Store subscription",
    fromEbay: true,
    details: [
      { label: "Order fees", figure: { kind: "money", of: (m) => m.fees - m.adFees - (m.accountFees ?? 0) }, fromEbay: true, tone: "out" },
      { label: "Ad fees", figure: { kind: "money", of: (m) => m.adFees }, fromEbay: true, tone: "out" },
      { label: "Listing fees", figure: { kind: "money", of: (m) => m.listingFees ?? 0 }, fromEbay: true, tone: "out" },
      { label: "Store fee", figure: { kind: "money", of: (m) => m.storeFees ?? 0 }, fromEbay: true, tone: "out" },
      // Other subscriptions (Terapeak Pro…), payout fees and the like: rare.
      { label: "Other fees", figure: { kind: "money", of: (m) => m.otherFees ?? 0 }, fromEbay: true, tone: "out", shown: (m) => (m.otherFees ?? 0) !== 0 },
    ],
  },
  {
    label: "Earnings",
    figure: { kind: "money", of: (m) => m.earnings },
    // Plain: green is kept for profit, what's actually left.
    tone: "plain",
    accent: "bg-sky-500",
    note: "Paid out to you",
    hint: "What reached you, after fees and refunds",
    fromEbay: true,
    details: [
      { label: "Refunds", figure: { kind: "money", of: (m) => m.refunds }, fromEbay: true, tone: "out" },
      { label: "Avg. order", figure: { kind: "money", of: (m) => per(m.earnings, m.withEarnings) }, fromEbay: true },
      { label: "Still settling", figure: { kind: "count", of: (m) => m.awaitingEbay }, fromEbay: true, warn: (m) => m.awaitingEbay > 0 },
    ],
  },
  {
    label: "Source cost",
    figure: { kind: "money", of: (m) => m.sourceCost },
    tone: "out",
    accent: "bg-orange-400",
    note: "Paid to suppliers",
    hint: "From each order's Source section",
    details: [
      { label: "Costed orders", figure: { kind: "text", of: (m) => `${count(m.withCost)} of ${count(m.withEarnings)}` }, fromEbay: true },
      { label: "Avg. order", figure: { kind: "money", of: (m) => per(m.sourceCost, m.withCost) }, tone: "out" },
      { label: "Without a cost", figure: { kind: "count", of: uncosted }, fromEbay: true, warn: (m) => uncosted(m) > 0 },
    ],
  },
  {
    label: "Profit",
    figure: { kind: "money", of: (m) => m.profit },
    tone: "result",
    accent: "bg-emerald-500",
    note: "Earnings − source cost",
    hint: "What's left after eBay and the supplier. ROI: profit ÷ supplier cost, over the orders with a cost entered",
    fromEbay: true,
    details: [
      { label: "ROI", figure: { kind: "text", of: (m) => (m.roi === null || m.roi === undefined ? "—" : `${m.roi}%`) }, fromEbay: true, tone: "result" },
      { label: "Avg. order", figure: { kind: "money", of: (m) => per(m.profit, m.withEarnings) }, fromEbay: true, tone: "result" },
      { label: "Needs a cost", figure: { kind: "text", of: (m) => (uncosted(m) > 0 ? `${count(uncosted(m))} order${uncosted(m) === 1 ? "" : "s"}` : "None") }, fromEbay: true, warn: (m) => uncosted(m) > 0 },
    ],
  },
];

// `trailing`: a control at the row's right end (show or hide the amounts).
export function MetricTabs({ metric, onMetric, trailing }: { metric: Metric; onMetric: (m: Metric) => void; trailing?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 border-b border-[var(--color-line)]">
      <div role="tablist" aria-label="Figure" className="flex flex-wrap gap-x-1">
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
      {trailing && <div className="mb-1.5 shrink-0">{trailing}</div>}
    </div>
  );
}

/** Shows or hides the money amounts (see lib/useAmounts). */
export function AmountsToggle({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  const label = hidden ? "Show amounts" : "Hide amounts";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={!hidden}
      aria-label={label}
      title={label}
      className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-ink)]"
    >
      {hidden ? (
        <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
          <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M10.6 5.1A9.8 9.8 0 0112 5c5 0 8.5 4.2 9.6 5.9a2 2 0 010 2.2 16.6 16.6 0 01-2.7 3.2M6.2 6.7C4.3 8 3 9.8 2.4 10.9a2 2 0 000 2.2C3.5 14.8 7 19 12 19c1.6 0 3-.4 4.3-1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9.9 9.9a3 3 0 004.2 4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
          <path d="M2.4 10.9C3.5 9.2 7 5 12 5s8.5 4.2 9.6 5.9a2 2 0 010 2.2C20.5 14.8 17 19 12 19s-8.5-4.2-9.6-5.9a2 2 0 010-2.2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      )}
      <span className="hidden sm:inline">{hidden ? "Show" : "Hide"}</span>
    </button>
  );
}

/**
 * The Sales tab: the money from what buyers paid to what's left, one card
 * per step with its details underneath.
 */
export function SalesCards({
  summaries,
  loading,
  unavailable,
  hidden = false,
}: {
  summaries: MoneySummary[];
  loading?: boolean;
  // eBay's finances can't be read (the account needs a reconnect).
  unavailable?: boolean;
  // Money amounts behind dots; counts and percentages still show.
  hidden?: boolean;
}) {
  const [main, ...others] = summaries;
  const total = (of: (m: MoneySummary) => number) => summaries.reduce((sum, m) => sum + of(m), 0);
  // A figure's number for its colour: money and counts as they are, a
  // margin from its percentage; other text has none.
  const valueOf = (figure: Figure): number | null =>
    figure.kind === "text" ? (/^-?\d/.test(figure.of(main)) ? parseFloat(figure.of(main)) : null) : figure.kind === "count" ? total(figure.of) : figure.of(main);
  const show = (figure: Figure) =>
    figure.kind === "money" ? (hidden ? maskAmount(main.currency) : formatAmount(figure.of(main), main.currency)) : figure.kind === "count" ? count(total(figure.of)) : figure.of(main);
  // A hidden amount is plain ink: its colour would give away its sign.
  const inkFor = (tone: Tone | undefined, figure: Figure) => (hidden && figure.kind === "money" ? INK.plain : inkOf(tone, valueOf(figure)));
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-5">
      {STEPS.map((step, index) => {
        const blocked = Boolean(unavailable && step.fromEbay);
        const figure = step.figure;
        return (
          <div key={step.label} className={`card flex min-w-0 flex-col px-3.5 py-3 sm:px-5 sm:py-4 ${index === STEPS.length - 1 ? "max-lg:col-span-2" : ""}`} title={step.hint}>
            <span className="flex items-center gap-2 text-[13px] font-medium text-[var(--color-muted)]">
              <span className={`h-2 w-2 rounded-full ${step.accent}`} aria-hidden />
              {step.label}
            </span>
            {loading || !main ? (
              <span className="mt-3 h-7 w-28 animate-pulse rounded-md bg-[var(--color-line)]" />
            ) : blocked ? (
              <span className="mt-2.5 text-[20px] font-semibold leading-none text-[var(--color-line-strong)] sm:text-[24px]">—</span>
            ) : (
              <>
                <span className={`mt-2.5 truncate text-[20px] font-semibold leading-none tracking-tight tabular-nums sm:text-[24px] ${inkFor(step.tone, figure)}`}>{show(figure)}</span>
                {figure.kind === "money" &&
                  // Only when no exchange rate could be had: each other currency
                  // apart. A market with nothing in these dates, or one eBay has
                  // no figures for yet, isn't worth a "+ $0.00" line.
                  others
                    .filter((o) => (step.label === "Sales" || o.withEarnings > 0) && figure.of(o) !== 0)
                    .map((o) => (
                      <span key={o.currency} className="mt-1 text-[12px] font-medium tabular-nums text-[var(--color-muted)]">
                        + {hidden ? maskAmount(o.currency) : formatAmount(figure.of(o), o.currency)}
                      </span>
                    ))}
              </>
            )}
            <span className="mt-1.5 truncate text-[12px] text-[var(--color-muted)]">
              {blocked && !loading ? "Needs the account reconnected" : typeof step.note === "function" ? (main && !loading ? step.note(main) : "\u00a0") : step.note}
            </span>
            <dl className="mt-3 space-y-1 border-t border-[var(--color-line)] pt-2.5 text-[12px] sm:mt-3.5 sm:pt-3 sm:text-[12.5px]">
              {step.details.filter((d) => !d.shown || (main && !loading && d.shown(main))).map((d) => {
                const dBlocked = Boolean(unavailable && d.fromEbay);
                const warn = main && !dBlocked ? d.warn?.(main) : false;
                return (
                  <div key={d.label} className="flex items-baseline justify-between gap-2">
                    <dt className="truncate text-[var(--color-muted)]">{d.label}</dt>
                    <dd className={`shrink-0 font-medium tabular-nums ${warn ? "text-amber-600" : main && !dBlocked ? inkFor(d.tone, d.figure) : INK.plain}`}>
                      {loading || !main ? <span className="inline-block h-3 w-12 animate-pulse rounded bg-[var(--color-line)] align-middle" /> : dBlocked ? "—" : show(d.figure)}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        );
      })}
    </div>
  );
}

// The listing pipeline, stage by stage: products hunted, approved or rejected
// (product hunting), then drafted and published in Liston, all in the chosen
// dates, each with what's behind it (found by Liston or by the team, rejected
// by a reviewer or by Liston for a supplier that doesn't match, drafted from a
// hunted product or not). What's live, waiting and stuck right now sits
// underneath.
interface StageDetail {
  label: string;
  of: (w: ListingWork) => number;
  hint: string;
  // Worth a look when there are any: amber.
  warn?: boolean;
}
const num = (v: number | undefined) => v ?? 0;
const STAGES: { label: string; note: string; of: (w: ListingWork) => number; ink?: string; details: StageDetail[] }[] = [
  {
    label: "Hunted",
    note: "Products found to list",
    of: (w) => num(w.hunted),
    details: [
      { label: "By your team", of: (w) => num(w.hunted) - num(w.huntedByListon), hint: "Checked and added by a hunter with a supplier they chose" },
      { label: "Found by Liston", of: (w) => num(w.huntedByListon), hint: "Discover's Hunt or Find with Liston picked the AliExpress supplier" },
    ],
  },
  {
    label: "Approved",
    note: "Picked to draft",
    of: (w) => num(w.approved),
    ink: "text-emerald-600",
    details: [
      { label: "By a reviewer", of: (w) => num(w.approved) - num(w.approvedAsAdded), hint: "Opened on the Hunting page and approved" },
      { label: "Owner's own", of: (w) => num(w.approvedAsAdded), hint: "Hunted by the owner with their own supplier: approved as added" },
    ],
  },
  {
    label: "Rejected",
    note: "Passed over",
    of: (w) => num(w.rejected),
    ink: "text-rose-600",
    details: [
      { label: "By a reviewer", of: (w) => num(w.rejected) - num(w.rejectedByListon), hint: "Rejected on the Hunting page" },
      { label: "Supplier didn't match", of: (w) => num(w.rejectedByListon), hint: "Rejected by Liston: the supplier doesn't sell the eBay listing's best-selling variations", warn: true },
      { label: "Sent back to fix", of: (w) => num(w.sentBack), hint: "Sent back to the hunter to change (not counted as rejected)" },
    ],
  },
  {
    label: "Drafted",
    note: "Drafts created in Liston",
    of: (w) => w.drafted,
    details: [
      { label: "From hunted products", of: (w) => num(w.draftedFromHunts), hint: "Drafted from an approved hunted product" },
      { label: "Other drafts", of: (w) => w.drafted - num(w.draftedFromHunts), hint: "Drafted from a competitor and supplier link on the Listings page" },
    ],
  },
  {
    label: "Published",
    note: "Went live from Liston",
    of: (w) => w.published,
    details: [
      { label: "From hunted products", of: (w) => num(w.publishedFromHunts), hint: "Its draft was made from a hunted product" },
      { label: "Other listings", of: (w) => w.published - num(w.publishedFromHunts), hint: "Drafted from a link on the Listings page" },
    ],
  },
];

/**
 * The Listings tab's cards and what stands right now. `huntingHref`: on one
 * account's Overview, the Hunting page's tab for a figure (a link each).
 */
export function ListingCards({ work, loading, huntingHref }: { work: ListingWork | null; loading?: boolean; huntingHref?: (view: "review" | "approved" | "all") => string }) {
  // Right now, the hunting figures only when there are any; the ones that need someone first.
  const now: { value: number; text: string; view?: "review" | "approved" | "all"; warn?: boolean }[] = work
    ? [
        { value: work.live, text: "live on eBay" },
        { value: work.waiting, text: `draft${work.waiting === 1 ? "" : "s"} waiting to publish` },
        ...[
          { value: num(work.reviewing), text: `hunted product${num(work.reviewing) === 1 ? "" : "s"} waiting for review`, view: "review" as const },
          { value: num(work.toDraft), text: `approved, still to be drafted`, view: "approved" as const },
          { value: num(work.draftFailed), text: `draft${num(work.draftFailed) === 1 ? "" : "s"} failed, to draft again`, view: "approved" as const, warn: true },
          { value: num(work.sentBackNow), text: `sent back to ${num(work.sentBackNow) === 1 ? "its hunter" : "their hunters"}`, view: "all" as const },
        ].filter((x) => x.value > 0),
      ]
    : [];
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-5">
        {STAGES.map((stage, index) => {
          const value = work ? stage.of(work) : 0;
          return (
            <div key={stage.label} className={`card flex min-w-0 flex-col px-3.5 py-3 sm:px-5 sm:py-4 ${index === STAGES.length - 1 ? "max-lg:col-span-2" : ""}`}>
              <span className="text-[13px] font-medium text-[var(--color-muted)]">{stage.label}</span>
              {loading || !work ? (
                <span className="mt-3 h-7 w-16 animate-pulse rounded-md bg-[var(--color-line)]" />
              ) : (
                <span className={`mt-2.5 text-[20px] font-semibold leading-none tracking-tight tabular-nums sm:text-[24px] ${value > 0 && stage.ink ? stage.ink : "text-[var(--color-ink)]"}`}>{count(value)}</span>
              )}
              <span className="mt-1.5 truncate text-[12px] text-[var(--color-muted)]">{stage.note}</span>
              <dl className="mt-3 space-y-1 border-t border-[var(--color-line)] pt-2.5 text-[12px] sm:mt-3.5 sm:pt-3 sm:text-[12.5px]">
                {stage.details.map((d) => {
                  const figure = work ? Math.max(0, d.of(work)) : 0;
                  return (
                    <div key={d.label} className="flex items-baseline justify-between gap-2" title={d.hint}>
                      <dt className="truncate text-[var(--color-muted)]">{d.label}</dt>
                      <dd className={`shrink-0 font-medium tabular-nums ${d.warn && figure > 0 ? "text-amber-600" : "text-[var(--color-ink)]"}`}>
                        {loading || !work ? <span className="inline-block h-3 w-6 animate-pulse rounded bg-[var(--color-line)] align-middle" /> : count(figure)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          );
        })}
      </div>
      {work && (
        <p className="mt-4 text-[13px] leading-relaxed text-[var(--color-muted)]">
          Right now:{" "}
          {now.map((x, i) => {
            const figure = <span className={`font-medium tabular-nums ${x.warn ? "text-amber-600" : "text-[var(--color-ink)]"}`}>{count(x.value)}</span>;
            return (
              <span key={x.text}>
                {i > 0 && " · "}
                {huntingHref && x.view ? (
                  <Link href={huntingHref(x.view)} className="hover:text-[var(--color-primary)] hover:underline">
                    {figure} {x.text}
                  </Link>
                ) : (
                  <>
                    {figure} {x.text}
                  </>
                )}
              </span>
            );
          })}
        </p>
      )}
    </>
  );
}
