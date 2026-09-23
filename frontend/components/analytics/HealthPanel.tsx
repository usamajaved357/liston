"use client";

import { useState } from "react";
import type { AnalyticsBenchmarks, HealthCheck, HealthFix, HealthRates, HealthReason, ListingEdit, ListingEditFigures, ListingHealth } from "@/lib/api";
import { formatMoney, formatShortDate } from "@/lib/format";
import { fullNumber } from "@/components/charts/chart-format";
import { StakeLabel } from "./InsightCards";
import { TONE, STAGE_TAG } from "./insights";

// A listing's health check in its panel: the verdict and what's at stake,
// its path from search to sale against the account's typical listing,
// the likely reasons with a fix for each, a deeper check on request, and
// how its figures moved after each edit made in Liston.

const pct = (n: number | null | undefined, digits = 1) => (n == null ? "—" : `${(n * 100).toFixed(digits)}%`);

// What the editor's Ask AI proposes for a fix as it opens (the seller accepts it or not).
const FIX_INSTRUCTION: Partial<Record<HealthFix, string>> = {
  title: "Rewrite the title to use close to 80 characters, with the words buyers search for first. Keep every word accurate.",
  specifics: "Fill every empty item specific eBay recommends for this category, using only facts already in the listing.",
  description: "Expand the description with size, material, what's in the box and compatibility, using only facts already in the listing.",
};
const FIX_LABEL: Record<HealthFix, string> = {
  title: "Improve title with AI",
  specifics: "Fill specifics with AI",
  description: "Expand with AI",
  photo: "Change main photo",
  photos: "Add photos",
  price: "Edit price",
  restock: "Update stock",
  offer: "Send an offer in Seller Hub",
};

