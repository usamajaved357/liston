"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, Connection, HuntFilters, HuntList, HuntSort, HuntView } from "@/lib/api";
import { ViewMenu } from "@/components/ViewMenu";
import { currencySymbol } from "@/lib/format";
import { useConnection } from "@/lib/useConnection";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import { AccountPageSkeleton } from "@/components/Skeleton";
import { HuntAddBar, HuntCheck, HuntForm } from "@/components/hunting/HuntForm";
import { HuntRows, PipelineTabs, SORT_LABELS } from "@/components/hunting/HuntList";
import { HuntPanel } from "@/components/hunting/HuntPanel";
import { DiscoverHuntDialog } from "@/components/hunting/DiscoverHuntDialog";
import { PushPrompt } from "@/components/NotificationBell";
import { DiscoverPanel } from "@/components/discover/DiscoverPanel";

// Product hunting on one eBay account: team members find products (a
// competitor's listing and the AliExpress product to supply it), Liston
// works out the profit on every option, and each product waits for a
// reviewer before anyone may draft it. Reviewers see the queue; listers
// see what's approved, ready to draft. Each team member's hunting figures
// are on their own page in the owner's Team area, not here. The Discover
// tab (?tab=discover) is where hunters find what to hunt: categories and
// keywords, what's selling, a watchlist.

const VIEWS: HuntView[] = ["all", "sourcing", "review", "approved", "drafted", "listed", "rejected", "mine"];

// The filter menu's choices; the server takes only these values.
const PROFIT_STEPS = [1, 2, 3, 5, 10];
const DEMAND_STEPS = [5, 10, 30, 100];
const ADDED_STEPS: { days: number; label: string; short: string }[] = [
  { days: 7, label: "Last 7 days", short: "Added in 7 days" },
  { days: 30, label: "Last 30 days", short: "Added in 30 days" },
  { days: 90, label: "Last 90 days", short: "Added in 90 days" },
];

// Where a person starts: reviewers on the queue, listers on what's approved, hunters on My hunts.
function startingView(connection: Connection): HuntView {
  const p = connection.permissions;
  if (!p || p.hunting_review) return "review";
  if (p.hunting) return "mine";
  return "approved";
}

