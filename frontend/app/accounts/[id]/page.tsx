"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError, EarningsRange, Money } from "@/lib/api";
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

export default function AccountOverviewPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { connection, loading, error } = useConnection(params.id);
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

  if (error || !connection) {
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
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-sm font-medium text-[var(--color-danger)] hover:underline"
            >
              Remove connection
            </button>
          </div>
        </div>
      }
    >
      {deleteError && (
        <div className="mb-4">
          <Alert>{deleteError}</Alert>
        </div>
      )}

      <EarningsWidget connectionId={connection.id} />

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
