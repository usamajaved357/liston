"use client";

import { useMemo } from "react";
import { DiscoverExplore, DiscoverSubjectRef, DiscoverYourTraffic } from "@/lib/api";
import { KpiTile } from "@/components/charts/KpiTile";
import { TrendChart } from "@/components/charts/TrendChart";
import { BarList } from "@/components/charts/BarList";
import { ColumnChart } from "@/components/charts/ColumnChart";
import { count, flag, money } from "@/components/research/format";
import { ago } from "@/components/hunting/HuntBits";
import { DiscoverListings } from "./DiscoverListings";
import { AccountDelivery, BAND, BudgetLine, CardHeader, Chevron, perMonth, Quiet, ScoreBadge, StarIcon } from "./discover-ui";

// One category or keyword in Discover, laid out like the Analytics page:
// the headline figures as tiles, your own traffic on a keyword, charts of
// where the sales are (day by day, by price, across the leading listings,
// by seller and delivery), how the opportunity score is made up, the
// subcategories ranked, what's selling now and the keywords that sell.

const intAxis = (v: number) => (Number.isInteger(v) ? count(v) : "");

function YourTraffic({ data }: { data: DiscoverYourTraffic }) {
  if (!data.listings) {
    return (
      <section className="card flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        <p className="min-w-0 flex-1 text-[12.5px] text-[var(--color-muted)]">
          <span className="font-semibold text-[var(--color-ink)]">None of your listings has this keyword yet.</span> If the figures above look good, it&apos;s a gap you could fill.
        </p>
      </section>
    );
  }
  const figures: { label: string; value: string; tone?: string }[] = [
    { label: "Your listings", value: count(data.listings) },
    { label: "Impressions", value: data.measured ? count(data.impressions || 0) : "—" },
    { label: "Clicks", value: data.measured ? count(data.views || 0) : "—" },
    { label: "Click rate", value: data.ctr === null || data.ctr === undefined ? "—" : `${data.ctr}%` },
    { label: "Sold", value: count(data.sold || 0), tone: data.sold ? "text-emerald-700" : undefined },
    { label: "Conversion", value: data.conversion === null || data.conversion === undefined ? "—" : `${data.conversion}%` },
  ];
  return (
    <section aria-label="Your listings with this keyword" className="card flex flex-col gap-3 px-4 py-3 xl:flex-row xl:items-center xl:gap-6">
      <div className="flex-shrink-0 xl:w-48">
        <p className="text-[12px] font-semibold text-[var(--color-ink)]">Your traffic on this keyword</p>
        <p className="text-[11.5px] text-[var(--color-muted)]">
          Your listings with it, last 30 days{data.measured !== undefined && data.measured < data.listings ? ` · traffic from ${data.measured} measured` : ""}
        </p>
      </div>
      <div className="grid min-w-0 flex-1 grid-cols-3 gap-x-4 gap-y-2.5 min-[900px]:grid-cols-6">
        {figures.map((f) => (
          <div key={f.label} className="min-w-0">
            <p className="truncate text-[11.5px] text-[var(--color-muted)]">{f.label}</p>
            <p className={`text-[15px] font-semibold tabular-nums ${f.tone || "text-[var(--color-ink)]"}`}>{f.value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ScoreCard({ data }: { data: DiscoverExplore }) {
  const o = data.opportunity;
  const b = BAND[o.band];
  return (
    <section className="card flex flex-col p-4">
      <CardHeader title="How the score is made" aside={<ScoreBadge score={o.score} band={o.band} size="sm" />} />
      <ul className="mt-3 space-y-2.5">
        {o.parts.map((p) => (
          <li key={p.key} title={p.detail}>
            <div className="flex items-baseline justify-between gap-2 text-[12px]">
              <span className="font-medium text-[var(--color-ink)]">{p.label}</span>
              <span className="tabular-nums text-[var(--color-muted)]">
                {p.points} / {p.max}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-paper)]">
              <div className={`h-full rounded-full ${b.bar}`} style={{ width: `${(p.points / p.max) * 100}%` }} />
            </div>
            <p className="mt-0.5 truncate text-[11px] text-[var(--color-muted)]">
              {p.value} · full at {p.full}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DiscoverSubjectView({
  data,
  onOpen,
  onBack,
  backLabel,
  onHunt,
  onReadMore,
  readingMore,
  onRank,
  onToggleWatch,
  watchBusy,
}: {
  data: DiscoverExplore;
  onOpen: (subject: DiscoverSubjectRef) => void;
  onBack: () => void;
  backLabel: string;
  onHunt: (url: string) => void;
  onReadMore: () => void;
  readingMore: boolean;
  onRank: () => void;
  onToggleWatch: () => void;
  watchBusy: boolean;
}) {
  const { subject, figures: f, market, charts } = data;
  const currency = market.currency;
  const risingIds = useMemo(() => new Set(data.rising.map((l) => l.itemId)), [data.rising]);
  const unranked = data.children.filter((c) => !c.scanned).length;
  const read = f.demand.read;
  const priceItems = charts.priceBands.map((b) => ({
    key: String(b.from),
    label: `${b.to === null ? `${money(b.from, currency)} and up` : `${money(b.from, currency)}–${money(b.to, currency)}`} · ${b.listings} listing${b.listings === 1 ? "" : "s"}`,
    axis: b.to === null ? `${money(b.from, currency, 0)}+` : money(b.from, currency, 0),
    value: b.perMonth,
  }));

  return (
    <div className="space-y-5">
      {/* Back, where we are, and the watch toggle. */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--color-muted)]">
          <button type="button" onClick={onBack} className="inline-flex h-7 items-center gap-1 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] pl-1.5 pr-2.5 font-medium text-[var(--color-ink)] hover:border-[var(--color-line-strong)]">
            <Chevron className="h-3.5 w-3.5 rotate-180" />
            {backLabel}
          </button>
          {subject.kind === "category" && subject.path.length > 1 && (
            <nav aria-label="Category path" className="flex min-w-0 flex-wrap items-center gap-x-1">
              {subject.path.slice(0, -1).map((p, i) => (
                <span key={p.id} className="inline-flex items-center gap-x-1">
                  {i > 0 && <span aria-hidden>›</span>}
                  <button type="button" onClick={() => onOpen({ categoryId: p.id })} className="hover:text-[var(--color-primary)] hover:underline">
                    {p.name}
                  </button>
                </span>
              ))}
            </nav>
          )}
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{subject.kind === "keyword" ? "Keyword" : "Category"}</p>
            <h2 className="text-[19px] font-semibold leading-tight text-[var(--color-ink)]">{subject.kind === "keyword" ? `“${subject.name}”` : subject.name}</h2>
            <p className="mt-1 text-[12px] text-[var(--color-muted)]">
              {market.name} · read {ago(subject.takenAt)}
              {subject.stale && " (today's searches are used up; this is the last reading)"} · <AccountDelivery account={data.account} />
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleWatch}
            disabled={watchBusy}
            aria-pressed={Boolean(data.watch)}
            className={`btn btn-sm !h-8 gap-1.5 !text-[12.5px] disabled:opacity-60 ${data.watch ? "border border-amber-300 bg-amber-50 text-amber-800" : "btn-secondary"}`}
            title={data.watch ? "Stop watching" : "Read it again every night, to chart its sales day by day"}
          >
            <StarIcon filled={Boolean(data.watch)} />
            {data.watch ? "Watching" : "Watch"}
          </button>
        </div>
      </div>

      {/* The headline figures. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiTile label={`Opportunity · ${BAND[data.opportunity.band].label}`} value={`${data.opportunity.score} / 100`} info="Demand, how many listings sell, competition, whether you can match the sellers' delivery, and price room. See how it's made below." />
        <KpiTile
          label="Monthly sales"
          value={read ? count(Math.round(f.demand.monthlySales)) : "—"}
          info={`What the ${read} leading listings sell between them a month: each one's eBay sold count over the time it has been live. eBay doesn't share buyers' search volume with apps, so demand is measured from the sales themselves.`}
        />
        <KpiTile label="Live listings" value={count(f.total)} info={`Every listing on ${market.name} for it right now: the competition. ${f.competition.sellers} sellers among the top ${f.sample}.`} />
        <KpiTile
          label="Sell-through"
          value={f.demand.sellThrough === null ? "—" : `${f.demand.sellThrough}%`}
          info={`Of the ${read} leading listings read, how many sell at least one a month. The middle one sells ${perMonth(f.demand.medianPerMonth)}; the best ${perMonth(f.demand.topPerMonth)}.`}
        />
        <KpiTile label="Typical price" value={f.price ? money(f.price.median, currency) : "—"} info={f.price ? `What buyers pay with postage; most listings between ${money(f.price.low, currency)} and ${money(f.price.high, currency)}.` : undefined} />
      </div>

      {subject.kind === "keyword" && data.yourTraffic && <YourTraffic data={data.yourTraffic} />}

      {/* Where the sales are. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <section className="card flex flex-col p-4">
          <CardHeader title="Sales by day" note={data.trend ? "The leading listings' sales, from Discover's daily readings" : undefined} />
          {data.trend ? (
            <div className="mt-2">
              <TrendChart
                points={data.trend.map((t) => ({ day: t.day, value: t.value, previous: null }))}
                format={(v) => (v === null ? "—" : `${count(Math.round(v))} sold`)}
                axisFormat={intAxis}
                label="Sales by day"
                currentLabel="Sold"
                showPrevious={false}
                legend={false}
                height={170}
              />
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center py-6 text-center">
              <p className="max-w-[260px] text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                The day-by-day chart builds from Discover&apos;s daily readings of these listings. Watch it and Liston reads it every night.
              </p>
              {!data.watch && (
                <button type="button" onClick={onToggleWatch} disabled={watchBusy} className="btn btn-secondary btn-sm mt-3 !h-8 gap-1.5 !text-[12.5px]">
                  <StarIcon />
                  Watch
                </button>
              )}
            </div>
          )}
        </section>

        <section className="card flex flex-col p-4">
          <CardHeader title="Sales by price" note="Sales a month at each price, postage included" />
          <div className="mt-3">{read && priceItems.length ? <ColumnChart items={priceItems} format={(v) => `${count(Math.round(v))}/mo`} label="Sales by price band" /> : <Quiet>Shows once sold counts are read.</Quiet>}</div>
        </section>

        <section className="card flex flex-col p-4">
          <CardHeader title="Sales across the leading listings" note={read ? `From the best seller down: ${charts.demandCurve.length} listings read` : undefined} />
          <div className="mt-3">
            {charts.demandCurve.length ? (
              <ColumnChart items={charts.demandCurve.map((d) => ({ key: d.itemId, label: d.title, value: d.perMonth }))} format={(v) => `${count(Math.round(v))}/mo`} label="Sales a month of each leading listing" />
            ) : (
              <Quiet>Shows once sold counts are read.</Quiet>
            )}
          </div>
        </section>

        <ScoreCard data={data} />

        <section className="card flex flex-col p-4">
          <CardHeader title="Who's selling" note="The sellers of the leading listings, by sales a month" />
          <div className="mt-3">
            <BarList items={charts.sellers.map((s) => ({ key: s.key, label: `${s.key}${s.listings > 1 ? ` · ${s.listings} listings` : ""}`, value: s.perMonth }))} format={(v) => `${count(Math.round(v))}/mo`} empty="Shows once sold counts are read." />
          </div>
        </section>

        <section className="card flex flex-col p-4">
          <CardHeader title="Delivery and where it ships from" note="Sales a month by delivery next to yours, then by country" />
          <div className="mt-3 space-y-4">
            <BarList items={charts.delivery.map((d) => ({ key: d.key, label: `${d.label} · ${d.listings}`, value: d.perMonth }))} format={(v) => `${count(Math.round(v))}/mo`} empty="Shows once sold counts are read." />
            {charts.countries.length > 0 && (
              <p className="flex flex-wrap gap-x-3 gap-y-1 border-t border-[var(--color-line)] pt-3 text-[11.5px] text-[var(--color-muted)]">
                {charts.countries.map((c) => (
                  <span key={c.key} className="tabular-nums">
                    {flag(c.key)} {c.key} <span className="font-semibold text-[var(--color-ink)]">{count(Math.round(c.perMonth))}/mo</span> · {c.listings}
                  </span>
                ))}
              </p>
            )}
          </div>
        </section>
      </div>

      {/* Subcategories, ranked once read. */}
      {data.children.length > 0 && (
        <section className="card overflow-hidden">
          <div className="p-4 pb-3">
            <CardHeader
              title="Subcategories"
              note="Ranked by opportunity once read: each one's leading listings and the sold counts of its top 5."
              aside={
                data.ranking ? (
                  <span className="text-[12px] font-medium text-[var(--color-primary)]">
                    Reading {data.ranking.done} of {data.ranking.total}…
                  </span>
                ) : unranked > 0 ? (
                  <button type="button" onClick={onRank} className="btn btn-secondary btn-sm !h-8 !text-[12.5px]">
                    Rank {unranked > 12 ? "the busiest 12" : unranked === data.children.length ? "them" : `the other ${unranked}`}
                  </button>
                ) : undefined
              }
            />
          </div>
          <div className="overflow-x-auto border-t border-[var(--color-line)]">
            <table className="w-full min-w-[680px] table-fixed text-[12.5px]">
              <thead className="bg-[var(--color-paper)] text-left text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                <tr>
                  <th className="w-[30%] px-4 py-2">Subcategory</th>
                  <th className="px-3 py-2">Opportunity</th>
                  <th className="px-3 py-2 text-right">Sales a month</th>
                  <th className="px-3 py-2 text-right">Sell-through</th>
                  <th className="px-3 py-2 text-right">Live</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-4 py-2 text-right">Fits you</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {data.children.map((c) => (
                  <tr key={c.id} onClick={() => onOpen({ categoryId: c.id })} className="cursor-pointer hover:bg-[var(--color-paper)]/60">
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1.5 font-medium text-[var(--color-ink)]">
                        <span className="truncate">{c.name}</span>
                        <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-line-strong)]" />
                      </span>
                    </td>
                    <td className="px-3 py-2.5">{c.scanned ? <ScoreBadge score={c.scanned.score} band={c.scanned.band} size="sm" /> : <span className="text-[11.5px] text-[var(--color-muted)]">Not ranked</span>}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.scanned ? perMonth(c.scanned.medianPerMonth) : "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.scanned ? `${c.scanned.selling} of ${c.scanned.read}` : "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.listings !== null ? count(c.listings) : "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.scanned?.price !== null && c.scanned?.price !== undefined ? money(c.scanned.price, currency) : "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{c.scanned?.fit !== null && c.scanned?.fit !== undefined ? `${c.scanned.fit}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="card min-w-0 overflow-hidden xl:col-span-2">
          <div className="p-4 pb-3">
            <CardHeader title="Keywords that sell" note="Phrases in the titles that sell. Open one to see its own figures." />
          </div>
          {data.keywords.length === 0 ? (
            <div className="border-t border-[var(--color-line)] px-4">
              <Quiet>{read ? "No phrase stands out across the listings that sell." : "Keywords show once sold counts are read."}</Quiet>
            </div>
          ) : (
            <table className="w-full table-fixed border-t border-[var(--color-line)] text-[12.5px]">
              <thead className="bg-[var(--color-paper)] text-left text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                <tr>
                  <th className="w-[46%] px-4 py-2">Keyword</th>
                  <th className="px-2 py-2 text-right" title="Sales a month of the leading listings with it">
                    Sales/mo
                  </th>
                  <th className="px-4 py-2 text-right" title="Its share of the sales, next to its share of the listings">
                    Share
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {data.keywords.map((k) => (
                  <tr key={k.term} onClick={() => onOpen({ q: k.term })} className="group cursor-pointer hover:bg-[var(--color-paper)]/60" title={`Open “${k.term}”`}>
                    <td className="px-4 py-2">
                      <span className="block truncate font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{k.term}</span>
                      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-[var(--color-paper)]">
                        <span className="block h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${Math.min(100, k.salesShare)}%` }} />
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums text-[var(--color-ink)]">{count(Math.round(k.perMonth))}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      <span className="text-[var(--color-ink)]">{k.salesShare}%</span>
                      <span className="block text-[10.5px] text-[var(--color-muted)]">
                        of {k.listingShare}% listings{k.lift !== null && k.lift >= 1.3 ? ` · ${k.lift}×` : ""}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="card flex min-w-0 flex-col p-4">
          {data.categories.length > 0 && (
            <>
              <CardHeader title="Listed in" note="The eBay categories its listings sit in: open one to see it as a whole." />
              <ul className="-mx-2 mt-2">
                {data.categories.slice(0, 6).map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => onOpen({ categoryId: c.id })} className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--color-paper)]">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{c.name}</span>
                      <span className="text-[11.5px] tabular-nums text-[var(--color-muted)]">{count(c.count)}</span>
                      <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-line-strong)]" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className={data.categories.length > 0 ? "mt-4 border-t border-[var(--color-line)] pt-4" : ""}>
            <CardHeader title="Brands" note="How the live listings split by brand: unbranded means room for a generic product." />
            <div className="mt-3">
              <BarList items={data.brands.slice(0, 6).map((b) => ({ key: b.name, label: b.unbranded ? `${b.name} (no brand)` : b.name, value: b.count }))} format={(v) => count(v)} empty="eBay gave no brand split." />
            </div>
          </div>
        </section>
      </div>

        <section className="card min-w-0 overflow-hidden">
          <div className="p-4 pb-3">
            <CardHeader title="Selling now" note={`The leading listings, fastest-selling first: ${read} read of ${data.listings.length}. Sales a month are over the time each has been live.`} />
          </div>
          <div className="border-t border-[var(--color-line)]">
            <DiscoverListings listings={data.listings} currency={currency} risingIds={risingIds} onHunt={onHunt} />
          </div>
          {(data.reads.more || data.reads.stopped) && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-line)] px-4 py-2.5">
              <p className="text-[11.5px] text-[var(--color-muted)]">
                {data.reads.signInFailed
                  ? "Sold counts need this account's eBay sign-in, which didn't work: reconnect the account, or ask the owner to."
                  : data.reads.stopped
                    ? "Today's sold-count reads ran out before every listing was read."
                    : `Sold counts read for the top ${data.reads.asked}.`}
              </p>
              {data.reads.more && !data.reads.stopped && (
                <button type="button" onClick={onReadMore} disabled={readingMore} className="btn btn-secondary btn-sm !h-8 !text-[12.5px]">
                  {readingMore ? "Reading…" : "Read 25 more"}
                </button>
              )}
            </div>
          )}
        </section>


      <BudgetLine budget={data.budget} />
    </div>
  );
}
