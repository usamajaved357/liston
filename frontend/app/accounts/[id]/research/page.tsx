"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError, ResearchBudget, ResearchDeliveryFilter, ResearchItem, ResearchResult } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import { AccountPageSkeleton } from "@/components/Skeleton";
import { count } from "@/components/research/format";
import { ResearchFolds, ResearchOverview } from "@/components/research/ResearchPanels";
import { RESEARCH_SORTS, ResearchListings, ResearchSort, sortResearch } from "@/components/research/ResearchListings";
import { DeliveryBar } from "@/components/research/DeliveryBar";
import { SoldListings } from "@/components/research/SoldListings";
import { SegmentedControl } from "@/components/charts/SegmentedControl";

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
    return runWith({ q: query.trim(), condition, minPrice: "", maxPrice: "" });
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
      actions={
        budget ? (
          <span
            className="inline-flex h-[30px] items-center gap-1.5 rounded-full bg-[var(--color-panel)] px-3 text-[12px] text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)]"
            title="eBay reads research can use today. Each search reads up to 200 fixed-price listings and the sold counts of the top 20. Resets when eBay's allowance does."
          >
            <span className={`h-1.5 w-1.5 rounded-full ${budget.remaining / budget.limit > 0.2 ? "bg-emerald-500" : budget.remaining > 0 ? "bg-amber-500" : "bg-rose-500"}`} aria-hidden />
            <b className="font-semibold tabular-nums text-[var(--color-ink)]">{count(budget.remaining)}</b>/{count(budget.limit)} reads left today
          </span>
        ) : undefined
      }
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
        <SegmentedControl
          label="Condition"
          value={condition}
          onChange={setCondition}
          options={[
            { key: "new", label: "New" },
            { key: "used", label: "Used" },
            { key: "any", label: "Any" },
          ]}
        />
        <button type="submit" disabled={searching || q.trim().length < 2} className="btn btn-primary btn-sm !h-9 px-4">
          {searching ? "Searching…" : "Research"}
        </button>
      </form>

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
        <div className={`mt-4 space-y-4 ${searching ? "opacity-60" : ""}`}>
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
            <div className="flex flex-wrap items-center justify-between gap-x-4 border-b border-[var(--color-line)] px-4">
              <div role="tablist" aria-label="Listings" className="flex gap-x-1">
                {[
                  { key: "active" as const, label: "Active", n: result.items.length, removed: 0 },
                  { key: "sold" as const, label: "Sold · 90 days", n: result.sales?.available ? result.sales.items.length : null, removed: result.sales?.available ? result.sales.summary.removed : 0 },
                ].map((t) => {
                  const on = view === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => setView(t.key)}
                      className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3.5 py-3 text-[14px] font-medium transition-colors ${
                        on ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                      }`}
                    >
                      {t.label}
                      {t.n !== null && <span className="text-[12.5px] tabular-nums opacity-70">{count(t.n)}</span>}
                      {t.removed > 0 && <span className="rounded-full bg-rose-50 px-1.5 text-[11px] font-semibold text-rose-700 ring-1 ring-inset ring-rose-200">{t.removed} removed</span>}
                    </button>
                  );
                })}
              </div>
              {view === "active" && (
                <div className="flex flex-wrap items-center gap-2 py-2">
                  <SegmentedControl size="sm" label="Sort" value={sort} onChange={setSort} options={RESEARCH_SORTS} />
                  {unread.length > 0 && (
                    <button
                      type="button"
                      onClick={() => readMoreSold(ordered)}
                      disabled={readingSold}
                      title="Read eBay's sold count for the next listings that don't have one yet"
                      className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)] disabled:opacity-60"
                    >
                      <svg viewBox="0 0 20 20" fill="none" className={`h-3.5 w-3.5 ${readingSold ? "animate-spin" : ""}`} aria-hidden>
                        <path d="M16 10a6 6 0 11-1.8-4.3M16 4v3.5h-3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {readingSold ? "Reading…" : `Sold counts for ${Math.min(20, unread.length)} more`}
                    </button>
                  )}
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
