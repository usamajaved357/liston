"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, EarningsRange, Money, OrderCounts, OrderStatusFilter } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { formatMoney } from "@/lib/format";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import { ConfirmDialog } from "@/components/ConfirmDialog";

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  expired: "bg-amber-50 text-amber-800 border-amber-200",
  error: "bg-red-50 text-red-700 border-red-200",
  suspended: "bg-red-50 text-red-700 border-red-200",
};

const RANGE_LABELS: Record<EarningsRange, string> = {
  today: "Today",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  this_month: "This month",
  last_month: "Last month",
  custom: "Custom",
  all_time: "All time",
};

const RANGE_ORDER: EarningsRange[] = ["today", "7d", "30d", "this_month", "last_month", "custom", "all_time"];

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
        active
          ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
          : "border-[var(--color-line)] text-[var(--color-muted)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-ink)]"
      }`}
    >
      {children}
    </button>
  );
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function EarningsWidget({ connectionId }: { connectionId: string }) {
  const [range, setRange] = useState<EarningsRange>("7d");
  const [customFrom, setCustomFrom] = useState(todayIso());
  const [customTo, setCustomTo] = useState(todayIso());
  const [earnings, setEarnings] = useState<Money>({ amount: 0 });
  const [orderCount, setOrderCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .getConnectionEarnings(connectionId, range, range === "custom" ? { from: customFrom, to: customTo } : undefined)
      .then((data) => {
        setEarnings(data.earnings);
        setOrderCount(data.orderCount);
        setTruncated(data.truncated);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load earnings from eBay."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, range, range === "custom" ? customFrom : null, range === "custom" ? customTo : null]);

  return (
    <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <h2 className="text-base font-bold text-[var(--color-ink)]">Earnings</h2>
        <div className="flex flex-wrap items-center gap-2">
          {RANGE_ORDER.map((key) => (
            <FilterPill key={key} active={range === key} onClick={() => setRange(key)}>
              {RANGE_LABELS[key]}
            </FilterPill>
          ))}
        </div>
      </div>

      {range === "custom" && (
        <div className="flex items-center gap-3 mb-5">
          <input
            type="date"
            value={customFrom}
            max={customTo}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="rounded-md border border-[var(--color-line)] px-3 py-1.5 text-sm text-[var(--color-ink)]"
          />
          <span className="text-sm text-[var(--color-muted)]">to</span>
          <input
            type="date"
            value={customTo}
            min={customFrom}
            max={todayIso()}
            onChange={(e) => setCustomTo(e.target.value)}
            className="rounded-md border border-[var(--color-line)] px-3 py-1.5 text-sm text-[var(--color-ink)]"
          />
        </div>
      )}

      {error ? (
        <Alert>{error}</Alert>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              {RANGE_LABELS[range]} revenue
            </span>
            <p className="mt-1.5 text-3xl font-extrabold text-[var(--color-ink)]">
              {loading ? "…" : formatMoney(earnings)}
            </p>
          </div>
          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Orders</span>
            <p className="mt-1.5 text-3xl font-extrabold text-[var(--color-ink)]">{loading ? "…" : orderCount}</p>
          </div>
        </div>
      )}

      {truncated && !error && (
        <p className="mt-4 text-xs text-[var(--color-muted)]">
          eBay only provides order history for the last 90 days — this is the most "all time" can show.
        </p>
      )}
    </div>
  );
}

// What a team member who manages orders actually needs on an account's
// Overview: the operational state of the queue — what's waiting to be
// shipped, what's unpaid, what's already gone out — not revenue, which is
// the owner's concern and none of a fulfilment teammate's business. Each
// tile links straight into the Orders tab pre-filtered to that status, over
// the same 90-day window it counted (eBay's Trading API doesn't serve order
// history further back than that).
const ORDER_SUMMARY_TILES: { key: Exclude<OrderStatusFilter, "all">; label: string; hint: string; tone: string }[] = [
  {
    key: "awaiting_dispatch",
    label: "Awaiting dispatch",
    hint: "Paid — needs shipping",
    tone: "text-[var(--color-ink)]",
  },
  { key: "awaiting_payment", label: "Awaiting payment", hint: "New — not paid yet", tone: "text-amber-700" },
  { key: "dispatched", label: "Paid and dispatched", hint: "Already shipped", tone: "text-emerald-700" },
  { key: "cancelled", label: "Cancelled", hint: "No action needed", tone: "text-[var(--color-danger)]" },
];

const SUMMARY_RANGE = "90d";

function OrdersSummaryWidget({ connectionId }: { connectionId: string }) {
  const [counts, setCounts] = useState<OrderCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    // perPage 1 because only `counts` is used here — the backend derives
    // counts from the whole window regardless of the page size requested.
    api
      .getConnectionOrders(connectionId, { range: SUMMARY_RANGE, status: "all", page: 1, perPage: 25 })
      .then((data) => setCounts(data.counts))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load orders from eBay."))
      .finally(() => setLoading(false));
  }, [connectionId]);

  return (
    <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-5">
        <h2 className="text-base font-bold text-[var(--color-ink)]">Orders</h2>
        <span className="text-xs text-[var(--color-muted)]">Last 90 days</span>
      </div>

      {error ? (
        <Alert>{error}</Alert>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ORDER_SUMMARY_TILES.map((tile) => (
            <Link
              key={tile.key}
              href={`/accounts/${connectionId}/orders?status=${tile.key}&range=${SUMMARY_RANGE}`}
              className="rounded-xl border border-[var(--color-line)] p-4 transition-colors hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-paper)]"
            >
              <p className={`text-3xl font-extrabold ${tile.tone}`}>{loading ? "…" : counts?.[tile.key] ?? 0}</p>
              <p className="mt-1.5 text-sm font-semibold text-[var(--color-ink)]">{tile.label}</p>
              <p className="text-xs text-[var(--color-muted)]">{tile.hint}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AccountOverviewPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { connection, user, loading, error } = useConnection(params.id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.deleteConnection(params.id);
      router.push("/connections");
    } catch {
      setDeleteError("Couldn't remove this connection. Try again.");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--color-muted)] text-sm">Loading…</p>
      </main>
    );
  }

  if (error || !connection || !user) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <Alert>{error || "This account connection doesn't exist, or isn't yours."}</Alert>
      </main>
    );
  }

  return (
    <AccountShell
      connectionId={connection.id}
      label={connection.label}
      platformKey={connection.platform_key}
      platformName={connection.platform_name}
      status={connection.status}
      permissions={connection.permissions}
      user={user}
      header={
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-extrabold text-[var(--color-ink)]">Overview</h1>
            <p className="text-sm text-[var(--color-muted)] mt-0.5">{connection.label} · {connection.platform_name}</p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`rounded-full border px-3 py-1 text-xs font-medium capitalize ${
                STATUS_STYLES[connection.status] || STATUS_STYLES.error
              }`}
            >
              {connection.status}
            </span>
            {/* Disconnecting a whole eBay account is always admin-only —
                connection.permissions is only ever set for a member. */}
            {connection.permissions === undefined && (
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-sm font-medium text-[var(--color-danger)] hover:underline"
              >
                Remove connection
              </button>
            )}
          </div>
        </div>
      }
    >
      {deleteError && (
        <div className="mb-4">
          <Alert>{deleteError}</Alert>
        </div>
      )}

      {/* An owner owns the P&L, so Overview leads with Earnings for them. A
          team member granted Orders is doing fulfilment work — revenue isn't
          theirs to monitor, so they get the operational state of the order
          queue instead. Anyone without Orders access has nothing to show
          here at all (Overview is entirely order-derived today). */}
      {connection.permissions === undefined ? (
        <EarningsWidget connectionId={connection.id} />
      ) : connection.permissions.orders ? (
        <OrdersSummaryWidget connectionId={connection.id} />
      ) : (
        <div className="rounded-2xl border border-dashed border-[var(--color-line)] p-8 text-center">
          <p className="text-sm text-[var(--color-muted)]">
            Nothing to show here yet — check the sections in the sidebar you have access to.
          </p>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Remove this connection?"
        description="Liston will no longer be able to draft or publish listings to this account."
        confirmLabel="Remove"
        danger
        loading={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
      />
    </AccountShell>
  );
}
