"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError, ResearchBudget, ResearchDeliveryFilter, ResearchItem, ResearchResult } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import { AccountPageSkeleton } from "@/components/Skeleton";
import { currencySymbol } from "@/lib/format";
import { bigMoney, count, money } from "@/components/research/format";
import { PriceCard, RiskCard, TitleCard, VerdictCard } from "@/components/research/ResearchPanels";
import { RESEARCH_SORTS, ResearchListings, ResearchSort, sortResearch } from "@/components/research/ResearchListings";
import { DeliveryBar } from "@/components/research/DeliveryBar";

// Product research on the account's eBay site: whether to list a product,
// at what price, under what title, and what could get it taken down — from
// what's live for a search, at what prices, from whom, and how well the
// leading listings sell (eBay's sold count per listing). Read through eBay's
// Browse API — a search is one read for up to 200 listings, each sold count
// one more — within research's share of the app's daily allowance. The AI's
// reading (title, brand and safety risk) follows the figures.

// delivery: which listings to compare with (left out: the server's default,
// those that deliver like this account).
type Params = { q: string; condition: string; minPrice: string; maxPrice: string; delivery?: ResearchDeliveryFilter };
const PAGE = 50;

function Stat({ label, value, lines }: { label: string; value: string; lines: string[] }) {
  return (
    <div className="card flex flex-col p-5">
      <span className="text-[13px] font-medium text-[var(--color-muted)]">{label}</span>
      <span className="mt-2.5 text-[26px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">{value}</span>
      <span className="mt-auto space-y-0.5 pt-3">
        {lines.map((line) => (
          <span key={line} className="block text-[12px] text-[var(--color-muted)]">
            {line}
          </span>
        ))}
      </span>
    </div>
  );
}

