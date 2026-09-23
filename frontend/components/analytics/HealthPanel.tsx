"use client";

import { useState } from "react";
import type { AnalyticsBenchmarks, HealthCheck, HealthRates, HealthReason, ListingEdit, ListingEditFigures, ListingHealth } from "@/lib/api";
import { formatDateTime, formatDay, formatMoney, formatShortDate } from "@/lib/format";
import { fullNumber } from "@/components/charts/chart-format";
import { StakeLabel } from "./InsightCards";
import { TONE, STAGE_TAG, editedFields } from "./insights";

// A listing's health check in its panel: the verdict and what's at stake,
// its path from search to sale against the account's typical listing,
// the likely reasons with a fix for each, a deeper check on request, and
// how its figures moved after each edit made in Liston.

const pct = (n: number | null | undefined, digits = 1) => (n == null ? "—" : `${(n * 100).toFixed(digits)}%`);

// Specifics only the seller can answer: never asked of the AI.
const SELLER_ONLY_SPECIFICS = ["seller warranty", "manufacturer part number", "mpn", "ean", "upc", "isbn", "gtin"];

export interface HealthPlan {
  instruction: string | null; // what Ask AI applies in the editor, in one go
  auto: Set<string>; // reason keys it covers
  todo: string[]; // what only the seller can do (stock, photos, policies…)
  todoKeys: Set<string>;
}

/**
 * The recommended changes for a listing, from its health reasons (and the
 * deeper check): the ones the AI can make — title, missing specifics the
 * listing's facts support, description, a price move to match similar
 * listings — as one instruction, and the rest as a to-do for the seller.
 */
