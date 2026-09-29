"use client";

import { useState } from "react";
import Link from "next/link";
import { ListingTrendKey, ListingTrendPoint, ListingWork, OverviewAccount, RecentListing } from "@/lib/api";
import { TrendChart } from "@/components/charts/TrendChart";
import { ViewMenu } from "@/components/ViewMenu";
import { InlineLegend, trendTerms } from "./OverviewSales";

// Under the Overview's Listings cards, as the Sales tab has its chart and
// best sellers: the listing pipeline day by day (one measure at a time,
// the stretch before alongside) and the newest listings put live from
// Liston, each with what it has sold in the dates.

const CHART_HEIGHT = 164;
const MEASURES: { key: ListingTrendKey; label: string }[] = [
  { key: "published", label: "Listings published" },
  { key: "drafted", label: "Listings drafted" },
  { key: "hunted", label: "Products hunted" },
  { key: "approved", label: "Products approved" },
  { key: "rejected", label: "Products rejected" },
];
const count = (n: number) => n.toLocaleString("en-GB");

export function ListingTrendCard({ points, caption }: { points: ListingTrendPoint[] | null; caption: string }) {
  const [measure, setMeasure] = useState<ListingTrendKey>("published");
  const chosen = MEASURES.find((m) => m.key === measure) || MEASURES[0];
  const list = points ?? [];
  const terms = trendTerms(list);
  // Hours still to come count on neither side: today so far against yesterday up to the same hour.
  const reached = list.filter((p) => !p.future);
  const total = reached.reduce((n, p) => n + p.values[measure], 0);
  const previous = reached.reduce((n, p) => n + (p.previous?.[measure] ?? 0), 0);
  const change = previous ? (total - previous) / previous : null;
  return (
    <section className="card flex h-full min-w-0 flex-col px-4 pb-3 pt-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">
            {chosen.label} by {terms.per}
          </h2>
          <div className="mt-1">
            <InlineLegend current={caption} previous={list.length > 0} today={list.some((p) => p.partial)} previousLabel={terms.previousLabel} todayLabel={terms.todayLabel} />
          </div>
        </div>
        <div className="flex items-start gap-3">
          {list.length > 0 && (
            <p className="text-right text-[12.5px] text-[var(--color-muted)]">
              <b className="text-[15px] font-semibold tabular-nums text-[var(--color-ink)]">{count(total)}</b>
              {change !== null ? (
                <span className={`mt-0.5 block text-[12px] font-medium tabular-nums ${change >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {change >= 0 ? "▲" : "▼"} {Math.abs(Math.round(change * 100))}% {terms.versus}
                </span>
              ) : (
                <span className="mt-0.5 block text-[11.5px]">
                  {count(previous)} {terms.hourly ? "yesterday" : "before"}
                </span>
              )}
            </p>
          )}
          <ViewMenu title="Measure" sections={[{ label: "Show", value: measure, options: MEASURES.map((m) => ({ key: m.key, label: m.label })), onChange: (k) => setMeasure(k as ListingTrendKey) }]} />
        </div>
      </div>
      <div className="mt-2 min-w-0">
        {!points || list.length === 0 ? (
          <p className="flex items-center justify-center text-center text-[13px] text-[var(--color-muted)]" style={{ height: CHART_HEIGHT }}>
            Nothing to chart yet.
          </p>
        ) : (
          <TrendChart
            points={list.map((p) => ({ day: p.day, value: p.future ? null : p.values[measure], previous: p.previous ? p.previous[measure] : null, previousDay: p.previousDay, partial: p.partial }))}
            height={CHART_HEIGHT}
            legend={false}
            label={`${chosen.label} per ${terms.per}, ${caption.toLowerCase()}`}
            format={(v) => (v == null ? "—" : count(v))}
            // Counts: whole numbers only on the side.
            axisFormat={(v) => (Number.isInteger(v) ? count(v) : "")}
            currentLabel={caption}
            previousLabel={terms.previousLabel}
          />
        )}
      </div>
    </section>
  );
}

/** Several markets' trends added up day by day (they share the same days). */
export function addListingTrends(trends: (ListingTrendPoint[] | null | undefined)[]): ListingTrendPoint[] | null {
  const list = trends.filter((t): t is ListingTrendPoint[] => Array.isArray(t) && t.length > 0);
  if (!list.length) return null;
  const keys = MEASURES.map((m) => m.key);
  return list[0].map((point, i) => ({
    ...point,
    values: Object.fromEntries(keys.map((k) => [k, list.reduce((n, t) => n + (t[i]?.values[k] || 0), 0)])) as Record<ListingTrendKey, number>,
    previous: Object.fromEntries(keys.map((k) => [k, list.reduce((n, t) => n + (t[i]?.previous?.[k] || 0), 0)])) as Record<ListingTrendKey, number>,
  }));
}

// On the account's eBay site's clock, as the chart beside it counts hours and days.
function when(iso: string, timeZone?: string | null) {
  const d = new Date(iso);
  const tz = timeZone ? { timeZone } : {};
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...tz });
  if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "short", ...tz });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...tz });
}

export function RecentListingsCard({
  items,
  showMarket,
  flagOf,
  empty = "Nothing published from Liston in these dates yet.",
}: {
  items: RecentListing[] | null;
  showMarket: boolean;
  flagOf: (marketplaceId: string) => string;
  // Said when there's nothing: "today" when the chart beside it shows the last 7 days.
  empty?: string;
}) {
  const shown = (items ?? []).slice(0, 5);
  return (
    <section className="card flex h-full min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-2 px-4 pt-3.5">
        <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Recently published</h2>
        <span className="text-[11.5px] text-[var(--color-muted)]">From Liston, with sales since</span>
      </div>
      {shown.length === 0 ? (
        <p className="flex flex-1 items-center justify-center px-4 py-8 text-center text-[13px] text-[var(--color-muted)]">{empty}</p>
      ) : (
        <ol className="mt-1.5 divide-y divide-[var(--color-line)]">
          {shown.map((item) => {
            const row = (
              <>
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.image} alt="" loading="lazy" className="h-7 w-7 shrink-0 rounded-md border border-[var(--color-line)] bg-white object-contain" />
                ) : (
                  <span className="h-7 w-7 shrink-0 rounded-md border border-dashed border-[var(--color-line)] bg-[var(--color-paper)]" />
                )}
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[12.5px] font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{item.title ?? (item.itemId ? `Item ${item.itemId}` : "Listing")}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--color-muted)]">
                    {showMarket && `${flagOf(item.marketplaceId)} `}
                    {item.account} · {when(item.publishedAt, item.timeZone)}
                  </span>
                </span>
                <span className="shrink-0 text-right leading-tight">
                  <span className={`block text-[12.5px] font-semibold tabular-nums ${item.units ? "text-emerald-600" : "text-[var(--color-muted)]"}`}>{item.units ? `${count(item.units)} sold` : "No sales yet"}</span>
                </span>
              </>
            );
            return (
              <li key={item.id}>
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer" className="group flex items-center gap-2.5 px-4 py-[5px] transition-colors hover:bg-[var(--color-paper)]/70" title={item.title ?? undefined}>
                    {row}
                  </a>
                ) : (
                  <div className="flex items-center gap-2.5 px-4 py-[5px]">{row}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// The Overview's accounts side by side: what each has live and waiting right
// now, and its listing work in the dates, busiest first, each opening its own
// Overview. Live listings show each account's share of the total.
const NOW_COLUMNS: { key: keyof ListingWork; label: string; hint: string }[] = [
  { key: "live", label: "Live", hint: "Live on eBay now" },
  { key: "waiting", label: "To publish", hint: "Drafts waiting to publish" },
  { key: "reviewing", label: "For review", hint: "Hunted products waiting for review" },
];
const DATE_COLUMNS: { key: keyof ListingWork; label: string; hint: string }[] = [
  { key: "hunted", label: "Hunted", hint: "Products hunted" },
  { key: "approved", label: "Approved", hint: "Hunted products approved" },
  { key: "rejected", label: "Rejected", hint: "Hunted products rejected" },
  { key: "drafted", label: "Drafted", hint: "Drafts created in Liston" },
  { key: "published", label: "Published", hint: "Went live from Liston" },
];
const figureOf = (w: ListingWork | null, key: keyof ListingWork) => (w ? Number(w[key] ?? 0) : 0);
// The line between what stands now and the chosen dates.
const GROUP_EDGE = "border-l border-[var(--color-line)]";
// Every figure column: its heading and its figures centred on the same line, rows centred top to bottom.
const COLUMN = "whitespace-nowrap px-2 text-center align-middle";

/** What needs someone on an account right now, for its row: failed drafts, then Liston's rejections in the dates. */
function flagsOf(w: ListingWork | null): string[] {
  if (!w) return [];
  const out: string[] = [];
  if (w.draftFailed) out.push(`${count(w.draftFailed)} draft${w.draftFailed === 1 ? "" : "s"} failed`);
  if (w.rejectedByListon) out.push(`${count(w.rejectedByListon)} supplier${w.rejectedByListon === 1 ? "" : "s"} didn't match`);
  return out;
}

export function AccountListingsCard({ accounts, datesLabel, showMarket }: { accounts: OverviewAccount[]; datesLabel: string; showMarket: boolean }) {
  const rows = [...accounts].sort((a, b) => figureOf(b.listings, "live") - figureOf(a.listings, "live") || a.label.localeCompare(b.label));
  const totalLive = rows.reduce((sum, a) => sum + figureOf(a.listings, "live"), 0);
  const total = (key: keyof ListingWork) => rows.reduce((sum, a) => sum + figureOf(a.listings, key), 0);
  const share = (a: OverviewAccount) => (totalLive > 0 ? figureOf(a.listings, "live") / totalLive : 0);
  const name = (a: OverviewAccount) => (
    <>
      {showMarket && a.marketplace?.flag ? <span className="mr-1">{a.marketplace.flag}</span> : null}
      {a.label}
      {showMarket && a.marketplace?.label ? <span className="font-normal text-[var(--color-muted)]"> · {a.marketplace.label}</span> : null}
    </>
  );
  const cell = (a: OverviewAccount, key: keyof ListingWork) => {
    const v = figureOf(a.listings, key);
    return <span className={v ? "text-[var(--color-ink)]" : "text-[var(--color-line-strong)]"}>{a.listings ? count(v) : "—"}</span>;
  };
  return (
    <section className="card mt-4 min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3.5">
        <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">By account</h2>
        <span className="text-[11.5px] text-[var(--color-muted)]">Open an account for its own Overview</span>
      </div>

      {/* Phones: one block per account. */}
      <ul className="mt-2 divide-y divide-[var(--color-line)] sm:hidden">
        {rows.map((a) => (
          <li key={a.id}>
            <Link href={`/accounts/${a.id}`} className="block px-4 py-2.5">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] font-medium text-[var(--color-ink)]">{name(a)}</span>
                <span className="shrink-0 text-[12.5px] tabular-nums text-[var(--color-muted)]">
                  <b className="font-semibold text-[var(--color-ink)]">{a.listings ? count(figureOf(a.listings, "live")) : "—"}</b> live
                </span>
              </span>
              <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-[var(--color-line)]">
                <span className="block h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${Math.round(share(a) * 100)}%` }} />
              </span>
              <span className="mt-1.5 block text-[11.5px] tabular-nums text-[var(--color-muted)]">
                {a.listings
                  ? `${NOW_COLUMNS.slice(1)
                      .map((c) => `${count(figureOf(a.listings, c.key))} ${c.label.toLowerCase()}`)
                      .join(" · ")} · ${datesLabel}: ${DATE_COLUMNS.map((c) => `${count(figureOf(a.listings, c.key))} ${c.label.toLowerCase()}`).join(" · ")}`
                  : "Couldn't be read from eBay just now"}
              </span>
              {flagsOf(a.listings).length > 0 && <span className="mt-1 block text-[11.5px] font-medium text-amber-600">{flagsOf(a.listings).join(" · ")}</span>}
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-3 hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[700px] table-fixed border-collapse text-[12.5px]">
          <colgroup>
            <col className="w-[23%]" />
            {[...NOW_COLUMNS, ...DATE_COLUMNS].map((c) => (
              <col key={c.key} />
            ))}
          </colgroup>
          <thead>
            {/* Which figures stand now and which are the chosen dates: each title centred over its own columns. */}
            <tr className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--color-muted)]">
              <td className="px-4" aria-hidden />
              <th scope="colgroup" colSpan={NOW_COLUMNS.length} className="px-0 pb-2 text-center align-bottom font-semibold">
                <span className="mx-3 block border-b border-[var(--color-line)] pb-1.5">Right now</span>
              </th>
              <th scope="colgroup" colSpan={DATE_COLUMNS.length} className={`${GROUP_EDGE} px-0 pb-2 text-center align-bottom font-semibold`}>
                <span className="mx-3 block border-b border-[var(--color-line)] pb-1.5">{datesLabel}</span>
              </th>
            </tr>
            <tr className="border-b border-[var(--color-line)] text-[11.5px] text-[var(--color-muted)]">
              <th scope="col" className="px-4 pb-2 text-left font-medium">
                Account
              </th>
              {[...NOW_COLUMNS, ...DATE_COLUMNS].map((c) => (
                <th key={c.key} scope="col" className={`${COLUMN} pb-2 font-medium ${c.key === DATE_COLUMNS[0].key ? GROUP_EDGE : ""}`} title={c.hint}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((a) => {
              const flags = flagsOf(a.listings);
              const pct = Math.round(share(a) * 100);
              return (
                <tr key={a.id} className="group border-b border-[var(--color-line)]/70 transition-colors last:border-0 hover:bg-[var(--color-primary-soft)]/40">
                  <td className="px-4 py-3 align-middle">
                    <Link href={`/accounts/${a.id}`} className="block truncate font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]" title={`Open ${a.label}'s Overview`}>
                      {name(a)}
                    </Link>
                    {/* Its share of everything live, as a bar. */}
                    <span className="mt-1.5 block h-1 w-full max-w-[160px] overflow-hidden rounded-full bg-[var(--color-line)]" aria-hidden>
                      <span className="block h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${pct}%` }} />
                    </span>
                    {!a.listings ? (
                      <span className="mt-1 block text-[11px] text-[var(--color-muted)]">Couldn&apos;t be read from eBay just now</span>
                    ) : (
                      flags.length > 0 && <span className="mt-1 block truncate text-[11px] font-medium text-amber-600">{flags.join(" · ")}</span>
                    )}
                  </td>
                  <td className={`${COLUMN} py-3`}>
                    <span className="block font-semibold text-[var(--color-ink)]">{a.listings ? count(figureOf(a.listings, "live")) : "—"}</span>
                    {a.listings && totalLive > 0 && <span className="mt-0.5 block text-[11px] text-[var(--color-muted)]">{pct}% of live</span>}
                  </td>
                  {[...NOW_COLUMNS.slice(1), ...DATE_COLUMNS].map((c) => (
                    <td key={c.key} className={`${COLUMN} py-3 ${c.key === DATE_COLUMNS[0].key ? GROUP_EDGE : ""}`}>
                      {cell(a, c.key)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          {rows.length > 1 && (
            <tfoot className="tabular-nums">
              <tr className="border-t border-[var(--color-line)] bg-[var(--color-paper)]/60 font-semibold text-[var(--color-ink)]">
                <td className="px-4 py-2.5 align-middle">All {rows.length} accounts</td>
                {[...NOW_COLUMNS, ...DATE_COLUMNS].map((c) => (
                  <td key={c.key} className={`${COLUMN} py-2.5 ${c.key === DATE_COLUMNS[0].key ? GROUP_EDGE : ""}`}>
                    {count(total(c.key))}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}
