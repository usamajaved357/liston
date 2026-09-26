"use client";

import { ReactNode, useState } from "react";
import { ResearchAdvice, ResearchAnalysis, ResearchKeyword, ResearchPrice, ResearchResult, ResearchRisk, ResearchSummary, ResearchVerdict } from "@/lib/api";
import { currencySymbol, formatShortDate } from "@/lib/format";
import { bigMoney, count, money } from "./format";

// The decision half of product research, kept short so the listings sit
// high on the page: one line saying whether to list it, the market in a
// strip of figures, then price, title, takedown risk and the market's
// detail folded away until asked for.

export type Tone = "good" | "warn" | "bad" | "unknown";
const TONE: Record<Tone, string> = {
  good: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  bad: "bg-rose-50 text-rose-700 ring-rose-200",
  unknown: "bg-[var(--color-paper)] text-[var(--color-muted)] ring-[var(--color-line)]",
};
const INK: Record<Tone, string> = { good: "text-emerald-600", warn: "text-amber-600", bad: "text-rose-600", unknown: "text-[var(--color-muted)]" };

export function ToneIcon({ tone, className = "h-4 w-4" }: { tone: Tone; className?: string }) {
  if (tone === "good")
    return (
      <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
        <circle cx="10" cy="10" r="8" fill="currentColor" opacity=".15" />
        <path d="M6.5 10.2l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (tone === "bad")
    return (
      <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
        <circle cx="10" cy="10" r="8" fill="currentColor" opacity=".15" />
        <path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  if (tone === "warn")
    return (
      <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
        <path d="M10 3l7.5 13h-15L10 3z" fill="currentColor" opacity=".15" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M10 8.2v3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="10" cy="14" r="1" fill="currentColor" />
      </svg>
    );
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 2.5" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`h-4 w-4 shrink-0 text-[var(--color-muted)] transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
      <path d="M5.5 8l4.5 4.5L14.5 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


const firstSentence = (text: string) => text.split(/(?<=[.!?])\s/)[0];

// The one reason that decides it, in a sentence: a protected brand by name,
// else the red reason, else the amber one, else the best thing about the
// market.
function headline(analysis: ResearchAnalysis) {
  const brand = analysis.risks.find((r) => r.key === "brand" && r.level === "bad");
  if (brand?.brands?.length) return `${brand.brands.join(", ")} is a protected brand. Listings that use it get removed under VeRO.`;
  const pick = analysis.verdict.reasons.find((r) => r.tone === "bad") || analysis.verdict.reasons.find((r) => r.tone === "warn") || analysis.verdict.reasons[0];
  return pick ? firstSentence(pick.text.replace(/^[^:]{2,30}:\s*/, "")) : "";
}

function Figure({ label, value, note, strong }: { label: string; value: ReactNode; note?: string; strong?: boolean }) {
  return (
    <div className="min-w-0 px-4 py-3" title={note}>
      <p className={`truncate text-[17px] font-semibold leading-tight tracking-tight tabular-nums ${strong ? "text-[var(--color-primary)]" : "text-[var(--color-ink)]"}`}>{value}</p>
      <p className="mt-1 truncate text-[12px] text-[var(--color-muted)]">
        {label}
      </p>
    </div>
  );
}

/**
 * Whether to list it, in one line, over the market's figures. The verdict
 * waits for the brand and safety check (a strong market can still be a
 * brand the owner has removed), so it never says one thing and then another.
 */
// A gauge from red through amber to green, the needle on the listing's
// health; all faded while the brand check runs.
const GAUGE = [
  { from: 180, to: 122, color: "#f43f5e" },
  { from: 118, to: 62, color: "#f59e0b" },
  { from: 58, to: 0, color: "#10b981" },
];
const NEEDLE: Record<ResearchVerdict["status"], number> = { unhealthy: 151, caution: 90, healthy: 29 };
const point = (deg: number, r: number) => [44 + r * Math.cos((deg * Math.PI) / 180), 44 - r * Math.sin((deg * Math.PI) / 180)];

function HealthGauge({ status }: { status: ResearchVerdict["status"] | null }) {
  const active = status === null ? -1 : status === "unhealthy" ? 0 : status === "caution" ? 1 : 2;
  const [nx, ny] = point(status ? NEEDLE[status] : 90, 25);
  return (
    <svg viewBox="0 0 88 50" className={`h-[50px] w-[88px] shrink-0 ${status === null ? "animate-pulse" : ""}`} aria-hidden>
      {GAUGE.map((seg, i) => {
        const [x1, y1] = point(seg.from, 36);
        const [x2, y2] = point(seg.to, 36);
        return <path key={i} d={`M${x1} ${y1} A36 36 0 0 1 ${x2} ${y2}`} fill="none" stroke={seg.color} strokeWidth="8" strokeLinecap="round" opacity={i === active ? 1 : 0.18} />;
      })}
      {status !== null && (
        <>
          <line x1="44" y1="44" x2={nx} y2={ny} stroke="#1e1b4b" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="44" cy="44" r="4" fill="#1e1b4b" />
        </>
      )}
    </svg>
  );
}

const HEALTH_WORD: Record<ResearchVerdict["status"], string> = { healthy: "Healthy", caution: "Caution", unhealthy: "Unhealthy" };
const HEALTH_INK: Record<ResearchVerdict["status"], string> = { healthy: "text-emerald-700", caution: "text-amber-700", unhealthy: "text-rose-700" };

/**
 * The listing's health, over the market's figures. It waits for the brand
 * and safety check (a strong market can still be a brand the owner has
 * removed), so it never says one thing and then another; when the check
 * couldn't run, it says so and offers to run it again.
 */
export function ResearchOverview({ result, checking, onRecheck, children }: { result: ResearchResult; checking: boolean; onRecheck?: () => void; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { analysis: a, advice, summary: s } = result;
  const currency = result.market.currency;
  const pending = !a.checked && checking;
  const unchecked = !a.checked && !checking;
  const range = s.price ? (
    <>
      {money(s.price.min, currency)}
      <span className="mx-1 font-normal text-[var(--color-muted)]">–</span>
      {money(s.price.max, currency)}
    </>
  ) : (
    "—"
  );
  const scoreTone: Tone = a.verdict.score >= 65 ? "good" : a.verdict.score >= 40 ? "warn" : "bad";
  const status = a.verdict.status;

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3.5">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <HealthGauge status={pending ? null : status} />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">Listing health</p>
            <p className={`text-[19px] font-semibold leading-tight tracking-tight ${pending ? "text-[var(--color-muted)]" : HEALTH_INK[status]}`}>{pending ? "Checking…" : HEALTH_WORD[status]}</p>
            <p className="mt-0.5 text-[12.5px] leading-snug text-[var(--color-muted)]">
              {pending ? (
                "Checking the brand and product rules"
              ) : (
                <>
                  <b className="font-semibold text-[var(--color-ink)]">{a.verdict.label}.</b> {headline(a)}
                </>
              )}
            </p>
            {unchecked && (
              <p className="mt-1 text-[12px] text-amber-700">
                Brand and safety not checked yet.{" "}
                {onRecheck && (
                  <button type="button" onClick={onRecheck} className="font-medium underline underline-offset-2 hover:text-amber-900">
                    Check now
                  </button>
                )}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <span className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]" title="Demand, how many listings sell, competition, price room and where rivals ship from. A takedown risk makes it Don't list whatever the score.">
            Market score
            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--color-paper)]">
              <span className={`block h-full rounded-full ${scoreTone === "good" ? "bg-emerald-500" : scoreTone === "warn" ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${Math.max(4, a.verdict.score)}%` }} />
            </span>
            <b className="font-semibold tabular-nums text-[var(--color-ink)]">{a.verdict.score}</b>
          </span>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[var(--color-primary)] hover:underline">
            {open ? "Hide reasons" : "Why"}
            <Chevron open={open} />
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-[var(--color-line)] bg-[var(--color-paper)]/50 px-4 py-3.5">
          {advice?.summary && <p className="mb-3 max-w-4xl text-[13px] leading-relaxed text-[var(--color-ink)]">{advice.summary}</p>}
          <ul className="grid gap-x-8 gap-y-2 md:grid-cols-2">
            {a.verdict.reasons.map((r) => (
              <li key={r.text} className="flex gap-2 text-[12.5px] leading-snug text-[var(--color-ink)]">
                <span className={`mt-px shrink-0 ${INK[r.tone]}`}>
                  <ToneIcon tone={r.tone} />
                </span>
                <span>{r.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 divide-[var(--color-line)] border-t border-[var(--color-line)] sm:grid-cols-4 xl:grid-cols-[1fr_1.6fr_1fr_1fr_0.8fr_1fr_1fr] xl:divide-x">
        <Figure label="Price buyers pay" value={s.price ? money(s.price.median, currency) : "—"} note="The middle price, postage included" />
        <Figure label="Price range" value={range} note={`Postage included${s.price?.outliers ? `; ${s.price.outliers} listing${s.price.outliers === 1 ? "" : "s"} priced far from the rest left out` : ""}`} />
        <Figure label="Sell yours at" value={a.price ? money(a.price.recommended, currency) : "—"} strong note="Recommended, with postage" />
        <Figure label="Sold a month" value={s.sold ? count(Math.round(s.sold.perMonth)) : "—"} note={s.sold ? `By the ${s.sold.read} listings read · about ${bigMoney(s.sold.revenuePerMonth, currency)} a month` : undefined} />
        <Figure label="Sellers" value={count(s.sellers)} note={`Biggest seller has ${s.topSellerShare}% of the listings`} />
        <Figure label="Free postage" value={`${s.freePostage}%`} />
        <Figure label={`Ship from ${result.market.label}`} value={`${s.domestic}%`} note={`Posted from ${result.market.countryName}`} />
      </div>
      {children && <div className="border-t border-[var(--color-line)]">{children}</div>}
    </section>
  );
}

// ---- the folded sections -------------------------------------------------------

function Fold({ title, summary, tone, children }: { title: string; summary: ReactNode; tone?: Tone; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-[var(--color-line)] first:border-t-0">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--color-paper)]/60">
        <span className="w-36 shrink-0 text-[13px] font-semibold text-[var(--color-ink)]">{title}</span>
        {tone && (
          <span className={`shrink-0 ${INK[tone]}`}>
            <ToneIcon tone={tone} />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-muted)]">{summary}</span>
        <Chevron open={open} />
      </button>
      {open && <div className="px-4 pb-4 pt-1">{children}</div>}
    </div>
  );
}

const RISK_TONE: Record<ResearchRisk["level"], Tone> = { ok: "good", warn: "warn", bad: "bad", unknown: "unknown" };

export function ResearchFolds({ result, checking }: { result: ResearchResult; checking: boolean }) {
  const { analysis: a, advice, summary: s } = result;
  const currency = result.market.currency;
  const flagged = a.risks.filter((r) => r.level === "bad" || r.level === "warn");
  const riskTone: Tone = flagged.some((r) => r.level === "bad") ? "bad" : flagged.length ? "warn" : a.checked ? "good" : "unknown";
  const riskSummary = flagged.length
    ? flagged.map((r) => r.label).join(" · ")
    : !a.checked && checking
      ? "Checking…"
      : "No risks found";

  return (
    <section className="card overflow-hidden">
      <Fold
        title="Price & profit"
        summary={a.price ? `Sell at ${money(a.price.recommended, currency)} · you keep ${money(a.price.afterFees, currency)} after fees · pay a supplier up to ${money(a.price.maxCost, currency)}` : "No prices to go on"}
      >
        <PriceBody key={a.price?.recommended ?? "none"} price={a.price} currency={currency} />
      </Fold>
      <Fold title="Title & keywords" summary={advice ? advice.title : checking ? "Writing a title from the listings that sell…" : "The words the selling titles use"}>
        <TitleBody advice={advice} keywords={a.keywords} checking={checking} />
      </Fold>
      <Fold title="Takedown risk" tone={riskTone} summary={riskSummary}>
        <RiskBody risks={a.risks} checking={checking && !a.checked} />
      </Fold>
      <Fold title="Market" summary={`${count(s.sellers)} sellers · biggest has ${s.topSellerShare}% · ${s.newInLast30Days} listed in the last 30 days`}>
        <MarketBody summary={s} currency={currency} />
      </Fold>
    </section>
  );
}

// ---- bodies ----------------------------------------------------------------------

const numberOr = (text: string, fallback: number) => {
  const n = parseFloat(text);
  return Number.isFinite(n) ? n : fallback;
};

function PriceBody({ price, currency }: { price: ResearchPrice | null; currency: string }) {
  // Starts at the recommended price; a new search remounts it (see key).
  const [sellAt, setSellAt] = useState(price ? price.recommended.toFixed(2) : "");
  const [cost, setCost] = useState("");
  if (!price) return <p className="text-[13px] text-[var(--color-muted)]">No prices to go on.</p>;
  const sym = currencySymbol(currency);
  const s = numberOr(sellAt, price.recommended);
  const feeRate = (price.fees.adsPercent + price.fees.processingPercent) / 100;
  const keep = s * (1 - feeRate) - price.fees.fixed;
  const c = parseFloat(cost);
  const hasCost = Number.isFinite(c) && c > 0;
  const profit = hasCost ? keep - c - price.fees.shipping : null;
  const roi = hasCost && profit !== null ? (profit / (c + price.fees.shipping)) * 100 : null;
  const maxCost = keep / (1 + price.targetRoiPercent / 100) - price.fees.shipping;
  const signal = price.confidence === "high" ? "Strong signal" : price.confidence === "medium" ? "Fair signal" : "Weak signal";
  return (
    <div className="grid gap-5 md:grid-cols-[1fr_1.2fr]">
      <div>
        <p className="text-[13px] leading-relaxed text-[var(--color-ink)]">
          {price.basis === "sales" ? "Most sales happen at" : "Most listings sit at"} <b>{money(price.low, currency)}–{money(price.high, currency)}</b>
          {price.basis === "sales" && <>, the middle at {money(price.salesMiddle, currency)}</>}, postage included.
        </p>
        <span
          className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${price.confidence === "high" ? TONE.good : price.confidence === "medium" ? TONE.warn : TONE.unknown}`}
          title={price.basis === "sales" ? `From ${price.basedOn} listings that sell, weighted by their sales` : `Too few sales, so from all ${price.basedOn} listings`}
        >
          {signal}
        </span>
        <p className="mt-3 text-[11.5px] leading-snug text-[var(--color-muted)]">
          Fees from this account&apos;s pricing: {price.fees.adsPercent}% ads, {price.fees.processingPercent}% eBay, {money(price.fees.fixed, currency)} an order; target return {price.targetRoiPercent}%.
        </p>
      </div>
      <div className="rounded-xl border border-[var(--color-line)] p-3.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11.5px] font-medium text-[var(--color-muted)]">Sell at ({sym})</span>
            <input value={sellAt} onChange={(e) => setSellAt(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" className="input input-sm mt-1 tabular-nums" />
          </label>
          <label className="block">
            <span className="text-[11.5px] font-medium text-[var(--color-muted)]">Supplier cost ({sym})</span>
            <input value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" placeholder="e.g. 2.40" className="input input-sm mt-1 tabular-nums" />
          </label>
        </div>
        <dl className="mt-3 space-y-1.5 text-[12.5px]">
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--color-muted)]">You keep after eBay fees</dt>
            <dd className="font-semibold tabular-nums text-[var(--color-ink)]">{money(keep, currency)}</dd>
          </div>
          {hasCost ? (
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-muted)]">Profit · return</dt>
              <dd className={`font-semibold tabular-nums ${profit! < 0 ? "text-rose-700" : roi! < price.targetRoiPercent ? "text-amber-700" : "text-emerald-700"}`}>
                {money(profit, currency)} · {Math.round(roi!)}%
              </dd>
            </div>
          ) : (
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-muted)]">Pay a supplier at most</dt>
              <dd className="font-semibold tabular-nums text-[var(--color-ink)]">{maxCost > 0 ? money(maxCost, currency) : "—"}</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}

function Chip({ k }: { k: ResearchKeyword }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] ring-1 ring-inset ${k.inQuery ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)] ring-transparent" : "bg-[var(--color-panel)] text-[var(--color-ink)] ring-[var(--color-line)]"}`}
      title={`In ${k.share}% of titles, weighted by sales`}
    >
      {k.term}
      <span className="tabular-nums text-[11px] text-[var(--color-muted)]">{k.share}%</span>
    </span>
  );
}

function TitleBody({ advice, keywords, checking }: { advice: ResearchAdvice | null; keywords: ResearchAnalysis["keywords"]; checking: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked: the text is on screen to select */
    }
  }
  const selling = [...keywords.phrases.slice(0, 5), ...keywords.words.filter((w) => !keywords.phrases.slice(0, 5).some((p) => p.term.split(" ").includes(w.term))).slice(0, 12)];
  return (
    <div className="space-y-4">
      {advice ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-line)] px-3.5 py-2.5">
          <p className="min-w-0 flex-1 text-[13.5px] font-medium leading-snug text-[var(--color-ink)]">{advice.title}</p>
          <span className={`text-[11.5px] tabular-nums ${advice.title.length > 80 ? "text-rose-700" : "text-[var(--color-muted)]"}`}>{advice.title.length}/80</span>
          <button type="button" onClick={() => copy(advice.title, "title")} className="btn btn-secondary btn-sm">
            {copied === "title" ? "Copied" : "Copy title"}
          </button>
        </div>
      ) : checking ? (
        <div className="h-12 animate-pulse rounded-xl bg-[var(--color-paper)]" />
      ) : (
        <p className="text-[12.5px] text-[var(--color-muted)]">A suggested title isn&apos;t available right now; the words below are what the selling titles use.</p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {advice && advice.keywords.length > 0 && (
          <div>
            <div className="flex items-center justify-between">
              <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">Buyers search</h3>
              <button type="button" onClick={() => copy(advice.keywords.join(", "), "keywords")} className="text-[12px] font-medium text-[var(--color-primary)] hover:underline">
                {copied === "keywords" ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {advice.keywords.map((k) => (
                <span key={k} className="rounded-full bg-[var(--color-primary-soft)] px-2.5 py-1 text-[12px] text-[var(--color-primary)]">
                  {k}
                </span>
              ))}
            </div>
          </div>
        )}
        {selling.length > 0 && (
          <div>
            <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">In the titles that sell</h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {selling.map((k) => (
                <Chip key={k.term} k={k} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RiskBody({ risks, checking }: { risks: ResearchRisk[]; checking: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <ul className="grid gap-x-8 gap-y-3 md:grid-cols-2">
        {risks.map((r) => {
          const tone = RISK_TONE[r.level];
          const pending = r.level === "unknown" && checking && (r.key === "brand" || r.key === "safety");
          return (
            <li key={r.key} className="flex gap-2.5">
              <span className={`mt-px shrink-0 ${INK[tone]}`}>{pending ? <span className="block h-4 w-4 animate-pulse rounded-full bg-[var(--color-line)]" /> : <ToneIcon tone={tone} />}</span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-[var(--color-ink)]">{r.label}</p>
                <p className="mt-0.5 text-[12px] leading-snug text-[var(--color-muted)]">{pending ? "Reading the brand and product rules for this site…" : r.detail}</p>
                {r.items && r.items.length > 0 && (
                  <>
                    <button type="button" onClick={() => setOpen(open === r.key ? null : r.key)} className="mt-1 text-[12px] font-medium text-[var(--color-primary)] hover:underline">
                      {open === r.key ? "Hide" : `See ${r.items.length === 1 ? "it" : `the ${r.items.length}`}`}
                    </button>
                    {open === r.key && (
                      <ul className="mt-1.5 space-y-1.5">
                        {r.items.map((item) => (
                          <li key={`${item.title}-${item.at}`} className="rounded-md bg-[var(--color-paper)] px-2.5 py-1.5 text-[12px]">
                            <p className="font-medium text-[var(--color-ink)]">{item.title}</p>
                            <p className="text-[var(--color-muted)]">
                              {item.account} · {formatShortDate(item.at)} · {item.reason}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-[11.5px] leading-snug text-[var(--color-muted)]">
        Removed listings come from eBay&apos;s sales history for the last 90 days; the brand and product rules, eBay&apos;s word filter and your own refused drafts are checked by Liston.
      </p>
    </div>
  );
}

function MarketBody({ summary: s, currency }: { summary: ResearchSummary; currency: string }) {
  const max = Math.max(1, ...s.bands.map((b) => b.count));
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">Where prices sit</h3>
        {s.bands.length ? (
          <div className="mt-3 flex h-32 items-end gap-1.5" role="img" aria-label="Listings per price band">
            {s.bands.map((band) => (
              <div key={band.from} className="group flex min-w-0 flex-1 flex-col items-center gap-1" title={`${money(band.from, currency)}${band.to === null ? " and up" : `–${money(band.to, currency)}`}: ${band.count} listings`}>
                <span className="text-[11px] tabular-nums text-[var(--color-muted)]">{band.count}</span>
                <div className="w-full rounded-t bg-[var(--color-primary)] opacity-80 group-hover:opacity-100" style={{ height: `${Math.max(4, (band.count / max) * 84)}px` }} />
                <span className="w-full truncate text-center text-[10.5px] tabular-nums text-[var(--color-muted)]">{`${currencySymbol(currency)}${band.from}${band.to === null ? "+" : ""}`}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-6 text-[13px] text-[var(--color-muted)]">Too few listings to show a spread.</p>
        )}
      </div>
      <div>
        <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">Biggest sellers</h3>
        <table className="mt-2 w-full text-[12.5px]">
          <thead className="text-left text-[11px] text-[var(--color-muted)]">
            <tr>
              <th className="pb-1 font-medium">Seller</th>
              <th className="pb-1 text-right font-medium">Listings</th>
              <th className="pb-1 text-right font-medium">Sold</th>
              <th className="pb-1 text-right font-medium">Sales</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {s.topSellers.slice(0, 6).map((seller) => (
              <tr key={seller.username}>
                <td className="max-w-0 py-1.5 pr-2">
                  <span className="block truncate text-[var(--color-ink)]">{seller.username}</span>
                </td>
                <td className="py-1.5 text-right tabular-nums text-[var(--color-ink)]">{seller.listings}</td>
                <td className="py-1.5 text-right tabular-nums text-[var(--color-ink)]">{seller.sold === null ? <span className="text-[var(--color-muted)]">—</span> : count(seller.sold)}</td>
                <td className="py-1.5 text-right tabular-nums text-[var(--color-ink)]">{seller.revenue === null ? <span className="text-[var(--color-muted)]">—</span> : bigMoney(seller.revenue, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