function HuntingBody() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { connection, user, loading, error } = useConnection(params.id);
  const askedView = VIEWS.includes(search.get("view") as HuntView) ? (search.get("view") as HuntView) : null;
  const [view, setView] = useState<HuntView | null>(askedView);
  const [hunter, setHunter] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<HuntSort | "">("");
  const [filters, setFilters] = useState<HuntFilters>({});
  const filtered = Boolean(filters.profit || filters.demand || filters.added || filters.unique || hunter);
  const [data, setData] = useState<HuntList | null>(null);
  const [page, setPage] = useState(1);
  // Which list request last answered: the list is loading until the current one has.
  const [answered, setAnswered] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // The open product is the address's ?open=, so a notification or link to it opens it even when this page is already showing.
  const openId = search.get("open");
  // Opened with Edit: the panel starts with its edit form open.
  const [editing, setEditing] = useState(false);
  const [reload, setReload] = useState(0);
  // A product checked but not added yet: its Add bar is the page's footer.
  const [checked, setChecked] = useState<HuntCheck | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  // The Hunt a product form: hidden until asked for (or arriving with a competitor to hunt, from Research).
  const [showForm, setShowForm] = useState(Boolean(search.get("competitor")));
  // A fresh form after each add.
  const [formKey, setFormKey] = useState(0);
  const tab: "products" | "discover" = search.get("tab") === "discover" ? "discover" : "products";

  // The page's place in the URL, so a shared or reopened link lands the same.
  const writeUrl = useCallback(
    (next: { view?: HuntView | null; open?: string | null }) => {
      const qs = new URLSearchParams(search.toString());
      const put = (key: string, value: string | null) => {
        if (value) qs.set(key, value);
        else qs.delete(key);
      };
      if (next.view !== undefined) put("view", next.view);
      if (next.open !== undefined) put("open", next.open);
      qs.delete("competitor");
      router.replace(`/accounts/${params.id}/hunting${qs.toString() ? `?${qs.toString()}` : ""}`, { scroll: false });
    },
    [params.id, router, search]
  );

  useEffect(() => {
    const timer = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const effectiveView = view || (connection ? startingView(connection) : null);
  const requestKey = JSON.stringify([effectiveView, hunter, query, sort, filters, reload]);
  const listLoading = answered !== requestKey || loadingMore;

  useEffect(() => {
    if (!connection || !effectiveView) return;
    let cancelled = false;
    api
      .huntList(connection.id, { view: effectiveView, hunter: effectiveView === "mine" ? undefined : hunter || undefined, q: query || undefined, sort: sort || undefined, ...filters })
      .then((d) => {
        if (cancelled) return;
        // An empty queue on arrival: show everything instead.
        if (!view && d.view === "review" && d.counts.review === 0 && d.counts.all > 0) {
          setView("all");
          return;
        }
        setData(d);
        setPage(1);
        setListError(null);
      })
      .catch((err) => !cancelled && setListError(err instanceof ApiError ? err.message : "Couldn't load the hunted products."))
      .finally(() => !cancelled && setAnswered(requestKey));
    return () => {
      cancelled = true;
    };
  }, [connection, effectiveView, view, hunter, query, sort, filters, reload, requestKey]);

  async function loadMore() {
    if (!connection || !effectiveView || !data) return;
    setLoadingMore(true);
    try {
      const next = await api.huntList(connection.id, { view: effectiveView, hunter: effectiveView === "mine" ? undefined : hunter || undefined, q: query || undefined, sort: sort || undefined, ...filters, page: page + 1 });
      setData({ ...next, items: [...data.items, ...next.items] });
      setPage(page + 1);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Couldn't load more.");
    } finally {
      setLoadingMore(false);
    }
  }

  function changeView(next: HuntView) {
    setView(next);
    writeUrl({ view: next });
  }
  const open = useCallback(
    (id: string | null) => {
      setEditing(false);
      writeUrl({ open: id });
    },
    [writeUrl]
  );
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  // While an approved product drafts itself, look again every few seconds: it moves to Drafted when done.
  const draftingNow = Boolean(data?.items.some((h) => h.draftState === "drafting"));
  useEffect(() => {
    if (!draftingNow) return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [draftingNow, refresh]);

  function onChecked(next: HuntCheck | null) {
    setChecked(next);
    if (next) setAdded(null);
  }
  function onAdded(hunt: { stage: string }) {
    setChecked(null);
    setAdded(hunt.stage === "approved" ? "Added and approved: it's ready to draft." : "Added: it's waiting for a reviewer.");
    setFormKey((k) => k + 1);
    setShowForm(false);
    refresh();
  }
  const closePanel = useCallback(() => open(null), [open]);

  // Products (the hunted products) or Discover (what to hunt), in the address.
  function changeTab(next: "products" | "discover") {
    const qs = new URLSearchParams(search.toString());
    if (next === "discover") qs.set("tab", "discover");
    else qs.delete("tab");
    // Discover pressed again from inside a category or keyword: back to its start.
    if (next === "discover" && tab === "discover") {
      qs.delete("dc");
      qs.delete("dq");
    }
    qs.delete("competitor");
    router.push(`/accounts/${params.id}/hunting${qs.toString() ? `?${qs.toString()}` : ""}`, { scroll: false });
  }
  // "Hunt" in Discover: the listing added on its own, its supplier added on its page (DiscoverHuntDialog).
  const [sourcing, setSourcing] = useState<string | null>(null);

  const viewer = data?.viewer;
  const perms = connection?.permissions;
  const canHunt = viewer ? viewer.canHunt : !perms || Boolean(perms.hunting || perms.hunting_review);
  const canReview = viewer ? viewer.canReview : !perms || Boolean(perms.hunting_review);
  // Discover is for whoever hunts or reviews; their own keywords need the account's analytics.
  const canDiscover = !perms || Boolean(perms.hunting || perms.hunting_review);
  const canSeeTraffic = !perms || Boolean(perms.analytics);
  const views = useMemo(() => {
    // The same tabs for everyone, in one order (a person who only drafts sees Approved).
    const allowed = data?.views || VIEWS;
    return VIEWS.filter((v) => allowed.includes(v));
  }, [data?.views]);

  if (loading) return <AccountPageSkeleton />;
  if (error || !connection || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <Alert>{error || "This account connection doesn't exist, or isn't yours."}</Alert>
      </main>
    );
  }
  const market = connection.marketplace;
  const money = currencySymbol(market?.currency || "GBP");

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
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Product hunting</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Find products worth listing on {market?.name ?? "eBay"}. Each one is checked for profit and approved before it&apos;s drafted.</p>
        </div>
      }
      subheader={
        canDiscover ? (
          <div role="tablist" aria-label="Hunting" className="flex gap-x-1 border-b border-[var(--color-line)]">
            {(["products", "discover"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => changeTab(t)}
                className={`-mb-px shrink-0 border-b-2 px-3.5 py-2 text-[13.5px] font-medium transition-colors ${
                  tab === t ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                }`}
              >
                {t === "products" ? "Hunted products" : "Discover"}
              </button>
            ))}
          </div>
        ) : undefined
      }
      footer={checked ? <HuntAddBar key={checked.checkId} connectionId={connection.id} checked={checked} onDiscard={() => setChecked(null)} onAdded={onAdded} /> : undefined}
      pinFooter
      actions={
        canHunt && !showForm ? (
          <button
            type="button"
            onClick={() => {
              setShowForm(true);
              setAdded(null);
              if (tab === "discover") changeTab("products");
            }}
            className="btn btn-primary btn-sm !h-8 gap-1 !px-3 !text-[12.5px]"
          >
            <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
              <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
            Add a product
          </button>
        ) : undefined
      }
    >
      {tab === "discover" && canDiscover ? (
        <DiscoverPanel connectionId={connection.id} canSeeTraffic={canSeeTraffic} onHunt={setSourcing} />
      ) : (
      <div className="space-y-5">
        {added && !checked && (
          <div className="notice notice-success">
            <span className="flex-1">{added}</span>
            {/* Waiting for a reviewer: the moment to offer being told of the decision. */}
            {added.includes("waiting for a reviewer") && <PushPrompt />}
            <button type="button" onClick={() => setAdded(null)} className="text-[12.5px] font-semibold hover:underline">
              Dismiss
            </button>
          </div>
        )}
        {canHunt && showForm && (
          <HuntForm
            key={formKey}
            connectionId={connection.id}
            marketName={market?.name ?? "eBay"}
            initialCompetitor={formKey === 0 ? search.get("competitor") : null}
            checked={checked}
            onChecked={onChecked}
            onClose={() => {
              setShowForm(false);
              setChecked(null);
            }}
          />
        )}

        {/* The list steps aside while a checked product is on screen; it's back after Add or Discard. */}
        {!checked && (
          <section className="card">
            {/* Not clipped, so the filter menu can hang below the card; the rows round their own bottom corners. */}
            {/* One header row: the tabs, then who, search and sort on the right. */}
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-3 py-2.5">
              <PipelineTabs views={views} counts={data?.counts || ({} as HuntList["counts"])} value={effectiveView || "all"} onChange={changeView} />
              <div className="flex w-full min-w-0 items-center gap-2 sm:ml-auto sm:w-auto">
                <ViewMenu
                  title="Sort and filters"
                  sections={[
                    {
                      label: "Sort",
                      value: sort || (effectiveView === "review" ? "waiting" : "newest"),
                      options: (Object.keys(SORT_LABELS) as HuntSort[]).map((k) => ({ key: k, label: SORT_LABELS[k] })),
                      onChange: (k) => setSort(k === (effectiveView === "review" ? "waiting" : "newest") ? "" : (k as HuntSort)),
                    },
                    ...(canReview && effectiveView !== "mine" && (data?.hunters.length || 0) > 1
                      ? [
                          {
                            label: "Hunter",
                            value: hunter || "any",
                            hideInSummary: !hunter,
                            options: [{ key: "any", label: "Everyone" }, ...(data?.hunters || []).map((h) => ({ key: h.id, label: h.id === user.id ? "You" : h.name }))],
                            onChange: (k: string) => setHunter(k === "any" ? "" : k),
                          },
                        ]
                      : []),
                    {
                      label: "Profit a sale",
                      value: String(filters.profit || 0),
                      hideInSummary: !filters.profit,
                      options: [{ key: "0", label: "Any profit" }, ...PROFIT_STEPS.map((n) => ({ key: String(n), label: `${money}${n} or more`, short: `${money}${n}+ profit` }))],
                      onChange: (k) => setFilters((f) => ({ ...f, profit: Number(k) || null })),
                    },
                    {
                      label: "Demand",
                      value: String(filters.demand || 0),
                      hideInSummary: !filters.demand,
                      options: [{ key: "0", label: "Any demand" }, ...DEMAND_STEPS.map((n) => ({ key: String(n), label: `${n}+ sold a month`, short: `${n}+ sold/mo` }))],
                      onChange: (k) => setFilters((f) => ({ ...f, demand: Number(k) || null })),
                    },
                    {
                      label: "Added",
                      value: String(filters.added || 0),
                      hideInSummary: !filters.added,
                      options: [{ key: "0", label: "Any time" }, ...ADDED_STEPS.map((a) => ({ key: String(a.days), label: a.label, short: a.short }))],
                      onChange: (k) => setFilters((f) => ({ ...f, added: Number(k) || null })),
                    },
                    {
                      label: "On your other accounts",
                      value: filters.unique ? "unique" : "any",
                      hideInSummary: !filters.unique,
                      options: [
                        { key: "any", label: "Show every product" },
                        { key: "unique", label: "Only ones not already hunted, drafted or live elsewhere", short: "Not elsewhere" },
                      ],
                      onChange: (k) => setFilters((f) => ({ ...f, unique: k === "unique" })),
                    },
                  ]}
                />
                {filtered && (
                  <button
                    type="button"
                    onClick={() => {
                      setFilters({});
                      setHunter("");
                    }}
                    className="flex-shrink-0 text-[12px] font-medium text-[var(--color-primary)] hover:underline"
                  >
                    Clear
                  </button>
                )}
                <label className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
                  <span className="sr-only">Search</span>
                  <svg viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted)]" aria-hidden>
                    <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, item number, hunter or note" className="input input-sm !h-7 rounded-full !pl-8 !pr-8 !text-[12px]" aria-label="Search products" />
                  {q && (
                    <button
                      type="button"
                      onClick={() => setQ("")}
                      aria-label="Clear the search"
                      title="Clear"
                      className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
                    >
                      <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                        <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </label>
              </div>
            </div>
            {listError ? (
              <div className="p-4">
                <Alert>{listError}</Alert>
              </div>
            ) : (
              <HuntRows
                data={data}
                view={effectiveView || "all"}
                you={user.id}
                query={query}
                filtered={filtered}
                loading={listLoading}
                onOpen={open}
                onEdit={(id) => {
                  open(id);
                  setEditing(true);
                }}
                onMore={loadMore}
              />
            )}
          </section>
        )}
      </div>
      )}

      {sourcing && (
        <DiscoverHuntDialog
          key={sourcing}
          connectionId={connection.id}
          competitorUrl={sourcing}
          onClose={() => setSourcing(null)}
          onOpenHunt={(id) => {
            setSourcing(null);
            refresh();
            open(id);
          }}
        />
      )}
      {openId && <HuntPanel key={`${openId}-${editing}`} huntId={openId} you={user.id} onClose={closePanel} onChanged={refresh} startEditing={editing} />}
    </AccountShell>
  );
}

export default function HuntingPage() {
  return (
    <Suspense fallback={<AccountPageSkeleton />}>
      <HuntingBody />
    </Suspense>
  );
}
