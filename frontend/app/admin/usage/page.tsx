"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnalyticsUsage, api, ApiError, BrowseUsage, ClaudeUsage, EbayUsage, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cacheUser, useCachedUser } from "@/lib/session";
import { Alert } from "@/components/Alert";
import { TrendChart } from "@/components/charts/TrendChart";

// API usage (admins only): eBay's daily allowances, each one pool for the
// whole of Liston (Trading for listings and orders, Traffic for views and
// impressions, Browse for public listing reads), and what Claude costs by
// feature. A card per source at the top, each with how much of today is
// gone and whether anything is holding back; the chosen one's detail below:
// its meter with the points where Liston starts saving calls, the figures
// that matter and where the calls went. The tab lives in the URL.

type Source = "trading" | "traffic" | "browse" | "claude";

const int = (n: number) => Math.round(n).toLocaleString();
const usd = (n: number) => `$${n < 0.1 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const pctOf = (used: number, limit: number) => (limit ? Math.min(100, Math.round((used / limit) * 100)) : 0);

function clock(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// "Resets in 5 h 12 min" (or at what time, once it's under a minute away).
function resetsIn(iso: string | null) {
  if (!iso) return "Resets daily";
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (min <= 0) return "Resetting now";
  const h = Math.floor(min / 60);
  return `Resets in ${h ? `${h} h ` : ""}${min % 60} min`;
}

// How a pool is doing, in words and a colour.
type Health = { label: string; dot: string; chip: string; bar: string };
const HEALTH = {
  ok: { label: "Healthy", dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", bar: "bg-[var(--color-primary)]" },
  close: { label: "Getting close", dot: "bg-amber-500", chip: "bg-amber-50 text-amber-800 ring-amber-200", bar: "bg-amber-500" },
  saving: { label: "Saving calls", dot: "bg-amber-500", chip: "bg-amber-50 text-amber-800 ring-amber-200", bar: "bg-amber-500" },
  out: { label: "Out for today", dot: "bg-rose-500", chip: "bg-rose-50 text-rose-700 ring-rose-200", bar: "bg-rose-500" },
} satisfies Record<string, Health>;
function healthOf(pct: number, exhausted: boolean, holding: boolean): Health {
  if (exhausted) return HEALTH.out;
  if (holding) return HEALTH.saving;
  if (pct >= 80) return HEALTH.close;
  return HEALTH.ok;
}

// `compact`: only the dot on a phone, where the card has no room for the words.
function HealthChip({ health, compact = false }: { health: Health; compact?: boolean }) {
  return (
    <span
      title={health.label}
      className={`inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 text-[11px] font-semibold ring-1 ring-inset ${health.chip} ${compact ? "px-1.5 sm:px-2" : "px-2"}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${health.dot}`} aria-hidden />
      <span className={compact ? "sr-only sm:not-sr-only" : ""}>{health.label}</span>
    </span>
  );
}

// ---- the cards at the top ---------------------------------------------------------

function SourceCard({ title, note, figure, detail, health, pct, selected, onSelect }: { title: string; note: string; figure: string; detail: string; health?: Health; pct?: number; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex min-w-0 flex-col rounded-[var(--radius-card)] border px-4 py-3.5 text-left shadow-[var(--shadow-card)] transition-all ${
        selected ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] ring-1 ring-[var(--color-primary)]/15" : "border-[var(--color-line)] bg-[var(--color-panel)] hover:-translate-y-px hover:border-[var(--color-line-strong)]"
      }`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold text-[var(--color-ink)]">{title}</span>
          <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{note}</span>
        </span>
        {health && <HealthChip health={health} compact />}
      </span>
      <span className="mt-3 block text-[24px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">{figure}</span>
      <span className="mt-1.5 block truncate text-[12px] text-[var(--color-muted)]">{detail}</span>
      {pct !== undefined && health && (
        <span className="mt-3 block h-1.5 overflow-hidden rounded-full bg-[var(--color-line)]" aria-hidden>
          <span className={`block h-full rounded-full ${health.bar}`} style={{ width: `${Math.max(pct ? 2 : 0, pct)}%` }} />
        </span>
      )}
    </button>
  );
}

