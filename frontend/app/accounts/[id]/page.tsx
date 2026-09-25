"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AccountOverview, api, ApiError, EbaySite, OrderCounts, OrderStatusFilter } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { ListingCards, MetricCards, MetricTabs, Metric } from "@/components/overview/OverviewMoney";
import { AccountShell } from "@/components/AccountShell";
import { useAccountEvents } from "@/lib/useAccountEvents";
import { useAccountRefresh } from "@/lib/useAccountRefresh";
import { Alert } from "@/components/Alert";

// The account's Overview: the same figures as the business Overview — a tab
// per figure (sales, fees, earnings, source cost, profit, listings) and cards
// breaking it down — in the account's own currency and time zone, then what
// needs doing (late dispatches, orders not yet bought from the supplier) and
// the order queue by state.

const RANGES: { key: string; label: string; phrase: string }[] = [
  { key: "today", label: "Today", phrase: "today" },
  { key: "7d", label: "7 days", phrase: "in the last 7 days" },
  { key: "30d", label: "30 days", phrase: "in the last 30 days" },
  { key: "this_month", label: "This month", phrase: "this month" },
  { key: "last_month", label: "Last month", phrase: "last month" },
  { key: "90d", label: "90 days", phrase: "in the last 90 days" },
];

const SUMMARY_RANGE = "90d";

const ORDER_TILES: { key: Exclude<OrderStatusFilter, "all">; label: string; hint: string; tone: string }[] = [
  { key: "awaiting_dispatch", label: "Awaiting dispatch", hint: "Paid, needs shipping", tone: "text-[var(--color-primary)]" },
  { key: "dispatched", label: "Dispatched", hint: "On the way to the buyer", tone: "text-emerald-700" },
  { key: "delivered", label: "Delivered", hint: "Carrier confirmed delivery", tone: "text-emerald-800" },
  { key: "cancelled", label: "Cancelled", hint: "No action needed", tone: "text-[var(--color-muted)]" },
];

type Attention = { overdue: number; notOrdered: number | null };

