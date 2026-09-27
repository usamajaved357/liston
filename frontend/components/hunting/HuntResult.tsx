"use client";

import { Fragment, ReactNode, useMemo, useState } from "react";
import Link from "next/link";
import { HuntCheckResult, HuntDuplicate, HuntMatchQuality, HuntOption } from "@/lib/api";
import { count, money, age } from "@/components/research/format";
import { ToneIcon } from "@/components/research/ResearchPanels";
import { HuntSales } from "./HuntSales";
import { ExternalIcon, FactPill, FeedbackPill, INK, LEVEL_TONE, MATCH, MatchChip, RatingPill, SectionHead, STAGE, StoreScores, Thumb, VERDICT, profitInk, roiText, signedMoney, ago } from "./HuntBits";

// A hunted product's profit check, most telling first: the profit on the
// best seller and where its money goes, where the product already is on the
// owner's accounts, what to check before approving, how the competitor
// sells, the two listings, and last every supplier option worked out at the
// competitor's price for it.

const OPTIONS_SHOWN = 8;

function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-[var(--color-muted)]">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] font-semibold tabular-nums text-[var(--color-ink)]">{value}</dd>
      {note && <dd className="truncate text-[11.5px] text-[var(--color-muted)]">{note}</dd>}
    </div>
  );
}

function ProductCard({ kind, title, url, image, badges, children }: { kind: "ebay" | "aliexpress"; title: string; url: string | null; image: string | null; badges?: ReactNode; children: ReactNode }) {
  return (
    <section className="card flex min-w-0 flex-col p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          <span className={`h-2 w-2 rounded-full ${kind === "ebay" ? "bg-[#0064D2]" : "bg-[#E62E04]"}`} aria-hidden />
          {kind === "ebay" ? "Competitor on eBay" : "Supplier on AliExpress"}
        </span>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--color-primary)] hover:underline">
            Open <ExternalIcon />
          </a>
        )}
      </div>
      <div className="mt-2.5 flex min-w-0 gap-3">
        <Thumb src={image} size={60} />
        <div className="min-w-0">
          <p className="line-clamp-2 text-[13px] font-medium leading-snug text-[var(--color-ink)]">{title}</p>
          {/* The record at a glance, coloured by how good it is. */}
          {badges && <div className="mt-2 flex flex-wrap gap-1.5">{badges}</div>}
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-[var(--color-line)] pt-3">{children}</dl>
    </section>
  );
}

function costRange(options: HuntOption[], currency: string) {
  const costs = options.map((o) => o.cost).filter((c): c is number => c !== null);
  if (!costs.length) return "—";
  const lo = Math.min(...costs);
  const hi = Math.max(...costs);
  return lo === hi ? money(lo, currency) : `${money(lo, currency)} – ${money(hi, currency)}`;
}

function dayRange(days: { min: number | null; max: number | null } | null | undefined) {
  if (!days || days.max === null) return null;
  return days.min && days.min !== days.max ? `${days.min}–${days.max} days` : `${days.max} days`;
}

// ---- the verdict --------------------------------------------------------------------------

