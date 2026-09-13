"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api, Listing, ListingStatusFilter } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { formatMoney } from "@/lib/format";
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

export default function AccountListingsPage() {
  const params = useParams<{ id: string }>();
  const { connection, loading: loadingConnection, error: connectionError } = useConnection(params.id);

  const [filter, setFilter] = useState<ListingStatusFilter | "draft">("active");
  const [items, setItems] = useState<Listing[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalEntries, setTotalEntries] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connection) return;
    if (filter === "draft") {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .getConnectionListings(connection.id, filter, page)
      .then((data) => {
        setItems(data.items);
        setTotalPages(data.totalPages);
        setTotalEntries(data.totalEntries);
      })
      .catch(() => setError("Couldn't load listings from eBay. Try again."))
      .finally(() => setLoading(false));
  }, [connection, filter, page]);

  function changeFilter(next: ListingStatusFilter | "draft") {
    setFilter(next);
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
    >
      <div className="flex items-center justify-between mb-7">
        <h1 className="text-xl font-extrabold text-[var(--color-ink)]">Listings</h1>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2">
          <FilterPill active={filter === "active"} onClick={() => changeFilter("active")}>
            Active
          </FilterPill>
          <FilterPill active={filter === "draft"} onClick={() => changeFilter("draft")}>
            Draft
          </FilterPill>
          <FilterPill active={filter === "inactive"} onClick={() => changeFilter("inactive")}>
            Inactive
          </FilterPill>
        </div>
        <Link
          href={`/accounts/${connection.id}/listings/new`}
          className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors"
        >
          + Add new
        </Link>
      </div>

      {filter === "draft" ? (
        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-10 text-center">
          <p className="text-sm font-semibold text-[var(--color-ink)] mb-1">No drafts yet</p>
          <p className="text-sm text-[var(--color-muted)] max-w-sm mx-auto">
            Listings Liston drafts with AI — before you review and publish them to eBay — will show up here.
          </p>
          <Link
            href={`/accounts/${connection.id}/listings/new`}
            className="inline-flex mt-4 rounded-md border border-[var(--color-line)] px-4 py-2 text-sm font-medium text-[var(--color-ink)] hover:border-[var(--color-accent)] transition-colors"
          >
            Draft a listing with AI
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--color-line)]">
            <span className="text-xs font-medium text-[var(--color-muted)]">
              {loading ? "Loading…" : `${totalEntries} ${filter} listing${totalEntries === 1 ? "" : "s"} on eBay`}
            </span>
          </div>

          {error && (
            <div className="p-5">
              <Alert>{error}</Alert>
            </div>
          )}

          {!error && !loading && items.length === 0 && (
            <p className="px-5 py-10 text-center text-sm text-[var(--color-muted)]">No {filter} listings found.</p>
          )}

          {!error &&
            items.map((item) => (
              <div
                key={item.itemId}
                className="flex items-center gap-4 px-5 py-4 border-b border-[var(--color-line)] last:border-b-0"
              >
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.imageUrl}
                    alt=""
                    className="h-12 w-12 rounded-lg object-cover flex-shrink-0 border border-[var(--color-line)]"
                  />
                ) : (
                  <div className="h-12 w-12 rounded-lg bg-[var(--color-paper)] flex-shrink-0 border border-[var(--color-line)]" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-[var(--color-ink)] truncate">{item.title}</p>
                  <p className="text-xs text-[var(--color-muted)]">
                    {item.sku ? `SKU ${item.sku} · ` : ""}
                    {item.quantityAvailable} available · {item.quantitySold} sold
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-bold text-[var(--color-ink)]">{formatMoney(item.price)}</p>
                  {item.convertedPrice && (
                    <p className="text-xs text-[var(--color-muted)]">≈ {formatMoney(item.convertedPrice)}</p>
                  )}
                </div>
                {item.viewItemUrl && (
                  <a
                    href={item.viewItemUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-shrink-0 text-sm font-medium text-[var(--color-accent)] hover:underline"
                  >
                    View ↗
                  </a>
                )}
              </div>
            ))}

          <PaginationControls page={page} totalPages={totalPages} onPage={setPage} />
        </div>
      )}
    </AccountShell>
  );
}
