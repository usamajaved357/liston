"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, AccountAnalytics, AnalyticsRange } from "@/lib/api";
import { cacheResponse, cachedResponse, readView, writeView } from "@/lib/viewState";
import { slug } from "@/lib/csv";
import { useConnection } from "@/lib/useConnection";
import { useAccountEvents } from "@/lib/useAccountEvents";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import { SegmentedControl } from "@/components/charts/SegmentedControl";
import { dayLabel, dayLabelLong, dayRangeLabel, timeAgo } from "@/components/charts/chart-format";
import { MetricsBoard } from "@/components/analytics/MetricsBoard";
import { ListingsTable } from "@/components/analytics/ListingsTable";
import { GrowthCard, SourcesStrip, TopMoversCard, WorthALookCard } from "@/components/analytics/InsightCards";
import type { ListingFilter } from "@/components/analytics/insights";
import { ListingAnalyticsPanel } from "@/components/analytics/ListingAnalyticsPanel";
import { RANGE_OPTIONS, comparedFor } from "@/components/analytics/metrics";

// Analytics: how the account's live listings are doing. Traffic
// (impressions, views, click-through) is eBay's, stored daily by the
// backend because eBay allows ~100 traffic calls a day for the whole app;
// sales are counted from the orders and include today. Nothing here calls
// eBay on its own; traffic arrives each day once eBay closes it.

const RANGE_KEYS = RANGE_OPTIONS.map((r) => r.key);

type AnalyticsView = { range: AnalyticsRange; openItem: string | null; listingFilter: ListingFilter; scrollTop: number };

// On the right of the ranges, as plain text: the last complete day the
// figures reach, with a dot (green when up to date, pulsing while
// updating). The details are in its tooltip.
function Freshness({ data }: { data: AccountAnalytics }) {
  const { sync } = data;
  const details = [
    sync.finalThrough && `Complete to ${dayLabelLong(sync.finalThrough)}.`,
    "Today's traffic arrives once eBay closes the day; sales are live.",
    `Next day added ${new Date(sync.nextSyncAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: data.timeZone })}.`,
    sync.history && !sync.history.complete && `Listing history: ${sync.history.stored} of ${sync.history.needed} days stored.`,
    `Days follow ${data.timeZone.replace("_", " ")} time. Last read from eBay ${timeAgo(sync.lastSyncedAt)}.`,
  ]
    .filter(Boolean)
    .join(" ");
  const date = sync.finalThrough ? new Date(`${sync.finalThrough}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : null;
  return (
    <span
      title={details}
      className="inline-flex cursor-help items-center gap-2 whitespace-nowrap text-[12.5px]"
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        {sync.syncing && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-primary)] opacity-60" />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${sync.syncing ? "bg-[var(--color-primary)]" : date ? "bg-emerald-500" : "bg-amber-400"}`} />
      </span>
      {sync.syncing ? (
        <span className="font-medium text-[var(--color-primary)]">Updating…</span>
      ) : date ? (
        <>
          <span className="text-[var(--color-muted)]">Updated at</span>
          <span className="font-semibold text-[var(--color-ink)]">{date}</span>
        </>
      ) : (
        <span className="text-[var(--color-muted)]">Waiting for eBay</span>
      )}
    </span>
  );
}

function AnalyticsPageInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { connection, user, loading, error } = useConnection(params.id);

  // Coming back (Back, or the sidebar) shows the page as it was left: the
  // range, the open listing, the group picked, the table and the scroll.
  // The URL wins when it names a range or listing.
  const viewKey = `analytics:${params.id}`;
  const [saved] = useState(() => readView<AnalyticsView>(viewKey));
  const urlRange = searchParams.get("range") as AnalyticsRange | null;
  const [range, setRange] = useState<AnalyticsRange>(() =>
    urlRange && RANGE_KEYS.includes(urlRange) ? urlRange : saved.range && RANGE_KEYS.includes(saved.range) ? saved.range : "30d"
  );
  const responseKey = (r: AnalyticsRange) => `analytics:${params.id}:${r}`;
  // The figures last shown for this range paint at once; they're re-read straight after.
  const [byRange, setByRange] = useState<Record<string, AccountAnalytics | { error: string }>>(() => {
    const cached = cachedResponse<AccountAnalytics>(responseKey(range));
    return cached ? { [range]: cached } : {};
  });
  const [shown, setShown] = useState<AccountAnalytics | null>(() => cachedResponse<AccountAnalytics>(responseKey(range)) ?? null);
  const [reload, setReload] = useState(0);
  const [openItem, setOpenItem] = useState<string | null>(() => searchParams.get("listing") ?? (urlRange ? null : saved.openItem ?? null));
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [listingFilter, setListingFilter] = useState<ListingFilter>(saved.listingFilter ?? "all");

  useEffect(() => writeView<AnalyticsView>(viewKey, { range, openItem, listingFilter }), [viewKey, range, openItem, listingFilter]);

  const loaded = byRange[range];
  const fresh = loaded && !("error" in loaded) ? loaded : null;
  const loadError = loaded && "error" in loaded ? loaded.error : null;
  // The last figures stay on screen, dimmed, while another range loads.
  const data = fresh || shown;
  const canView = connection ? connection.permissions === undefined || Boolean(connection.permissions.analytics) : false;

  useEffect(() => {
    if (!connection || !canView) return;
    let cancelled = false;
    api
      .getAnalytics(connection.id, range)
      .then((d) => {
        if (cancelled) return;
        cacheResponse(`analytics:${connection.id}:${range}`, d);
        setByRange((m) => ({ ...m, [range]: d }));
        setShown(d);
      })
      .catch((err) => !cancelled && setByRange((m) => ({ ...m, [range]: { error: err instanceof ApiError ? err.message : "Couldn't load analytics." } })));
    return () => {
      cancelled = true;
    };
  }, [connection, canView, range, reload]);

  // The page's scroll: kept as it moves, put back once the figures are on
  // screen again.
  // Ready once the page's own frame (and its scrolling area) is on screen.
  const scrollReady = Boolean(data) && !loading && canView;
  const scrollRestored = useRef(false);
  useEffect(() => {
    if (!scrollReady) return;
    const scroller = document.querySelector<HTMLElement>("[data-scroller]");
    if (!scroller) return;
    if (!scrollRestored.current) {
      scrollRestored.current = true;
      if (saved.scrollTop) scroller.scrollTop = saved.scrollTop;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => writeView<AnalyticsView>(viewKey, { scrollTop: scroller.scrollTop }), 120);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [scrollReady, saved.scrollTop, viewKey]);

  // New traffic from eBay (the daily update, a refresh, backfill) or a new
  // sale re-reads the figures; the frame stays put while it does.
  useAccountEvents(connection && canView ? connection.id : null, (event) => {
    if (event.kind === "analytics" || event.kind === "orders") {
      setByRange({});
      setReload((n) => n + 1);
    }
  });

  const setUrl = useCallback(
    (next: { range?: AnalyticsRange; listing?: string | null }) => {
      const q = new URLSearchParams(searchParams.toString());
      if (next.range) q.set("range", next.range);
      if (next.listing !== undefined) {
        if (next.listing) q.set("listing", next.listing);
        else q.delete("listing");
      }
      router.replace(`/accounts/${params.id}/analytics?${q.toString()}`, { scroll: false });
    },
    [router, searchParams, params.id]
  );

  function changeRange(next: AnalyticsRange) {
    setRange(next);
    setUrl({ range: next });
  }

  // A group picked in "Growth opportunities": the table below shows it.
  function showGroup(filter: ListingFilter) {
    setListingFilter(filter);
    requestAnimationFrame(() => document.getElementById("analytics-listings")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function openListing(itemId: string | null) {
    setOpenItem(itemId);
    setUrl({ listing: itemId });
  }

  const [loadingAll, setLoadingAll] = useState(false);
  async function loadAll() {
    if (!connection) return;
    setLoadingAll(true);
    setNotice(null);
    try {
      const { calls, listings } = await api.loadAllListingAnalytics(connection.id, range);
      setNotice({ tone: "success", text: `Figures for all ${listings.toLocaleString()} listings loaded (${calls} ${calls === 1 ? "call" : "calls"} from today's allowance).` });
      setByRange({});
      setReload((n) => n + 1);
    } catch (err) {
      setNotice({ tone: "danger", text: err instanceof ApiError ? err.message : "Couldn't load every listing." });
    } finally {
      setLoadingAll(false);
    }
  }

  async function reconnect() {
    if (!connection) return;
    setReconnecting(true);
    try {
      const { authorizeUrl } = await api.reauthorizeConnection(connection.id, `/accounts/${connection.id}/analytics`);
      window.location.href = authorizeUrl;
    } catch (err) {
      setReconnecting(false);
      setNotice({ tone: "danger", text: err instanceof ApiError ? err.message : "Couldn't start reconnecting." });
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-10">
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="h-6 w-40 animate-pulse rounded-full bg-[var(--color-line)]" />
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="card h-24 animate-pulse" />
            ))}
          </div>
          <div className="card h-80 animate-pulse" />
        </div>
      </main>
    );
  }
  if (error || !connection || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <Alert>{error || "This account connection doesn't exist, or isn't yours."}</Alert>
      </main>
    );
  }

  const compared = comparedFor(range);
  const rangeLabel = data ? dayRangeLabel(data.range.from, data.range.to) : "";
  // Downloads are named for the account and the dates they cover.
  const csvBase = data ? `${slug(connection.label)}-${data.range.from}-to-${data.range.to}` : undefined;

  return (
    <AccountShell
      connectionId={connection.id}
      label={connection.label}
      platformKey={connection.platform_key}
      platformName={connection.platform_name}
      marketplace={connection.marketplace}
      permissions={connection.permissions}
      user={user}
      header={
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Analytics</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">How your live listings are seen, clicked and bought · traffic from eBay, sales from your orders</p>
        </div>
      }
      subheader={
        canView && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SegmentedControl label="Date range" value={range} onChange={changeRange} options={RANGE_OPTIONS.map((r) => ({ key: r.key, label: r.label }))} />
            {data && data.status === "ok" && <Freshness data={data} />}
          </div>
        )
      }
    >
      {!canView ? (
        <div className="card px-6 py-12 text-center">
          <p className="text-sm font-medium text-[var(--color-ink)]">You don&apos;t have access to Analytics for this account</p>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">Ask the account owner to give you Analytics access on the Team page.</p>
        </div>
      ) : (
        <div className={`space-y-5 transition-opacity ${data && !fresh ? "opacity-60" : ""}`}>
          {notice && (
            <div className={`notice ${notice.tone === "success" ? "notice-success" : "notice-danger"}`}>
              <span className="flex-1">{notice.text}</span>
              <button type="button" onClick={() => setNotice(null)} className="text-[12px] font-semibold opacity-70 hover:opacity-100">
                Dismiss
              </button>
            </div>
          )}
          {loadError && !data && <Alert>{loadError}</Alert>}

          {data?.status === "reconnect" && (
            <div className="card flex flex-wrap items-center gap-4 border-[#fde68a] bg-[var(--color-warning-soft)] p-5">
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-white text-[var(--color-warning)]">
                <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
                  <path d="M4 17l5-5 4 4 7-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-[var(--color-ink)]">Reconnect to see impressions and views</p>
                <p className="mt-0.5 text-[13px] text-[#92400e]">This account was linked before eBay&apos;s traffic permission existed. Reconnect once; your sales below are already here.</p>
              </div>
              <button type="button" onClick={reconnect} disabled={reconnecting} className="btn btn-primary btn-sm">
                {reconnecting ? "Opening eBay…" : "Reconnect"}
              </button>
            </div>
          )}
          {data?.status === "unsupported" && <div className="notice notice-warning">eBay&apos;s traffic report doesn&apos;t cover this account&apos;s eBay site yet. Sales below are from your orders.</div>}
          {data?.status === "ok" && data.sync.lastError && <div className="notice notice-warning">The last update from eBay stopped early: {data.sync.lastError}</div>}
          {data?.status === "ok" && data.sync.waitingForAllowance && (
            <div className="notice notice-warning">Today&apos;s eBay allowance for traffic data is used up, so this account&apos;s latest figures are read after the reset. Sales are up to date.</div>
          )}
          {data?.status === "ok" && <SourcesStrip sources={data.sources} />}

          <MetricsBoard
            totals={data?.totals ?? null}
            changes={data?.changes ?? null}
            series={data?.series ?? []}
            previousSeries={data?.previousSeries ?? null}
            leadInSeries={data?.leadInSeries ?? null}
            currency={data?.currency ?? null}
            range={range}
            rangeLabel={rangeLabel}
            previousRange={data?.range.previous ?? null}
            loading={!data && !loadError}
            trafficUnavailable={data ? data.status !== "ok" || !data.sync.finalThrough : false}
            csvName={csvBase}
          />

          {data && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              <GrowthCard data={data} onPick={showGroup} />
              <TopMoversCard data={data} onOpen={openListing} />
              <WorthALookCard data={data} onOpen={openListing} />
            </div>
          )}

          {data && (
            <ListingsTable
              rows={data.listings}
              currency={data.currency}
              compared={compared}
              onOpen={openListing}
              report={data.listingReport}
              partial={data.range.partial}
              onLoadAll={loadAll}
              loadingAll={loadingAll}
              filter={listingFilter}
              onFilter={setListingFilter}
              viewKey={`${viewKey}:table`}
              history={data.sync.history}
              csvName={csvBase && `${slug(connection.label)}-listings-${data.range.from}-to-${data.range.to}`}
            />
          )}
        </div>
      )}

      {openItem && canView && <ListingAnalyticsPanel connectionId={connection.id} itemId={openItem} initialRange={range} onClose={() => openListing(null)} />}
    </AccountShell>
  );
}

// useSearchParams (the range and open listing live in the URL) needs a
// Suspense boundary above it.
export default function AnalyticsPage() {
  return (
    <Suspense fallback={null}>
      <AnalyticsPageInner />
    </Suspense>
  );
}
