"use client";

import { useMemo } from "react";
import { DiscoverExplore, DiscoverSubjectRef } from "@/lib/api";
import { count, money } from "@/components/research/format";
import { ago } from "@/components/hunting/HuntBits";
import { DiscoverListings } from "./DiscoverListings";
import { AccountDelivery, BAND, BudgetLine, perMonth, ScoreBadge, SectionTitle, StarIcon } from "./discover-ui";

// One category or keyword in Discover: how good it is to hunt in (the
// opportunity score, part by part, and the figures behind it), its
// subcategories ranked the same way, what's selling now, and the keywords
// of the titles that sell.

function Tile({ label, value, note, tone }: { label: string; value: React.ReactNode; note?: React.ReactNode; tone?: string }) {
  return (
    <div className="card min-w-0 px-3.5 py-3">
      <p className="text-[11.5px] font-medium text-[var(--color-muted)]">{label}</p>
      <p className={`mt-1 text-[19px] font-semibold leading-tight tabular-nums ${tone || "text-[var(--color-ink)]"}`}>{value}</p>
      {note && <p className="mt-1 text-[11.5px] leading-snug text-[var(--color-muted)]">{note}</p>}
    </div>
  );
}

function ScoreCard({ data }: { data: DiscoverExplore }) {
  const o = data.opportunity;
  const b = BAND[o.band];
  return (
    <section className="card min-w-0 px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11.5px] font-medium text-[var(--color-muted)]">Opportunity</p>
        <span className={`text-[12px] font-semibold ${b.ink}`}>{b.label}</span>
      </div>
      <p className="mt-0.5 flex items-baseline gap-1">
        <span className={`text-[30px] font-semibold leading-none tabular-nums ${b.ink}`}>{o.score}</span>
        <span className="text-[12px] text-[var(--color-muted)]">of 100</span>
      </p>
      <ul className="mt-3 space-y-2">
        {o.parts.map((p) => (
          <li key={p.key} title={p.detail}>
            <div className="flex items-baseline justify-between gap-2 text-[12px]">
              <span className="text-[var(--color-ink)]">{p.label}</span>
              <span className="tabular-nums text-[var(--color-muted)]">
                {p.points}/{p.max}
              </span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--color-paper)]">
              <div className={`h-full rounded-full ${b.bar}`} style={{ width: `${(p.points / p.max) * 100}%` }} />
            </div>
            <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
              {p.value} <span className="opacity-80">· full points at {p.full}</span>
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
  onHunt: (url: string) => void;
  onReadMore: () => void;
  readingMore: boolean;
  onRank: () => void;
  onToggleWatch: () => void;
  watchBusy: boolean;
}) {
  const { subject, figures: f, market } = data;
  const currency = market.currency;
  const risingIds = useMemo(() => new Set(data.rising.map((l) => l.itemId)), [data.rising]);
  const unranked = data.children.filter((c) => !c.scanned).length;
  const selling = data.listings.filter((l) => l.sold !== null);

  return (
    <div className="space-y-4">
      {/* Where we are, and the watch toggle. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <nav aria-label="Where you are" className="flex flex-wrap items-center gap-x-1 text-[12px] text-[var(--color-muted)]">
            <button type="button" onClick={onBack} className="font-medium hover:text-[var(--color-primary)]">
              Discover
            </button>
            {subject.kind === "keyword" ? (
              <>
                <span aria-hidden>›</span>
                <span>Keyword</span>
              </>
            ) : (
              subject.path.slice(0, -1).map((p) => (
                <span key={p.id} className="inline-flex items-center gap-x-1">
                  <span aria-hidden>›</span>
                  <button type="button" onClick={() => onOpen({ categoryId: p.id })} className="hover:text-[var(--color-primary)]">
                    {p.name}
                  </button>
                </span>
              ))
            )}
          </nav>
          <h2 className="mt-0.5 text-[17px] font-semibold text-[var(--color-ink)]">{subject.kind === "keyword" ? `“${subject.name}”` : subject.name}</h2>
          <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">
            {count(f.total)} live listing{f.total === 1 ? "" : "s"} on {market.name} · read {ago(subject.takenAt)}
            {subject.stale && " (today's searches are used up; this is the last reading)"}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleWatch}
          disabled={watchBusy}
          aria-pressed={Boolean(data.watch)}
          className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-semibold transition-colors disabled:opacity-60 ${
            data.watch ? "border-amber-300 bg-amber-50 text-amber-800" : "border-[var(--color-line)] text-[var(--color-ink)] hover:border-amber-300 hover:text-amber-800"
          }`}
          title={data.watch ? "Stop watching" : "Read it again every night, to see what sells lately"}
        >
          <StarIcon filled={Boolean(data.watch)} />
          {data.watch ? "Watching" : "Watch"}
        </button>
      </div>

      {/* The score, part by part, and the figures behind it. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <ScoreCard data={data} />
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:col-span-2">
          <Tile
            label="Demand"
            value={f.demand.medianPerMonth === null ? "—" : `${f.demand.medianPerMonth} a month`}
            note={
              f.demand.read
                ? `The middle of the ${f.demand.read} leading listings read; ${f.demand.selling} of them sell every month. The best sells ${perMonth(f.demand.topPerMonth)}.`
                : "Sold counts aren't read yet."
            }
          />
          <Tile
            label="Competition"
            value={`${count(f.total)} live`}
            note={
              f.competition.topSeller
                ? `${f.competition.sellers} sellers among the top ${f.sample}; the biggest, ${f.competition.topSeller.username}, has ${f.competition.topSeller.share}% of them.`
                : `${f.competition.sellers} sellers among the top ${f.sample}.`
            }
          />
          <Tile
            label="What buyers pay"
            value={f.price ? money(f.price.median, currency) : "—"}
            note={f.price ? `With postage; most between ${money(f.price.low, currency)} and ${money(f.price.high, currency)}.` : undefined}
          />
          <Tile
            label="Fits your delivery"
            value={f.fit ? `${f.fit.share}%` : "—"}
            tone={f.fit ? (f.fit.share >= 50 ? "text-emerald-700" : f.fit.share >= 25 ? "text-amber-700" : "text-rose-700") : undefined}
            note={
              f.fit ? (
                <>
                  {f.fit.canMatch} of {f.fit.sellers} selling listings deliver like you or slower{f.fit.overseas ? `; ${f.fit.overseas}% ship from abroad` : ""}.{" "}
                  <AccountDelivery account={data.account} />
                </>
              ) : (
                <AccountDelivery account={data.account} />
              )
            }
          />
        </div>
      </div>

      {data.recent && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800 ring-1 ring-inset ring-emerald-200">
          Lately: <span className="font-semibold tabular-nums">{count(data.recent.sold)} sold</span> in the last {data.recent.days} day{data.recent.days === 1 ? "" : "s"} across {data.recent.listings} of its leading listings, from Discover&apos;s daily readings.
        </p>
      )}

      {/* Subcategories, ranked once read. */}
      {data.children.length > 0 && (
        <section className="card overflow-hidden">
          <SectionTitle
            title="Subcategories"
            note="Ranked by opportunity once read: each one's leading listings and the sold counts of its top 5."
            right={
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
          <ul className="divide-y divide-[var(--color-line)] border-t border-[var(--color-line)]">
            {data.children.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => onOpen({ categoryId: c.id })} className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--color-paper)]/70">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-[var(--color-ink)]">{c.name}</span>
                    <span className="block text-[11.5px] text-[var(--color-muted)]">
                      {c.listings !== null ? `${count(c.listings)} live` : "Not read"}
                      {c.scanned && (
                        <>
                          {" · "}
                          {perMonth(c.scanned.medianPerMonth)} · {c.scanned.selling} of {c.scanned.read} sell
                          {c.scanned.price !== null && ` · ${money(c.scanned.price, currency)}`}
                          {c.scanned.fit !== null && ` · fits you ${c.scanned.fit}%`}
                        </>
                      )}
                    </span>
                  </span>
                  {c.scanned ? <ScoreBadge score={c.scanned.score} band={c.scanned.band} size="sm" /> : <span className="text-[11.5px] text-[var(--color-muted)]">Not ranked</span>}
                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 shrink-0 text-[var(--color-muted)]" aria-hidden>
                    <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* A keyword: the categories its listings sit in. */}
      {data.categories.length > 0 && (
        <section className="card px-4 py-3">
          <p className="text-[12px] font-medium text-[var(--color-muted)]">Listed in</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {data.categories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onOpen({ categoryId: c.id })}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[var(--color-panel)] px-2.5 text-[12px] font-medium text-[var(--color-ink)] ring-1 ring-inset ring-[var(--color-line)] hover:ring-[var(--color-primary)]"
              >
                {c.name}
                <span className="tabular-nums text-[var(--color-muted)]">{count(c.count)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* What's selling now. */}
        <section className="card min-w-0 overflow-hidden xl:col-span-2">
          <SectionTitle
            title="Selling now"
            note={`The leading listings, fastest-selling first: ${selling.length} read of ${data.listings.length}. Sales a month are over the time each has been live.`}
          />
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

        {/* The words of the titles that sell. */}
        <section className="card min-w-0 overflow-hidden">
          <SectionTitle title="Keywords that sell" note="Phrases in the titles that sell, by their share of the sales next to their share of the listings." />
          {data.keywords.length === 0 ? (
            <p className="border-t border-[var(--color-line)] px-4 py-6 text-center text-[12.5px] text-[var(--color-muted)]">
              {f.demand.read ? "No phrase stands out across the listings that sell." : "Keywords show once sold counts are read."}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-line)] border-t border-[var(--color-line)]">
              {data.keywords.map((k) => (
                <li key={k.term}>
                  <button type="button" onClick={() => onOpen({ q: k.term })} className="group flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-[var(--color-paper)]/70" title={`Explore “${k.term}”`}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{k.term}</span>
                      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-[var(--color-paper)]">
                        <span className="block h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${Math.min(100, k.salesShare)}%` }} />
                      </span>
                      <span className="mt-0.5 block text-[11px] tabular-nums text-[var(--color-muted)]">
                        {k.salesShare}% of sales · in {k.listingShare}% of listings
                      </span>
                    </span>
                    {k.lift !== null && k.lift >= 1.3 && (
                      <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 text-[11px] font-semibold tabular-nums text-emerald-700 ring-1 ring-inset ring-emerald-200" title="Its share of the sales over its share of the listings">
                        {k.lift}×
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data.brands.length > 0 && (
            <p className="border-t border-[var(--color-line)] px-4 py-2.5 text-[11.5px] text-[var(--color-muted)]">
              Brands:{" "}
              {data.brands
                .slice(0, 5)
                .map((b) => `${b.name} ${count(b.count)}`)
                .join(" · ")}
            </p>
          )}
        </section>
      </div>

      <BudgetLine budget={data.budget} />
    </div>
  );
}
