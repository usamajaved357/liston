"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, AccountAnalytics, AnalyticsRange } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { useAccountEvents } from "@/lib/useAccountEvents";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import { SegmentedControl } from "@/components/charts/SegmentedControl";
import { BarList } from "@/components/charts/BarList";
import { dayLabel, dayLabelLong, dayRangeLabel, fullNumber, timeAgo } from "@/components/charts/chart-format";
import { MetricsBoard } from "@/components/analytics/MetricsBoard";
import { Funnel } from "@/components/analytics/Funnel";
import { HintChip, ListingsTable } from "@/components/analytics/ListingsTable";
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

function Freshness({ data }: { data: AccountAnalytics }) {
  const { sync } = data;
  const parts: string[] = [];
  if (sync.finalThrough) parts.push(`eBay traffic complete to ${dayLabelLong(sync.finalThrough)}`);
  if (sync.todayUpdatedAt) parts.push(`today so far as of ${timeOfDay(sync.todayUpdatedAt)}`);
  parts.push(`next update ${new Date(sync.nextSyncAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}`);
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
      {sync.syncing ? (
        <span className="inline-flex items-center gap-1.5 font-medium text-[var(--color-primary)]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-primary)]" /> Updating from eBay…
        </span>
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
      )}
      {parts.join(" · ")}
    </p>
  );
}

function InsightsCard({ data, onOpen }: { data: AccountAnalytics; onOpen: (id: string) => void }) {
  const withHints = data.listings.filter((l) => l.hint);
  const attention = withHints.filter((l) => l.hint!.kind !== "converting").sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const winners = withHints.filter((l) => l.hint!.kind === "converting").sort((a, b) => (b.sold ?? 0) - (a.sold ?? 0));
  const picks = [...attention.slice(0, 3), ...winners.slice(0, 2)];
  return (
    <section className="card flex flex-col p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Worth a look</h2>
        <span className="text-[11.5px] text-[var(--color-muted)]">
          {attention.length} need attention · {winners.length} converting well
        </span>
      </div>
      {!data.coverage.listingsComplete ? (
        <p className="mt-4 text-[12.5px] leading-relaxed text-[var(--color-muted)]">Suggestions appear once every day of this range has per-listing figures.</p>
      ) : picks.length === 0 ? (
        <p className="mt-4 text-[12.5px] leading-relaxed text-[var(--color-muted)]">Nothing stands out in this range. Every listing is getting seen and clicked at a normal rate.</p>
      ) : (
        <ul className="mt-3 -mx-2 flex-1 space-y-0.5">
          {picks.map((l) => (
            <li key={l.itemId}>
              <button type="button" onClick={() => onOpen(l.itemId)} className="group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-[var(--color-paper)]">
                {l.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={l.imageUrl} alt="" className="h-9 w-9 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-contain" loading="lazy" />
                ) : (
                  <span className="h-9 w-9 flex-shrink-0 rounded-lg bg-[var(--color-paper)]" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{l.title}</span>
                  <span className="mt-0.5 block text-[11.5px] text-[var(--color-muted)]">
                    {fullNumber(l.views)} views · {fullNumber(l.sold)} sold
                  </span>
                </span>
                <HintChip hint={l.hint!} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
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
        <div className={`space-y-6 transition-opacity ${data && !fresh ? "opacity-60" : ""}`}>
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
          {data?.status === "ok" && data.coverage.listingDaysDone < data.coverage.listingDaysTotal && (
            <div className="card flex flex-wrap items-center gap-4 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-[var(--color-ink)]">Building your per-listing history</p>
                <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">
                  {data.coverage.listingsFrom ? `Per-listing traffic from ${dayLabel(data.coverage.listingsFrom)}. ` : ""}
                  Earlier days are read from eBay a few at a time, within its daily allowance. Account totals above are already complete.
                </p>
              </div>
              <div className="w-48">
                <div className="flex justify-between text-[11.5px] text-[var(--color-muted)]">
                  <span>
                    {data.coverage.listingDaysDone} of {data.coverage.listingDaysTotal} days
                  </span>
                  <span>{Math.round((data.coverage.listingDaysDone / data.coverage.listingDaysTotal) * 100)}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-line)]">
                  <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${(data.coverage.listingDaysDone / data.coverage.listingDaysTotal) * 100}%` }} />
                </div>
              </div>
            </div>
          )}

          <MetricsBoard
            totals={data?.totals ?? null}
            changes={data?.changes ?? null}
            series={data?.series ?? []}
            previousSeries={data?.previousSeries ?? null}
            currency={data?.currency ?? null}
            range={range}
            rangeLabel={rangeLabel}
            previousRange={data?.range.previous ?? null}
            loading={!data && !loadError}
            trafficUnavailable={data ? data.status !== "ok" || !data.coverage.account : false}
          />

          {data && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <section className="card p-5">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">From shown to sold</h2>
                  <span className="text-[11.5px] text-[var(--color-muted)]">{rangeLabel}</span>
                </div>
                <div className="mt-4">
                  <Funnel impressions={data.totals.impressions} views={data.totals.views} sold={data.totals.sold} ctr={data.totals.ctr} />
                </div>
              </section>
              <section className="card p-5">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Where views came from</h2>
                  <span className="text-[11.5px] text-[var(--color-muted)]">{fullNumber(data.totals.views)} views</span>
                </div>
                <div className="mt-4">
                  <BarList items={data.sources.map((s) => ({ key: s.key, label: s.label, value: s.views }))} format={fullNumber} empty="No views recorded in this range yet." />
                </div>
              </section>
              <InsightsCard data={data} onOpen={openListing} />
            </div>
          )}

          {data && <ListingsTable rows={data.listings} currency={data.currency} compared={compared} onOpen={openListing} complete={data.coverage.listingsComplete} />}

          {data && (
            <p className="pb-2 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
              Impressions, views and click-through come from eBay&apos;s Analytics API; sales and units from your orders (cancelled orders excluded, postage excluded). Days follow eBay&apos;s reporting
              day, which ends at 08:00 UK time. Updated {timeAgo(data.sync.lastSyncedAt)}.
            </p>
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
