"use client";

import { useMemo, useState } from "react";
import {
  DiscoverExplore,
  DiscoverSubjectRef,
  DiscoverWinnersFilters,
  DiscoverYourTraffic,
} from "@/lib/api";
import { TrendChart } from "@/components/charts/TrendChart";
import { ShareBar, ShareTone } from "@/components/charts/ShareBar";
import { count, flag, money } from "@/components/research/format";
import { ago } from "@/components/hunting/HuntBits";
import { DiscoverProducts } from "./DiscoverProducts";
import {
  DEFAULT_FILTERS,
  DiscoverProductFilters,
  filterProducts,
} from "./DiscoverProductFilters";
import { DiscoverCompliance } from "./DiscoverCompliance";
import { PillTabs } from "@/components/PillTabs";
import {
  AccountDelivery,
  BAND,
  BudgetLine,
  CardHeader,
  Chevron,
  FlagTag,
  perMonth,
  Quiet,
  ScoreBadge,
  StarIcon,
  StatTile,
} from "./discover-ui";

type View = "products" | "subcategories" | "keywords" | "market";

// One category or keyword in Discover, laid out like the Analytics page:
// the headline figures as tiles (with what a supplier may cost at the
// account's target return), your own traffic on a keyword, "Before you
// hunt" (brands and VeRO, restricted items, eBay's word filter), the app's
// own charts of where the sales are, the subcategories ranked, the keywords
// that sell with the brand split, and what's selling now.

const intAxis = (v: number) => (Number.isInteger(v) ? count(v) : "");
const pctText = (v: number | null) =>
  v === null ? "—" : `${Math.round(v * 10) / 10}%`;
const SELLER_TONES: ShareTone[] = [
  "indigo",
  "indigoSoft",
  "sky",
  "emerald",
  "amber",
  "rose",
];