export function healthPlan(health: ListingHealth, check: HealthCheck | null, price: number | null, currency: string | null): HealthPlan {
  const steps: string[] = [];
  const auto = new Set<string>();
  const todo: string[] = [];
  const todoKeys = new Set<string>();
  const money = (n: number) => formatMoney({ amount: n, currency: currency || undefined });
  const you = (key: string, text: string) => {
    todo.push(text);
    todoKeys.add(key);
  };
  for (const r of health.reasons || []) {
    if (r.status === "pass") continue;
    switch (r.key) {
      case "title":
        steps.push("Rewrite the title to use close to 80 characters, with the words buyers search for first. Keep every word accurate.");
        auto.add(r.key);
        break;
      case "specifics": {
        const missing = check?.quality.specificsMissing;
        if (missing?.length) {
          const aiCan = missing.filter((n) => !SELLER_ONLY_SPECIFICS.includes(n.toLowerCase()));
          const sellerOnly = missing.filter((n) => SELLER_ONLY_SPECIFICS.includes(n.toLowerCase()));
          if (aiCan.length) {
            steps.push(`Fill these empty item specifics eBay recommends for this category: ${aiCan.join(", ")}. Use only facts the listing states; leave out any it doesn't.`);
            auto.add(r.key);
          }
          if (sellerOnly.length) you(r.key, `Add ${sellerOnly.join(", ")} if you have them (only you know these).`);
        } else {
          steps.push("Fill any empty item specifics eBay recommends for this category that the listing's facts support.");
          auto.add(r.key);
        }
        break;
      }
      case "description":
        steps.push("Expand the description with size, material, what's in the box and compatibility, using only facts already in the listing.");
        auto.add(r.key);
        break;
      case "competitor": {
        const cheapest = check?.quality.competitor?.cheapest;
        const postage = check?.quality.shippingCost ?? 0;
        if (price != null && cheapest != null && price + postage > cheapest) {
          // Match the cheapest similar listing, delivered, but never cut more than a fifth at once.
          const drop = Math.min(price + postage - cheapest, price * 0.2);
          const target = Math.max(0.01, Math.round((price - drop) * 100) / 100);
          steps.push(`Lower the price by ${money(drop)} to ${money(target)} (every variation by the same amount), to match the cheapest similar listing delivered.`);
          auto.add(r.key);
        }
        break;
      }
      case "stock":
        you(r.key, "Put it back in stock: eBay hides it from search until then.");
        break;
      case "photo":
        you(r.key, "Try a stronger main photo: it decides the click in search.");
        break;
      case "photos":
        you(r.key, "Add more photos (eBay allows 24).");
        break;
      case "price":
        you(r.key, "Check the price against your other listings in this category.");
        break;
      case "postage":
        you(r.key, "Consider free postage (set in your postage policy).");
        break;
      case "dispatch":
        you(r.key, "Shorten the dispatch time (set in your postage policy).");
        break;
      case "returns":
        you(r.key, "Accept returns (set in your returns policy).");
        break;
      case "decline":
        you(r.key, "Check what changed recently: price, stock or a competitor.");
        break;
      case "watchers":
        you(r.key, "Send the watchers an offer in Seller Hub.");
        break;
      default:
        break;
    }
  }
  const instruction = steps.length
    ? `Apply these recommended changes from the listing's health check, and leave everything else as it is:\n${steps.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
    : null;
  return { instruction, auto, todo, todoKeys };
}

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

function Movement({ label, before, after, format, perDay, light }: { label: string; before: number | null; after: number | null; format: (n: number | null) => string; perDay?: boolean; light?: boolean }) {
  if (before == null || after == null) return null;
  const change = before > 0 ? (after - before) / before : null;
  const up = (change ?? 0) > 0;
  return (
    <div className={`rounded-lg px-2.5 py-1.5 ${light ? "bg-white" : "bg-[var(--color-paper)]"}`}>
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

// One edit made in Liston and how the listing's figures moved after it. The
// newest sits at the top of the check (`latest`), so a change just applied
// is the first thing seen; older ones are listed at the bottom.
function EditRow({ edit, currency, latest }: { edit: ListingEdit; currency: string | null; latest?: boolean }) {
  const b: ListingEditFigures | null = edit.figuresBefore;
  const a: ListingEditFigures | null = edit.figuresAfter;
  const measured = Boolean(a && b);
  const money = (n: number | null | undefined) => (n == null ? "—" : formatMoney({ amount: n, currency: currency || undefined }));
  const Wrapper = latest ? "div" : "li";
  return (
    <Wrapper className={latest ? "mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/60 px-4 py-3" : "border-b border-[var(--color-line)] py-3 last:border-0"}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-center gap-2 text-[12.5px] font-semibold text-[var(--color-ink)]">
          {latest && (
            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center self-center rounded-full bg-emerald-500 text-white" aria-hidden>
              <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none">
                <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          )}
          {editedFields(edit.fields)} changed in Liston
        </p>
        <span className="text-[11px] text-[var(--color-muted)]" title={formatDateTime(edit.changedAt)}>
          {formatDay(edit.day)}
        </span>
      </div>
      {edit.fields.includes("title") && edit.before.title !== edit.after.title && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
          <span className="line-through decoration-slate-300">{edit.before.title}</span> → <span className="text-[var(--color-ink)]">{edit.after.title}</span>
        </p>
      )}
      {edit.fields.includes("price") && (
        <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">
          Price {money(edit.before.price)} → <span className="font-semibold text-[var(--color-ink)]">{money(edit.after.price)}</span>
        </p>
      )}
      {edit.fields.includes("specifics") && edit.before.specifics != null && edit.after.specifics != null && edit.before.specifics !== edit.after.specifics && (
        <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">
          Item specifics {edit.before.specifics} → <span className="font-semibold text-[var(--color-ink)]">{edit.after.specifics}</span>
        </p>
      )}
      {edit.fields.includes("photos") && edit.before.photos != null && edit.after.photos != null && edit.before.photos !== edit.after.photos && (
        <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">
          Photos {edit.before.photos} → <span className="font-semibold text-[var(--color-ink)]">{edit.after.photos}</span>
        </p>
      )}
      {measured && a && b ? (
        <>
          <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <Movement label="Impressions" before={b.impressionsPerDay} after={a.impressionsPerDay} format={(n) => (n == null ? "—" : fullNumber(Math.round(n)))} perDay light={latest} />
            <Movement label="Click-through" before={b.ctr} after={a.ctr} format={(n) => pct(n)} light={latest} />
            <Movement label="Views" before={b.viewsPerDay} after={a.viewsPerDay} format={(n) => (n == null ? "—" : String(n))} perDay light={latest} />
            <Movement label="Sold" before={b.soldPerDay} after={a.soldPerDay} format={(n) => (n == null ? "—" : String(n))} perDay light={latest} />
          </div>
          <p className="mt-1 text-[10.5px] text-[var(--color-muted)]">
            {b.days} days before against {a.days} days after
          </p>
        </>
      ) : (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
          {edit.waitDays > 0
            ? `Results from ${formatDay(edit.day, 4)}, once 3 full days have passed${latest ? ". Until then, the check above is from the days before this change." : "."}`
            : "Not enough stored days either side of the change to compare."}
        </p>
      )}
    </Wrapper>
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
  price,
  onApply,
  onCheck,
}: {
  health: ListingHealth;
  benchmarks: AnalyticsBenchmarks | null;
  check: HealthCheck | null;
  checkCalls: { listing: number; competitor: number };
  edits: ListingEdit[];
  currency: string | null;
  sellerHubUrl: string | null;
  price: number | null; // the listing's price (the lowest, for variations)
  onApply: (plan: HealthPlan) => Promise<void> | void;
  onCheck: (competitor: boolean) => Promise<void>;
}) {
  // Similar listings' prices cost a second call: only when the seller asks.
  const [competitor, setCompetitor] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const plan = healthPlan(health, check, price, currency);
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

  async function apply() {
    setApplying(true);
    try {
      await onApply(plan);
    } finally {
      setApplying(false);
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

        {edits[0] && <EditRow edit={edits[0]} currency={currency} latest />}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--color-primary)]/25 bg-[var(--color-primary-soft)]/50 px-4 py-3">
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold text-[var(--color-ink)]">
              {plan.instruction ? `${plan.auto.size} change${plan.auto.size === 1 ? "" : "s"} Liston can make for you` : plan.todo.length ? "Changes only you can make" : "Nothing to fix right now"}
            </p>
            <p className="text-[11.5px] leading-relaxed text-[var(--color-muted)]">
              {plan.instruction
                ? `Applied in the editor for you to review before it goes live${plan.todo.length ? `; ${plan.todo.length} more for you to do` : ""}.`
                : plan.todo.length
                  ? "Opens the listing in the editor with the list of what to change."
                  : "Open the listing in the editor to change anything yourself."}
            </p>
          </div>
          {plan.instruction ? (
            <button type="button" onClick={apply} disabled={applying} className="btn btn-primary btn-sm">
              <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden>
                <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z" fill="currentColor" />
              </svg>
              {applying ? "Opening…" : "Apply recommended changes"}
            </button>
          ) : (
            <button type="button" onClick={apply} disabled={applying} className="btn btn-secondary btn-sm">
              {applying ? "Opening…" : "Open in editor"}
            </button>
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
                {plan.auto.has(r.key) ? (
                  <span className="mt-0.5 flex-shrink-0 whitespace-nowrap rounded-full bg-[var(--color-primary-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--color-primary)]">Applied for you</span>
                ) : r.key === "watchers" && sellerHubUrl ? (
                  <a href={sellerHubUrl} target="_blank" rel="noopener noreferrer" className="mt-0.5 flex-shrink-0 whitespace-nowrap text-[11.5px] font-semibold text-[var(--color-primary)] hover:underline">
                    Seller Hub ↗
                  </a>
                ) : plan.todoKeys.has(r.key) ? (
                  <span className="mt-0.5 flex-shrink-0 whitespace-nowrap rounded-full bg-[var(--color-paper)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--color-muted)]">For you</span>
                ) : null}
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
              {check
                ? `Checked ${formatShortDate(check.checkedAt)} · ${check.calls} eBay call${check.calls === 1 ? "" : "s"}${check.quality.editedAt ? ` · updated with your edit on ${formatShortDate(check.quality.editedAt)}` : ""}`
                : "Reads the live listing from eBay. Nothing is read until you press it."}
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

      {edits.length > 1 && (
        <div className="border-t border-[var(--color-line)] px-5 py-3">
          <p className="pt-1 text-[12.5px] font-semibold text-[var(--color-ink)]">Earlier changes made in Liston</p>
          <ul>
            {edits.slice(1).map((e) => (
              <EditRow key={e.id} edit={e} currency={currency} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
