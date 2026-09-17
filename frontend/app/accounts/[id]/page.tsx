"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, EarningsRange, Money, OrderCounts, OrderStatusFilter } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { formatMoney } from "@/lib/format";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";

// The account dashboard: money in and orders for a chosen window, the live
// catalogue and what's waiting in drafts, then the order queue by state.
// Inbox and Campaigns are shown dimmed so the shape of the page is already
// there when those land.

const RANGES: { key: EarningsRange; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "all_time", label: "All time" },
];

const SUMMARY_RANGE = "90d";

const ORDER_TILES: { key: Exclude<OrderStatusFilter, "all">; label: string; hint: string; tone: string }[] = [
  { key: "awaiting_dispatch", label: "Awaiting dispatch", hint: "Paid, needs shipping", tone: "text-[var(--color-primary)]" },
  { key: "awaiting_payment", label: "Awaiting payment", hint: "New, not paid yet", tone: "text-amber-700" },
  { key: "dispatched", label: "Dispatched", hint: "Already shipped", tone: "text-emerald-700" },
  { key: "cancelled", label: "Cancelled", hint: "No action needed", tone: "text-[var(--color-muted)]" },
];

function Stat({
  label,
  value,
  hint,
  icon,
  tone = "default",
  href,
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  tone?: "default" | "primary" | "accent";
  href?: string;
  loading?: boolean;
}) {
  const iconBg = {
    default: "bg-[var(--color-paper)] text-[var(--color-muted)]",
    primary: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]",
    accent: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
  }[tone];
  const body = (
    <>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-[var(--color-muted)]">{label}</span>
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${iconBg}`}>{icon}</span>
      </div>
      {loading ? (
        <div className="mt-4 h-7 w-24 animate-pulse rounded-md bg-[var(--color-line)]" />
      ) : (
        <p className="mt-3 text-[28px] font-semibold leading-none tracking-tight text-[var(--color-ink)]">{value}</p>
      )}
      {hint && <p className="mt-2 text-[12px] text-[var(--color-muted)]">{hint}</p>}
    </>
  );
  return href ? (
    <Link href={href} className="card block p-5 transition-colors hover:border-[var(--color-line-strong)]">
      {body}
    </Link>
  ) : (
    <div className="card p-5">{body}</div>
  );
}

function ComingSoonCard({ title, blurb, icon }: { title: string; blurb: string; icon: React.ReactNode }) {
  return (
    <div className="card flex items-center gap-4 p-4 opacity-60">
      <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--color-paper)] text-[var(--color-muted)]">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[var(--color-ink)]">{title}</p>
        <p className="truncate text-[12.5px] text-[var(--color-muted)]">{blurb}</p>
      </div>
      <span className="flex-shrink-0 rounded-full bg-[var(--color-paper)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)]">
        Coming soon
      </span>
    </div>
  );
}

function OrderQueue({ connectionId, counts, loading, error }: { connectionId: string; counts: OrderCounts | null; loading: boolean; error: string | null }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Order queue</h2>
        <span className="text-[12px] text-[var(--color-muted)]">Last 90 days</span>
      </div>
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
                <p className={`text-[28px] font-semibold leading-none tracking-tight ${tile.tone}`}>{counts?.[tile.key] ?? 0}</p>
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

const Icons = {
  money: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M4 17l5-5 4 4 7-8M15 8h5v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  orders: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M3.5 8L12 3.5 20.5 8v8L12 20.5 3.5 16V8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M3.5 8L12 12.5 20.5 8M12 12.5v8" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  ),
  listings: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M3.5 12.5V5.5a2 2 0 012-2h7l8 8-7 7-8-8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
    </svg>
  ),
  drafts: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M4 20h4l10-10-4-4L4 16v4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12.5 7.5l4 4" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M4 6.5A1.5 1.5 0 015.5 5h13A1.5 1.5 0 0120 6.5v11a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5v-11z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.5 7l7.5 5.5L19.5 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  campaigns: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M4 10.5v3a1.5 1.5 0 001.5 1.5H8l6 4V5L8 9H5.5A1.5 1.5 0 004 10.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M17.5 9.5a3.5 3.5 0 010 5M8 15v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
};

function OwnerDashboard({ connectionId }: { connectionId: string }) {
  const [range, setRange] = useState<EarningsRange>("7d");
  // Keyed by range so switching ranges shows the skeleton without a
  // synchronous reset inside the effect.
  const [earningsByRange, setEarningsByRange] = useState<Record<string, { amount: Money; orders: number; truncated: boolean } | { error: string }>>({});
  const loaded = earningsByRange[range];
  const earnings = loaded && !("error" in loaded) ? loaded : null;
  const earningsError = loaded && "error" in loaded ? loaded.error : null;
  const [live, setLive] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<number | null>(null);
  const [counts, setCounts] = useState<OrderCounts | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getConnectionEarnings(connectionId, range)
      .then((d) => !cancelled && setEarningsByRange((m) => ({ ...m, [range]: { amount: d.earnings, orders: d.orderCount, truncated: d.truncated } })))
      .catch((err) => !cancelled && setEarningsByRange((m) => ({ ...m, [range]: { error: err instanceof ApiError ? err.message : "Couldn't load earnings from eBay." } })));
    return () => {
      cancelled = true;
    };
  }, [connectionId, range]);

  useEffect(() => {
    let cancelled = false;
    api.getConnectionListings(connectionId, "active", 1).then((d) => !cancelled && setLive(d.totalEntries)).catch(() => !cancelled && setLive(0));
    api.listDraftListings(connectionId).then((d) => !cancelled && setDrafts(d.drafts.length)).catch(() => !cancelled && setDrafts(0));
    api
      .getConnectionOrders(connectionId, { range: SUMMARY_RANGE, status: "all", page: 1, perPage: 25 })
      .then((d) => !cancelled && setCounts(d.counts))
      .catch((err) => !cancelled && setCountsError(err instanceof ApiError ? err.message : "Couldn't load orders from eBay."));
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const rangeLabel = RANGES.find((r) => r.key === range)?.label.toLowerCase() || range;
  const base = `/accounts/${connectionId}`;

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-[var(--color-muted)]">
            Sales for <span className="font-medium text-[var(--color-ink)]">{rangeLabel}</span>
            {earnings?.truncated && <span className="ml-2">· eBay only keeps 90 days of orders</span>}
          </p>
          <div className="inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                className={`h-7 rounded-full px-3 text-[12px] font-medium transition-colors ${
                  range === r.key ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {earningsError && (
          <div className="notice notice-danger mb-4">
            <span className="flex-1">{earningsError}</span>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Earnings" value={earnings ? formatMoney(earnings.amount) : "—"} hint={`Revenue in the last ${rangeLabel}`} tone="accent" icon={Icons.money} loading={!earnings && !earningsError} />
          <Stat
            label="Orders"
            value={earnings ? String(earnings.orders) : "—"}
            hint={`Placed in the last ${rangeLabel}`}
            tone="primary"
            icon={Icons.orders}
            href={`${base}/orders`}
            loading={!earnings && !earningsError}
          />
          <Stat label="Live listings" value={live === null ? "—" : String(live)} hint="Active on eBay right now" icon={Icons.listings} href={`${base}/listings`} loading={live === null} />
          <Stat
            label="Drafts waiting"
            value={drafts === null ? "—" : String(drafts)}
            hint={drafts ? "Ready to review and publish" : "Nothing waiting to publish"}
            icon={Icons.drafts}
            href={`${base}/listings?filter=draft`}
            loading={drafts === null}
          />
        </div>
      </section>

      <OrderQueue connectionId={connectionId} counts={counts} loading={!counts && !countsError} error={countsError} />

      <section>
        <h2 className="mb-3 text-[13px] font-semibold text-[var(--color-ink)]">On the way</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <ComingSoonCard title="Inbox" blurb="Buyer messages from eBay in one place, with suggested replies." icon={Icons.inbox} />
          <ComingSoonCard title="Campaigns" blurb="Promoted listings and sales events, with what each one earned." icon={Icons.campaigns} />
        </div>
      </section>
    </div>
  );
}

// A team member granted Orders is doing fulfilment work — revenue isn't
// theirs to see, so they get the queue and nothing else.
function MemberDashboard({ connectionId }: { connectionId: string }) {
  const [counts, setCounts] = useState<OrderCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .getConnectionOrders(connectionId, { range: SUMMARY_RANGE, status: "all", page: 1, perPage: 25 })
      .then((d) => setCounts(d.counts))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load orders from eBay."));
  }, [connectionId]);
  return <OrderQueue connectionId={connectionId} counts={counts} loading={!counts && !error} error={error} />;
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
      header={
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Overview</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
            {connection.label} · {connection.platform_name}
          </p>
        </div>
      }
    >
      {isOwner ? (
        <OwnerDashboard connectionId={connection.id} />
      ) : connection.permissions?.orders ? (
        <MemberDashboard connectionId={connection.id} />
      ) : (
        <div className="card px-6 py-12 text-center">
          <p className="text-sm font-medium text-[var(--color-ink)]">Nothing to show here yet</p>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">Use the sections in the sidebar you have access to.</p>
        </div>
      )}
    </AccountShell>
  );
}
