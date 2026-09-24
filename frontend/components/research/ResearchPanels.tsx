"use client";

import { useEffect, useState } from "react";
import { ResearchAdvice, ResearchAnalysis, ResearchKeyword, ResearchPrice, ResearchRisk, ResearchVerdict } from "@/lib/api";
import { currencySymbol, formatShortDate } from "@/lib/format";
import { money } from "./format";

// The decision half of product research: one verdict, the price to sell at,
// the title and keywords, and what could get a listing taken down.

type Tone = "good" | "warn" | "bad" | "unknown";
const TONE: Record<Tone, string> = {
  good: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  bad: "bg-rose-50 text-rose-700 ring-rose-200",
  unknown: "bg-[var(--color-paper)] text-[var(--color-muted)] ring-[var(--color-line)]",
};
const BAR: Record<Tone, string> = { good: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-rose-500", unknown: "bg-[var(--color-line-strong)]" };

function ToneIcon({ tone, className = "h-4 w-4" }: { tone: Tone; className?: string }) {
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

const STATUS_TONE: Record<ResearchVerdict["status"], Tone> = { healthy: "good", caution: "warn", unhealthy: "bad" };
const STATUS_WORD: Record<ResearchVerdict["status"], string> = { healthy: "Healthy", caution: "Caution", unhealthy: "Unhealthy" };

export function VerdictCard({ verdict, advice, checking }: { verdict: ResearchVerdict; advice: ResearchAdvice | null; checking: boolean }) {
  const [all, setAll] = useState(false);
  const tone = STATUS_TONE[verdict.status];
  // The market's own score, coloured by itself: a strong market can still be
  // "Don't list" when a takedown risk overrides it.
  const scoreTone: Tone = verdict.score >= 65 ? "good" : verdict.score >= 40 ? "warn" : "bad";
  const overridden = verdict.label === "Don't list";
  const reasons = all ? verdict.reasons : verdict.reasons.slice(0, 5);
  return (
    <section className="card grid gap-5 p-5 md:grid-cols-[260px_1fr]">
      <div className="flex flex-col">
        <span className="text-[13px] font-medium text-[var(--color-muted)]">Should you list it?</span>
        <div className="mt-3 flex items-center gap-3">
          <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ${TONE[tone]}`}>
            <ToneIcon tone={tone} className="h-7 w-7" />
          </span>
          <div className="min-w-0">
            <p className="text-[22px] font-semibold leading-tight tracking-tight text-[var(--color-ink)]">{verdict.label}</p>
            <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11.5px] font-semibold ring-1 ring-inset ${TONE[tone]}`}>{STATUS_WORD[verdict.status]}</span>
          </div>
        </div>
        <div className="mt-5">
          <div className="flex items-baseline justify-between text-[12px] text-[var(--color-muted)]">
            <span>Opportunity score</span>
            <span className="font-semibold tabular-nums text-[var(--color-ink)]">{verdict.score}/100</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--color-paper)]" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={verdict.score} aria-label="Opportunity score">
            <div className={`h-full rounded-full ${BAR[scoreTone]}`} style={{ width: `${Math.max(3, verdict.score)}%` }} />
          </div>
          <p className="mt-2 text-[11.5px] leading-snug text-[var(--color-muted)]">
            {overridden
              ? `${verdict.score >= 65 ? "The market itself scores well, but" : "And"} a takedown risk overrides the score — see the red reasons.`
              : "Demand, how many listings sell, competition, price room and where rivals ship from. A takedown risk makes it \u201cDon't list\u201d whatever the score."}
          </p>
        </div>
      </div>
      <div className="min-w-0 border-t border-[var(--color-line)] pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0">
        {advice?.summary ? (
          <p className="mb-3 rounded-lg bg-[var(--color-primary-soft)] px-3 py-2 text-[13px] text-[var(--color-ink)]">{advice.summary}</p>
        ) : checking ? (
          <p className="mb-3 h-9 animate-pulse rounded-lg bg-[var(--color-paper)]" />
        ) : null}
        <ul className="space-y-2">
          {reasons.map((r) => (
            <li key={r.text} className="flex gap-2.5 text-[13px] leading-snug text-[var(--color-ink)]">
              <span className={`mt-px shrink-0 ${r.tone === "good" ? "text-emerald-600" : r.tone === "warn" ? "text-amber-600" : "text-rose-600"}`}>
                <ToneIcon tone={r.tone} />
              </span>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
        {verdict.reasons.length > 5 && (
          <button type="button" onClick={() => setAll((v) => !v)} className="mt-2 text-[12.5px] font-medium text-[var(--color-primary)] hover:underline">
            {all ? "Show fewer" : `Show all ${verdict.reasons.length} reasons`}
          </button>
        )}
        {checking && <p className="mt-3 text-[12px] text-[var(--color-muted)]">Checking brand and safety risk…</p>}
      </div>
    </section>
  );
}

const numberOr = (text: string, fallback: number) => {
  const n = parseFloat(text);
  return Number.isFinite(n) ? n : fallback;
};

export function PriceCard({ price, currency }: { price: ResearchPrice | null; currency: string }) {
  const [sellAt, setSellAt] = useState("");
  const [cost, setCost] = useState("");
  useEffect(() => {
    setSellAt(price ? price.recommended.toFixed(2) : "");
  }, [price]);
  if (!price) {
    return (
      <section className="card p-5">
        <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Sell it for</h2>
        <p className="mt-6 text-center text-[13px] text-[var(--color-muted)]">No prices to go on.</p>
      </section>
    );
  }
  const sym = currencySymbol(currency);
  const s = numberOr(sellAt, price.recommended);
  const feeRate = (price.fees.adsPercent + price.fees.processingPercent) / 100;
  const keep = s * (1 - feeRate) - price.fees.fixed;
  const c = parseFloat(cost);
  const hasCost = Number.isFinite(c) && c > 0;
  const profit = hasCost ? keep - c - price.fees.shipping : null;
  const roi = hasCost && profit !== null ? (profit / (c + price.fees.shipping)) * 100 : null;
  const maxCost = keep / (1 + price.targetRoiPercent / 100) - price.fees.shipping;
  return (
    <section className="card flex flex-col p-5">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Sell it for</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${price.confidence === "high" ? TONE.good : price.confidence === "medium" ? TONE.warn : TONE.unknown}`}
          title={price.basis === "sales" ? `From ${price.basedOn} listings that sell, weighted by their sales` : `Too few sales, so from all ${price.basedOn} listings`}
        >
          {price.confidence === "high" ? "Strong signal" : price.confidence === "medium" ? "Fair signal" : "Weak signal"}
        </span>
      </div>
      <p className="mt-2.5 text-[30px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">{money(price.recommended, currency)}</p>
      <p className="mt-1.5 text-[12px] text-[var(--color-muted)]">
        With postage. {price.basis === "sales" ? "Most sales happen at" : "Most listings sit at"} {money(price.low, currency)}–{money(price.high, currency)}
        {price.basis === "sales" && `, the middle at ${money(price.salesMiddle, currency)}`}.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[11.5px] font-medium text-[var(--color-muted)]">Sell at ({sym})</span>
          <input value={sellAt} onChange={(e) => setSellAt(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" className="input mt-1 !h-9 tabular-nums" />
        </label>
        <label className="block">
          <span className="text-[11.5px] font-medium text-[var(--color-muted)]">Supplier cost ({sym})</span>
          <input value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" placeholder="e.g. 2.40" className="input mt-1 !h-9 tabular-nums" />
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
      <p className="mt-auto pt-3 text-[11.5px] leading-snug text-[var(--color-muted)]">
        Fees from this account&apos;s pricing: {price.fees.adsPercent}% ads, {price.fees.processingPercent}% eBay, {money(price.fees.fixed, currency)} an order; target return {price.targetRoiPercent}%.
      </p>
    </section>
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

export function TitleCard({ advice, keywords, checking }: { advice: ResearchAdvice | null; keywords: ResearchAnalysis["keywords"]; checking: boolean }) {
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
  return (
    <section className="card flex flex-col p-5">
      <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Title &amp; keywords</h2>
      {advice ? (
        <div className="mt-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)] p-3">
          <p className="text-[13.5px] font-medium leading-snug text-[var(--color-ink)]">{advice.title}</p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className={`text-[11.5px] tabular-nums ${advice.title.length > 80 ? "text-rose-700" : "text-[var(--color-muted)]"}`}>{advice.title.length}/80 characters</span>
            <button type="button" onClick={() => copy(advice.title, "title")} className="btn btn-secondary btn-sm">
              {copied === "title" ? "Copied" : "Copy title"}
            </button>
          </div>
        </div>
      ) : checking ? (
        <div className="mt-3 h-[84px] animate-pulse rounded-lg bg-[var(--color-paper)]" />
      ) : (
        <p className="mt-3 rounded-lg bg-[var(--color-paper)] p-3 text-[12.5px] text-[var(--color-muted)]">A suggested title isn&apos;t available right now; the words below are what the selling titles use.</p>
      )}
      {advice && advice.keywords.length > 0 && (
        <>
          <div className="mt-4 flex items-center justify-between">
            <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">Buyers search</h3>
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
        </>
      )}
      {(keywords.phrases.length > 0 || keywords.words.length > 0) && (
        <>
          <h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">In the titles that sell</h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[...keywords.phrases.slice(0, 5), ...keywords.words.filter((w) => !keywords.phrases.slice(0, 5).some((p) => p.term.split(" ").includes(w.term))).slice(0, 12)].map((k) => (
              <Chip key={k.term} k={k} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

const RISK_TONE: Record<ResearchRisk["level"], Tone> = { ok: "good", warn: "warn", bad: "bad", unknown: "unknown" };
const RISK_WORD: Record<ResearchRisk["level"], string> = { ok: "Clear", warn: "Check", bad: "Risk", unknown: "—" };

export function RiskCard({ risks, checking }: { risks: ResearchRisk[]; checking: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card flex flex-col p-5">
      <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Takedown risk</h2>
      <ul className="mt-2 divide-y divide-[var(--color-line)]">
        {risks.map((r) => {
          const tone = RISK_TONE[r.level];
          const pending = r.level === "unknown" && checking;
          return (
            <li key={r.key} className="py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[13px] font-medium text-[var(--color-ink)]">
                  <span className={tone === "good" ? "text-emerald-600" : tone === "warn" ? "text-amber-600" : tone === "bad" ? "text-rose-600" : "text-[var(--color-muted)]"}>
                    <ToneIcon tone={tone} />
                  </span>
                  {r.label}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${pending ? TONE.unknown + " animate-pulse" : TONE[tone]}`}>
                  {pending ? "Checking" : RISK_WORD[r.level]}
                </span>
              </div>
              <p className="mt-1 pl-6 text-[12px] leading-snug text-[var(--color-muted)]">{pending ? "Reading the brand and product rules for this site…" : r.detail}</p>
              {r.items && r.items.length > 0 && (
                <div className="pl-6">
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
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-auto pt-2 text-[11.5px] leading-snug text-[var(--color-muted)]">
        eBay doesn&apos;t publish takedown history for any product (its Compliance API closed in March 2026). This checks your own refused drafts, eBay&apos;s word filter, and the brand and product rules.
      </p>
    </section>
  );
}
