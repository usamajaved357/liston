"use client";

import { DiscoverCompliance as Compliance, DiscoverRisk } from "@/lib/api";
import { CardHeader } from "./discover-ui";

// "Before you hunt": whether a category or keyword is safe to hunt in.
// Three checks side by side — brands and VeRO (eBay's brand split and the
// AI's reading of the listings), restricted or prohibited items (by name
// and in the leading titles), and eBay's automated word filter (the words
// in the titles it reacts to, with what Liston writes instead) — under one
// verdict.

const LEVEL = {
  clear: { label: "Clear to hunt", tone: "text-emerald-700", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", icon: "M5 12.5l4.5 4.5L19 7.5" },
  check: { label: "Check before listing", tone: "text-amber-700", chip: "bg-amber-50 text-amber-800 ring-amber-200", icon: "M12 8v5M12 16.5v.5" },
  risky: { label: "Risky: read before hunting", tone: "text-rose-700", chip: "bg-rose-50 text-rose-700 ring-rose-200", icon: "M12 8v5M12 16.5v.5" },
} as const;

const RISK = {
  none: { label: "No risk found", dot: "bg-emerald-500" },
  low: { label: "Some risk", dot: "bg-amber-500" },
  high: { label: "High risk", dot: "bg-rose-500" },
} as const;

function Risk({ risk }: { risk: DiscoverRisk | null | undefined }) {
  if (!risk) return null;
  const r = RISK[risk.level];
  return (
    <p className="mt-1.5 text-[12px] leading-snug text-[var(--color-ink)]">
      <span className="inline-flex items-center gap-1.5 font-semibold">
        <span className={`h-1.5 w-1.5 rounded-full ${r.dot}`} aria-hidden />
        {r.label}
      </span>
      {risk.brands && risk.brands.length > 0 && <span className="font-medium"> · {risk.brands.join(", ")}</span>}
      {risk.reason && <span className="block text-[var(--color-muted)]">{risk.reason}</span>}
    </p>
  );
}

function Column({ title, children, tone }: { title: string; children: React.ReactNode; tone?: "bad" | "warn" | "ok" }) {
  const dot = tone === "bad" ? "bg-rose-500" : tone === "warn" ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
        {title}
      </p>
      {children}
    </div>
  );
}

export function DiscoverCompliance({ data, checking, onCheck, aiUnavailable }: { data: Compliance; checking: boolean; onCheck: () => void; aiUnavailable: boolean }) {
  const level = LEVEL[data.level];
  const nameRestricted = data.subject.restricted;
  const titleRestricted = data.titles.restricted;
  const restrictedTone = nameRestricted.length || titleRestricted.some((r) => r.kind === "prohibited") || data.ai?.safety?.level === "high" ? "bad" : titleRestricted.length || data.ai?.safety?.level === "low" ? "warn" : "ok";
  const brandTone = data.ai?.brand?.level === "high" ? "bad" : data.ai?.brand?.level === "low" || (data.brands.branded ?? 0) >= 50 ? "warn" : "ok";
  const wordTone = data.subject.hazmat.length || data.titles.hazmat.some((h) => h.share >= 20) ? "warn" : "ok";
  return (
    <section className="card p-4">
      <CardHeader
        title="Before you hunt"
        note="eBay's rules for this: brands and VeRO, restricted items, and the words eBay's filters react to. A guide: eBay decides."
        aside={
          <span className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold ring-1 ring-inset ${level.chip}`}>
            <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden>
              <path d={level.icon} stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {level.label}
          </span>
        }
      />
      <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-3">
        <Column title="Brands and VeRO" tone={brandTone}>
          {data.ai?.brand ? (
            <Risk risk={data.ai.brand} />
          ) : checking ? (
            <p className="mt-1.5 text-[12px] text-[var(--color-muted)]">Reading the listings for brands whose owners take listings down…</p>
          ) : aiUnavailable ? (
            <p className="mt-1.5 text-[12px] text-[var(--color-muted)]">The brand check isn&apos;t available right now.</p>
          ) : (
            <button type="button" onClick={onCheck} className="mt-1.5 text-[12px] font-semibold text-[var(--color-primary)] hover:underline">
              Check brands and VeRO
            </button>
          )}
          <p className="mt-2 text-[11.5px] leading-snug text-[var(--color-muted)]">
            {data.brands.branded === null
              ? "eBay gave no brand split."
              : `${data.brands.branded}% of the live listings carry a brand${data.brands.top.length ? `: ${data.brands.top
                  .slice(0, 3)
                  .map((b) => b.name)
                  .join(", ")}` : ""}.`}
          </p>
        </Column>

        <Column title="Restricted items" tone={restrictedTone}>
          {nameRestricted.length > 0 ? (
            <p className="mt-1.5 text-[12px] font-semibold text-rose-700">
              {nameRestricted.map((r) => `${r.label}${r.kind === "prohibited" ? " (not allowed)" : " (restricted)"}`).join(" · ")}
            </p>
          ) : titleRestricted.length > 0 ? (
            <ul className="mt-1.5 space-y-1 text-[12px]">
              {titleRestricted.slice(0, 3).map((r) => (
                <li key={r.key} className="text-[var(--color-ink)]">
                  <span className={`font-semibold ${r.kind === "prohibited" ? "text-rose-700" : "text-amber-700"}`}>{r.label}</span>
                  <span className="text-[var(--color-muted)]">
                    {" "}
                    · in {r.share}% of titles ({r.words.slice(0, 3).join(", ")})
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-[12px] font-semibold text-[var(--color-ink)]">Nothing restricted by name</p>
          )}
          {data.ai?.safety && <Risk risk={data.ai.safety} />}
        </Column>

        <Column title="eBay's word filter" tone={wordTone}>
          {data.subject.hazmat.length > 0 && (
            <p className="mt-1.5 text-[12px] font-semibold text-amber-700">Its name has {data.subject.hazmat.map((w) => `“${w}”`).join(", ")}: eBay&apos;s filter blocks listings with it.</p>
          )}
          {data.titles.hazmat.length > 0 ? (
            <ul className="mt-1.5 space-y-1 text-[12px]">
              {data.titles.hazmat.slice(0, 4).map((h) => (
                <li key={h.word}>
                  <span className="font-semibold text-[var(--color-ink)]">“{h.word}”</span>
                  <span className="text-[var(--color-muted)]">
                    {" "}
                    in {h.share}% of titles{h.safer ? ` · write “${h.safer}”` : " · leave it out"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            !data.subject.hazmat.length && <p className="mt-1.5 text-[12px] font-semibold text-[var(--color-ink)]">No filtered words in the leading titles</p>
          )}
        </Column>
      </div>
      {data.ai?.summary && <p className="mt-4 border-t border-[var(--color-line)] pt-3 text-[12px] leading-relaxed text-[var(--color-muted)]">{data.ai.summary}</p>}
    </section>
  );
}