// ---- the detail's pieces ----------------------------------------------------------

type Threshold = { at: number; text: string; active?: boolean };

// Today's pool: used of the limit, the bar with where Liston starts saving
// calls marked on it, and those points spelled out beneath.
function Meter({ used, limit, unit, exhausted, health, resetAt, confirmedAt, thresholds, footnote, outText }: {
  used: number;
  limit: number;
  unit: string;
  exhausted: boolean;
  health: Health;
  resetAt: string | null;
  confirmedAt: string | null;
  thresholds: Threshold[];
  footnote?: string;
  outText: string;
}) {
  const pct = pctOf(used, limit);
  return (
    <section className="card px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[12px] font-medium text-[var(--color-muted)]">Used today</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span className="text-[28px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">{int(used)}</span>
            <span className="text-[13px] text-[var(--color-muted)]">{`of ${int(limit)} ${unit} · ${pct}%`}</span>
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <HealthChip health={health} />
          <span className="text-[11.5px] text-[var(--color-muted)]">{`${resetsIn(resetAt)} · ${confirmedAt ? `confirmed with eBay at ${clock(confirmedAt)}` : "counted by Liston"}`}</span>
        </div>
      </div>

      <div className="relative mt-4 h-2.5 rounded-full bg-[var(--color-line)]">
        <div className={`h-full rounded-full ${health.bar}`} style={{ width: `${Math.max(pct ? 1 : 0, pct)}%` }} />
        {thresholds.map((t) => (
          <span key={t.at} className="absolute -top-1 h-[18px] w-0.5 -translate-x-1/2 rounded-full bg-[var(--color-ink)]/35" style={{ left: `${t.at}%` }} title={`${t.at}%: ${t.text}`} aria-hidden />
        ))}
      </div>
      <div className="relative mt-1 h-4 text-[10.5px] tabular-nums text-[var(--color-muted)]" aria-hidden>
        {thresholds.map((t) => (
          <span key={t.at} className="absolute -translate-x-1/2" style={{ left: `${t.at}%` }}>{`${t.at}%`}</span>
        ))}
      </div>

      <ul className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {thresholds.map((t) => (
          <li key={t.at} className="flex items-start gap-2.5 text-[12.5px]">
            <span className="mt-px inline-flex h-[18px] min-w-[38px] flex-shrink-0 items-center justify-center rounded-md bg-[var(--color-paper)] px-1.5 text-[11px] font-semibold tabular-nums text-[var(--color-ink)] ring-1 ring-inset ring-[var(--color-line)]">{`${t.at}%`}</span>
            <span className="text-[var(--color-muted)]">
              {t.text}
              {t.active && <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-px text-[10.5px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">now</span>}
            </span>
          </li>
        ))}
        {footnote && (
          <li className="flex items-start gap-2.5 text-[12.5px]">
            <span className="mt-px inline-flex h-[18px] min-w-[38px] flex-shrink-0 items-center justify-center rounded-md bg-[var(--color-paper)] px-1.5 text-[11px] font-semibold text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)]">Rest</span>
            <span className="text-[var(--color-muted)]">{footnote}</span>
          </li>
        )}
      </ul>

      {exhausted && <p className="notice notice-danger mt-4 text-[12.5px]">{outText}</p>}
    </section>
  );
}

// A few figures side by side, in one card.
function Figures({ items }: { items: { label: string; value: string; sub: string }[] }) {
  return (
    <section className="card grid grid-cols-2 divide-[var(--color-line)] lg:grid-cols-4 lg:divide-x">
      {items.map((f, i) => (
        <div key={f.label} className={`px-5 py-4 ${i >= 2 ? "border-t border-[var(--color-line)] lg:border-t-0" : ""} ${i % 2 === 1 ? "border-l border-[var(--color-line)] lg:border-l-0" : ""}`}>
          <p className="text-[12px] font-medium text-[var(--color-muted)]">{f.label}</p>
          <p className="mt-1 text-[20px] font-semibold leading-tight tracking-tight tabular-nums text-[var(--color-ink)]">{f.value}</p>
          <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--color-muted)]">{f.sub}</p>
        </div>
      ))}
    </section>
  );
}

