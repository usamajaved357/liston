"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, AccountAnalytics, AnalyticsRange } from "@/lib/api";
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
// sales are counted from the orders and include today. Changing the range
// never calls eBay — only "Refresh today" does, a few times a day.

const RANGE_KEYS = RANGE_OPTIONS.map((r) => r.key);

function timeOfDay(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// One short line beside the ranges; the details are in its tooltip.
function Freshness({ data }: { data: AccountAnalytics }) {
  const { sync } = data;
  const details = [
    sync.finalThrough && `Complete to ${dayLabelLong(sync.finalThrough)}.`,
    sync.todayUpdatedAt && `Today so far as of ${timeOfDay(sync.todayUpdatedAt)}.`,
    `Next day added ${new Date(sync.nextSyncAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}.`,
    sync.history && !sync.history.complete && `Listing history: ${sync.history.stored} of ${sync.history.needed} days stored.`,
    `Days follow ${data.timeZone.replace("_", " ")} time. Last read from eBay ${timeAgo(sync.lastSyncedAt)}.`,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span title={details} className="inline-flex cursor-help items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-2.5 py-1 text-[11.5px] text-[var(--color-muted)]">
      {sync.syncing ? (
        <>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-primary)]" aria-hidden />
          <span className="font-medium text-[var(--color-primary)]">Updating…</span>
        </>
      ) : (
        <>
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
          {sync.finalThrough ? `Updated to ${dayLabel(sync.finalThrough)}` : "Waiting for eBay"}
        </>
      )}
    </span>
  );
}

function AnalyticsPageInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { connection, user, loading, error } = useConnection(params.id);

  const urlRange = searchParams.get("range") as AnalyticsRange | null;
  const [range, setRange] = useState<AnalyticsRange>(urlRange && RANGE_KEYS.includes(urlRange) ? urlRange : "30d");
  const [byRange, setByRange] = useState<Record<string, AccountAnalytics | { error: string }>>({});
  const [shown, setShown] = useState<AccountAnalytics | null>(null);
  const [reload, setReload] = useState(0);
  const [openItem, setOpenItem] = useState<string | null>(searchParams.get("listing"));
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [listingFilter, setListingFilter] = useState<ListingFilter>("all");

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
        setByRange((m) => ({ ...m, [range]: d }));
        setShown(d);
      })
      .catch((err) => !cancelled && setByRange((m) => ({ ...m, [range]: { error: err instanceof ApiError ? err.message : "Couldn't load analytics." } })));
    return () => {
      cancelled = true;
    };
  }, [connection, canView, range, reload]);

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

  async function refreshToday() {
    if (!connection) return;
    setRefreshing(true);
    setNotice(null);
    try {
      const { refreshesLeft } = await api.refreshAnalyticsToday(connection.id);
      setNotice({ tone: "success", text: `Today's figures updated from eBay. ${refreshesLeft} ${refreshesLeft === 1 ? "refresh" : "refreshes"} left today.` });
      setByRange({});
      setReload((n) => n + 1);
    } catch (err) {
      setNotice({ tone: "danger", text: err instanceof ApiError ? err.message : "Couldn't refresh today's figures." });
    } finally {
      setRefreshing(false);
    }
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
  const refreshDisabled = refreshing || !data || data.status !== "ok" || data.sync.refreshesLeft <= 0;

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
      actions={
        canView && (
          <button
            type="button"
            onClick={refreshToday}
            disabled={refreshDisabled}
            className="btn btn-secondary btn-sm"
            title={data && data.sync.refreshesLeft <= 0 ? "Today's refreshes are used. Figures update daily at 10:00 UK time." : "Read today's figures so far from eBay"}
          >
            <svg viewBox="0 0 24 24" fill="none" className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden>
              <path d="M20 12a8 8 0 11-2.34-5.66M20 4v5h-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {refreshing ? "Refreshing…" : "Refresh today"}
            {data && data.status === "ok" && <span className="rounded-full bg-[var(--color-paper)] px-1.5 text-[11px] font-semibold text-[var(--color-muted)]">{data.sync.refreshesLeft} left</span>}
          </button>
        )
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
              days={data.range.days}
              onOpen={openListing}
              report={data.listingReport}
              partial={data.range.partial}
              todayRead={Boolean(data.sync.todayListingsUpdatedAt)}
              onLoadAll={loadAll}
              loadingAll={loadingAll}
              filter={listingFilter}
              onFilter={setListingFilter}
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
