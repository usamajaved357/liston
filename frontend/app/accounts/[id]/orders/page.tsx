"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, Money, Order, OrderRange } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { formatMoney, formatDate } from "@/lib/format";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";

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

function PaginationControls({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--color-line)]">
      <button
        onClick={() => onPage(page - 1)}
        disabled={page <= 1}
        className="text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)] disabled:opacity-40 disabled:hover:text-[var(--color-muted)] transition-colors"
      >
        ← Previous
      </button>
      <span className="text-xs text-[var(--color-muted)]">
        Page {page} of {totalPages}
      </span>
      <button
        onClick={() => onPage(page + 1)}
        disabled={page >= totalPages}
        className="text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)] disabled:opacity-40 disabled:hover:text-[var(--color-muted)] transition-colors"
      >
        Next →
      </button>
    </div>
  );
}

const RANGE_LABELS: Record<OrderRange, string> = {
  today: "Today",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};

export default function AccountOrdersPage() {
  const params = useParams<{ id: string }>();
  const { connection, loading: loadingConnection, error: connectionError } = useConnection(params.id);

  const [range, setRange] = useState<OrderRange>("7d");
  const [orders, setOrders] = useState<Order[]>([]);
  const [earnings, setEarnings] = useState<Money>({ amount: 0 });
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalEntries, setTotalEntries] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connection) return;
    setLoading(true);
    setError(null);
    Promise.all([
      api.getConnectionOrders(connection.id, range, page),
      api.getConnectionEarnings(connection.id, range),
    ])
      .then(([ordersData, earningsData]) => {
        setOrders(ordersData.orders);
        setTotalPages(ordersData.totalPages);
        setTotalEntries(ordersData.totalEntries);
        setEarnings(earningsData.earnings);
      })
      .catch(() => setError("Couldn't load orders from eBay. Try again."))
      .finally(() => setLoading(false));
  }, [connection, range, page]);

  function changeRange(next: OrderRange) {
    setRange(next);
    setPage(1);
  }

  if (loadingConnection) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--color-muted)] text-sm">Loading…</p>
      </main>
    );
  }

  if (connectionError || !connection) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <Alert>{connectionError || "This account connection doesn't exist, or isn't yours."}</Alert>
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
      header={<h1 className="text-xl font-extrabold text-[var(--color-ink)]">Orders</h1>}
    >
      <div className="flex items-center gap-2 mb-5">
        {(Object.keys(RANGE_LABELS) as OrderRange[]).map((key) => (
          <FilterPill key={key} active={range === key} onClick={() => changeRange(key)}>
            {RANGE_LABELS[key]}
          </FilterPill>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 mb-5">
        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Earnings — {RANGE_LABELS[range].toLowerCase()}
          </span>
          <p className="mt-1.5 text-2xl font-extrabold text-[var(--color-ink)]">
            {loading ? "…" : formatMoney(earnings)}
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Orders</span>
          <p className="mt-1.5 text-2xl font-extrabold text-[var(--color-ink)]">{loading ? "…" : totalEntries}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] overflow-hidden">
        {error && (
          <div className="p-5">
            <Alert>{error}</Alert>
          </div>
        )}

        {!error && !loading && orders.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-[var(--color-muted)]">No orders in this range.</p>
        )}

        {!error &&
          orders.map((order) => (
            <div
              key={order.orderId}
              className="flex items-center gap-4 px-5 py-4 border-b border-[var(--color-line)] last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-[var(--color-ink)] truncate">
                  {order.itemTitle || "Order"}
                  {order.itemCount > 1 ? ` +${order.itemCount - 1} more` : ""}
                </p>
                <p className="text-xs text-[var(--color-muted)]">
                  {order.buyerName || "Unknown buyer"} · {formatDate(order.createdAt)}
                </p>
              </div>
              <span className="rounded-full border border-[var(--color-line)] px-2.5 py-1 text-[11px] font-bold capitalize text-[var(--color-muted)] flex-shrink-0">
                {order.status}
              </span>
              <p className="text-sm font-bold text-[var(--color-ink)] flex-shrink-0 w-16 text-right">
                {formatMoney(order.total)}
              </p>
            </div>
          ))}

        <PaginationControls page={page} totalPages={totalPages} onPage={setPage} />
      </div>
    </AccountShell>
  );
}
