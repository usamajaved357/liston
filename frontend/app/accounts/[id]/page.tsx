"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AccountOverview, api, ApiError, EbaySite, OrderCounts, OrderRange, OrderStatusFilter } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { AmountsToggle, ListingCards, SalesCards, MetricTabs, Metric } from "@/components/overview/OverviewMoney";
import { ListingTrendCard, RecentListingsCard } from "@/components/overview/OverviewListings";
import { MemberWorkOverview } from "@/components/overview/MemberWorkOverview";
import { useAmounts } from "@/lib/useAmounts";
import { AccountShell } from "@/components/AccountShell";
import { useAccountEvents } from "@/lib/useAccountEvents";
import { useAccountRefresh } from "@/lib/useAccountRefresh";
import { Alert } from "@/components/Alert";
import { PillTabs } from "@/components/PillTabs";

// The account's Overview: the same figures as the business Overview — a
// Sales tab with every money figure and a Listings tab — in the account's
// own currency and time zone, then what
// needs doing (late dispatches, orders not yet bought from the supplier) and
// the order queue by state in one line.

const RANGES: { key: string; label: string; phrase: string }[] = [
  { key: "today", label: "Today", phrase: "today" },
  { key: "7d", label: "7 days", phrase: "in the last 7 days" },
  { key: "30d", label: "30 days", phrase: "in the last 30 days" },
  { key: "this_month", label: "This month", phrase: "this month" },
  { key: "last_month", label: "Last month", phrase: "last month" },
  { key: "90d", label: "90 days", phrase: "in the last 90 days" },
];

const SUMMARY_RANGE = "90d";

// The Orders page's period that covers an Overview range (it offers 7, 30
// and 90 days), for the queue's links.
const ORDERS_RANGE: Record<string, OrderRange> = { today: "7d", "7d": "7d", "30d": "30d", this_month: "30d", last_month: "90d", "90d": "90d" };

// Which orders the queue counts: the Overview's dates for an owner, the
// last 90 days for a member (who has no date filter).
type QueuePeriod = { key: string; label: string; ordersRange: OrderRange };
const LAST_90_DAYS: QueuePeriod = { key: "90d", label: "last 90 days", ordersRange: "90d" };