function YourTraffic({ data }: { data: DiscoverYourTraffic }) {
  if (!data.listings) {
    return (
      <section className="card flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
            <path
              d="M12 5v14M5 12h14"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <p className="min-w-0 flex-1 text-[12.5px] text-[var(--color-muted)]">
          <span className="font-semibold text-[var(--color-ink)]">
            None of your listings has this keyword yet.
          </span>{" "}
          If the figures above look good, it&apos;s a gap you could fill.
        </p>
      </section>
    );
  }
  const figures: { label: string; value: string; tone?: string }[] = [
    { label: "Your listings", value: count(data.listings) },
    {
      label: "Impressions",
      value: data.measured ? count(data.impressions || 0) : "—",
    },
    { label: "Clicks", value: data.measured ? count(data.views || 0) : "—" },
    {
      label: "Click rate",
      value: data.ctr === null || data.ctr === undefined ? "—" : `${data.ctr}%`,
    },
    {
      label: "Sold",
      value: count(data.sold || 0),
      tone: data.sold ? "text-emerald-700" : undefined,
    },
    {
      label: "Conversion",
      value:
        data.conversion === null || data.conversion === undefined
          ? "—"
          : `${data.conversion}%`,
    },
  ];
  return (
    <section
      aria-label="Your traffic on this keyword"
      className="card flex flex-col gap-3 px-4 py-3 xl:flex-row xl:items-center xl:gap-6"
    >
      <div className="flex-shrink-0 xl:w-48">
        <p className="text-[12px] font-semibold text-[var(--color-ink)]">
          Your traffic on this keyword
        </p>
        <p className="text-[11.5px] text-[var(--color-muted)]">
          Your listings with it, last 30 days
          {data.measured !== undefined && data.measured < data.listings
            ? ` · traffic from ${data.measured} measured`
            : ""}
        </p>
      </div>
      <div className="grid min-w-0 flex-1 grid-cols-3 gap-x-4 gap-y-2.5 min-[900px]:grid-cols-6">
        {figures.map((f) => (
          <div key={f.label} className="min-w-0">
            <p className="truncate text-[11.5px] text-[var(--color-muted)]">
              {f.label}
            </p>
            <p
              className={`text-[15px] font-semibold tabular-nums ${f.tone || "text-[var(--color-ink)]"}`}
            >
              {f.value}
            </p>
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
      <CardHeader
        title="How the score is made"
        aside={<ScoreBadge score={o.score} band={o.band} size="sm" />}
      />
      <ul className="mt-3 divide-y divide-[var(--color-line)]">
        {o.parts.map((p) => (
          <li
            key={p.key}
            title={p.detail}
            className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
          >
            {/* A small ring per part: how much of its points it earned. */}
            <svg
              viewBox="0 0 36 36"
              className="h-8 w-8 flex-shrink-0 -rotate-90"
              aria-hidden
            >
              <circle
                cx="18"
                cy="18"
                r="14"
                fill="none"
                stroke="var(--color-paper)"
                strokeWidth="4"
              />
              <circle
                cx="18"
                cy="18"
                r="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="round"
                strokeDasharray={`${(p.points / p.max) * 88} 88`}
                className={b.ink}
              />
            </svg>
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="font-medium text-[var(--color-ink)]">
                  {p.label}
                </span>
                <span className="tabular-nums text-[var(--color-muted)]">
                  {p.points} / {p.max}
                </span>
              </p>
              <p className="truncate text-[11px] text-[var(--color-muted)]">
                {p.value} · full at {p.full}
              </p>
            </div>
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
  checking,
  onCheck,
  aiUnavailable,
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
  checking: boolean;
  onCheck: () => void;
  aiUnavailable: boolean;
}) {
  const { subject, figures: f, market, charts } = data;
  const currency = market.currency;
  const [filters, setFilters] =
    useState<DiscoverWinnersFilters>(DEFAULT_FILTERS);
  const [view, setView] = useState<View>("products");
  const shownProducts = useMemo(
    () => filterProducts(data.products, filters),
    [data.products, filters],
  );
  const unranked = data.children.filter(
    (c) => !c.scanned && !c.restricted,
  ).length;
  const read = f.demand.read;
  // A top-level category is too broad for "Before you hunt": it shows on a keyword or a subcategory.
  const specific = subject.kind === "keyword" || subject.path.length > 1;
  const hidden = data.compliance.hidden;
  const hiddenText = hidden.count
    ? `${hidden.count} of the leading listings ${hidden.count === 1 ? "is" : "are"} hidden: ${[hidden.restricted ? `${hidden.restricted} restricted on eBay` : null, hidden.brand ? `${hidden.brand} ${hidden.brands.length ? `branded (${hidden.brands.slice(0, 3).join(", ")})` : "a VeRO brand"}` : null].filter(Boolean).join(", ")}. Nothing here counts them.`
    : null;

  // Sales by price: each band's share of the sales (solid) against its share of the listings (dashed).
  const bandSales = charts.priceBands.reduce((n, b) => n + b.perMonth, 0);
  const bandListings = charts.priceBands.reduce((n, b) => n + b.listings, 0);
  const bandKey = (b: { from: number; to: number | null }) =>
    b.to === null
      ? `${money(b.from, currency, 0)}+`
      : `${money(b.from, currency, 0)}–${money(b.to, currency, 0)}`;
  const pricePoints = charts.priceBands.map((b) => ({
    day: bandKey(b),
    value: bandSales ? Math.round((b.perMonth / bandSales) * 1000) / 10 : 0,
    previous: bandListings
      ? Math.round((b.listings / bandListings) * 1000) / 10
      : 0,
  }));
  const titles = new Map(
    charts.demandCurve.map((d, i) => [`#${i + 1}`, d.title]),
  );
  const curvePoints = charts.demandCurve.map((d, i) => ({
    day: `#${i + 1}`,
    value: d.perMonth,
    previous: null,
  }));
  const sellerSales = charts.sellers.reduce((n, s) => n + s.perMonth, 0);
  const otherSellers = Math.max(0, f.demand.monthlySales - sellerSales);
  const deliveryTone: Record<string, ShareTone> = {
    faster: "amber",
    similar: "emerald",
    slower: "sky",
    unknown: "slate",
  };

  return (
    <div className="space-y-5">
      {/* Back, where we are, and the watch toggle. */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--color-muted)]">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-7 items-center gap-1 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] pl-1.5 pr-2.5 font-medium text-[var(--color-ink)] hover:border-[var(--color-line-strong)]"
          >
            <Chevron className="h-3.5 w-3.5 rotate-180" />
            {backLabel}
          </button>
          {subject.kind === "category" && subject.path.length > 2 && (
            <nav
              aria-label="Category path"
              className="flex min-w-0 flex-wrap items-center gap-x-1"
            >
              {subject.path.slice(0, -2).map((p, i) => (
                <span key={p.id} className="inline-flex items-center gap-x-1">
                  {i > 0 && <span aria-hidden>›</span>}
                  <button
                    type="button"
                    onClick={() => onOpen({ categoryId: p.id })}
                    className="hover:text-[var(--color-primary)] hover:underline"
                  >
                    {p.name}
                  </button>
                </span>
              ))}
            </nav>
          )}
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              {subject.kind === "keyword" ? "Keyword" : "Category"}
            </p>
            <h2 className="text-[19px] font-semibold leading-tight text-[var(--color-ink)]">
              {subject.kind === "keyword" ? `“${subject.name}”` : subject.name}
            </h2>
            <p className="mt-1 text-[12px] text-[var(--color-muted)]">
              {market.name} · read {ago(subject.takenAt)}
              {subject.stale &&
                " (today's searches are used up; this is the last reading)"}{" "}
              · <AccountDelivery account={data.account} />
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleWatch}
            disabled={watchBusy}
            aria-pressed={Boolean(data.watch)}
            className={`btn btn-sm !h-8 gap-1.5 !text-[12.5px] disabled:opacity-60 ${data.watch ? "border border-amber-300 bg-amber-50 text-amber-800" : "btn-secondary"}`}
            title={
              data.watch
                ? "Stop watching"
                : "Read it again every night, to chart its sales day by day"
            }
          >
            <StarIcon filled={Boolean(data.watch)} />
            {data.watch ? "Watching" : "Watch"}
          </button>
        </div>
      </div>

      {specific && data.compliance.level === "risky" && (
        <div className="notice notice-danger">
          <span className="flex-1">
            <span className="font-semibold">Risky to hunt.</span>{" "}
            {data.compliance.subject.restricted.length
              ? `${data.compliance.subject.restricted.map((r) => r.label).join(", ")}: eBay ${data.compliance.subject.restricted.some((r) => r.kind === "prohibited") ? "doesn't allow these" : "restricts these, and some need approval"}.`
              : data.compliance.ai?.brand?.level === "high"
                ? `${data.compliance.ai.brand.brands?.join(", ") || "A brand"} can have listings taken down (VeRO). ${data.compliance.ai.brand.reason}`
                : data.compliance.ai?.safety?.reason ||
                  "See Before you hunt below."}
          </span>
        </div>
      )}

      {/* The headline figures. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          icon="target"
          label="Opportunity"
          value={`${data.opportunity.score} / 100`}
          chip={BAND[data.opportunity.band].label}
          tone={
            data.opportunity.band === "strong"
              ? "emerald"
              : data.opportunity.band === "fair"
                ? "amber"
                : "rose"
          }
          gauge={data.opportunity.score}
          sub="Demand to price room, out of 100"
          info="Demand, how many listings sell, competition, whether you can match the sellers' delivery, and price room. See how it's made below."
        />
        <StatTile
          icon="trend"
          label="Monthly sales"
          value={read ? count(Math.round(f.demand.monthlySales)) : "—"}
          tone="primary"
          sub={
            read ? `${read} leading listings read` : "Once sold counts are read"
          }
          info={`What the ${read} leading listings sell between them a month: each one's eBay sold count over the time it has been live. eBay doesn't share buyers' search volume with apps, so demand is measured from the sales themselves.`}
        />
        <StatTile
          icon="layers"
          label="Live listings"
          value={count(f.total)}
          tone="sky"
          sub={`${f.competition.sellers} sellers in the top ${f.sample}`}
          info={`Every listing on ${market.name} for it right now: the competition. ${f.competition.sellers} sellers among the top ${f.sample}.`}
        />
        <StatTile
          icon="check"
          label="Sell-through"
          value={
            f.demand.sellThrough === null ? "—" : `${f.demand.sellThrough}%`
          }
          tone={
            f.demand.sellThrough === null
              ? "slate"
              : f.demand.sellThrough >= 60
                ? "emerald"
                : f.demand.sellThrough >= 30
                  ? "amber"
                  : "rose"
          }
          gauge={f.demand.sellThrough}
          sub={
            read
              ? `${f.demand.selling} of ${read} sell every month`
              : "Once sold counts are read"
          }
          info={`Of the ${read} leading listings read, how many sell at least one a month. The middle one sells ${perMonth(f.demand.medianPerMonth)}; the best ${perMonth(f.demand.topPerMonth)}.`}
        />
        <StatTile
          icon="tag"
          label="Typical price"
          value={f.price ? money(f.price.median, currency) : "—"}
          tone="amber"
          sub={
            f.price
              ? `Most ${money(f.price.low, currency)}–${money(f.price.high, currency)}`
              : "No prices"
          }
          info={
            f.price
              ? `What buyers pay with postage; most listings between ${money(f.price.low, currency)} and ${money(f.price.high, currency)}.`
              : undefined
          }
        />
        <StatTile
          icon="wallet"
          label="Supplier budget"
          value={data.price ? money(data.price.maxCost, currency) : "—"}
          tone="emerald"
          sub={
            data.price
              ? `Sell at ${money(data.price.recommended, currency)} · ${data.price.targetRoiPercent}% return`
              : "Set your pricing to see it"
          }
          info={
            data.price
              ? `The most a supplier (with postage) may cost for your ${data.price.targetRoiPercent}% target return, selling at ${money(data.price.recommended, currency)} (just under what the sales centre on) after eBay's fees and ads in your pricing settings.`
              : undefined
          }
        />
      </div>

      {subject.kind === "keyword" && data.yourTraffic && (
        <YourTraffic data={data.yourTraffic} />
      )}

      {specific && (
        <DiscoverCompliance
          data={data.compliance}
          checking={checking}
          onCheck={onCheck}
          aiUnavailable={aiUnavailable}
        />
      )}

      {/* What to look at, as tabs, so nothing sits below a long list: the products (the point), its
          subcategories (each with its own products and keywords), the keywords that sell, the market picture. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PillTabs<View>
          label="Show"
          value={view}
          onChange={setView}
          tabs={[
            { key: "products", label: "Products", count: data.products.length },
            ...(data.children.length ? [{ key: "subcategories" as View, label: "Subcategories", count: data.children.length }] : []),
            { key: "keywords", label: "Keywords", count: data.keywords.length },
            { key: "market", label: "Market picture" },
          ]}
        />
        <p className="text-[11.5px] text-[var(--color-muted)]">
          {view === "products"
            ? "The same product under several sellers is one row, scored the way a hunter judges it."
            : view === "subcategories"
              ? "Open one for its own products, keywords and subcategories: the deeper, the more specific."
              : view === "keywords"
                ? "The phrases of the titles that sell here: open one to find its products."
                : "Sales by day, by price and across the leading listings; the score; who's selling and how they deliver."}
        </p>
      </div>

      {/* The products here, the way a hunter reads them: the page's point. */}
      {view === "products" && (
        <section className="card min-w-0 overflow-hidden">
          <div className="p-4 pb-3">
            <CardHeader
              title="Products here, best to hunt first"
              note={`Sales a month together, how many sellers make a living from it, what buyers pay, how much of its sales come from sellers delivering like you, and whether it's rising or new. Each says why.${hiddenText ? ` ${hiddenText}` : ""}`}
              aside={
                <span className="text-[12px] tabular-nums text-[var(--color-muted)]">
                  {shownProducts.length === data.products.length
                    ? `${data.products.length} products`
                    : `${shownProducts.length} of ${data.products.length} products`}
                </span>
              }
            />
            <div className="mt-3 border-t border-[var(--color-line)] pt-3">
              <DiscoverProductFilters
                filters={filters}
                onChange={setFilters}
                currency={currency}
              />
            </div>
          </div>
          <div className="border-t border-[var(--color-line)]">
            <DiscoverProducts
              products={shownProducts}
              currency={currency}
              onHunt={onHunt}
              empty={
                !read
                  ? "Products show once sold counts are read."
                  : data.products.length
                    ? "No product here matches these filters. Loosen one, or load more products."
                    : "No product here sells yet."
              }
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-line)] px-4 py-2.5">
            <p className="text-[11.5px] text-[var(--color-muted)]">
              {data.reads.signInFailed
                ? "Sold counts need this account's eBay sign-in, which didn't work: reconnect the account, or ask the owner to."
                : data.reads.stopped
                  ? "Today's sold-count reads ran out before every listing was read."
                  : `From the ${read} leading listings read of ${data.listings.length}${data.reads.more ? "; loading more reads the next ones' sold counts" : ""}.`}
            </p>
            {data.reads.more && !data.reads.stopped && (
              <button
                type="button"
                onClick={onReadMore}
                disabled={readingMore}
                className="btn btn-secondary btn-sm !h-8 !text-[12.5px]"
              >
                {readingMore ? "Loading…" : `Load more products`}
              </button>
            )}
          </div>
        </section>
      )}

      {view === "keywords" && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <section className="card min-w-0 overflow-hidden xl:col-span-2">
            <div className="p-4 pb-3">
              <CardHeader
                title="Keywords that sell"
                note={`Phrases in the titles that sell: their sales a month, eBay's sold counts, their share of the sales next to how many titles use them, and the lift (share of sales over share of titles)${data.subject.kind === "category" && !data.subject.leaf ? ". The deeper the category, the more it shows" : ""}. Open one to see its own figures.`}
              />
            </div>
            {data.keywords.length === 0 ? (
              <div className="border-t border-[var(--color-line)] px-4">
                <Quiet>
                  {read
                    ? "No phrase stands out across the listings that sell."
                    : "Keywords show once sold counts are read."}
                </Quiet>
              </div>
            ) : (
              <div className="overflow-x-auto border-t border-[var(--color-line)]">
                <table className="w-full min-w-[640px] table-fixed text-[12.5px]">
                  <thead className="whitespace-nowrap bg-[var(--color-paper)] text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                    <tr>
                      <th className="w-[36%] px-4 py-2 text-left">Keyword</th>
                      <th
                        className="px-3 py-2 text-center"
                        title="Sales a month of the leading listings with it"
                      >
                        Sales a month
                      </th>
                      <th
                        className="px-3 py-2 text-center"
                        title="eBay's sold counts of the leading listings with it, in total"
                      >
                        Sold
                      </th>
                      <th
                        className="px-3 py-2 text-center"
                        title="Its share of the leading listings' sales"
                      >
                        Share
                      </th>
                      <th
                        className="px-3 py-2 text-center"
                        title="How many of the leading listings' titles use it"
                      >
                        In titles
                      </th>
                      <th
                        className="px-4 py-2 text-center"
                        title="Its share of the sales over its share of the listings"
                      >
                        Lift
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-line)]">
                    {data.keywords.map((k) => (
                      <tr
                        key={k.term}
                        onClick={() => onOpen({ q: k.term })}
                        className="group cursor-pointer hover:bg-[var(--color-paper)]/60"
                        title={`Open “${k.term}”`}
                      >
                        <td className="px-4 py-2 text-left">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">
                              {k.term}
                            </span>
                            <FlagTag flag={k.flag} />
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center font-semibold tabular-nums text-[var(--color-ink)]">
                          {count(Math.round(k.perMonth))}
                        </td>
                        <td className="px-3 py-2 text-center tabular-nums">
                          {count(k.sold)}
                        </td>
                        <td className="px-3 py-2 text-center tabular-nums">
                          {k.salesShare}%
                        </td>
                        <td className="px-3 py-2 text-center tabular-nums text-[var(--color-muted)]">
                          {k.listingShare}%
                        </td>
                        <td
                          className={`px-4 py-2 text-center font-semibold tabular-nums ${k.lift !== null && k.lift >= 1.3 ? "text-emerald-700" : "text-[var(--color-muted)]"}`}
                        >
                          {k.lift !== null ? `${k.lift}×` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card flex min-w-0 flex-col p-4">
            {data.categories.length > 0 && (
              <div className="mb-5">
                <CardHeader
                  title="Listed in"
                  note="The eBay categories its listings sit in"
                />
                <ul className="-mx-2 mt-2">
                  {data.categories.slice(0, 6).map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => onOpen({ categoryId: c.id })}
                        className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--color-paper)]"
                      >
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">
                          {c.name}
                        </span>
                        <span className="text-center text-[11.5px] tabular-nums text-[var(--color-muted)]">
                          {count(c.count)}
                        </span>
                        <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-line-strong)]" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <CardHeader
              title="Brands"
              note="How the live listings split by brand: unbranded means room for a generic product"
            />
            <div className="mt-3">
              <ShareBar
                columns={1}
                items={data.brands
                  .slice(0, 6)
                  .map((b, i) => ({
                    key: b.name,
                    label: b.unbranded ? `${b.name} (no brand)` : b.name,
                    value: b.count,
                    tone: b.unbranded
                      ? "slate"
                      : SELLER_TONES[i % SELLER_TONES.length],
                  }))}
                format={(v) => count(v)}
                empty="eBay gave no brand split."
              />
            </div>
          </section>
        </div>
      )}

      {view === "market" && (
        <>
          {/* Where the sales are, in the app's charts. */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <section className="card flex flex-col p-4">
              <CardHeader
                title="Sales by day"
                note={
                  data.trend
                    ? "The leading listings' sales, from Discover's daily readings"
                    : "Builds from Discover's daily readings"
                }
              />
              {data.trend ? (
                <div className="mt-2">
                  <TrendChart
                    points={data.trend.map((t) => ({
                      day: t.day,
                      value: t.value,
                      previous: null,
                    }))}
                    format={(v) =>
                      v === null ? "—" : `${count(Math.round(v))} sold`
                    }
                    axisFormat={intAxis}
                    label="Sales by day"
                    currentLabel="Sold"
                    showPrevious={false}
                    legend={false}
                    height={180}
                  />
                </div>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center py-6 text-center">
                  <p className="max-w-[260px] text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                    Liston reads these listings once a day. The chart appears
                    after the second reading; watch it to read it every night.
                  </p>
                  {!data.watch && (
                    <button
                      type="button"
                      onClick={onToggleWatch}
                      disabled={watchBusy}
                      className="btn btn-secondary btn-sm mt-3 !h-8 gap-1.5 !text-[12.5px]"
                    >
                      <StarIcon />
                      Watch
                    </button>
                  )}
                </div>
              )}
            </section>

            <section className="card flex flex-col p-4">
              <CardHeader
                title="Sales by price"
                note="Share of the sales at each price (solid) against share of the listings (dashed), postage included"
              />
              <div className="mt-2">
                {read && pricePoints.length > 1 ? (
                  <TrendChart
                    points={pricePoints}
                    format={pctText}
                    axisFormat={(v) => `${v}%`}
                    label="Sales and listings by price"
                    currentLabel="Share of sales"
                    previousLabel="Share of listings"
                    legend={false}
                    height={180}
                    xLabel={(k) => k.split("–")[0]}
                    xTitle={(k) => `Buyers pay ${k}`}
                  />
                ) : (
                  <Quiet>Shows once sold counts are read.</Quiet>
                )}
              </div>
            </section>

            <section className="card flex flex-col p-4">
              <CardHeader
                title="Sales across the leading listings"
                note={
                  read
                    ? `Sales a month from the best seller down, ${charts.demandCurve.length} read: a steep drop means a few listings take most of it`
                    : undefined
                }
              />
              <div className="mt-2">
                {curvePoints.length > 1 ? (
                  <TrendChart
                    points={curvePoints}
                    format={(v) =>
                      v === null ? "—" : `${count(Math.round(v))} a month`
                    }
                    axisFormat={intAxis}
                    label="Sales a month of each leading listing"
                    currentLabel="Sales a month"
                    showPrevious={false}
                    legend={false}
                    height={180}
                    xLabel={(k) => k}
                    xTitle={(k) =>
                      `${k} · ${(titles.get(k) || "").slice(0, 60)}`
                    }
                  />
                ) : (
                  <Quiet>Shows once sold counts are read.</Quiet>
                )}
              </div>
            </section>

            <ScoreCard data={data} />

            <section className="card flex flex-col p-4">
              <CardHeader
                title="Who's selling"
                note="The leading listings' sales a month, by seller"
              />
              <div className="mt-3">
                <ShareBar
                  items={[
                    ...charts.sellers
                      .slice(0, 5)
                      .map((s, i) => ({
                        key: s.key,
                        label: s.key,
                        value: s.perMonth,
                        tone: SELLER_TONES[i],
                        note:
                          s.listings > 1 ? `${s.listings} listings` : undefined,
                      })),
                    {
                      key: "others",
                      label: "Everyone else",
                      value: otherSellers,
                      tone: "slate" as ShareTone,
                    },
                  ]}
                  format={(v) => `${count(Math.round(v))}/mo`}
                  empty="Shows once sold counts are read."
                />
              </div>
            </section>

            <section className="card flex flex-col p-4">
              <CardHeader
                title="Delivery and where it ships from"
                note="Sales a month by delivery next to yours, then by country"
              />
              <div className="mt-3 space-y-5">
                <ShareBar
                  items={charts.delivery.map((d) => ({
                    key: d.key,
                    label: d.label || d.key,
                    value: d.perMonth,
                    tone: deliveryTone[d.key] || "slate",
                    note: `${d.listings} listings`,
                  }))}
                  format={(v) => `${count(Math.round(v))}/mo`}
                  empty="Shows once sold counts are read."
                />
                {charts.countries.some((c) => c.perMonth > 0) && (
                  <ShareBar
                    columns={3}
                    items={charts.countries.map((c, i) => ({
                      key: c.key,
                      label: `${flag(c.key)} ${c.key}`,
                      value: c.perMonth,
                      tone: (c.domestic
                        ? "indigo"
                        : (
                            [
                              "sky",
                              "amber",
                              "rose",
                              "emerald",
                              "slate",
                            ] as ShareTone[]
                          )[i % 5]) as ShareTone,
                    }))}
                    format={(v) => `${count(Math.round(v))}/mo`}
                  />
                )}
              </div>
            </section>
          </div>
        </>
      )}

      {/* Subcategories: each one's data fetched on request, then ranked. */}
      {view === "subcategories" && data.children.length > 0 && (
        <section className="card overflow-hidden">
          <div className="p-4 pb-3">
            <CardHeader
              title="Subcategories"
              note="Fetch their data to see each one's sales, price and the phrases its selling titles share, best first (its leading listings and the sold counts of its top 8). The deeper you go, the more keywords a category shows."
              aside={
                data.ranking ? (
                  <span className="text-[12px] font-medium text-[var(--color-primary)]">
                    Fetching {data.ranking.done} of {data.ranking.total}…
                  </span>
                ) : unranked > 0 ? (
                  <button
                    type="button"
                    onClick={onRank}
                    className="btn btn-secondary btn-sm !h-8 !text-[12.5px]"
                  >
                    Fetch data
                    {unranked > 12
                      ? " for the busiest 12"
                      : unranked === data.children.length
                        ? ""
                        : ` for the other ${unranked}`}
                  </button>
                ) : undefined
              }
            />
          </div>
          <div className="overflow-x-auto border-t border-[var(--color-line)]">
            <table className="w-full min-w-[860px] table-fixed text-[12.5px]">
              <thead className="whitespace-nowrap bg-[var(--color-paper)] text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                <tr>
                  <th className="w-[34%] px-4 py-2 text-left">
                    Subcategory and its keywords
                  </th>
                  <th className="w-[12%] px-3 py-2 text-center">Opportunity</th>
                  <th
                    className="px-3 py-2 text-center"
                    title="What its leading listings sell between them a month"
                  >
                    Sales a month
                  </th>
                  <th
                    className="px-3 py-2 text-center"
                    title="eBay's sold counts of the leading listings read, in total"
                  >
                    Sold
                  </th>
                  <th
                    className="px-3 py-2 text-center"
                    title="Of the leading listings read, how many sell at least one a month"
                  >
                    Selling
                  </th>
                  <th className="px-3 py-2 text-center">Live</th>
                  <th className="px-3 py-2 text-center">Price</th>
                  <th className="px-4 py-2 text-center">Fits you</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {data.children.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => onOpen({ categoryId: c.id })}
                    className={`cursor-pointer align-top hover:bg-[var(--color-paper)]/60 ${c.restricted ? "opacity-60" : ""}`}
                  >
                    <td className="px-4 py-2.5 text-left">
                      <span className="flex items-center gap-1.5 font-medium text-[var(--color-ink)]">
                        <span className="truncate">{c.name}</span>
                        <FlagTag flag={c.flag} />
                        <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-line-strong)]" />
                      </span>
                      {c.restricted ? (
                        <span className="mt-0.5 block text-[11px] text-[var(--color-muted)]">
                          {c.restricted.label}: eBay{" "}
                          {c.restricted.kind === "prohibited"
                            ? "doesn't allow these"
                            : "restricts these"}
                          . Not fetched.
                        </span>
                      ) : c.keywords.length > 0 ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {c.keywords.map((k) => (
                            <button
                              key={k.term}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpen({ q: k.term });
                              }}
                              className="inline-flex h-5 items-center gap-1 rounded-full bg-[var(--color-paper)] px-2 text-[11px] font-medium text-[var(--color-ink)] ring-1 ring-inset ring-[var(--color-line)] hover:bg-[var(--color-primary-soft)] hover:text-[var(--color-primary)] hover:ring-[var(--color-primary)]/30"
                              title={`“${k.term}”: ${count(Math.round(k.perMonth))} sales a month across its leading listings. Open it.`}
                            >
                              {k.term}
                              <span className="tabular-nums text-[var(--color-muted)]">
                                {count(Math.round(k.perMonth))}/mo
                              </span>
                            </button>
                          ))}
                        </span>
                      ) : c.scanned ? (
                        <span className="mt-0.5 block text-[11px] text-[var(--color-muted)]">
                          No phrase stands out yet
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {c.scanned ? (
                        <ScoreBadge
                          score={c.scanned.score}
                          band={c.scanned.band}
                          size="sm"
                        />
                      ) : (
                        <span className="text-[11.5px] text-[var(--color-muted)]">
                          {c.restricted ? "—" : "Not fetched"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center font-semibold tabular-nums text-[var(--color-ink)]">
                      {c.scanned
                        ? count(Math.round(c.scanned.monthlySales))
                        : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      {c.scanned ? count(c.scanned.soldTotal) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      {c.scanned
                        ? `${c.scanned.selling} of ${c.scanned.read}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      {c.listings !== null ? count(c.listings) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      {c.scanned?.price !== null &&
                      c.scanned?.price !== undefined
                        ? money(c.scanned.price, currency)
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-center tabular-nums">
                      {c.scanned?.fit !== null && c.scanned?.fit !== undefined
                        ? `${c.scanned.fit}%`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <BudgetLine budget={data.budget} />
    </div>
  );
}
