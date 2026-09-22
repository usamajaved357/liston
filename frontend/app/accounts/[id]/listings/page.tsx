"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, DraftListing, isVariationDraft, Listing, ListingAnalyticsSummaries, ListingStatusFilter } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { formatMoney, formatShortDate } from "@/lib/format";
import { AccountShell } from "@/components/AccountShell";
import { ListFooter } from "@/components/ListFooter";
import { Alert } from "@/components/Alert";
import { ListSkeleton } from "@/components/Skeleton";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SyncStatus } from "@/components/SyncStatus";
import { useAccountEvents } from "@/lib/useAccountEvents";
import { ListingAnalyticsPanel } from "@/components/analytics/ListingAnalyticsPanel";
import { compactNumber } from "@/components/charts/chart-format";

type Tab = ListingStatusFilter | "draft";
const TrashIcon = (
  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Thumb({ src }: { src: string | null }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className="h-14 w-14 flex-shrink-0 rounded-xl border border-[var(--color-line)] bg-white object-cover" />
  ) : (
    <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] text-[var(--color-muted)]">
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
        <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 17" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

// Stock reads at a glance: a dot that turns amber when a listing is about to
// run dry and red once it has.
function StockBadge({ available }: { available: number }) {
  const tone = available === 0 ? ["bg-rose-500", "text-rose-700", "Out of stock"] : available <= 3 ? ["bg-amber-500", "text-amber-700", `${available} left`] : ["bg-emerald-500", "text-[var(--color-muted)]", `${available} in stock`];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${tone[1]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone[0]}`} />
      {tone[2]}
    </span>
  );
}

const ChartIcon = (
  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

function ListingRow({
  item,
  onEdit,
  editing,
  onDelete,
  onEnd,
  stats,
  onAnalytics,
}: {
  item: Listing;
  onEdit: () => void;
  editing: boolean;
  onDelete?: () => void;
  onEnd?: () => void;
  // The last 30 days, from stored analytics (no eBay call per row).
  stats?: { views: number | null; sold: number; watchers: number | null } | null;
  onAnalytics?: () => void;
}) {
  const open = () => {
    if (item.viewItemUrl) window.open(item.viewItemUrl, "_blank", "noopener");
  };
  return (
    <li
      onClick={open}
      className={`group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-[var(--color-paper)] ${item.viewItemUrl ? "cursor-pointer" : ""}`}
    >
      <Thumb src={item.imageUrl} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium leading-snug text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{item.title}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--color-muted)]">
          <StockBadge available={item.quantityAvailable} />
          <span>{item.quantitySold} sold</span>
          {stats && (
            <span className="inline-flex items-center gap-1 text-[var(--color-ink)]" title="The last 30 complete days: views from eBay, units sold from your orders; watchers now">
              <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 text-[var(--color-muted)]" aria-hidden>
                <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="2.8" stroke="currentColor" strokeWidth="1.8" />
              </svg>
              {stats.views != null && (
                <>
                  <span className="font-medium tabular-nums">{compactNumber(stats.views)}</span>
                  <span className="text-[var(--color-muted)]">views ·</span>
                </>
              )}
              <span className="text-[var(--color-muted)]">
                {stats.sold} sold in 30 days
                {stats.watchers != null && ` · ${stats.watchers} watching`}
              </span>
            </span>
          )}
          <span className="font-mono text-[11.5px] tracking-tight">#{item.itemId}</span>
          {item.sku && <span className="truncate">SKU {item.sku}</span>}
          {item.startTime && <span>Listed {formatShortDate(item.startTime)}</span>}
        </div>
      </div>
      <p className="w-20 flex-shrink-0 text-right text-[14px] font-medium tracking-tight text-[var(--color-ink)]">{formatMoney(item.price)}</p>
      {onAnalytics && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAnalytics();
          }}
          className="btn btn-ghost btn-icon flex-shrink-0 !h-7 !w-7 hover:!bg-[var(--color-primary-soft)] hover:!text-[var(--color-primary)]"
          title="Analytics: impressions, views and sales"
          aria-label={`Analytics for ${item.title}`}
        >
          {ChartIcon}
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        disabled={editing}
        className="btn flex-shrink-0 !h-7 !px-3 !text-[12px] bg-[var(--color-primary-soft)] font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white"
      >
        {editing ? "Opening…" : "Edit"}
      </button>
      {onEnd && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEnd();
          }}
          className="btn btn-danger-ghost flex-shrink-0 !h-7 !px-3 !text-[12px]"
          title="End this listing on eBay"
        >
          End
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="btn btn-danger-ghost btn-icon -mr-2 flex-shrink-0"
          title="Delete permanently"
          aria-label="Delete permanently"
        >
          {TrashIcon}
        </button>
      )}
    </li>
  );
}

function DraftRow({ draft, connectionId, onDelete }: { draft: DraftListing; connectionId: string; onDelete: () => void }) {
  const router = useRouter();
  const content = draft.generated_data;
  const isVariation = isVariationDraft(content);
  const title = isVariation ? content.commonTitle : content.title;
  const image = content.imageUrls[0];
  const price = isVariation ? content.variants[0]?.price : content.price;
  const variantCount = isVariation ? content.variants.length : null;
  const href = `/accounts/${connectionId}/listings/draft/${draft.id}`;
  return (
    <li onClick={() => router.push(href)} className="group flex cursor-pointer items-center gap-4 px-5 py-3.5 transition-colors hover:bg-[var(--color-paper)]">
      <Thumb src={image || null} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium leading-snug text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{title}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--color-muted)]">
          <span className="inline-flex items-center gap-1.5 font-medium text-amber-700">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Draft
          </span>
          <span>{variantCount !== null ? `${variantCount} variations` : "Single listing"}</span>
          {draft.sku && <span className="truncate">SKU {draft.sku}</span>}
          {draft.created_at && <span>Drafted {formatShortDate(draft.created_at)}</span>}
        </div>
      </div>
      <p className="w-20 flex-shrink-0 text-right text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
        {price ? formatMoney({ amount: Number(price.value), currency: price.currency }) : ""}
      </p>
      <Link
        href={href}
        onClick={(e) => e.stopPropagation()}
        className="btn flex-shrink-0 !h-7 !px-3 !text-[12px] bg-[var(--color-primary-soft)] font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white"
      >
        Edit
      </Link>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="btn btn-danger-ghost btn-icon -mr-2 flex-shrink-0"
        title="Delete draft"
        aria-label="Delete draft"
      >
        {TrashIcon}
      </button>
    </li>
  );
}

export default function AccountListingsPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { connection, user, loading: loadingConnection, error: connectionError } = useConnection(params.id);

  // The selected tab lives in the URL, so opening a draft and coming back
  // lands on the same tab rather than resetting to Active.
  const urlFilter = searchParams.get("filter");
  const updatedItemId = searchParams.get("updated");
  const updateWarning = searchParams.get("warning");
  const endedItemId = searchParams.get("ended");
  const [filter, setFilter] = useState<Tab>(urlFilter === "draft" || urlFilter === "inactive" ? urlFilter : "active");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<number | "all">(25);
  const [items, setItems] = useState<Listing[]>([]);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  // Bumped after a manual refresh so the load effect runs again.
  const [reloadKey, setReloadKey] = useState(0);
  const [drafts, setDrafts] = useState<DraftListing[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [totalEntries, setTotalEntries] = useState(0);
  const [counts, setCounts] = useState<{ active?: number; inactive?: number; draft?: number }>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draftToDelete, setDraftToDelete] = useState<string | null>(null);
  const [deletingDraft, setDeletingDraft] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<ListingAnalyticsSummaries | null>(null);
  const [analyticsItem, setAnalyticsItem] = useState<string | null>(null);
  const [itemToDelete, setItemToDelete] = useState<Listing | null>(null);
  const [itemToEnd, setItemToEnd] = useState<Listing | null>(null);
  const [endingItem, setEndingItem] = useState(false);
  const [deletingItem, setDeletingItem] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    const done = (fn: () => void) => {
      if (!cancelled) fn();
    };
    if (filter === "draft") {
      api
        .listDraftListings(connection.id)
        .then((data) =>
          done(() => {
            setDrafts(data.drafts);
            setCounts((c) => ({ ...c, draft: data.drafts.length }));
            setError(null);
            setLoading(false);
          })
        )
        .catch(() => done(() => { setError("Couldn't load your draft listings. Try again."); setLoading(false); }));
    } else {
      api
        .getConnectionListings(connection.id, filter, page, perPage, debounced)
        .then((data) =>
          done(() => {
            setItems(data.items);
            setTotalPages(data.totalPages);
            setTotalEntries(data.totalEntries);
            setSyncedAt(data.syncedAt);
            setCounts((c) => ({ ...c, [filter]: data.allCount }));
            setError(null);
            setLoading(false);
          })
        )
        .catch(() => done(() => { setError("Couldn't load listings from eBay. Try again."); setLoading(false); }));
    }
    return () => {
      cancelled = true;
    };
  }, [connection, filter, page, perPage, debounced, reloadKey]);

  // eBay (or one of our own publishes) changed this account: show it now.
  useAccountEvents(connection?.id, (event) => {
    if (event.kind === "listings" && filter !== "draft") setReloadKey((k) => k + 1);
  });

  // Last-30-day views per live listing, from stored analytics only.
  const canSeeAnalytics = connection ? connection.permissions === undefined || Boolean(connection.permissions.analytics) : false;
  useEffect(() => {
    if (!connection || !canSeeAnalytics || filter !== "active") return;
    let cancelled = false;
    api
      .getListingAnalyticsSummaries(connection.id)
      .then((d) => !cancelled && setSummaries(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connection, canSeeAnalytics, filter, reloadKey]);

  async function handleRefresh() {
    if (!connection) return;
    setRefreshing(true);
    setRefreshNote(null);
    try {
      await api.refreshConnection(connection.id);
      setReloadKey((k) => k + 1);
    } catch (err) {
      // The list stays; only the status line says why nothing was re-read.
      setRefreshNote(err instanceof ApiError && err.status === 429 ? "Refreshed under a minute ago" : "Couldn't refresh from eBay");
      setTimeout(() => setRefreshNote(null), 6000);
    } finally {
      setRefreshing(false);
    }
  }

  function changeFilter(next: Tab) {
    if (next === filter) return;
    setFilter(next);
    setPage(1);
    setLoading(true);
    router.replace(`/accounts/${params.id}/listings${next === "active" ? "" : `?filter=${next}`}`, { scroll: false });
  }

  async function openLiveEdit(itemId: string) {
    if (!connection) return;
    setEditingItemId(itemId);
    setError(null);
    try {
      const { listing } = await api.startLiveEdit(connection.id, itemId);
      router.push(`/accounts/${connection.id}/listings/draft/${listing.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open this listing for editing. Try again.");
      setEditingItemId(null);
    }
  }

  async function handleDeleteItem() {
    if (!connection || !itemToDelete) return;
    setDeletingItem(true);
    try {
      await api.removeInactiveListing(connection.id, itemToDelete.itemId);
      setItems((list) => list.filter((i) => i.itemId !== itemToDelete.itemId));
      setTotalEntries((n) => Math.max(0, n - 1));
      setCounts((c) => ({ ...c, inactive: Math.max(0, (c.inactive || 1) - 1) }));
      setItemToDelete(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete this listing. Try again.");
    } finally {
      setDeletingItem(false);
    }
  }

  async function handleEndItem() {
    if (!connection || !itemToEnd) return;
    setEndingItem(true);
    try {
      const result = await api.endLiveListing(connection.id, itemToEnd.itemId);
      setItems((list) => list.filter((i) => i.itemId !== itemToEnd.itemId));
      setTotalEntries((n) => Math.max(0, n - 1));
      setCounts((c) => ({ ...c, active: Math.max(0, (c.active || 1) - 1), inactive: (c.inactive || 0) + 1 }));
      setItemToEnd(null);
      if (result.warnings.length) setError(`Ended, but eBay noted: ${result.warnings.join(" ")}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't end this listing. Try again.");
    } finally {
      setEndingItem(false);
    }
  }

  async function handleDeleteDraft() {
    if (!draftToDelete) return;
    setDeletingDraft(true);
    try {
      await api.deleteDraftListing(draftToDelete);
      setDrafts((list) => list.filter((d) => d.id !== draftToDelete));
      setCounts((c) => ({ ...c, draft: (c.draft || 1) - 1 }));
      setDraftToDelete(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete this draft.");
    } finally {
      setDeletingDraft(false);
    }
  }

  if (loadingConnection) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-10">
        <div className="mx-auto max-w-5xl">
          <div className="mb-4 h-6 w-32 animate-pulse rounded-full bg-[var(--color-line)]" />
          <div className="card overflow-hidden">
            <ListSkeleton />
          </div>
        </div>
      </main>
    );
  }

  if (connectionError || !connection || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <Alert>{connectionError || "This account connection doesn't exist, or isn't yours."}</Alert>
      </main>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "active", label: "Active" },
    { key: "draft", label: "Drafts" },
    { key: "inactive", label: "Inactive" },
  ];
  const visibleDrafts = debounced ? drafts.filter((d) => (isVariationDraft(d.generated_data) ? d.generated_data.commonTitle : d.generated_data.title).toLowerCase().includes(debounced.toLowerCase())) : drafts;

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
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Listings</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
            {connection.label} · {connection.platform_name}
          </p>
        </div>
      }
      subheader={
        <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Same control as the per-page selector in the footer: a bordered
            capsule with the active option filled. */}
        <div className="inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => changeFilter(t.key)}
              className={`flex h-7 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-medium transition-colors ${
                filter === t.key ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              }`}
            >
              {t.label}
              {counts[t.key] !== undefined && <span className={filter === t.key ? "text-white/70" : "text-[var(--color-muted)]/70"}>{counts[t.key]}</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {filter !== "draft" && <SyncStatus syncedAt={syncedAt} onRefresh={handleRefresh} refreshing={refreshing} note={refreshNote} />}
          {filter === "draft" && (
            <Link href={`/accounts/${connection.id}/listings/new`} className="btn btn-primary btn-sm">
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
              Draft a listing
            </Link>
          )}
        <div className="relative w-72 max-w-full">
          <svg viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]">
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by title, SKU or item number"
            className="input input-sm !pl-10"
          />
        </div>
        </div>
      </div>
      }
      footer={
        !loading && filter !== "draft" && items.length > 0 ? (
          <ListFooter
            page={page}
            totalPages={totalPages}
            totalEntries={totalEntries}
            perPage={perPage}
            sizes={[25, 50, 100, "all"]}
            onPage={(p) => {
              setPage(p);
              document.querySelector("[data-scroller]")?.scrollTo({ top: 0, behavior: "smooth" });
            }}
            onPerPage={(n) => {
              setPerPage(n);
              setPage(1);
            }}
          />
        ) : null
      }
    >
      {error && (
        <div className="notice notice-danger mb-4">
          <span className="flex-1">{error}</span>
        </div>
      )}
      {endedItemId && (
        <div className="notice notice-success mb-4">
          <span className="flex-1">Listing #{endedItemId} has been ended on eBay. It now sits under Inactive.</span>
        </div>
      )}
      {updatedItemId && !updateWarning && (
        <div className="notice notice-success mb-4">
          <span className="flex-1">Listing #{updatedItemId} has been updated on eBay. It can take a minute to show here.</span>
        </div>
      )}
      {updatedItemId && updateWarning && (
        <div className="notice notice-warning mb-4">
          <span className="flex-1">
            Listing #{updatedItemId} was updated, but eBay didn&apos;t apply everything: {updateWarning}
          </span>
        </div>
      )}

      <div className="card overflow-hidden">
        {loading ? (
          <ListSkeleton />
        ) : filter === "draft" ? (
          visibleDrafts.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <p className="text-sm font-medium text-[var(--color-ink)]">{debounced ? "No drafts match that search" : "No drafts yet"}</p>
              <p className="mt-1 text-[13px] text-[var(--color-muted)]">Listings Liston drafts will show up here, ready for you to review and publish to eBay.</p>
              {!debounced && (
                <Link href={`/accounts/${connection.id}/listings/new`} className="btn btn-primary btn-sm mt-4">
                  Draft a listing
                </Link>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-line)]">
              {visibleDrafts.map((draft) => (
                <DraftRow key={draft.id} draft={draft} connectionId={connection.id} onDelete={() => setDraftToDelete(draft.id)} />
              ))}
            </ul>
          )
        ) : items.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-sm font-medium text-[var(--color-ink)]">{debounced ? "Nothing matches that search" : `No ${filter} listings`}</p>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{debounced ? "Try a different title, SKU or item number." : "Listings on eBay show up here as soon as they're live."}</p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {items.map((item) => (
              <ListingRow
                key={item.itemId}
                item={item}
                stats={
                  filter === "active" && summaries?.status === "ok" && summaries.items[item.itemId]
                    ? summaries.items[item.itemId]
                    : null
                }
                onAnalytics={filter === "active" && canSeeAnalytics ? () => setAnalyticsItem(item.itemId) : undefined}
                editing={editingItemId === item.itemId}
                onEdit={() => openLiveEdit(item.itemId)}
                onDelete={filter === "inactive" && !connection.permissions ? () => setItemToDelete(item) : undefined}
                onEnd={filter === "active" ? () => setItemToEnd(item) : undefined}
              />
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={itemToDelete !== null}
        title="Delete this listing permanently?"
        description="It's removed from Liston for good and cleared from eBay's inventory where Liston created it. This can't be undone. eBay may still show it under Unsold in Seller Hub until it purges old entries."
        confirmLabel="Delete"
        danger
        loading={deletingItem}
        onCancel={() => setItemToDelete(null)}
        onConfirm={handleDeleteItem}
      />
      <ConfirmDialog
        open={itemToEnd !== null}
        title="End this listing on eBay?"
        description={`"${itemToEnd?.title || ""}" comes off eBay straight away and moves to Inactive. Buyers can no longer purchase it; you can relist it from eBay later.`}
        confirmLabel="End listing"
        danger
        loading={endingItem}
        onCancel={() => setItemToEnd(null)}
        onConfirm={handleEndItem}
      />
      <ConfirmDialog
        open={draftToDelete !== null}
        title="Delete this draft?"
        description="This removes the draft from Liston. Nothing has been created on eBay yet, so there's nothing to undo there."
        confirmLabel="Delete"
        danger
        loading={deletingDraft}
        onCancel={() => setDraftToDelete(null)}
        onConfirm={handleDeleteDraft}
      />
      {analyticsItem && <ListingAnalyticsPanel connectionId={connection.id} itemId={analyticsItem} onClose={() => setAnalyticsItem(null)} />}
    </AccountShell>
  );
}
