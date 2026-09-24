"use client";

import { useMemo, useState } from "react";
import type { AccountAnalytics, AnalyticsSource, ListingAnalyticsRow, ListingHealth, ListingLastEdit } from "@/lib/api";
import { formatDay, formatMoney } from "@/lib/format";
import { SegmentedControl } from "@/components/charts/SegmentedControl";
import { compactNumber, fullNumber, percent } from "@/components/charts/chart-format";
import { ACTIONS, ActionKey, STAGE_TAG, TONE, Tone, atStake, editedFields, needsAttention } from "./insights";

// The three cards under the chart — what to do next, what's moving, and the
// listings worth opening — plus the traffic-sources strip under the chart.
// Everything here comes from figures the page already has.

function Thumb({ src, size = 36 }: { src: string | null; size?: number }) {
  const cls = "flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-contain";
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" width={size} height={size} style={{ width: size, height: size }} className={cls} loading="lazy" />
  ) : (
    <span style={{ width: size, height: size }} className={`${cls} bg-[var(--color-paper)]`} />
  );
}

/** A small status tag: a coloured dot and a word or two. */
export function StatusTag({ tone, label, title }: { tone: Tone; label: string; title?: string }) {
  const t = TONE[tone];
  return (
    <span title={title} className={`inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded-full px-1.5 text-[10.5px] font-semibold ${t.soft} ${t.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden />
      {label}
    </span>
  );
}

/** A listing's health as a tag (problems, strong sellers and new listings only). */
export function HealthTag({ health }: { health: ListingHealth }) {
  const tag = health.minor ? null : STAGE_TAG[health.stage];
  return tag ? <StatusTag tone={tag.tone} label={tag.label} title={`${health.label}: ${health.detail}`} /> : null;
}

/**
 * A listing updated from Liston: "Updated · results 27 Sept" while its
 * results aren't in (it's out of Needs attention until then), then a quiet
 * "✓ Updated 23 Sept" beside its health tag.
 */
export function EditTag({ edit }: { edit: ListingLastEdit }) {
  const title = `${editedFields(edit.fields)} changed in Liston on ${formatDay(edit.day)}${
    edit.waiting ? `. Its results show from ${formatDay(edit.resultsFrom)}; until then it's kept out of Needs attention.` : "."
  }`;
  const check = (
    <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" aria-hidden>
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  return edit.waiting ? (
    <span title={title} className="inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 px-1.5 text-[10.5px] font-semibold text-emerald-700">
      {check}
      Updated · results {formatDay(edit.resultsFrom)}
    </span>
  ) : (
    <span title={title} className="inline-flex items-center gap-1 whitespace-nowrap text-[10.5px] font-medium text-emerald-700">
      {check}
      Updated {formatDay(edit.day)}
    </span>
  );
}

/** "£24" at stake, in the account's currency; nothing when it's pennies. */
export function StakeLabel({ amount, currency, className = "" }: { amount: number; currency: string | null; className?: string }) {
  if (!(amount >= 1)) return null;
  return <span className={`tabular-nums ${className}`}>≈ {formatMoney({ amount: Math.round(amount), currency: currency || undefined }).replace(/\.00$/, "")}</span>;
}

function CardHeader({ title, aside }: { title: string; aside?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{title}</h2>
      {aside}
    </div>
  );
}

const Quiet = ({ children }: { children: React.ReactNode }) => <p className="mt-4 text-[12px] leading-relaxed text-[var(--color-muted)]">{children}</p>;

function listingFiguresReady(data: AccountAnalytics) {
  if (data.range.partial) return "Choose 7 days or longer: suggestions look at complete days.";
  if (data.listingReport.state === "filling") return "Appears once this range's listing figures are stored.";
  if (data.listingReport.state !== "ok") return "Appears once this range's listing figures are read from eBay.";
  return null;
}

// ---- growth opportunities ----------------------------------------------------------

export function GrowthCard({ data, onPick }: { data: AccountAnalytics; onPick: (key: ActionKey) => void }) {
  const groups = useMemo(
    () => ACTIONS.map((a) => ({ ...a, rows: data.listings.filter((r) => a.test(r)) })).filter((g) => g.rows.length > 0),
    [data]
  );
  const waiting = listingFiguresReady(data);
  return (
    <section className="card flex flex-col p-4">
      <CardHeader title="Growth opportunities" aside={<span className="text-[11px] text-[var(--color-muted)]">what to do next</span>} />
      {waiting ? (
        <Quiet>{waiting}</Quiet>
      ) : groups.length === 0 ? (
        <Quiet>Nothing to fix in this range: stock is healthy and every listing is being seen, clicked and bought at a normal rate.</Quiet>
      ) : (
        <ul className="-mx-1.5 mt-2.5 space-y-0.5">
          {groups.map((g) => {
            const t = TONE[g.tone];
            return (
              <li key={g.key}>
                <button
                  type="button"
                  onClick={() => onPick(g.key)}
                  className="group flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-[var(--color-paper)]"
                  title={`Show these ${g.rows.length} in the table`}
                >
                  <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${t.soft} ${t.text}`}>
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
                      <path d={g.icon} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold text-[var(--color-ink)]">{g.label}</span>
                    <span className="block truncate text-[11px] text-[var(--color-muted)]">{g.action}</span>
                  </span>
                  <span className="flex flex-col items-end leading-tight">
                    <span className="flex items-center gap-1 text-[12.5px] font-semibold tabular-nums text-[var(--color-ink)]">
                      {g.rows.length}
                    <svg viewBox="0 0 16 16" className="h-3 w-3 text-[var(--color-line-strong)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--color-primary)]" fill="none" aria-hidden>
                      <path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    </span>
                    <StakeLabel amount={atStake(g.rows)} currency={data.currency} className="text-[10.5px] font-medium text-[var(--color-muted)]" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---- top movers -----------------------------------------------------------------------

type MoverMetric = "views" | "sold";

function moversFor(data: AccountAnalytics, metric: MoverMetric) {
  // A change needs enough behind it to mean something.
  const minimum = metric === "views" ? 10 : 2;
  const withChange = data.listings
    .map((r) => ({ row: r, change: r.changes?.[metric] ?? null, now: r[metric] ?? 0 }))
    .filter((m) => m.change != null && Number.isFinite(m.change) && Math.max(m.now, m.now / (1 + m.change!)) >= minimum);
  const rising = withChange.filter((m) => m.change! > 0).sort((a, b) => b.change! - a.change!).slice(0, 3);
  const falling = withChange.filter((m) => m.change! < 0).sort((a, b) => a.change! - b.change!).slice(0, 3);
  return { rising, falling, any: withChange.length > 0 };
}

export function TopMoversCard({ data, onOpen }: { data: AccountAnalytics; onOpen: (id: string) => void }) {
  const byViews = useMemo(() => moversFor(data, "views"), [data]);
  const bySales = useMemo(() => moversFor(data, "sold"), [data]);
  // Until the person picks, whichever measure has comparisons to show.
  const [picked, setPicked] = useState<MoverMetric | null>(null);
  const metric: MoverMetric = picked ?? (byViews.any || !bySales.any ? "views" : "sold");
  const movers = metric === "views" ? byViews : bySales;
  const history = data.sync.history;
  const waiting = data.range.partial ? listingFiguresReady(data) : null;
  const row = (m: { row: ListingAnalyticsRow; change: number | null; now: number }) => {
    const up = (m.change ?? 0) > 0;
    const pct = Math.abs((m.change ?? 0) * 100);
    return (
      <li key={m.row.itemId}>
        <button type="button" onClick={() => onOpen(m.row.itemId)} className="group flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-paper)]">
          <Thumb src={m.row.imageUrl} size={28} />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{m.row.title}</span>
          <span className="text-[11px] tabular-nums text-[var(--color-muted)]">{compactNumber(m.now)}</span>
          <span className={`w-[52px] text-right text-[11.5px] font-semibold tabular-nums ${up ? "text-emerald-700" : "text-[var(--color-danger)]"}`}>
            {up ? "▲" : "▼"} {pct >= 1000 ? `${Math.round(pct / 100) / 10}k` : Math.round(pct)}%
          </span>
        </button>
      </li>
    );
  };
  return (
    <section className="card flex flex-col p-4">
      <CardHeader
        title="Top movers"
        aside={
          <SegmentedControl
            size="sm"
            label="Movers by"
            value={metric}
            onChange={setPicked}
            options={[
              { key: "views", label: "Views" },
              { key: "sold", label: "Sales" },
            ]}
          />
        }
      />
      {waiting ? (
        <Quiet>{waiting}</Quiet>
      ) : !movers.rising.length && !movers.falling.length ? (
        <Quiet>
          {metric === "views" && history && !history.complete
            ? `View changes appear once the previous period's listing figures are stored (${history.stored} of ${history.needed} days so far).`
            : "No big changes against the previous period."}
        </Quiet>
      ) : (
        <div className="mt-2.5 space-y-2">
          {[
            ["Rising", movers.rising],
            ["Falling", movers.falling],
          ].map(([label, list]) =>
            (list as typeof movers.rising).length ? (
              <div key={label as string}>
                <p className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{label as string}</p>
                <ul className="-mx-1.5">{(list as typeof movers.rising).map(row)}</ul>
              </div>
            ) : null
          )}
        </div>
      )}
    </section>
  );
}

// ---- worth a look ---------------------------------------------------------------------

// The listings where fixing pays most: problems ranked by the sales they'd
// make at the account's typical rates (not by views), and the best seller.
export function WorthALookCard({ data, onOpen }: { data: AccountAnalytics; onOpen: (id: string) => void }) {
  const problems = data.listings.filter(needsAttention).sort((a, b) => (b.health!.opportunity?.amount ?? 0) - (a.health!.opportunity?.amount ?? 0));
  const winners = data.listings.filter((l) => l.health?.stage === "converting").sort((a, b) => (b.sold ?? 0) - (a.sold ?? 0));
  const picks = [...problems.slice(0, 4), ...winners.slice(0, 1)];
  const total = atStake(problems);
  const waiting = listingFiguresReady(data);
  return (
    <section className="card flex flex-col p-4">
      <CardHeader
        title="Worth a look"
        aside={
          total >= 1 ? (
            <span className="text-[11px] text-[var(--color-muted)]" title="What these listings would sell over these days at your typical listing's rates">
              <StakeLabel amount={total} currency={data.currency} className="font-semibold text-[var(--color-ink)]" /> at stake
            </span>
          ) : null
        }
      />
      {waiting ? (
        <Quiet>{waiting}</Quiet>
      ) : picks.length === 0 ? (
        <Quiet>Nothing stands out: every listing with enough data is seen, clicked and bought at about your normal rates.</Quiet>
      ) : (
        <ul className="-mx-1.5 mt-2.5 space-y-0.5">
          {picks.map((l) => {
            const h = l.health!;
            const tag = STAGE_TAG[h.stage];
            const tone = TONE[tag?.tone ?? "neutral"];
            const reason = h.reasons?.find((r) => r.status === "fail") || h.reasons?.find((r) => r.status === "warn");
            return (
              <li key={l.itemId}>
                <button type="button" onClick={() => onOpen(l.itemId)} title={reason ? reason.text : h.detail} className="group flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-[var(--color-paper)]">
                  <span className="relative">
                    <Thumb src={l.imageUrl} size={34} />
                    <span className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--color-panel)] ${tone.dot}`} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{l.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
                      <span className={`whitespace-nowrap font-semibold ${tone.text}`}>{h.label}</span>
                      <span aria-hidden>·</span>
                      <span className="truncate tabular-nums">{h.problem ? h.detail : `${fullNumber(l.sold)} sold · ${percent(l.conversion)} of visits buy`}</span>
                    </span>
                  </span>
                  {h.problem && <StakeLabel amount={h.opportunity?.amount ?? 0} currency={data.currency} className="flex-shrink-0 text-[11.5px] font-semibold text-[var(--color-ink)]" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---- traffic sources ------------------------------------------------------------------

/** Where views came from, as a slim row under the chart. */
export function SourcesStrip({ sources }: { sources: AnalyticsSource[] }) {
  const total = sources.reduce((sum, s) => sum + (s.views || 0), 0);
  if (!total) return null;
  const sorted = [...sources].sort((a, b) => (b.views || 0) - (a.views || 0));
  const top = (sorted[0].views || 0) / total;
  return (
    <section aria-label="Where views came from" className="card flex flex-col gap-2.5 px-4 py-3 xl:flex-row xl:items-center xl:gap-6">
      <div className="flex flex-shrink-0 items-baseline gap-2 xl:w-44 xl:flex-col xl:items-start xl:gap-0.5">
        <p className="text-[12px] font-semibold text-[var(--color-ink)]">Where views came from</p>
        <p className="text-[11.5px] tabular-nums text-[var(--color-muted)]">{fullNumber(total)} views</p>
      </div>
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-2.5 min-[640px]:grid-cols-3 min-[900px]:grid-cols-5">
        {sorted.map((s) => {
          const share = (s.views || 0) / total;
          return (
            <div key={s.key} className="min-w-0" title={`${s.label}: ${fullNumber(s.views)} views`}>
              <p className="truncate text-[11.5px] text-[var(--color-muted)]">{s.label}</p>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-paper)]">
                  <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${Math.max(2, share * 100)}%`, opacity: 0.35 + (0.65 * share) / top }} />
                </div>
                <span className="w-10 text-right text-[12px] font-semibold tabular-nums text-[var(--color-ink)]">{percent(share)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