function Step({ label, value, normal, weak, format }: { label: string; value: number | null; normal: number | null; weak: boolean; format: (n: number | null) => string }) {
  const max = Math.max(value ?? 0, normal ?? 0) || 1;
  return (
    <div className="grid grid-cols-[112px_1fr] items-center gap-3">
      <span className={`text-[12px] ${weak ? "font-semibold text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>{label}</span>
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-paper)]">
            <div className={`h-full rounded-full ${weak ? "bg-amber-500" : "bg-[var(--color-primary)]"}`} style={{ width: `${Math.max(2, ((value ?? 0) / max) * 100)}%` }} />
          </div>
          <span className={`w-16 text-right text-[12px] font-semibold tabular-nums ${weak ? "text-[#92400e]" : "text-[var(--color-ink)]"}`}>{format(value)}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--color-paper)]">
            <div className="h-full rounded-full bg-slate-300" style={{ width: `${Math.max(2, ((normal ?? 0) / max) * 100)}%` }} />
          </div>
          <span className="w-16 text-right text-[11px] tabular-nums text-[var(--color-muted)]">{format(normal)}</span>
        </div>
      </div>
    </div>
  );
}

function ReasonIcon({ status }: { status: HealthReason["status"] }) {
  const map = {
    fail: { cls: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]", d: "M5 5l6 6M11 5l-6 6" },
    warn: { cls: "bg-[var(--color-warning-soft)] text-[#b45309]", d: "M8 4.5v4.5M8 11.4v.1" },
    pass: { cls: "bg-emerald-50 text-emerald-600", d: "M4.5 8.5l2.2 2.2 4.8-5" },
    info: { cls: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]", d: "M8 7.5V11M8 4.9v.1" },
  }[status];
  return (
    <span className={`mt-px flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ${map.cls}`} aria-label={status}>
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden>
        <path d={map.d} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

const FIELD_LABEL: Record<ListingEdit["fields"][number], string> = {
  title: "Title",
  main_photo: "Main photo",
  photos: "Photos",
  price: "Price",
  quantity: "Stock",
  specifics: "Item specifics",
  description: "Description",
};

function Movement({ label, before, after, format, perDay }: { label: string; before: number | null; after: number | null; format: (n: number | null) => string; perDay?: boolean }) {
  if (before == null || after == null) return null;
  const change = before > 0 ? (after - before) / before : null;
  const up = (change ?? 0) > 0;
  return (
    <div className="rounded-lg bg-[var(--color-paper)] px-2.5 py-1.5">
      <p className="text-[10.5px] text-[var(--color-muted)]">
        {label}
        {perDay ? " a day" : ""}
      </p>
      <p className="mt-0.5 text-[12px] tabular-nums text-[var(--color-ink)]">
        {format(before)} → <span className="font-semibold">{format(after)}</span>
        {change != null && Math.abs(change) >= 0.05 && <span className={`ml-1 text-[11px] font-semibold ${up ? "text-emerald-700" : "text-[var(--color-danger)]"}`}>{up ? "▲" : "▼"}</span>}
      </p>
    </div>
  );
}

function EditRow({ edit, currency }: { edit: ListingEdit; currency: string | null }) {
  const b: ListingEditFigures | null = edit.figuresBefore;
  const a: ListingEditFigures | null = edit.figuresAfter;
  const money = (n: number | null | undefined) => (n == null ? "—" : formatMoney({ amount: n, currency: currency || undefined }));
  return (
    <li className="border-b border-[var(--color-line)] py-3 last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[12.5px] font-semibold text-[var(--color-ink)]">{edit.fields.map((f) => FIELD_LABEL[f]).join(", ")} changed</p>
        <span className="text-[11px] text-[var(--color-muted)]">{formatShortDate(edit.changedAt)}</span>
      </div>
      {edit.fields.includes("title") && edit.before.title !== edit.after.title && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
          <span className="line-through decoration-slate-300">{edit.before.title}</span> → <span className="text-[var(--color-ink)]">{edit.after.title}</span>
        </p>
      )}
      {edit.fields.includes("price") && (
        <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">
          Price {money(edit.before.price)} → <span className="text-[var(--color-ink)]">{money(edit.after.price)}</span>
        </p>
      )}
      {a && b ? (
        <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          <Movement label="Impressions" before={b.impressionsPerDay} after={a.impressionsPerDay} format={(n) => (n == null ? "—" : fullNumber(Math.round(n)))} perDay />
          <Movement label="Click-through" before={b.ctr} after={a.ctr} format={(n) => pct(n)} />
          <Movement label="Views" before={b.viewsPerDay} after={a.viewsPerDay} format={(n) => (n == null ? "—" : String(n))} perDay />
          <Movement label="Sold" before={b.soldPerDay} after={a.soldPerDay} format={(n) => (n == null ? "—" : String(n))} perDay />
        </div>
      ) : (
        <p className="mt-1.5 text-[11.5px] text-[var(--color-muted)]">
          {edit.waitDays > 0
            ? `Its effect shows after ${edit.waitDays} more complete day${edit.waitDays === 1 ? "" : "s"}.`
            : "Not enough stored days either side of the change to compare yet."}
        </p>
      )}
      {a && b && (
        <p className="mt-1 text-[10.5px] text-[var(--color-muted)]">
          {b.days} days before against {a.days} days after
        </p>
      )}
    </li>
  );
}

function CheckSummary({ check, currency }: { check: HealthCheck; currency: string | null }) {
  const q = check.quality;
  const money = (n: number | null | undefined) => (n == null ? "—" : formatMoney({ amount: n, currency: q.currency || currency || undefined }));
  const chips: { label: string; value: string; bad?: boolean }[] = [];
  if (q.photos != null) chips.push({ label: "Photos", value: `${q.photos} of 24`, bad: q.photos < 6 });
  if (q.specificsRecommended != null && q.specificsMissing) chips.push({ label: "Item specifics", value: `${q.specificsRecommended - q.specificsMissing.length} of ${q.specificsRecommended} eBay recommends`, bad: q.specificsMissing.length > 0 });
  if (q.titleLength != null) chips.push({ label: "Title", value: `${q.titleLength} of 80 characters`, bad: q.titleLength < 60 });
  if (q.shippingCost != null) chips.push({ label: "Postage", value: q.shippingCost === 0 ? "Free" : money(q.shippingCost), bad: q.shippingCost > 0 });
  if (q.dispatchDays != null) chips.push({ label: "Dispatch", value: `${q.dispatchDays} day${q.dispatchDays === 1 ? "" : "s"}`, bad: q.dispatchDays > 3 });
  if (q.returnsAccepted != null) chips.push({ label: "Returns", value: q.returnsAccepted ? "Accepted" : "Not accepted", bad: !q.returnsAccepted });
  if (q.competitor && !q.competitor.error)
    chips.push({ label: "Similar listings", value: q.competitor.cheapest == null ? "None found" : `from ${money(q.competitor.cheapest)} · typical ${money(q.competitor.median)}` });
  return (
    <div className="mt-2.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {chips.map((c) => (
        <div key={c.label} className="flex items-baseline justify-between gap-3 rounded-lg bg-[var(--color-paper)] px-2.5 py-1.5">
          <span className="text-[11px] text-[var(--color-muted)]">{c.label}</span>
          <span className={`truncate text-right text-[12px] font-semibold ${c.bad ? "text-[#92400e]" : "text-[var(--color-ink)]"}`}>{c.value}</span>
        </div>
      ))}
      {q.specificsMissing && q.specificsMissing.length > 0 && (
        <p className="text-[11px] leading-relaxed text-[var(--color-muted)] sm:col-span-2">Empty: {q.specificsMissing.join(", ")}</p>
      )}
      {q.competitor?.error && <p className="text-[11px] text-[var(--color-danger)] sm:col-span-2">{q.competitor.error}</p>}
    </div>
  );
}

export function HealthPanel({
  health,
  benchmarks,
  check,
  checkCalls,
  edits,
  currency,
  sellerHubUrl,
  onFix,
  onCheck,
}: {
  health: ListingHealth;
  benchmarks: AnalyticsBenchmarks | null;
  check: HealthCheck | null;
  checkCalls: { listing: number; competitor: number };
  edits: ListingEdit[];
  currency: string | null;
  sellerHubUrl: string | null;
  onFix: (fix: HealthFix, instruction: string | null) => Promise<void> | void;
  onCheck: (competitor: boolean) => Promise<void>;
}) {
  // Similar listings' prices cost a second call: only when the seller asks.
  const [competitor, setCompetitor] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [fixing, setFixing] = useState<HealthFix | null>(null);
  const tone = TONE[STAGE_TAG[health.stage]?.tone ?? (health.tone === "good" ? "good" : "neutral")];
  const rates: HealthRates | undefined = health.rates;
  const normal: HealthRates | undefined = health.normal;
  const weak = health.stage;
  const reasons = health.reasons || [];
  const calls = checkCalls.listing + (competitor ? checkCalls.competitor : 0);

  async function runCheck() {
    setChecking(true);
    setCheckError(null);
    try {
      await onCheck(competitor);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : "The check didn't finish. Try again.");
    } finally {
      setChecking(false);
    }
  }

  async function fix(key: HealthFix) {
    setFixing(key);
    // Specifics: name the empty ones the deeper check found, so the AI fills
    // those rather than guessing which.
    const missing = check?.quality.specificsMissing;
    const instruction =
      key === "specifics" && missing?.length
        ? `Fill these empty item specifics eBay recommends for this category: ${missing.join(", ")}. Use only facts already in the listing (title, description, photos); leave any the listing can't support empty.`
        : (FIX_INSTRUCTION[key] ?? null);
    try {
      await onFix(key, instruction);
    } finally {
      setFixing(null);
    }
  }

  return (
    <section className="card overflow-hidden" aria-label="Health check">
      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Health check</p>
            <p className="mt-1 flex items-center gap-2 text-[15px] font-semibold text-[var(--color-ink)]">
              <span className={`h-2.5 w-2.5 rounded-full ${tone.dot}`} aria-hidden />
              {health.label}
            </p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{health.detail}</p>
          </div>
          {health.problem && health.opportunity && health.opportunity.amount >= 1 && (
            <div className="rounded-xl bg-[var(--color-warning-soft)] px-3 py-2 text-right" title="What it would sell over these days at your typical listing's rates">
              <p className="text-[15px] font-semibold text-[#92400e]">
                <StakeLabel amount={health.opportunity.amount} currency={currency} />
              </p>
              <p className="text-[10.5px] text-[#92400e]">
                about {health.opportunity.units} more sale{health.opportunity.units === 1 ? "" : "s"} at stake
              </p>
            </div>
          )}
        </div>

        {rates && normal && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-end gap-4 text-[10.5px] text-[var(--color-muted)]">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-3 rounded-full bg-[var(--color-primary)]" aria-hidden />
                This listing
              </span>
              <span className="inline-flex items-center gap-1.5" title={benchmarks ? `The middle of your ${benchmarks.listings} listings with enough data, over the same days` : undefined}>
                <span className="h-1 w-3 rounded-full bg-slate-300" aria-hidden />
                Your typical listing
              </span>
            </div>
            <Step label="Shown in search" value={rates.impressionsPerDay} normal={normal.impressionsPerDay} weak={weak === "not_shown"} format={(n) => (n == null ? "—" : `${fullNumber(Math.round(n))}/day`)} />
            <Step label="Clicked" value={rates.ctr} normal={normal.ctr} weak={weak === "not_clicked"} format={(n) => pct(n)} />
            <Step label="Bought" value={rates.conversion} normal={normal.conversion} weak={weak === "not_bought"} format={(n) => pct(n)} />
          </div>
        )}

        {reasons.length > 0 && (
          <ul className="mt-5 space-y-2.5">
            {reasons.map((r) => (
              <li key={r.key} className="flex items-start gap-2.5">
                <ReasonIcon status={r.status} />
                <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-[var(--color-ink)]">{r.text}</p>
                {r.fix && r.status !== "pass" && (
                  r.fix === "offer" ? (
                    sellerHubUrl && (
                      <a href={sellerHubUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm flex-shrink-0">
                        {FIX_LABEL.offer}
                      </a>
                    )
                  ) : (
                    <button type="button" onClick={() => fix(r.fix!)} disabled={fixing !== null} className="btn btn-secondary btn-sm flex-shrink-0">
                      {fixing === r.fix ? "Opening…" : FIX_LABEL[r.fix]}
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
        {health.minor && health.opportunity && (
          <p className="mt-3 rounded-lg bg-[var(--color-paper)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
            A small gap: fixing it is worth about {health.opportunity.units} of a sale over these days, so it isn&apos;t listed under Needs attention.
          </p>
        )}
        {health.problem && !check && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--color-muted)]">A deeper check below reads the photos, postage, returns and the item specifics eBay recommends, for more exact reasons.</p>
        )}
      </div>

      <div className="border-t border-[var(--color-line)] bg-[var(--color-paper)]/50 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold text-[var(--color-ink)]">Deeper check</p>
            <p className="text-[11.5px] text-[var(--color-muted)]">
              {check ? `Checked ${formatShortDate(check.checkedAt)} · ${check.calls} eBay call${check.calls === 1 ? "" : "s"}` : "Reads the live listing from eBay. Nothing is read until you press it."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-[var(--color-muted)]">
              <input type="checkbox" checked={competitor} onChange={(e) => setCompetitor(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--color-primary)]" />
              Similar listings&apos; prices
            </label>
            <button type="button" onClick={runCheck} disabled={checking} className="btn btn-secondary btn-sm">
              {checking ? "Checking…" : check ? "Check again" : "Run check"}
              <span className="text-[11px] font-medium text-[var(--color-muted)]">
                {calls} call{calls === 1 ? "" : "s"}
              </span>
            </button>
          </div>
        </div>
        {checkError && <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">{checkError}</p>}
        {check && <CheckSummary check={check} currency={currency} />}
      </div>

      {edits.length > 0 && (
        <div className="border-t border-[var(--color-line)] px-5 py-3">
          <p className="pt-1 text-[12.5px] font-semibold text-[var(--color-ink)]">Changes made in Liston</p>
          <ul>
            {edits.map((e) => (
              <EditRow key={e.id} edit={e} currency={currency} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