function Verdict({ result }: { result: HuntCheckResult }) {
  const { summary, currency, targetRoiPercent } = result;
  const head = summary.headline;
  const v = VERDICT[summary.verdict];
  const row = head.optionIndex !== null ? result.options[head.optionIndex] : null;
  const best = summary.bestSeller;
  const unpriced = summary.verdict === "unpriced";
  const about =
    head.basis === "best_seller" && best
      ? `per sale on the best seller${best.label ? `, ${best.label}` : ""}${best.sold ? ` (${count(best.sold)} sold)` : ""}`
      : head.basis === "best_option"
        ? `per sale on the best option${row?.label ? `, ${row.label}` : ""}`
        : head.basis === "your_price"
          ? `per sale at your price of ${row?.sellPrice !== null && row?.sellPrice !== undefined ? money(row.sellPrice, currency) : "—"}${row?.label && result.options.length > 1 ? ` on the cheapest option, ${row.label}` : ""}`
          : "no profit could be worked out";
  const prices = result.options.filter((o) => o.stock !== 0 && o.sellPrice !== null).map((o) => o.sellPrice as number);
  return (
    <section className={`overflow-hidden rounded-[var(--radius-card)] ring-1 ring-inset ${v.soft}`}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <span className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-white/80 ${v.ink}`}>
            <ToneIcon tone={v.tone} className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <p className={`text-[12px] font-semibold uppercase tracking-wide ${v.ink}`}>{unpriced ? `No competitor · priced at your ${targetRoiPercent}% target` : v.label}</p>
            <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
              <span className={`text-[26px] font-semibold leading-none tracking-tight tabular-nums ${profitInk(head.profit, head.roi, targetRoiPercent, unpriced)}`}>{signedMoney(head.profit, currency)}</span>
              <span className="text-[14px] font-semibold tabular-nums text-[var(--color-ink)]">{roiText(head.roi)} return</span>
            </p>
            <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">
              {about}
              {best && head.basis === "best_seller" && best.quality === "close" ? " · closest supplier option" : ""}
            </p>
          </div>
        </div>
        {unpriced ? (
          <dl className="grid w-full grid-cols-3 gap-x-5 gap-y-2 sm:w-auto">
            <Stat label="Your prices" value={prices.length ? (Math.min(...prices) === Math.max(...prices) ? money(prices[0], currency) : `${money(Math.min(...prices), currency)} – ${money(Math.max(...prices), currency)}`) : "—"} note="rounded to .99" />
            <Stat label="In stock" value={`${summary.inStock} of ${summary.total}`} note="options" />
            <Stat label="Market price" value="—" note="add a competitor" />
          </dl>
        ) : (
          <dl className="grid w-full grid-cols-3 gap-x-5 gap-y-2 sm:w-auto">
            <Stat label="Options earning" value={`${summary.profitable} of ${summary.inStock}`} note={summary.inStock < summary.total ? `${summary.total - summary.inStock} out of stock` : "in stock"} />
            <Stat label={`Under ${targetRoiPercent}% target`} value={count(summary.belowTarget)} note="in-stock options" />
            <Stat label="Sold a month" value={result.demand.soldPerMonth === null ? "—" : count(result.demand.soldPerMonth)} note={result.demand.sold === null ? "not shown by eBay" : `${count(result.demand.sold)} in all`} />
          </dl>
        )}
      </div>
      {row && row.sellPrice !== null && row.fees && (
        <div className="border-t border-black/5 bg-white/75 px-4 py-4 sm:px-5">
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Where the money goes{row.label && result.options.length > 1 ? ` · ${row.label}` : ""}
          </p>
          <Split option={row} currency={currency} />
        </div>
      )}
      {unpriced && (
        <p className="border-t border-black/5 bg-white/50 px-4 py-2 text-[12px] text-[var(--color-ink)] sm:px-5">
          Checked from the supplier alone: there&apos;s no market price, best seller or demand to judge by, so each option earns your target by design. Add a competitor to see whether buyers pay these prices.
        </p>
      )}
      {best && best.optionIndex === null && head.basis !== "best_seller" && best.label && (
        <p className="border-t border-black/5 bg-white/50 px-4 py-2 text-[12px] text-[var(--color-ink)] sm:px-5">
          The competitor&apos;s best seller, <b className="font-semibold">{best.label}</b>, has no matching option at this supplier.
        </p>
      )}
      <WorkedOut result={result} />
    </section>
  );
}

// How the fees, postage and price were arrived at, folded away under the profit.
function WorkedOut({ result }: { result: HuntCheckResult }) {
  const { competitor: c, currency, shipping, fees } = result;
  return (
    <details className="group border-t border-black/5 bg-white/50">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 text-[12px] font-semibold text-[var(--color-ink)] hover:bg-white/60 sm:px-5 [&::-webkit-details-marker]:hidden">
        How it&apos;s worked out
        <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 text-[var(--color-muted)] transition-transform group-open:rotate-180" aria-hidden>
          <path d="M6 8l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="space-y-1 px-4 pb-3.5 text-[12px] leading-relaxed text-[var(--color-muted)] sm:px-5">
        <p>
          <b className="font-semibold text-[var(--color-ink)]">Fees:</b>{" "}
          {fees.basis === "orders"
            ? `what eBay took on this account's last ${fees.orders} orders (${fees.days} days): ${fees.processingPercent}% final value, ${fees.adsPercent}% promoted listings`
            : `this account's pricing settings: ${fees.processingPercent}% final value, ${fees.adsPercent}% promoted listings`}
          , plus {money(fees.fixed, currency)} per order.
        </p>
        <p>
          <b className="font-semibold text-[var(--color-ink)]">Postage:</b>{" "}
          {shipping.basis === "aliexpress"
            ? shipping.freeOver
              ? `AliExpress ships it free on orders over ${money(shipping.freeOver, currency)}${shipping.company ? ` (${shipping.company})` : ""}, so postage isn't counted. It only adds the ${money(shipping.cost, currency)} fee when there's no free-shipping offer.`
              : `AliExpress's own charge to ${result.market?.name || "the buyer"}${shipping.company ? ` (${shipping.company})` : ""}${shipping.forOption ? ` for ${shipping.forOption}` : ""}, added to every sale.`
            : "the flat postage cost in this account's pricing settings (AliExpress didn't quote)."}
        </p>
        <p>
          <b className="font-semibold text-[var(--color-ink)]">Price:</b>{" "}
          {c
            ? "each option is sold at the competitor's price for the same option, postage included; an option they don't sell uses their lowest price."
            : `no competitor, so each option is priced as a draft would be: cost and postage marked up to your ${result.targetRoiPercent}% target return, rounded up to .99.`}
        </p>
      </div>
    </details>
  );
}