const TodoIcons = {
  // A clock: past the dispatch-by date.
  late: (
    <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  // A cart: still to buy from the supplier.
  supplier: (
    <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
      <path d="M3.5 4.5h2l2.2 10.2a1.5 1.5 0 001.5 1.2h7.9a1.5 1.5 0 001.5-1.1l1.4-5.8H6.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9.5" cy="19.5" r="1.3" fill="currentColor" />
      <circle cx="17" cy="19.5" r="1.3" fill="currentColor" />
    </svg>
  ),
};

// The order queue by state, and above it what needs doing now.
function OrderQueue({ connectionId, counts, attention, loading, error }: { connectionId: string; counts: OrderCounts | null; attention: Attention | null; loading: boolean; error: string | null }) {
  const todo = [
    attention?.overdue
      ? { n: attention.overdue, text: `past ${attention.overdue === 1 ? "its" : "their"} dispatch-by date`, tone: "danger" as const, icon: TodoIcons.late }
      : null,
    attention?.notOrdered ? { n: attention.notOrdered, text: "paid but not yet ordered from the supplier", tone: "warning" as const, icon: TodoIcons.supplier } : null,
  ].filter((t) => t !== null);
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Order queue</h2>
        <span className="text-[12px] text-[var(--color-muted)]">Last 90 days</span>
      </div>
      {todo.length > 0 && (
        <div className={`mb-4 grid gap-3 ${todo.length > 1 ? "lg:grid-cols-2" : ""}`}>
          {todo.map((t) => {
            const tone =
              t.tone === "danger"
                ? { box: "border-rose-200 bg-rose-50/70 hover:border-rose-300", icon: "bg-rose-100 text-rose-600", action: "text-rose-700" }
                : { box: "border-amber-200 bg-amber-50/70 hover:border-amber-300", icon: "bg-amber-100 text-amber-700", action: "text-amber-800" };
            return (
              <Link
                key={t.text}
                href={`/accounts/${connectionId}/orders?status=awaiting_dispatch&range=${SUMMARY_RANGE}`}
                className={`group flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${tone.box}`}
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone.icon}`}>{t.icon}</span>
                <span className="min-w-0 flex-1 text-[13.5px] text-[var(--color-ink)]">
                  <span className="font-semibold tabular-nums">
                    {t.n.toLocaleString("en-GB")} order{t.n === 1 ? "" : "s"}
                  </span>{" "}
                  <span className="text-[var(--color-muted)]">{t.text}</span>
                </span>
                <span className={`flex shrink-0 items-center gap-1 text-[13px] font-medium ${tone.action}`}>
                  Review
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden className="h-4 w-4 transition-transform group-hover:translate-x-0.5">
                    <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </Link>
            );
          })}
        </div>
      )}
      {error ? (
        <Alert>{error}</Alert>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {ORDER_TILES.map((tile) => (
            <Link
              key={tile.key}
              href={`/accounts/${connectionId}/orders?status=${tile.key}&range=${SUMMARY_RANGE}`}
              className="card p-5 transition-colors hover:border-[var(--color-line-strong)]"
            >
              {loading ? (
                <div className="h-7 w-12 animate-pulse rounded-md bg-[var(--color-line)]" />
              ) : (
                <p className={`text-[28px] font-semibold leading-none tracking-tight tabular-nums ${tile.tone}`}>{(counts?.[tile.key] ?? 0).toLocaleString("en-GB")}</p>
              )}
              <p className="mt-3 text-sm font-medium text-[var(--color-ink)]">{tile.label}</p>
              <p className="text-[12px] text-[var(--color-muted)]">{tile.hint}</p>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

// The queue's counts and what needs doing, for owners and members alike.
function useOrderQueue(connectionId: string, reloadKey: number, liveKey: number, onSynced: (syncedAt: string | null) => void) {
  const [counts, setCounts] = useState<OrderCounts | null>(null);
  const [attention, setAttention] = useState<Attention | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getConnectionOrders(connectionId, { range: SUMMARY_RANGE, status: "all", page: 1, perPage: 25 })
      .then((d) => {
        if (cancelled) return;
        setCounts(d.counts);
        setAttention(d.attention ?? null);
        onSynced(d.syncedAt);
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn't load orders from eBay."));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, reloadKey, liveKey]);
  return { counts, attention, error };
}

// `reloadKey` bumps after the header's refresh; `onSynced` reports how fresh
// the account's orders are, for that header.
type DashboardProps = { connectionId: string; reloadKey: number; onSynced: (syncedAt: string | null) => void };

function OwnerDashboard({ connectionId, reloadKey, onSynced }: DashboardProps) {
  const [range, setRange] = useState("today");
  const [metric, setMetric] = useState<Metric>("sales");
  // Keyed by range, so switching shows the skeleton without a reset in the effect.
  const [byRange, setByRange] = useState<Record<string, AccountOverview | { error: string }>>({});
  const loaded = byRange[range];
  const data = loaded && !("error" in loaded) ? loaded : null;
  const dataError = loaded && "error" in loaded ? loaded.error : null;

  // Live: a sale or a publish re-reads the account; the figures follow.
  const [liveKey, setLiveKey] = useState(0);
  useAccountEvents(connectionId, () => {
    setByRange({});
    setLiveKey((k) => k + 1);
  });
  const queue = useOrderQueue(connectionId, reloadKey, liveKey, onSynced);

  useEffect(() => {
    let cancelled = false;
    api
      .getAccountOverview(connectionId, range)
      .then((d) => !cancelled && setByRange((m) => ({ ...m, [range]: d })))
      .catch((err) => !cancelled && setByRange((m) => ({ ...m, [range]: { error: err instanceof ApiError ? err.message : "Couldn't load this account's figures." } })));
    return () => {
      cancelled = true;
    };
  }, [connectionId, range, liveKey, reloadKey]);

  // Fees and earnings are read from eBay in the background; ask again while they come.
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    if (!data?.financesPending || polls >= 6) return;
    const timer = setTimeout(() => {
      setPolls((n) => n + 1);
      setByRange((m) => {
        const next = { ...m };
        delete next[range];
        return next;
      });
      setLiveKey((k) => k + 1);
    }, 8000);
    return () => clearTimeout(timer);
  }, [data, polls, range]);

  const phrase = RANGES.find((r) => r.key === range)?.phrase ?? "";
  const moneyTab = metric !== "sales" && metric !== "listings";

  async function reconnect() {
    try {
      const { authorizeUrl } = await api.reauthorizeConnection(connectionId, `/accounts/${connectionId}`);
      window.location.href = authorizeUrl;
    } catch {
      /* stays on the page */
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-[var(--color-muted)]">
            Figures for <span className="font-medium text-[var(--color-ink)]">{phrase.replace(/^in /, "")}</span>
          </p>
          <div role="radiogroup" aria-label="Dates" className="inline-flex flex-wrap rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                role="radio"
                aria-checked={range === r.key}
                onClick={() => setRange(r.key)}
                className={`h-7 rounded-full px-3 text-[12px] font-medium transition-colors ${
                  range === r.key ? "bg-[var(--color-primary)] text-white shadow-sm" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <MetricTabs metric={metric} onMetric={setMetric} />
        <div className="mt-5">
          {dataError ? (
            <Alert>{dataError}</Alert>
          ) : metric === "listings" ? (
            <ListingCards work={data?.listings ?? null} loading={!data} />
          ) : (
            <MetricCards metric={metric} summaries={data ? [data.money] : []} loading={!data} unavailable={data ? !data.financesAccess : false} />
          )}
        </div>

        {data && moneyTab && !data.financesAccess && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[#fde68a] bg-[var(--color-warning-soft)] px-4 py-3 text-[13px] text-[#92400e]">
            <span className="min-w-[240px] flex-1">
              This account was connected before Liston could read eBay&apos;s finances, so its fees, earnings and profit can&apos;t show yet. Reconnect it once
              to include them.
            </span>
            <button type="button" onClick={reconnect} className="btn btn-primary btn-sm">
              Reconnect to eBay
            </button>
          </div>
        )}
        {data && moneyTab && data.financesAccess && data.financesPending && (
          <p className="mt-3 text-[12.5px] text-[var(--color-muted)]">Reading fees and earnings from eBay. The figures update by themselves.</p>
        )}
      </section>

      <OrderQueue connectionId={connectionId} counts={queue.counts} attention={queue.attention} loading={!queue.counts && !queue.error} error={queue.error} />
    </div>
  );
}

// A team member granted Orders is doing fulfilment work — revenue isn't
// theirs to see, so they get what needs doing and the queue, nothing else.
function MemberDashboard({ connectionId, reloadKey, onSynced }: DashboardProps) {
  const queue = useOrderQueue(connectionId, reloadKey, 0, onSynced);
  return <OrderQueue connectionId={connectionId} counts={queue.counts} attention={queue.attention} loading={!queue.counts && !queue.error} error={queue.error} />;
}

// An account selling on more eBay sites than it's linked for: eBay sends
// every site's listings and orders to it, so they show here together. Each
// site can become an account of its own in one click (same eBay sign-in).
function OtherSitesNotice({ connectionId, label, onAdded }: { connectionId: string; label: string; onAdded: () => void }) {
  const [sites, setSites] = useState<EbaySite[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .getEbaySites(connectionId)
      .then((d) => setSites(d.sites))
      .catch(() => setSites([]));
  }, [connectionId, added]);

  const unlinked = sites.filter((s) => !s.connectionId);

  async function add(site: EbaySite) {
    setAdding(site.marketplace.id);
    setError(null);
    try {
      const { connection } = await api.addEbaySite(connectionId, site.marketplace.id);
      setAdded({ id: connection.id, name: site.marketplace.name });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that site. Try again.");
    } finally {
      setAdding(null);
    }
  }

  if (!added && !unlinked.length) return null;
  return (
    <div className="mb-6 space-y-2">
      {added && (
        <Alert variant="success">
          {added.name} is now its own account; its listings and orders moved there.{" "}
          <Link href={`/accounts/${added.id}`} className="font-medium underline">
            Open {label} · {added.name}
          </Link>
        </Alert>
      )}
      {unlinked.map((site) => (
        <div
          key={site.marketplace.id}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-[#fde68a] bg-[var(--color-warning-soft)] px-4 py-3 text-[13px] text-[#92400e]"
        >
          <span className="min-w-[240px] flex-1">
            {label} also sells on {site.marketplace.flag} {site.marketplace.name}: {site.listings} listing{site.listings === 1 ? "" : "s"} and {site.orders} order
            {site.orders === 1 ? "" : "s"} from there are showing in this account, in {site.marketplace.currency}.
          </span>
          <button type="button" onClick={() => add(site)} disabled={adding !== null} className="btn btn-primary btn-sm">
            {adding === site.marketplace.id ? "Adding…" : `Add ${site.marketplace.name} as its own account`}
          </button>
        </div>
      ))}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

function ShellSkeleton() {
  return (
    <main className="min-h-screen bg-[var(--color-paper)] p-10">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="h-6 w-40 animate-pulse rounded-full bg-[var(--color-line)]" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card h-28 animate-pulse" />
          ))}
        </div>
      </div>
    </main>
  );
}

export default function AccountOverviewPage() {
  const params = useParams<{ id: string }>();
  const { connection, user, loading, error } = useConnection(params.id);
  const { sync, setSyncedAt, reloadKey, reload } = useAccountRefresh(connection?.id);
  // Back from linking a site this account already had: its sign-in was
  // refreshed instead of a copy being added.
  const alreadyConnected = useSearchParams().get("alreadyConnected") === "1";

  if (loading) return <ShellSkeleton />;

  if (error || !connection || !user) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <Alert>{error || "This account connection doesn't exist, or isn't yours."}</Alert>
      </main>
    );
  }

  const isOwner = connection.permissions === undefined;

  return (
    <AccountShell
      connectionId={connection.id}
      label={connection.label}
      platformKey={connection.platform_key}
      platformName={connection.platform_name}
      marketplace={connection.marketplace}
      permissions={connection.permissions}
      user={user}
      sync={isOwner || connection.permissions?.orders ? sync : undefined}
      header={
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Overview</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
            {connection.label} · {connection.marketplace?.name ?? connection.platform_name}
          </p>
        </div>
      }
    >
      {alreadyConnected && (
        <div className="mb-4">
          <Alert variant="success">
            This eBay account was already connected for {connection.marketplace?.name ?? "this site"}, so no copy was added; its sign-in has been
            refreshed. To add another site, connect it again and pick that site.
          </Alert>
        </div>
      )}
      {isOwner && connection.platform_key === "ebay" && <OtherSitesNotice connectionId={connection.id} label={connection.label} onAdded={reload} />}
      {isOwner ? (
        <OwnerDashboard connectionId={connection.id} reloadKey={reloadKey} onSynced={setSyncedAt} />
      ) : connection.permissions?.orders ? (
        <MemberDashboard connectionId={connection.id} reloadKey={reloadKey} onSynced={setSyncedAt} />
      ) : (
        <div className="card px-6 py-12 text-center">
          <p className="text-sm font-medium text-[var(--color-ink)]">Nothing to show here yet</p>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">Use the sections in the sidebar you have access to.</p>
        </div>
      )}
    </AccountShell>
  );
}