// The queue by state, one tile each, coloured by what the state means:
// amber waits on you, blue is on its way, green arrived, red fell through.
// The same colour marks the state's share of the bar above the tiles.
const stateIcon = (paths: React.ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
    {paths}
  </svg>
);
const ORDER_STATES: { key: Exclude<OrderStatusFilter, "all">; label: string; hint: string; bar: string; tile: string; pill: string; icon: React.ReactNode }[] = [
  {
    key: "awaiting_dispatch",
    label: "Awaiting dispatch",
    hint: "Paid, needs shipping",
    bar: "bg-amber-400",
    tile: "bg-amber-50 text-amber-600 ring-amber-100",
    pill: "text-amber-700 ring-amber-200/70",
    // A parcel waiting to go.
    icon: stateIcon(<><path d="M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7L12 3.5z" /><path d="M4.5 7.7L12 12l7.5-4.3M12 12v8.5" /></>),
  },
  {
    key: "dispatched",
    label: "Dispatched",
    hint: "On the way to the buyer",
    bar: "bg-sky-500",
    tile: "bg-sky-50 text-sky-600 ring-sky-100",
    pill: "text-sky-700 ring-sky-200/70",
    // A van on its way.
    icon: stateIcon(<><path d="M3 7.5A1.5 1.5 0 014.5 6h8A1.5 1.5 0 0114 7.5V15.5H3V7.5z" /><path d="M14 10h3.4a1.5 1.5 0 011.2.6l1.9 2.5a1.5 1.5 0 01.3.9v1.5H14" /><circle cx="7" cy="17" r="1.7" /><circle cx="16.5" cy="17" r="1.7" /></>),
  },
  {
    key: "delivered",
    label: "Delivered",
    hint: "Carrier confirmed delivery",
    bar: "bg-emerald-500",
    tile: "bg-emerald-50 text-emerald-600 ring-emerald-100",
    pill: "text-emerald-700 ring-emerald-200/70",
    // Home, with a tick.
    icon: stateIcon(<><path d="M4 11L12 4.5 20 11" /><path d="M6 9.5v9.5h12V9.5" /><path d="M9.5 14.3l1.8 1.8 3.3-3.5" /></>),
  },
  {
    key: "cancelled",
    label: "Cancelled",
    hint: "No action needed",
    bar: "bg-rose-400",
    tile: "bg-rose-50 text-rose-500 ring-rose-100",
    pill: "text-rose-600 ring-rose-200/70",
    // A circle struck through.
    icon: stateIcon(<><circle cx="12" cy="12" r="8.5" /><path d="M6 6l12 12" /></>),
  },
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
function OrderQueue({
  connectionId,
  counts,
  attention,
  loading,
  error,
  period = LAST_90_DAYS,
}: {
  connectionId: string;
  counts: OrderCounts | null;
  attention: Attention | null;
  loading: boolean;
  error: string | null;
  period?: QueuePeriod;
}) {
  const todo = [
    attention?.overdue
      ? { n: attention.overdue, text: `past ${attention.overdue === 1 ? "its" : "their"} dispatch-by date`, tone: "danger" as const, icon: TodoIcons.late }
      : null,
    attention?.notOrdered ? { n: attention.notOrdered, text: "paid but not yet ordered from the supplier", tone: "warning" as const, icon: TodoIcons.supplier } : null,
  ].filter((t) => t !== null);
  const total = ORDER_STATES.reduce((sum, st) => sum + (counts?.[st.key] ?? 0), 0);
  const share = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : "0%");

  if (error) {
    return (
      <section>
        <h2 className="mb-3 text-[14px] font-semibold text-[var(--color-ink)]">Order queue</h2>
        <Alert>{error}</Alert>
      </section>
    );
  }
  return (
    <section className="rounded-[18px] border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-[var(--shadow-card)] sm:p-5">
      {/* Its name, and how many orders in which dates. */}
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-indigo-50 text-indigo-600 ring-1 ring-inset ring-indigo-100">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-[17px] w-[17px]" aria-hidden>
            <path d="M9 6.5h10.5M9 12h10.5M9 17.5h10.5" />
            <circle cx="5" cy="6.5" r="1" fill="currentColor" stroke="none" />
            <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
            <circle cx="5" cy="17.5" r="1" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-[var(--color-ink)]">Order queue</h2>
        <span className="flex-shrink-0 rounded-full bg-[var(--color-paper)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-muted)]">
          {loading ? (
            period.label.replace(/^./, (c) => c.toUpperCase())
          ) : (
            <>
              <span className="tabular-nums text-[var(--color-ink)]">{total.toLocaleString("en-GB")}</span> order{total === 1 ? "" : "s"} · {period.label}
            </>
          )}
        </span>
      </div>

      {/* How the orders split, as one bar: only when there are any to split. */}
      {loading ? (
        <div className="mt-4 h-2.5 animate-pulse rounded-full bg-[var(--color-line)]" />
      ) : (
        total > 0 && (
          <div className="mt-4 flex h-2.5 gap-[3px] overflow-hidden rounded-full" role="img" aria-label="Orders by state">
            {ORDER_STATES.filter((st) => (counts?.[st.key] ?? 0) > 0).map((st) => (
              <span key={st.key} className={`h-full rounded-full ${st.bar}`} style={{ flexGrow: counts?.[st.key] ?? 0, flexBasis: 0, minWidth: 8 }} title={`${st.label}: ${counts?.[st.key] ?? 0}`} />
            ))}
          </div>
        )
      )}

      {/* Each state as a tile, opening the Orders page on it. */}
      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        {ORDER_STATES.map((st) => {
          const n = counts?.[st.key] ?? 0;
          return (
            <Link
              key={st.key}
              href={`/accounts/${connectionId}/orders?status=${st.key}&range=${period.ordersRange}`}
              className="group relative flex min-w-0 flex-col rounded-xl bg-[var(--color-paper)] p-3 ring-1 ring-inset ring-transparent transition-all hover:bg-[var(--color-panel)] hover:shadow-[0_6px_18px_-10px_rgba(15,23,42,0.25)] hover:ring-[var(--color-line)] sm:p-3.5"
            >
              <span className="flex items-center gap-2">
                <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${st.tile}`}>{st.icon}</span>
                <span className="min-w-0 flex-1 text-[12.5px] font-medium leading-tight text-[var(--color-ink)] sm:truncate">{st.label}</span>
                <svg viewBox="0 0 24 24" fill="none" aria-hidden className="h-4 w-4 flex-shrink-0 text-[var(--color-muted)] opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100">
                  <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              {loading ? (
                <span className="mt-3 block h-7 w-14 animate-pulse rounded-lg bg-[var(--color-line)]" />
              ) : (
                <span className="mt-3 flex items-center gap-2">
                  <span className="text-[24px] font-semibold leading-none tracking-[-0.025em] tabular-nums text-[var(--color-ink)]">{n.toLocaleString("en-GB")}</span>
                  <span className={`rounded-full bg-[var(--color-panel)] px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums ring-1 ring-inset ${n ? st.pill : "text-[var(--color-muted)] ring-[var(--color-line)]"}`}>{share(n)}</span>
                </span>
              )}
              <span className="mt-2 text-[12px] leading-snug text-[var(--color-muted)] sm:truncate">{st.hint}</span>
            </Link>
          );
        })}
      </div>

      {/* What needs doing, under the tiles. */}
      {todo.length > 0 && (
        <div className="mt-3 space-y-2">
          {todo.map((t) => {
            const tone =
              t.tone === "danger"
                ? { row: "bg-rose-50/80 ring-rose-200/70 hover:bg-rose-50", icon: "text-rose-600 ring-rose-200/70", action: "text-rose-700 ring-rose-200/80" }
                : { row: "bg-amber-50/80 ring-amber-200/70 hover:bg-amber-50", icon: "text-amber-600 ring-amber-200/70", action: "text-amber-800 ring-amber-200/80" };
            return (
              <Link key={t.text} href={`/accounts/${connectionId}/orders?status=awaiting_dispatch&range=${SUMMARY_RANGE}`} className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-inset transition-colors sm:px-3.5 ${tone.row}`}>
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[var(--color-panel)] ring-1 ring-inset ${tone.icon}`}>{t.icon}</span>
                <span className="min-w-0 flex-1 text-[13px] leading-snug text-[var(--color-ink)]">
                  <span className="font-semibold tabular-nums">
                    {t.n.toLocaleString("en-GB")} order{t.n === 1 ? "" : "s"}
                  </span>{" "}
                  <span className="text-[var(--color-muted)]">{t.text}</span>
                  {/* What needs doing looks at every open order, whatever the dates above. */}
                  {period.key !== "90d" && <span className="text-[var(--color-muted)]"> · last 90 days</span>}
                </span>
                <span className={`flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--color-panel)] py-1 pl-3 pr-2 text-[12.5px] font-semibold shadow-sm ring-1 ring-inset ${tone.action}`}>
                  Review
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5">
                    <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </Link>
            );
          })}
        </div>
      )}
      {!loading && todo.length === 0 && (
        <p className="mt-3 flex items-center gap-2.5 rounded-xl bg-emerald-50/70 px-3.5 py-2.5 text-[13px] text-emerald-900 ring-1 ring-inset ring-emerald-200/60">
          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden>
            <circle cx="10" cy="10" r="8" fill="currentColor" opacity=".15" />
            <path d="M6.5 10.2l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Nothing waiting on you: every paid order is ordered from its supplier and on time.
        </p>
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
  const amounts = useAmounts();
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
  const moneyTab = metric === "sales";

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
          <PillTabs role="radiogroup" label="Dates" tabs={RANGES} value={range} onChange={setRange} />
        </div>

        <MetricTabs metric={metric} onMetric={setMetric} trailing={metric === "sales" ? <AmountsToggle hidden={amounts.hidden} onToggle={amounts.toggle} /> : undefined} />
        <div className="mt-5">
          {dataError ? (
            <Alert>{dataError}</Alert>
          ) : metric === "listings" ? (
            <>
              <ListingCards work={data?.listings ?? null} loading={!data} huntingHref={(view) => `/accounts/${connectionId}/hunting?view=${view}`} />
              {/* How listing work moved, and what went live. */}
              {data && (
                <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <div className="min-w-0 lg:col-span-2">
                    <ListingTrendCard points={data.listingTrend ?? null} caption={range === "today" ? "Today" : range === "this_month" ? "This month" : range === "last_month" ? "Last month" : `Last ${RANGES.find((r) => r.key === range)?.label ?? ""}`} />
                  </div>
                  <RecentListingsCard items={data.recentListings ?? []} showMarket={false} flagOf={() => ""} empty={range === "today" ? "Nothing published from Liston today yet." : undefined} />
                </div>
              )}
            </>
          ) : (
            <SalesCards summaries={data ? [data.money] : []} loading={!data} unavailable={data ? !data.financesAccess : false} hidden={amounts.hidden} />
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

      {/* The queue counts the dates chosen above; if those figures couldn't
          be read, the last 90 days. What needs doing is always every open order.
          The Listings tab is about listings, so it leaves the queue out. */}
      {metric === "listings" ? null : dataError ? (
        <OrderQueue connectionId={connectionId} counts={queue.counts} attention={queue.attention} loading={!queue.counts && !queue.error} error={queue.error} />
      ) : (
        <OrderQueue
          connectionId={connectionId}
          counts={data?.queue ?? null}
          attention={queue.attention}
          loading={!data?.queue}
          error={queue.error}
          period={{ key: range, label: phrase.replace(/^in (the )?/, ""), ordersRange: ORDERS_RANGE[range] ?? "90d" }}
        />
      )}
    </div>
  );
}

// A team member granted Orders is doing fulfilment work — revenue isn't
// theirs to see, so under their own work they get what needs doing and the
// queue, nothing else.
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
    <main className="min-h-screen bg-[var(--color-paper)] p-4 sm:p-10">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="h-6 w-40 animate-pulse rounded-full bg-[var(--color-line)]" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
      ) : (
        // A member: their own work here (never money), then the order queue with Orders access.
        <MemberWorkOverview connectionId={connection.id}>
          {connection.permissions?.orders && <MemberDashboard connectionId={connection.id} reloadKey={reloadKey} onSynced={setSyncedAt} />}
        </MemberWorkOverview>
      )}
    </AccountShell>
  );
}