// Where the calls went, largest first: each with its figure and share as
// text, so the bar is never the only way to read it.
function Breakdown({ title, note, rows, format = int, empty }: { title: string; note?: string; rows: { key: string; label: string; hint?: string; value: number; tag?: string }[]; format?: (v: number) => string; empty: string }) {
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  return (
    <section className="card px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{title}</h2>
        {note && <span className="text-[11.5px] text-[var(--color-muted)]">{note}</span>}
      </div>
      {!total ? (
        <p className="py-6 text-center text-[13px] text-[var(--color-muted)]">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {sorted.map((r) => {
            const share = r.value / total;
            return (
              <li key={r.key}>
                <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <span className="min-w-0 truncate text-[var(--color-ink)]" title={r.hint || r.label}>
                    {r.label}
                    {r.tag && <span className="ml-2 rounded-full bg-[var(--color-primary-soft)] px-1.5 py-px text-[10.5px] font-semibold text-[var(--color-primary)]">{r.tag}</span>}
                    {r.hint && <span className="ml-2 text-[11.5px] text-[var(--color-muted)]">{r.hint}</span>}
                  </span>
                  <span className="flex-shrink-0 tabular-nums">
                    <span className="font-semibold text-[var(--color-ink)]">{format(r.value)}</span>
                    <span className="ml-1.5 inline-block w-9 text-right text-[var(--color-muted)]">{`${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`}</span>
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-paper)]">
                  <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, opacity: 0.35 + 0.65 * (r.value / max) }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// The long explanation, folded away until someone wants it.
function HowItWorks({ children }: { children: React.ReactNode }) {
  return (
    <details className="group card px-5 py-3.5">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[12.5px] font-medium text-[var(--color-ink)] [&::-webkit-details-marker]:hidden">
        <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 text-[var(--color-muted)] transition-transform group-open:rotate-90" aria-hidden>
          <path d="M8 5l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        How this allowance is shared
      </summary>
      <div className="mt-2.5 space-y-2 pl-6 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{children}</div>
    </details>
  );
}

// ---- each source --------------------------------------------------------------------

function TradingDetail({ usage }: { usage: EbayUsage }) {
  const pct = pctOf(usage.used, usage.limit);
  const health = healthOf(pct, usage.exhausted, usage.paused.background || usage.paused.push);
  return (
    <div className="space-y-4">
      <Meter
        used={usage.used}
        limit={usage.limit}
        unit="calls"
        exhausted={usage.exhausted}
        health={health}
        resetAt={usage.resetAt}
        confirmedAt={usage.lastSyncedWithEbay}
        thresholds={[
          { at: 80, text: "Background refreshes pause", active: usage.paused.background },
          { at: 92, text: "Refreshes after an eBay push pause", active: usage.paused.push },
        ]}
        footnote="The last 8% is kept for publishing and refreshing by hand."
        outText="eBay has refused further Trading calls today. Pages keep showing their last copy until the reset."
      />
      <Figures
        items={[
          { label: "Left today", value: int(usage.remaining), sub: "calls until the reset" },
          { label: "Saved", value: int(usage.deferred.background + usage.deferred.push), sub: "refreshes skipped to protect the allowance" },
          { label: "Running now", value: int(usage.inFlight), sub: usage.waiting ? `${int(usage.waiting)} waiting for a slot` : "nothing waiting" },
          {
            label: "Live eBay push",
            value: `${usage.orderPushLive} of ${usage.accountsTotal}`,
            sub: usage.orderPushConfigured ? `accounts sending new orders (${usage.listingPushLive} listing changes), last 2 days` : "not set up on this server",
          },
        ]}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Breakdown
          title="By account"
          note="today"
          rows={usage.byAccount.map((a) => ({ key: a.connectionId, label: a.label, value: a.count, tag: a.push ? "live orders" : undefined }))}
          empty="No account has needed eBay yet today."
        />
        <Breakdown title="By call" note="today" rows={usage.byCall.map((c) => ({ key: c.name, label: c.name, value: c.count }))} empty="No Trading calls yet today." />
      </div>
      <HowItWorks>
        <p>Trading is eBay&apos;s API for listings, orders and publishing. Its allowance is one pool for Liston as a whole, not per account, so every workspace draws on the same calls.</p>
        <p>Liston re-reads accounts in the background and when eBay pushes a change. Those stop first as the day&apos;s pool runs low, so publishing and a refresh someone asks for always have calls left.</p>
      </HowItWorks>
    </div>
  );
}

const TRAFFIC_STATUS: Record<AnalyticsUsage["byAccount"][number]["status"], { label: string; className: string }> = {
  ok: { label: "Up to date", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  reconnect: { label: "Needs reconnecting", className: "bg-amber-50 text-amber-800 ring-amber-200" },
  unsupported: { label: "Site not covered", className: "bg-slate-50 text-slate-600 ring-slate-200" },
  waiting: { label: "After the reset", className: "bg-slate-50 text-slate-600 ring-slate-200" },
  error: { label: "Stopped early", className: "bg-amber-50 text-amber-800 ring-amber-200" },
};

function TrafficDetail({ usage }: { usage: AnalyticsUsage }) {
  const pct = pctOf(usage.used, usage.limit);
  const health = healthOf(pct, usage.exhausted, usage.paused.sync || usage.paused.view);
  return (
    <div className="space-y-4">
      <Meter
        used={usage.used}
        limit={usage.limit}
        unit="calls"
        exhausted={usage.exhausted}
        health={health}
        resetAt={usage.resetAt}
        confirmedAt={usage.lastSyncedWithEbay}
        thresholds={[
          { at: 70, text: "The nightly update pauses", active: usage.paused.sync },
          { at: 90, text: "Load all and single-listing reads pause", active: usage.paused.view },
          { at: 95, text: usage.spareWindow.open ? "Filling listing history stops (filling now)" : `Filling listing history stops (fills from ${clock(usage.spareWindow.opensAt)})` },
        ]}
        footnote="The last 5% is never spent: a margin for eBay's own count."
        outText="eBay has refused further traffic calls today. Analytics keeps showing its stored history."
      />
      <Figures
        items={[
          { label: "Left today", value: int(usage.remaining), sub: "calls until the reset" },
          { label: "Nightly update", value: int(usage.byKind.sync), sub: "each account's day just ended" },
          { label: "History fill", value: int(usage.byKind.history ?? 0), sub: "from leftover allowance" },
          { label: "On request", value: int(usage.byKind.view), sub: "Load all and one listing" },
        ]}
      />
      <section className="card overflow-hidden">
        <div className="flex items-baseline justify-between gap-3 px-5 pb-2 pt-4">
          <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">By account</h2>
          <span className="text-[11.5px] text-[var(--color-muted)]">today, and the listing history stored</span>
        </div>
        {usage.byAccount.length === 0 ? (
          <p className="px-5 pb-6 pt-2 text-center text-[13px] text-[var(--color-muted)]">No account has been read yet. The first read is at the next nightly update or when someone opens Analytics.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="border-y border-[var(--color-line)] bg-[var(--color-paper)] text-[11.5px] text-[var(--color-muted)]">
                <tr>
                  <th className="px-5 py-2 text-left font-medium">Account</th>
                  <th className="w-[110px] px-3 py-2 text-center font-medium">Calls today</th>
                  <th className="w-[190px] px-3 py-2 text-left font-medium">Listing history</th>
                  <th className="w-[110px] px-3 py-2 text-center font-medium">Complete to</th>
                  <th className="w-[170px] px-5 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {usage.byAccount.map((a) => {
                  const status = TRAFFIC_STATUS[a.status];
                  const h = a.history;
                  const stored = h ? Math.min(100, Math.round((h.stored / Math.max(1, h.needed)) * 100)) : 0;
                  return (
                    <tr key={a.connectionId}>
                      <td className="px-5 py-2.5">
                        <span className="block text-[var(--color-ink)]">{a.label}</span>
                        {a.timeZone && <span className="block text-[11.5px] text-[var(--color-muted)]">{a.timeZone.replace("_", " ")}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center font-semibold tabular-nums text-[var(--color-ink)]">{int(a.calls)}</td>
                      <td className="px-3 py-2.5">
                        {h ? (
                          <span className="block" title="Days of every listing's figures stored; ranges inside them cost no calls">
                            <span className="text-[12px] tabular-nums text-[var(--color-ink)]">{h.complete ? `Complete · ${h.needed} days` : `${h.stored} of ${h.needed} days`}</span>
                            <span className="mt-1 block h-1 overflow-hidden rounded-full bg-[var(--color-line)]">
                              <span className={`block h-full rounded-full ${h.complete ? "bg-emerald-500" : "bg-[var(--color-primary)]"}`} style={{ width: `${h.complete ? 100 : stored}%` }} />
                            </span>
                          </span>
                        ) : (
                          <span className="text-[var(--color-muted)]">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-[var(--color-muted)]">
                        {a.finalThrough ? new Date(`${a.finalThrough}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }) : "—"}
                      </td>
                      <td className="px-5 py-2.5">
                        <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${status.className}`} title={a.lastError || undefined}>
                          {status.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <HowItWorks>
        <p>
          Traffic is eBay&apos;s report of impressions and views. Its allowance is far smaller than Trading&apos;s, {int(usage.limit)} calls a day for all of Liston, so each
          account&apos;s figures are read once a night (02:00 in the account&apos;s time zone) and kept. Filters add up stored days and never call eBay.
        </p>
        <p>Older days of listing history (92 in all) fill only in the last hours before the reset, from calls that would otherwise go unused.</p>
      </HowItWorks>
    </div>
  );
}

const BROWSE_USE: Record<string, { label: string; hint: string }> = {
  drafting: { label: "Drafting", hint: "the competitor listing a draft is made from" },
  research: { label: "Product research", hint: "searches and sold counts" },
  health: { label: "Listing health", hint: "similar listings" },
  hunting: { label: "Product hunting", hint: "competitor listings checked" },
  "hunting-track": { label: "Hunted products, daily", hint: "each one's competitor read again for its sales" },
  discover: { label: "Discover", hint: "leading listings' sold counts" },
};
const BROWSE_CALL: Record<string, string> = {
  search: "Search results",
  getItem: "One listing and its sold count",
  getItemsByItemGroup: "A listing with variations",
  getItemByLegacyId: "A listing by its eBay number",
};

function BrowseDetail({ usage }: { usage: BrowseUsage }) {
  const research = usage.research;
  const pct = pctOf(usage.used, usage.limit);
  const researchMark = pctOf(research.limit, usage.limit);
  const researchPct = pctOf(research.used, research.limit);
  const health = healthOf(pct, usage.exhausted, research.remaining <= 0);
  const count = (name: string) => usage.byKind.find((k) => k.name === name)?.count ?? 0;
  return (
    <div className="space-y-4">
      <Meter
        used={usage.used}
        limit={usage.limit}
        unit="calls"
        exhausted={usage.exhausted}
        health={health}
        resetAt={usage.resetAt}
        confirmedAt={usage.lastSyncedWithEbay}
        thresholds={[{ at: researchMark, text: `Product research stops at its share (${int(research.limit)} calls)`, active: research.remaining <= 0 }]}
        footnote="The rest is kept for drafting and listing health checks."
        outText="eBay has refused further Browse calls today: new drafts from an eBay link and research wait for the reset."
      />
      <Figures
        items={[
          { label: "Left today", value: int(usage.remaining), sub: "calls until the reset" },
          { label: "Product research", value: `${researchPct}%`, sub: `${int(research.used)} of its ${int(research.limit)}, about ${int(Math.floor(research.remaining / 21))} searches left` },
          { label: "Drafting", value: int(count("drafting")), sub: "competitor listings read" },
          { label: "Product hunting", value: int(count("hunting")), sub: "competitor listings checked" },
        ]}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Breakdown title="By use" note="today" rows={usage.byKind.map((k) => ({ key: k.name, label: BROWSE_USE[k.name]?.label ?? k.name, hint: BROWSE_USE[k.name]?.hint, value: k.count }))} empty="No Browse calls yet today." />
        <Breakdown title="By call" note="today" rows={usage.byCall.map((c) => ({ key: c.name, label: BROWSE_CALL[c.name] ?? c.name, hint: BROWSE_CALL[c.name] ? c.name : undefined, value: c.count }))} empty="No Browse calls yet today." />
      </div>
      <HowItWorks>
        <p>Browse is eBay&apos;s API for reading public listings with Liston&apos;s own key, a separate allowance from Trading&apos;s and one pool for all of Liston.</p>
        <p>
          Drafting reads the competitor listing, listing health reads similar listings, and product research reads searches and sold counts. Research stops at{" "}
          {int(research.limit)} a day so drafting always has {int(Math.max(0, usage.limit - research.limit))} left. &ldquo;Check with eBay&rdquo; replaces the total with eBay&apos;s own
          figure; the split by use stays Liston&apos;s count.
        </p>
      </HowItWorks>
    </div>
  );
}

function ClaudeDetail({ usage }: { usage: ClaudeUsage }) {
  const week = usage.days.slice(0, 7);
  const weekTotal = week.reduce((sum, d) => sum + d.total, 0);
  const byPurpose = new Map<string, { label: string; calls: number; input: number; output: number; cost: number }>();
  for (const day of week) {
    for (const row of day.byPurpose) {
      const into = byPurpose.get(row.purpose) || { label: row.label, calls: 0, input: 0, output: 0, cost: 0 };
      into.calls += row.calls;
      into.input += row.input;
      into.output += row.output;
      into.cost += row.cost;
      byPurpose.set(row.purpose, into);
    }
  }
  const features = [...byPurpose.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const today = usage.days[0];
  const drafts = byPurpose.get("draft.write")?.calls ?? 0;
  const perDraft = drafts ? ((byPurpose.get("draft.write")?.cost ?? 0) + (byPurpose.get("draft.title")?.cost ?? 0)) / drafts : null;
  const points = [...usage.days].reverse().map((d) => ({ day: d.day, value: d.total }));
  return (
    <div className="space-y-4">
      <Figures
        items={[
          { label: "Today", value: usd(today?.total ?? 0), sub: `${int(today?.calls ?? 0)} calls so far` },
          { label: "Last 7 days", value: usd(weekTotal), sub: `about ${usd(weekTotal / 7)} a day` },
          { label: "Biggest cost", value: features[0] ? usd(features[0][1].cost) : "—", sub: features[0] ? `${features[0][1].label}, last 7 days` : "no calls yet" },
          { label: "Per draft", value: perDraft === null ? "—" : usd(perDraft), sub: "writing and the title, on average" },
        ]}
      />
      <section className="card px-5 py-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Spend by day</h2>
          <span className="text-[11.5px] text-[var(--color-muted)]">{`last ${usage.days.length} days, UTC as in the Claude Console`}</span>
        </div>
        <div className="mt-3">
          {points.some((p) => p.value > 0) ? (
            <TrendChart points={points} format={(v) => (v == null ? "—" : usd(v))} axisFormat={(v) => `$${v.toFixed(v < 1 ? 2 : 0)}`} label="Claude spend" currentLabel="Spend" variant="bars" showPrevious={false} legend={false} height={200} />
          ) : (
            <p className="py-6 text-center text-[13px] text-[var(--color-muted)]">No Claude calls counted yet.</p>
          )}
        </div>
      </section>
      <section className="card overflow-hidden">
        <div className="flex items-baseline justify-between gap-3 px-5 pb-2 pt-4">
          <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">By feature</h2>
          <span className="text-[11.5px] text-[var(--color-muted)]">{`last 7 days · ${usage.model}, list prices`}</span>
        </div>
        {features.length === 0 ? (
          <p className="px-5 pb-6 pt-2 text-center text-[13px] text-[var(--color-muted)]">No Claude calls counted yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="border-y border-[var(--color-line)] bg-[var(--color-paper)] text-[11.5px] text-[var(--color-muted)]">
                <tr>
                  <th className="px-5 py-2 text-left font-medium">Feature</th>
                  <th className="w-[90px] px-3 py-2 text-center font-medium">Calls</th>
                  <th className="w-[150px] px-3 py-2 text-center font-medium">Tokens in / out</th>
                  <th className="w-[100px] px-3 py-2 text-center font-medium">Per call</th>
                  <th className="w-[150px] px-5 py-2 text-center font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {features.map(([purpose, f]) => {
                  const share = weekTotal ? f.cost / weekTotal : 0;
                  return (
                    <tr key={purpose}>
                      <td className="px-5 py-2.5 text-[var(--color-ink)]">{f.label}</td>
                      <td className="px-3 py-2.5 text-center tabular-nums">{int(f.calls)}</td>
                      <td className="px-3 py-2.5 text-center text-[12px] tabular-nums text-[var(--color-muted)]">{`${int(f.input / Math.max(1, f.calls))} / ${int(f.output / Math.max(1, f.calls))}`}</td>
                      <td className="px-3 py-2.5 text-center tabular-nums">{usd(f.cost / Math.max(1, f.calls))}</td>
                      <td className="px-5 py-2.5">
                        <span className="flex items-center justify-center gap-2 tabular-nums">
                          <span className="font-semibold text-[var(--color-ink)]">{usd(f.cost)}</span>
                          <span className="w-8 text-[11.5px] text-[var(--color-muted)]">{`${Math.round(share * 100)}%`}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="text-[12px] text-[var(--color-muted)]">What each Claude call cost, by the feature that made it, from the token counts Claude returns. Counted from when this was switched on.</p>
    </div>
  );
}

// ---- the page ---------------------------------------------------------------------

function ApiUsageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const asked = searchParams.get("tab");
  const [tab, setTab] = useState<Source>(asked === "traffic" || asked === "browse" || asked === "claude" ? asked : "trading");
  const cachedUser = useCachedUser();
  const [liveUser, setUser] = useState<User | null>(null);
  const user = liveUser ?? cachedUser;
  const [usage, setUsage] = useState<EbayUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.me(), api.getEbayUsage()])
      .then(([me, data]) => {
        if (!me.user.is_admin) {
          router.replace("/dashboard");
          return;
        }
        setUser(me.user);
        cacheUser(me.user);
        setUsage(data);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/login");
        else if (err instanceof ApiError && err.status === 403) router.replace("/dashboard");
        else setError("Couldn't load API usage.");
      })
      .finally(() => setLoading(false));
  }, [router]);

  function choose(next: Source) {
    setTab(next);
    router.replace(`/admin/usage${next === "trading" ? "" : `?tab=${next}`}`, { scroll: false });
  }

  async function checkWithEbay() {
    setSyncing(true);
    setError(null);
    try {
      setUsage(await api.getEbayUsage(true));
    } catch {
      setError("Couldn't read the figures from eBay. Try again in a minute.");
    } finally {
      setSyncing(false);
    }
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-4 sm:p-10">
        <PageSkeleton />
      </main>
    );
  }

  const trading = usage && { pct: pctOf(usage.used, usage.limit), health: healthOf(pctOf(usage.used, usage.limit), usage.exhausted, usage.paused.background || usage.paused.push) };
  const traffic = usage?.analytics && { pct: pctOf(usage.analytics.used, usage.analytics.limit), health: healthOf(pctOf(usage.analytics.used, usage.analytics.limit), usage.analytics.exhausted, usage.analytics.paused.sync || usage.analytics.paused.view) };
  const browse = usage?.browse && { pct: pctOf(usage.browse.used, usage.browse.limit), health: healthOf(pctOf(usage.browse.used, usage.browse.limit), usage.browse.exhausted, usage.browse.research.remaining <= 0) };
  const claudeWeek = usage?.claude ? usage.claude.days.slice(0, 7).reduce((sum, d) => sum + d.total, 0) : 0;

  return (
    <AppShell
      connectionsUsed={Number(user.connections_used ?? 0)}
      maxConnections={user.max_connections ?? 0}
      planName={user.plan_name ?? "Unassigned"}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-ink)]">API usage</h1>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">eBay&apos;s daily allowances and what Claude costs, for all of Liston.</p>
          </div>
          <button type="button" onClick={checkWithEbay} disabled={syncing || loading} className="btn btn-secondary btn-sm gap-1.5">
            <svg viewBox="0 0 24 24" fill="none" className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} aria-hidden>
              <path d="M20 12a8 8 0 01-14.3 4.9M4 12a8 8 0 0114.3-4.9M18.5 3.5v4h-4M5.5 20.5v-4h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {syncing ? "Asking eBay…" : "Check with eBay"}
          </button>
        </div>
      }
    >
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {loading || !usage || !trading ? (
        <PageSkeleton rows={2} />
      ) : (
        <div className="space-y-5 pb-4">
          <div role="tablist" aria-label="API" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <SourceCard title="Trading API" note="Listings and orders" figure={`${trading.pct}%`} detail={`${int(usage.used)} of ${int(usage.limit)} calls`} health={trading.health} pct={trading.pct} selected={tab === "trading"} onSelect={() => choose("trading")} />
            {traffic && usage.analytics && (
              <SourceCard title="Traffic API" note="Views and impressions" figure={`${traffic.pct}%`} detail={`${int(usage.analytics.used)} of ${int(usage.analytics.limit)} calls`} health={traffic.health} pct={traffic.pct} selected={tab === "traffic"} onSelect={() => choose("traffic")} />
            )}
            {browse && usage.browse && (
              <SourceCard title="Browse API" note="Public listing reads" figure={`${browse.pct}%`} detail={`${int(usage.browse.used)} of ${int(usage.browse.limit)} calls`} health={browse.health} pct={browse.pct} selected={tab === "browse"} onSelect={() => choose("browse")} />
            )}
            {usage.claude && (
              <SourceCard title="Claude AI" note="Drafts, descriptions, checks" figure={usd(usage.claude.days[0]?.total ?? 0)} detail={`today · ${usd(claudeWeek)} in the last 7 days`} selected={tab === "claude"} onSelect={() => choose("claude")} />
            )}
          </div>

          {tab === "claude" ? (
            usage.claude ? <ClaudeDetail usage={usage.claude} /> : <Alert>Claude figures aren&apos;t available from this server yet.</Alert>
          ) : tab === "browse" ? (
            usage.browse ? <BrowseDetail usage={usage.browse} /> : <Alert>Browse figures aren&apos;t available from this server yet.</Alert>
          ) : tab === "traffic" ? (
            usage.analytics ? <TrafficDetail usage={usage.analytics} /> : <Alert>Traffic figures aren&apos;t available from this server yet.</Alert>
          ) : (
            <TradingDetail usage={usage} />
          )}
        </div>
      )}
    </AppShell>
  );
}

// useSearchParams (the tab is in the URL) needs a Suspense boundary above it.
export default function ApiUsagePage() {
  return (
    <Suspense fallback={null}>
      <ApiUsageInner />
    </Suspense>
  );
}