// ---- the options table ------------------------------------------------------------------------

// What the sell price splits into, as one bar: the supplier's price, postage, eBay's fees and what's left.
function Split({ option, currency }: { option: HuntOption; currency: string }) {
  if (option.sellPrice === null || option.cost === null || !option.fees) return null;
  const parts = [
    { key: "cost", label: "Supplier", value: option.cost, color: "bg-slate-500" },
    { key: "post", label: "Postage", value: option.shipping, color: "bg-slate-300" },
    { key: "fees", label: "eBay fees", value: option.fees.total, color: "bg-amber-400" },
    { key: "profit", label: option.profit !== null && option.profit < 0 ? "Loss" : "Profit", value: Math.abs(option.profit ?? 0), color: option.profit !== null && option.profit < 0 ? "bg-rose-500" : "bg-emerald-500" },
  ].filter((p) => p.value > 0);
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const lines: [string, number, boolean?][] = [
    ["Sells for", option.sellPrice],
    ["Promoted listing fee", -option.fees.ads],
    ["eBay final value fee", -option.fees.processing],
    ["Per-order fee", -option.fees.fixed],
    ["Supplier price", -option.cost],
    ["Supplier postage", -option.shipping],
    ["Profit", option.profit ?? 0, true],
  ];
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full" role="img" aria-label="How the sell price splits">
          {parts.map((p) => (
            <span key={p.key} className={`${p.color} first:rounded-l-full last:rounded-r-full`} style={{ width: `${(p.value / total) * 100}%` }} title={`${p.label} ${money(p.value, currency)}`} />
          ))}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-[var(--color-muted)]">
          {parts.map((p) => (
            <li key={p.key} className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-sm ${p.color}`} aria-hidden />
              {p.label} {money(p.value, currency)}
            </li>
          ))}
        </ul>
        <dl className="mt-3 grid grid-cols-3 gap-3">
          <Stat label="Break-even price" value={option.breakEven === null ? "—" : money(option.breakEven, currency)} />
          <Stat label="Price for target" value={option.targetPrice === null ? "—" : money(option.targetPrice, currency)} />
          <Stat label="Margin" value={option.margin === null ? "—" : `${option.margin < 0 ? "−" : ""}${Math.abs(option.margin)}%`} />
        </dl>
      </div>
      <dl className="space-y-1 text-[12.5px]">
        {lines.map(([label, raw, strong]) => {
          const value = raw || 0; // no "−£0.00" for free postage
          return (
            <div key={label} className={`flex items-baseline justify-between gap-3 ${strong ? "border-t border-[var(--color-line)] pt-1.5 font-semibold" : ""}`}>
              <dt className={strong ? "text-[var(--color-ink)]" : "text-[var(--color-muted)]"}>{label}</dt>
              <dd className={`tabular-nums ${strong ? profitInk(value, option.roi, null) : "text-[var(--color-ink)]"}`}>{value < 0 ? `−${money(Math.abs(value), currency)}` : money(value, currency)}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

// What an option sells at, and what that price is: the competitor's same
// option, their nearest, their lowest, or (no competitor) your own price.
const MATCH_LINE: Record<HuntMatchQuality, { dot: string; text: (label: string | null) => string }> = {
  exact: { dot: "bg-emerald-500", text: (l) => (l ? `Their ${l}` : "Same option") },
  close: { dot: "bg-sky-500", text: (l) => (l ? `Nearest: ${l}` : "Nearest option") },
  lowest: { dot: "bg-amber-500", text: () => "Their lowest price" },
  single: { dot: "bg-slate-400", text: () => "Listing price" },
  target: { dot: "bg-indigo-500", text: () => "At your target" },
};

function SellsAt({ match, currency }: { match: NonNullable<HuntOption["match"]>; currency: string }) {
  const m = MATCH_LINE[match.quality];
  return (
    <span className="flex flex-col items-center leading-tight" title={MATCH[match.quality].title}>
      <span className="font-semibold tabular-nums text-[var(--color-ink)]">{money(match.price, currency)}</span>
      <span className="mt-1 inline-flex max-w-[140px] items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${m.dot}`} aria-hidden />
        <span className="truncate">{m.text(match.label)}</span>
      </span>
    </span>
  );
}

function StockText({ stock }: { stock: number | null }) {
  if (stock === null) return <span className="text-[var(--color-muted)]">—</span>;
  if (stock === 0) return <span className="font-semibold text-rose-600">Out</span>;
  return <span className={stock < 10 ? "font-semibold text-amber-600" : "text-[var(--color-ink)]"}>{count(stock)}</span>;
}

function OptionsTable({ result }: { result: HuntCheckResult }) {
  const { currency, targetRoiPercent, summary } = result;
  const unpriced = summary.verdict === "unpriced";
  const [open, setOpen] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  // The option the product is judged on first, then what earns most, the out-of-stock last.
  const ordered = useMemo(() => {
    const rows = result.options.map((option, index) => ({ option, index }));
    return rows.sort((a, b) => {
      if (a.index === summary.headline.optionIndex) return -1;
      if (b.index === summary.headline.optionIndex) return 1;
      const outA = a.option.stock === 0 ? 1 : 0;
      const outB = b.option.stock === 0 ? 1 : 0;
      if (outA !== outB) return outA - outB;
      return (b.option.profit ?? -Infinity) - (a.option.profit ?? -Infinity);
    });
  }, [result.options, summary.headline.optionIndex]);
  const shown = all ? ordered : ordered.slice(0, OPTIONS_SHOWN);
  const isBestSeller = (index: number) => summary.bestSeller?.optionIndex === index;
  const single = result.options.length === 1 && !result.options[0].label;

  // A marker under an option's name: the one matching the competitor's best
  // seller, or the one earning most. Soft pills with a mark, never wrapping.
  const tagClass = "inline-flex h-5 flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[10.5px] font-semibold ring-1 ring-inset";
  const tag = (index: number) =>
    isBestSeller(index) ? (
      <span className={`${tagClass} bg-indigo-50 text-indigo-700 ring-indigo-200`}>
        <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden>
          <path d="M10 2.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4L10 14.6l-4.8 2.5.9-5.4L2.2 7.9l5.4-.8L10 2.2z" />
        </svg>
        Best seller{summary.bestSeller?.sold ? ` · ${count(summary.bestSeller.sold)} sold` : ""}
      </span>
    ) : !unpriced && summary.bestOptionIndex === index && summary.headline.optionIndex !== index ? (
      <span className={`${tagClass} bg-emerald-50 text-emerald-700 ring-emerald-200`}>
        <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" aria-hidden>
          <path d="M4 13.5l4.5-4.5 3 3L16 7.5M12 7.5h4v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Most profit
      </span>
    ) : null;

  return (
    <section className="card overflow-hidden">
      <SectionHead
        icon="options"
        title={single ? "Profit per sale" : `Every option (${result.options.length})`}
        meta={`${result.competitor ? "At the competitor's price, postage included." : `At your price: cost and postage marked up to your ${targetRoiPercent}% target return.`} Tap a row for the breakdown.`}
      />

      {/* Phones: a card per option. */}
      <ul className="divide-y divide-[var(--color-line)] border-t border-[var(--color-line)] md:hidden">
        {shown.map(({ option, index }) => (
          <li key={index} className={option.stock === 0 ? "opacity-60" : ""}>
            <button type="button" onClick={() => setOpen(open === index ? null : index)} className="flex w-full items-start gap-3 px-4 py-3 text-left">
              <Thumb src={option.imageUrl} size={44} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-[var(--color-ink)]">{option.label || "The product"}</span>
                {tag(index) && <span className="mt-1 flex">{tag(index)}</span>}
                <span className="mt-1 grid grid-cols-3 gap-x-2 text-[11.5px] text-[var(--color-muted)]">
                  <span>
                    Cost <b className="font-semibold tabular-nums text-[var(--color-ink)]">{option.cost === null ? "—" : money(option.cost, currency)}</b>
                  </span>
                  <span>
                    Sells <b className="font-semibold tabular-nums text-[var(--color-ink)]">{option.sellPrice === null ? "—" : money(option.sellPrice, currency)}</b>
                  </span>
                  <span>
                    Stock <b className="font-semibold tabular-nums"><StockText stock={option.stock} /></b>
                  </span>
                </span>
              </span>
              <span className="flex-shrink-0 text-right">
                <span className={`block text-[15px] font-semibold tabular-nums ${profitInk(option.profit, option.roi, targetRoiPercent, unpriced)}`}>{signedMoney(option.profit, currency)}</span>
                <span className="block text-[11.5px] tabular-nums text-[var(--color-muted)]">{roiText(option.roi)}</span>
              </span>
            </button>
            {open === index && (
              <div className="bg-[var(--color-paper)]/60 px-4 pb-4 pt-1">
                {option.match && (
                  <p className="mb-3 flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
                    <MatchChip quality={option.match.quality} />
                    {option.match.quality === "target" ? `Your price at a ${targetRoiPercent}% return` : option.match.label ? `Competitor's ${option.match.label}` : "Competitor's price"}
                    {option.match.sold ? ` · ${count(option.match.sold)} sold` : ""}
                  </p>
                )}
                <Split option={option} currency={currency} />
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Wider screens: the table. */}
      <div className="hidden overflow-x-auto border-t border-[var(--color-line)] md:block">
        <table className="w-full min-w-[760px] text-[12.5px]">
          <thead>
            <tr className="bg-[var(--color-paper)] text-[10.5px] whitespace-nowrap uppercase tracking-wide text-[var(--color-muted)]">
              <th className="px-4 py-2.5 text-left font-semibold">Option</th>
              <th className="w-[76px] px-2 py-2.5 text-center font-semibold">Stock</th>
              <th className="w-[84px] px-2 py-2.5 text-center font-semibold">Cost</th>
              <th className="w-[84px] px-2 py-2.5 text-center font-semibold">Postage</th>
              <th className="w-[150px] px-2 py-2.5 text-center font-semibold">{result.competitor ? "Their price" : "Your price"}</th>
              <th className="w-[92px] px-2 py-2.5 text-center font-semibold">eBay fees</th>
              <th className="w-[92px] px-2 py-2.5 text-center font-semibold">Profit</th>
              <th className="w-[84px] px-3 py-2.5 text-center font-semibold">Return</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {shown.map(({ option, index }) => {
              const expanded = open === index;
              return (
                <Fragment key={index}>
                  <tr
                    onClick={() => setOpen(expanded ? null : index)}
                    className={`cursor-pointer transition-colors hover:bg-[var(--color-paper)]/70 ${expanded ? "bg-[var(--color-primary-soft)]/40" : ""} ${option.stock === 0 ? "opacity-55" : ""}`}
                  >
                    <td className="px-4 py-2.5">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Thumb src={option.imageUrl} size={34} className="rounded-lg" />
                        <span className="min-w-0">
                          <span className="block max-w-[260px] truncate font-medium text-[var(--color-ink)]" title={option.label || undefined}>
                            {option.label || "The product"}
                          </span>
                          {tag(index) && <span className="mt-1 flex">{tag(index)}</span>}
                          {!option.costExact && <span className="block text-[11px] text-amber-700">Product price used</span>}
                        </span>
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-center tabular-nums">
                      <StockText stock={option.stock} />
                    </td>
                    <td className="px-2 py-2.5 text-center tabular-nums text-[var(--color-ink)]">{option.cost === null ? "—" : money(option.cost, currency)}</td>
                    <td className="px-2 py-2.5 text-center tabular-nums text-[var(--color-ink)]">{option.shipping ? money(option.shipping, currency) : <span className="text-[var(--color-muted)]">Free</span>}</td>
                    <td className="px-2 py-2.5 text-center">
                      {option.match ? <SellsAt match={option.match} currency={currency} /> : "—"}
                    </td>
                    <td className="px-2 py-2.5 text-center tabular-nums text-[var(--color-muted)]">{option.fees ? money(option.fees.total, currency) : "—"}</td>
                    <td className={`px-2 py-2.5 text-center font-semibold tabular-nums ${profitInk(option.profit, option.roi, targetRoiPercent, unpriced)}`}>{signedMoney(option.profit, currency)}</td>
                    <td className="px-3 py-2.5 text-center tabular-nums text-[var(--color-ink)]">{roiText(option.roi)}</td>
                  </tr>
                  {expanded && (
                    <tr className="bg-[var(--color-paper)]/50">
                      <td colSpan={8} className="px-4 py-4">
                        <Split option={option} currency={currency} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {ordered.length > OPTIONS_SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)} className="w-full border-t border-[var(--color-line)] py-2.5 text-[12.5px] font-semibold text-[var(--color-primary)] hover:bg-[var(--color-paper)]">
          {all ? "Show fewer" : `Show all ${ordered.length} options`}
        </button>
      )}
    </section>
  );
}

// ---- risks and duplicates ------------------------------------------------------------------------

const CHECK_TILE = {
  bad: "bg-rose-50/70 ring-rose-200",
  warn: "bg-amber-50/70 ring-amber-200",
  good: "bg-[var(--color-panel)] ring-[var(--color-line)]",
  unknown: "bg-[var(--color-paper)] ring-[var(--color-line)]",
} as const;

function Checks({ result }: { result: HuntCheckResult }) {
  const order = { bad: 0, warn: 1, unknown: 2, ok: 3 } as const;
  const checks = [...result.checks].sort((a, b) => order[a.level] - order[b.level]);
  const bad = checks.filter((c) => c.level === "bad").length;
  const look = checks.filter((c) => c.level === "warn").length;
  const fine = checks.filter((c) => c.level === "ok").length;
  const pill = "inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-semibold ring-1 ring-inset";
  return (
    <section className="card overflow-hidden">
      <SectionHead
        icon="checks"
        title="Before approving"
        meta={
          <>
            {bad > 0 && <span className={`${pill} bg-rose-50 text-rose-700 ring-rose-200`}>{bad} against it</span>}
            {look > 0 && <span className={`${pill} bg-amber-50 text-amber-700 ring-amber-200`}>{look} to look at</span>}
            {fine > 0 && <span className={`${pill} bg-emerald-50 text-emerald-700 ring-emerald-200`}>{fine} fine</span>}
          </>
        }
      />
      <ul className="grid grid-cols-1 gap-2 border-t border-[var(--color-line)] p-4 sm:px-5 md:grid-cols-2">
        {checks.map((c) => {
          const tone = LEVEL_TONE[c.level];
          return (
            <li key={c.key} className={`flex min-w-0 gap-3 rounded-xl px-3 py-2.5 ring-1 ring-inset ${CHECK_TILE[tone]}`}>
              <span className={`mt-px flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-black/5 ${INK[tone]}`}>
                <ToneIcon tone={tone} />
              </span>
              <span className="min-w-0">
                <span className="block text-[12.5px] font-semibold text-[var(--color-ink)]">{c.label}</span>
                <span className="block text-[12px] leading-snug text-[var(--color-muted)]">{c.detail}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {result.warnings.length > 0 && (
        <ul className="space-y-1 border-t border-[var(--color-line)] px-4 py-3 text-[12px] text-amber-800 sm:px-5">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function duplicateLine(d: HuntDuplicate): { text: ReactNode; meta: string } {
  const where = d.sameAccount ? `this account (${d.account})` : d.account;
  const same = d.same === "both" ? "same supplier and competitor" : d.same === "supplier" ? "same supplier product" : d.same === "competitor" ? "same competitor listing" : "";
  switch (d.type) {
    case "hunt":
      return { text: <>Hunted on {where}{d.by ? ` by ${d.by}` : ""}</>, meta: [d.stage ? STAGE[d.stage].label : null, same, d.at ? ago(d.at) : null].filter(Boolean).join(" · ") };
    case "draft":
      return { text: <>A draft on {where}</>, meta: [same, d.at ? ago(d.at) : null].filter(Boolean).join(" · ") };
    case "listing":
    case "live":
      return { text: <>Live on {where}{d.itemId ? ` (#${d.itemId})` : ""}</>, meta: same || "same supplier product" };
    case "own_competitor":
      return { text: <>The competitor listing is yours, on {where}</>, meta: d.itemId ? `#${d.itemId}` : "" };
    default:
      return { text: <>Similar title live on {where}</>, meta: `${d.similarity}% alike${d.itemId ? ` · #${d.itemId}` : ""}` };
  }
}

export function Duplicates({ items }: { items: HuntDuplicate[] }) {
  if (!items.length) return null;
  return (
    <section className="rounded-[var(--radius-card)] border border-amber-200 bg-amber-50/70 p-4">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold text-amber-900">
        <ToneIcon tone="warn" />
        Already on your accounts
      </h3>
      <ul className="mt-2 space-y-2">
        {items.map((d, i) => {
          const line = duplicateLine(d);
          // A live listing opens in the account's Listings, searched to it.
          const href = d.itemId && d.type !== "draft" && d.type !== "hunt" ? `/accounts/${d.connectionId}/listings?q=${encodeURIComponent(d.itemId)}` : null;
          return (
            <li key={`${d.type}-${d.id || d.itemId || i}`} className="min-w-0 text-[12.5px]">
              <p className="font-medium text-[var(--color-ink)]">
                {line.text}
                {href && (
                  <Link href={href} target="_blank" className="ml-2 text-[12px] font-semibold text-amber-800 underline-offset-2 hover:underline">
                    View listing
                  </Link>
                )}
              </p>
              <p className="truncate text-[11.5px] text-amber-900/70">
                {line.meta}
                {d.title ? ` · ${d.title}` : ""}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="mt-2.5 text-[11.5px] text-amber-900/70">A heads-up only: the same product can go on any of your accounts, or twice on one.</p>
    </section>
  );
}

// ---- the whole check -----------------------------------------------------------------------------

// Checked from the supplier alone: what that means, where the competitor's card would be.
function NoCompetitor({ target }: { target: number }) {
  return (
    <section className="flex min-w-0 flex-col rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] bg-[var(--color-panel)]/60 p-4">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        <span className="h-2 w-2 rounded-full border border-[#0064D2]" aria-hidden />
        No competitor
      </span>
      <p className="mt-2.5 text-[13px] font-medium text-[var(--color-ink)]">Checked from the supplier alone</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
        Each option is priced as a draft would be: its cost and postage marked up to your {target}% target return. A competitor&apos;s listing adds the market price, the best seller and how many sell.
      </p>
    </section>
  );
}

export function HuntResult({ result }: { result: HuntCheckResult }) {
  const { competitor: c, source: s, currency, shipping, demand } = result;
  const supplier = s.supplier;
  const postage = c?.postage ? (c.postage.cost ? `+ ${money(c.postage.cost, currency)} postage` : "Free postage") : null;
  return (
    <div className="space-y-4">
      <Verdict result={result} />
      <Duplicates items={result.duplicates || []} />
      <Checks result={result} />
      <HuntSales result={result} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {!c ? (
          <NoCompetitor target={result.targetRoiPercent} />
        ) : (
        <ProductCard
          kind="ebay"
          title={c.title}
          url={c.url}
          image={c.imageUrl}
          badges={
            <>
              <FeedbackPill percent={c.seller?.feedbackPercentage} score={c.seller?.feedbackScore} />
              {demand.soldPerMonth !== null && demand.soldPerMonth > 0 && (
                <FactPill tone={demand.soldPerMonth >= 3 ? "indigo" : "amber"} title="How many the competitor sells a month">
                  {count(demand.soldPerMonth)} sold / month
                </FactPill>
              )}
              {c.abroad && c.country && (
                <FactPill tone="amber" title="The competitor posts from abroad">
                  Posts from {c.country}
                </FactPill>
              )}
            </>
          }
        >
          <Stat label="Price" value={c.lowestPrice === null ? "—" : `${result.options.length > 1 || demand.variations > 1 ? "From " : ""}${money(c.lowestPrice, currency)}`} note={postage || undefined} />
          <Stat label="Sold" value={demand.sold === null ? "—" : count(demand.sold)} note={demand.soldPerMonth === null ? undefined : `${count(demand.soldPerMonth)} a month`} />
          <Stat label="Listed for" value={demand.daysLive === null ? "—" : age(demand.daysLive)} note={demand.variations ? `${demand.sellingVariations} of ${demand.variations} options selling` : undefined} />
          <Stat
            label="Seller"
            value={c.seller?.username || "—"}
            note={c.seller?.business ? "Business seller" : c.seller ? "Private seller" : undefined}
          />
        </ProductCard>
        )}
        <ProductCard
          kind="aliexpress"
          title={s.title}
          url={s.url}
          image={s.imageUrl}
          badges={
            supplier ? (
              <>
                <RatingPill rating={supplier.rating} reviews={supplier.reviews} />
                {supplier.orders && <FactPill title="Orders on AliExpress">{supplier.orders} orders</FactPill>}
                {supplier.onSale === false && <FactPill tone="rose">No longer on sale</FactPill>}
              </>
            ) : undefined
          }
        >
          <Stat label="Cost" value={costRange(result.options, currency)} note={`${count(s.options)} option${s.options === 1 ? "" : "s"}`} />
          <Stat
            label="Postage"
            value={shipping.basis === "aliexpress" ? ((shipping.counted ?? shipping.cost) ? money(shipping.counted ?? shipping.cost, currency) : "Free") : `${money(shipping.cost, currency)} (settings)`}
            note={shipping.basis === "aliexpress" ? [shipping.freeOver ? `free over ${money(shipping.freeOver, currency)}` : null, dayRange({ min: shipping.minDays, max: shipping.maxDays })].filter(Boolean).join(" · ") || undefined : "AliExpress quote not available"}
          />
          <Stat label="Delivery" value={s.days ? dayRange(s.days) || "—" : "—"} note={s.days ? "to the buyer" : undefined} />
          <div className="min-w-0">
            <dt className="text-[11px] font-medium text-[var(--color-muted)]">Store</dt>
            <dd className="mt-0.5 truncate text-[13px] font-semibold text-[var(--color-ink)]" title={supplier?.store?.name}>
              {supplier?.store?.name || "—"}
            </dd>
            <dd className="mt-1">
              <StoreScores store={supplier?.store} />
            </dd>
          </div>
        </ProductCard>
      </div>

      <OptionsTable result={result} />
    </div>
  );
}
