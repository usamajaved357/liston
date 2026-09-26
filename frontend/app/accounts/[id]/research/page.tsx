"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError, ResearchBudget, ResearchDeliveryFilter, ResearchItem, ResearchResult } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import { AccountPageSkeleton } from "@/components/Skeleton";
import { currencySymbol } from "@/lib/format";
import { count } from "@/components/research/format";
import { ResearchFolds, ResearchOverview } from "@/components/research/ResearchPanels";
import { RESEARCH_SORTS, ResearchListings, ResearchSort, sortResearch } from "@/components/research/ResearchListings";
import { DeliveryBar } from "@/components/research/DeliveryBar";
import { SoldListings } from "@/components/research/SoldListings";

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
  // The listings card: what's live now, or what sold in the last 90 days.
  const [view, setView] = useState<"active" | "sold">("active");
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
      {budget && (
        <p className="mt-2 px-1 text-[12px] text-[var(--color-muted)]" title="Fixed-price listings. Each search reads up to 200 listings and the sold counts of the top 20.">
          {count(budget.remaining)} of {count(budget.limit)} research reads left today
        </p>
      )}

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
        <div className={`mt-5 space-y-4 ${searching ? "opacity-60" : ""}`}>
          <p className="px-1 text-[13px] text-[var(--color-muted)]">
            <span className="font-semibold text-[var(--color-ink)]">{count(result.total)}</span> live listings
            {result.delivery?.filter && result.delivery.filter !== "all"
              ? ` · figures from the ${count(s.sampled)} that deliver ${result.delivery.filter === "similar" ? "like you" : result.delivery.filter === "faster" ? "faster" : "slower"}`
              : s.sampled < result.total
                ? ` · figures from the top ${count(s.sampled)}`
                : ""}
          </p>

          <ResearchOverview result={result} checking={checking} onRecheck={() => asked.current && readAdvice(asked.current)}>
            {result.delivery && <DeliveryBar delivery={result.delivery} accountName={connection.label} busy={searching} onChange={compareWith} />}
          </ResearchOverview>
          <ResearchFolds result={result} checking={checking} />

          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
              <div role="tablist" aria-label="Listings" className="flex items-center gap-1">
                {[
                  { key: "active" as const, label: "Active", n: result.items.length, removed: 0 },
                  { key: "sold" as const, label: "Sold · 90 days", n: result.sales?.available ? result.sales.items.length : null, removed: result.sales?.available ? result.sales.summary.removed : 0 },
                ].map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={view === t.key}
                    onClick={() => setView(t.key)}
                    className={`relative flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold transition-colors ${
                      view === t.key ? "bg-[var(--color-paper)] text-[var(--color-ink)]" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                    }`}
                  >
                    {t.label}
                    {t.n !== null && <span className="text-[12px] font-medium tabular-nums text-[var(--color-muted)]">{count(t.n)}</span>}
                    {t.removed > 0 && <span className="rounded-full bg-rose-50 px-1.5 text-[11px] font-semibold text-rose-700 ring-1 ring-inset ring-rose-200">{t.removed} removed</span>}
                  </button>
                ))}
              </div>
              {view === "active" && (
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
              )}
            </div>
            {view === "sold" ? (
              <SoldListings sales={result.sales ?? { available: false }} currency={currency} />
            ) : (
              <ResearchListings items={ordered.slice(0, shown)} currency={currency} connectionId={connection.id} maxSold={maxSold} />
            )}
            {view === "active" && shown < ordered.length && (
              <div className="border-t border-[var(--color-line)] px-4 py-3 text-center">
                <button type="button" onClick={() => setShown((n) => n + PAGE)} className="btn btn-ghost btn-sm">
                  Show {Math.min(PAGE, ordered.length - shown)} more of {count(ordered.length)}
                </button>
              </div>
            )}
          </section>
          <p className="text-[12px] text-[var(--color-muted)]">
            {view === "active"
              ? "Sold is eBay's own count of how many a listing has sold since it went live; a month is counted from that date. Sales is that count at today's price with postage."
              : result.sales?.available
                ? "From eBay's sales history for the last 90 days. A listing eBay removed can't be opened any more; Liston tells it apart from one that ended the normal way by asking eBay about it."
                : ""}
          </p>
        </div>
      )}
    </AccountShell>
  );
}