export default function ResearchPage() {
  const params = useParams<{ id: string }>();
  const { connection, user, loading, error } = useConnection(params.id);
  const [q, setQ] = useState("");
  const [condition, setCondition] = useState("new");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [readingSold, setReadingSold] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [budget, setBudget] = useState<ResearchBudget | null>(null);
  const [sort, setSort] = useState<ResearchSort>("best");
  const [checking, setChecking] = useState(false);
  // The search on screen, as asked (the form may have changed since).
  const asked = useRef<Params | null>(null);
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    if (!connection) return;
    api.researchBudget(connection.id).then(setBudget).catch(() => {});
  }, [connection]);

  // The AI's reading of the search on screen; the figures are already up.
  async function readAdvice(params: Params) {
    if (!connection) return;
    setChecking(true);
    try {
      const data = await api.researchAdvice(connection.id, params);
      if (asked.current !== params) return;
      setResult((r) => (r ? { ...r, advice: data.advice, analysis: data.analysis } : r));
    } catch {
      /* the figures stand without it */
    } finally {
      if (asked.current === params) setChecking(false);
    }
  }

  async function run(query: string) {
    if (!connection || query.trim().length < 2) return;
    return runWith({ q: query.trim(), condition, minPrice, maxPrice });
  }

  // The same search, compared with listings that deliver faster, slower,
  // like this account, or all of them. The search and sold counts read are
  // kept, so this costs few or no eBay reads.
  function compareWith(filter: ResearchDeliveryFilter) {
    if (!asked.current) return;
    runWith({ ...asked.current, delivery: filter }, { keepView: true });
  }

  async function runWith(params: Params, { keepView = false }: { keepView?: boolean } = {}) {
    if (!connection) return;
    asked.current = params;
    setSearching(true);
    setChecking(false);
    setProblem(null);
    try {
      const data = await api.researchSearch(connection.id, params);
      if (asked.current !== params) return;
      setResult(data);
      setBudget(data.budget);
      if (!keepView) setSort("best");
      setShown(PAGE);
      if (!data.advice) readAdvice(params);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Couldn't search eBay just now. Try again.");
    } finally {
      setSearching(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    run(q);
  }

  // The next listings (in the order shown) without a sold count: read 20.
  const unread = useMemo(() => (result ? result.items.filter((i) => i.sold === null) : []), [result]);
  async function readMoreSold(ordered: ResearchItem[]) {
    if (!connection || !result) return;
    const next = ordered.filter((i) => i.sold === null).slice(0, 20);
    if (!next.length) return;
    setReadingSold(true);
    setProblem(null);
    try {
      const data = await api.researchSold(
        connection.id,
        next.map(({ itemId, legacyItemId, hasVariations, createdAt }) => ({ itemId, legacyItemId, hasVariations, createdAt }))
      );
      const byId = new Map(data.items.map((i) => [i.itemId, i]));
      setResult((r) => (r ? { ...r, items: r.items.map((i) => (byId.has(i.itemId) ? { ...i, ...byId.get(i.itemId)! } : i)) } : r));
      setBudget(data.budget);
      // The figures, price and verdict redone with the new counts: the
      // search and every count read are kept, so this reads nothing from eBay.
      if (asked.current) {
        const fresh = await api.researchSearch(connection.id, asked.current).catch(() => null);
        if (fresh) setResult((r) => (r ? { ...fresh, advice: fresh.advice ?? r.advice } : fresh));
      }
      if (data.soldLimited) setProblem("Research has used today's eBay reads, so some sold counts are still missing. They reset at 07:00 UTC.");
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Couldn't read the sold counts.");
    } finally {
      setReadingSold(false);
    }
  }

  if (loading) return <AccountPageSkeleton />;
  if (error || !connection || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <Alert>{error || "This account connection doesn't exist, or isn't yours."}</Alert>
      </main>
    );
  }

  const market = connection.marketplace;
  const currency = result?.market.currency ?? market?.currency ?? "GBP";
  const ordered = result ? sortResearch(result.items, sort) : [];
  const s = result?.summary;
  const a = result?.analysis;
  const maxSold = result ? Math.max(0, ...result.items.map((i) => i.sold ?? 0)) : 0;

  return (
    <AccountShell
      connectionId={connection.id}
      label={connection.label}
      platformKey={connection.platform_key}
      platformName={connection.platform_name}
      marketplace={connection.marketplace}
      status={connection.status}
      permissions={connection.permissions}
      user={user}
      header={
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Product research</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
            What sells on {market?.name ?? "eBay"}: prices, competition, where it ships from, and how many each listing has sold.
          </p>
        </div>
      }
    >
      <form onSubmit={onSubmit} className="card flex flex-wrap items-center gap-2 p-2">
        <label className="relative min-w-[220px] flex-1">
          <span className="sr-only">Product</span>
          <svg viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]">
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search a product on ${market?.name ?? "eBay"}`}
            className="input input-sm !h-9 !pl-9"
            autoFocus
          />
        </label>
        <div role="radiogroup" aria-label="Condition" className="inline-flex h-9 items-center rounded-lg bg-[var(--color-paper)] p-0.5">
          {[
            { key: "new", label: "New" },
            { key: "used", label: "Used" },
            { key: "any", label: "Any" },
          ].map((c) => (
            <button
              key={c.key}
              type="button"
              role="radio"
              aria-checked={condition === c.key}
              onClick={() => setCondition(c.key)}
              className={`h-8 rounded-md px-3 text-[12.5px] font-medium transition-colors ${
                condition === c.key ? "bg-[var(--color-panel)] text-[var(--color-ink)] shadow-sm ring-1 ring-[var(--color-line)]" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex h-9 items-center rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-panel)] text-[13px] transition-colors hover:border-[var(--color-line-strong)] focus-within:!border-[var(--color-primary)]">
          <label className="flex h-full items-center pl-3">
            <span className="text-[var(--color-muted)]">{currencySymbol(currency)}</span>
            <span className="sr-only">Min price</span>
            <input value={minPrice} onChange={(e) => setMinPrice(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" placeholder="Min" className="h-full w-14 bg-transparent px-1.5 outline-none placeholder:text-[var(--color-muted)]" />
          </label>
          <span className="text-[var(--color-muted)]" aria-hidden>
            –
          </span>
          <label className="flex h-full items-center pl-2 pr-1">
            <span className="text-[var(--color-muted)]">{currencySymbol(currency)}</span>
            <span className="sr-only">Max price</span>
            <input value={maxPrice} onChange={(e) => setMaxPrice(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" placeholder="Max" className="h-full w-14 bg-transparent px-1.5 outline-none placeholder:text-[var(--color-muted)]" />
          </label>
        </div>
        <button type="submit" disabled={searching || q.trim().length < 2} className="btn btn-primary btn-sm !h-9 px-4">
          {searching ? "Searching…" : "Research"}
        </button>
      </form>
      <p className="mt-2 px-1 text-[12px] text-[var(--color-muted)]">
        {market?.name ?? "eBay"} · fixed-price listings · each search reads up to 200 listings and the sold counts of the top 20
        {budget && ` · ${count(budget.remaining)} of today's ${count(budget.limit)} research reads left`}
      </p>

      {problem && (
        <div className="mt-4">
          <Alert>{problem}</Alert>
        </div>
      )}

      {!result && !searching && (
        <div className="card mt-5 flex flex-col items-center px-6 py-12 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
              <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="M15.5 15.5L20 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M7.5 12l2-2.5 2 1.5 2-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <p className="mt-3 text-[14px] font-semibold text-[var(--color-ink)]">Research a product before you list it</p>
          <p className="mt-1 max-w-md text-[13px] leading-relaxed text-[var(--color-muted)]">
            See what buyers pay, how much it sells, who you&apos;d compete with, and a recommended price and title for {connection.label}.
          </p>
        </div>
      )}

      {searching && !result && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card h-36 animate-pulse" />
          ))}
        </div>
      )}

      {result && s && (
        <div className={`mt-6 space-y-6 ${searching ? "opacity-60" : ""}`}>
          <p className="text-[14px] text-[var(--color-ink)]">
            <span className="font-semibold">{count(result.total)}</span> live listings for “{result.query}” on {result.market.flag} {result.market.name}
            {result.delivery?.filter && result.delivery.filter !== "all" ? (
              <span className="text-[var(--color-muted)]">
                {" "}
                · figures from the {count(s.sampled)} of the top {count(result.delivery.counts.all)} that deliver{" "}
                {result.delivery.filter === "similar" ? "like you" : result.delivery.filter === "faster" ? "faster than you" : "slower than you"}
              </span>
            ) : (
              s.sampled < result.total && <span className="text-[var(--color-muted)]"> · figures from the top {count(s.sampled)}</span>
            )}
          </p>

          {result.delivery && (
            <DeliveryBar delivery={result.delivery} accountName={connection.label} busy={searching} onChange={compareWith} />
          )}
          {a && <VerdictCard verdict={a.verdict} advice={result.advice} checking={checking} />}
          {a && (
            <div className="grid gap-4 lg:grid-cols-3">
              <PriceCard price={a.price} currency={currency} />
              <TitleCard advice={result.advice} keywords={a.keywords} checking={checking} />
              <RiskCard risks={a.risks} checking={checking} />
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Price buyers pay"
              value={s.price ? money(s.price.median, currency) : "—"}
              lines={s.price ? [`Middle price, postage included`, `${money(s.price.min, currency)} to ${money(s.price.max, currency)} · average ${money(s.price.average, currency)}`] : ["No prices"]}
            />
            <Stat
              label="Demand"
              value={s.sold ? `${count(Math.round(s.sold.perMonth))}/mo` : "—"}
              lines={
                s.sold
                  ? [
                      `Sold a month by the ${s.sold.read} listings read · about ${bigMoney(s.sold.revenuePerMonth, currency)}`,
                      `${count(s.sold.total)} sold in all (${bigMoney(s.sold.revenue, currency)}) · ${s.sold.selling} of ${s.sold.read} have sold`,
                    ]
                  : ["Sold counts not read yet"]
              }
            />
            <Stat
              label="Competition"
              value={`${count(s.sellers)} sellers`}
              lines={[`In the top ${count(s.sampled)} listings`, `Biggest seller has ${s.topSellerShare}% · ${s.newInLast30Days} listed in the last 30 days`]}
            />
            <Stat
              label={`Ships from ${result.market.countryName}`}
              value={`${s.domestic}%`}
              lines={[`${100 - s.domestic}% ship from overseas`, `${s.freePostage}% offer free postage`]}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card p-5">
              <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Where prices sit</h2>
              <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">Listings in each price band, postage included</p>
              {s.bands.length ? (
                <div className="mt-4 flex h-40 items-end gap-1.5" role="img" aria-label="Listings per price band">
                  {s.bands.map((band) => {
                    const max = Math.max(...s.bands.map((b) => b.count));
                    return (
                      <div key={band.from} className="group flex min-w-0 flex-1 flex-col items-center gap-1" title={`${money(band.from, currency)}${band.to === null ? " and up" : `–${money(band.to, currency)}`}: ${band.count} listings`}>
                        <span className="text-[11px] tabular-nums text-[var(--color-muted)]">{band.count}</span>
                        <div className="w-full rounded-t-md bg-[var(--color-primary)] opacity-80 group-hover:opacity-100" style={{ height: `${Math.max(4, (band.count / max) * 110)}px` }} />
                        <span className="w-full truncate text-center text-[10.5px] tabular-nums text-[var(--color-muted)]">
                          {`${currencySymbol(currency)}${band.from}${band.to === null ? "+" : ""}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="py-8 text-center text-[13px] text-[var(--color-muted)]">Too few listings to show a spread.</p>
              )}
            </section>
            <section className="card p-5">
              <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Biggest sellers</h2>
              <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">Listings each has in the top {count(s.sampled)}, and what the ones read have sold</p>
              <table className="mt-3 w-full text-[13px]">
                <thead className="text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
                  <tr>
                    <th className="pb-1.5 font-semibold">Seller</th>
                    <th className="pb-1.5 text-right font-semibold">Listings</th>
                    <th className="pb-1.5 text-right font-semibold">Sold</th>
                    <th className="pb-1.5 text-right font-semibold">Sales</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-line)]">
                  {s.topSellers.map((seller) => (
                    <tr key={seller.username}>
                      <td className="max-w-0 py-2 pr-2">
                        <span className="block truncate text-[var(--color-ink)]">{seller.username}</span>
                        {seller.feedbackPercentage !== null && (
                          <span className="block text-[11.5px] text-[var(--color-muted)]">
                            {seller.feedbackPercentage}% · {count(seller.feedbackScore ?? 0)} feedback
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right font-semibold tabular-nums text-[var(--color-ink)]">{seller.listings}</td>
                      <td className="py-2 text-right tabular-nums text-[var(--color-ink)]">{seller.sold === null ? <span className="text-[var(--color-muted)]">—</span> : count(seller.sold)}</td>
                      <td className="py-2 text-right tabular-nums text-[var(--color-ink)]">{seller.revenue === null ? <span className="text-[var(--color-muted)]">—</span> : bigMoney(seller.revenue, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
              <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Listings</h2>
              <div className="flex flex-wrap items-center gap-2">
                {unread.length > 0 && (
                  <button type="button" onClick={() => readMoreSold(ordered)} disabled={readingSold} className="btn btn-secondary btn-sm">
                    {readingSold ? "Reading sold counts…" : `Read sold counts for the next ${Math.min(20, unread.length)}`}
                  </button>
                )}
                <div role="radiogroup" aria-label="Sort" className="inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
                  {RESEARCH_SORTS.map((o) => (
                    <button
                      key={o.key}
                      type="button"
                      role="radio"
                      aria-checked={sort === o.key}
                      onClick={() => setSort(o.key)}
                      className={`h-7 rounded-full px-3 text-[12px] font-medium ${sort === o.key ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"}`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <ResearchListings items={ordered.slice(0, shown)} currency={currency} connectionId={connection.id} maxSold={maxSold} />
            {shown < ordered.length && (
              <div className="border-t border-[var(--color-line)] px-4 py-3 text-center">
                <button type="button" onClick={() => setShown((n) => n + PAGE)} className="btn btn-ghost btn-sm">
                  Show {Math.min(PAGE, ordered.length - shown)} more of {count(ordered.length)}
                </button>
              </div>
            )}
          </section>
          <p className="text-[12px] text-[var(--color-muted)]">
            Sold is eBay&apos;s own count of how many a listing has sold since it went live; a month is counted from that date. Sales is that
            count at today&apos;s price with postage — eBay doesn&apos;t give past sale prices. Sold listings from the last 90 days (what
            eBay&apos;s Terapeak shows) need eBay&apos;s approval for Liston first.
          </p>
        </div>
      )}
    </AccountShell>
  );
}
