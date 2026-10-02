"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, DraftListing, isVariationDraft, Listing, ListingSort, ListingStatusFilter, ListingStock } from "@/lib/api";
import { readView, writeView } from "@/lib/viewState";
import { ViewMenu } from "@/components/ViewMenu";
import { useConnection } from "@/lib/useConnection";
import { scrollPageToTop } from "@/lib/pageScroll";
import { formatMoney, formatShortDate } from "@/lib/format";
import { AccountShell } from "@/components/AccountShell";
import { ListFooter } from "@/components/ListFooter";
import { Alert } from "@/components/Alert";
import { ListSkeleton } from "@/components/Skeleton";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useAccountTimeZone } from "@/lib/timezone";
import { useAccountEvents } from "@/lib/useAccountEvents";
import { ListingAnalyticsPanel } from "@/components/analytics/ListingAnalyticsPanel";
import { PillTabs } from "@/components/PillTabs";
import { PriceStockDialog } from "@/components/listings/PriceStockDialog";
import { MenuItem, PopMenu } from "@/components/PopMenu";

type Tab = ListingStatusFilter | "draft";

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

// The Listings tab's orders, sorted over the whole list before paging
// (backend listing-sort.js). eBay's own order is "time left", which for
// Good 'Til Cancelled listings is only the day each one renews.
const SORT_OPTIONS: { key: ListingSort; label: string }[] = [
  { key: "newest", label: "Newest listed" },
  { key: "edited", label: "Recently edited" },
  { key: "best_selling", label: "Best selling" },
  { key: "last_sold", label: "Last sold" },
  { key: "not_selling", label: "Not selling" },
  { key: "low_stock", label: "Low stock" },
  { key: "price_high", label: "Price: high to low" },
  { key: "price_low", label: "Price: low to high" },
];
const INACTIVE_SORT_OPTIONS: { key: ListingSort; label: string }[] = [
  { key: "newest", label: "Recently ended" },
  ...SORT_OPTIONS.filter((o) => !["newest", "not_selling", "low_stock"].includes(o.key)),
];

// Stock at a glance: a soft pill, red once it has run out, amber when it's
// about to, quiet otherwise.
function StockBadge({ available }: { available: number }) {
  const tone =
    available === 0
      ? { pill: "bg-rose-50 text-rose-700", dot: "bg-rose-500", text: "Out of stock" }
      : available <= 3
        ? { pill: "bg-amber-50 text-amber-800", dot: "bg-amber-500", text: `${available} left` }
        : { pill: "bg-[var(--color-paper)] text-[var(--color-ink)]", dot: "bg-emerald-500", text: `${available} in stock` };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-[3px] text-[12px] font-medium ${tone.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {tone.text}
    </span>
  );
}

const PencilIcon = (
  <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden>
    <path d="M10.5 3l2.5 2.5L6 12.5H3.5V10L10.5 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);
const MoreIcon = (
  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
    <circle cx="4.5" cy="10" r="1.6" />
    <circle cx="10" cy="10" r="1.6" />
    <circle cx="15.5" cy="10" r="1.6" />
  </svg>
);
const menuIcon = (d: string) => (
  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
    <path d={d} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const MENU_ICONS = {
  priceStock: menuIcon("M10 3v14M13.5 6H8.25a2.25 2.25 0 000 4.5h3.5a2.25 2.25 0 010 4.5H6"),
  analytics: menuIcon("M4 16V9M10 16V4M16 16v-5"),
  view: menuIcon("M11 4h5v5M16 4l-7 7M14 11.5V15a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h3.5"),
  edit: menuIcon("M12.5 4.5l3 3L7 16H4v-3l8.5-8.5z"),
  relist: menuIcon("M4 10a6 6 0 0110.2-4.3L16 7.5M16 4v3.5h-3.5M16 10a6 6 0 01-10.2 4.3L4 12.5M4 16v-3.5h3.5"),
  hunt: menuIcon("M10 3v3M10 14v3M3 10h3M14 10h3M10 14a4 4 0 100-8 4 4 0 000 8z"),
  copy: menuIcon("M7 7V4.5A1.5 1.5 0 018.5 3h7A1.5 1.5 0 0117 4.5v7a1.5 1.5 0 01-1.5 1.5H13M4.5 7h7A1.5 1.5 0 0113 8.5v7a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 15.5v-7A1.5 1.5 0 014.5 7z"),
  end: menuIcon("M6 6l8 8M14 6l-8 8"),
  trash: menuIcon("M4 6h12M8.5 9v5M11.5 9v5M5.5 6l.7 9.2a1.5 1.5 0 001.5 1.3h4.6a1.5 1.5 0 001.5-1.3L14.5 6M8 6V4h4v2"),
};

// The Listings tab's columns: the listing, then price, stock and sales, then
// its actions. One grid for the header and every row, so they line up.
const LISTING_COLUMNS = "xl:grid xl:grid-cols-[minmax(0,1fr)_104px_136px_156px_40px] xl:items-center xl:gap-5";

function ListingColumnsHeader({ labels }: { labels: [string, string, string, string] }) {
  return (
    <div className={`hidden border-b border-[var(--color-line)] bg-[var(--color-paper)]/60 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)] ${LISTING_COLUMNS}`}>
      <span>{labels[0]}</span>
      <span className="text-center">{labels[1]}</span>
      <span className="text-center">{labels[2]}</span>
      <span className="text-center">{labels[3]}</span>
      <span className="sr-only">Actions</span>
    </div>
  );
}

// A row's "…": everything it can do, Edit first. While a listing opens for
// editing it turns into a spinner.
function RowMenu({ label, items, busy = false }: { label: string; items: MenuItem[]; busy?: boolean }) {
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  return (
    <div className="ml-auto flex items-center justify-end xl:ml-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMenuAt(menuAt ? null : e.currentTarget);
        }}
        disabled={busy}
        aria-label={busy ? "Opening…" : `Actions for ${label}`}
        title={busy ? "Opening…" : "Actions"}
        aria-haspopup="menu"
        aria-expanded={Boolean(menuAt)}
        className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border transition-colors ${
          menuAt ? "border-[var(--color-line-strong)] bg-[var(--color-panel)] text-[var(--color-ink)]" : "border-transparent text-[var(--color-muted)] hover:border-[var(--color-line)] hover:bg-[var(--color-panel)] hover:text-[var(--color-ink)]"
        }`}
      >
        {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-hidden /> : MoreIcon}
      </button>
      {menuAt && <PopMenu anchor={menuAt} items={items} onClose={() => setMenuAt(null)} />}
    </div>
  );
}

// One listing: its photo, title and labels; its price, stock and sales (a
// live one's price and stock open the quick edit); a "…" menu with what it
// can do, Edit (Relist once ended) first. A click elsewhere on the row opens
// it on eBay.
function ListingRow({
  item,
  onEdit,
  relist,
  editing,
  onDelete,
  onEnd,
  onAnalytics,
  onPriceStock,
}: {
  item: Listing;
  onEdit: () => void;
  relist?: boolean; // an ended listing: opens it to relist
  editing: boolean;
  onDelete?: () => void;
  onEnd?: () => void;
  onAnalytics?: () => void;
  // A live listing: its price and stock alone, changed on eBay without a full edit.
  onPriceStock?: () => void;
}) {
  const timeZone = useAccountTimeZone();
  const [copied, setCopied] = useState(false);
  const open = () => {
    if (item.viewItemUrl) window.open(item.viewItemUrl, "_blank", "noopener");
  };
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const copyId = () => {
    navigator.clipboard?.writeText(item.itemId).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {}
    );
  };
  const menu: MenuItem[] = [
    relist ? { label: "Relist", icon: MENU_ICONS.relist, onSelect: onEdit } : { label: "Edit listing", icon: MENU_ICONS.edit, onSelect: onEdit },
    ...(onPriceStock ? [{ label: "Price & stock", icon: MENU_ICONS.priceStock, onSelect: onPriceStock }] : []),
    ...(onAnalytics ? [{ label: "Traffic & sales", icon: MENU_ICONS.analytics, onSelect: onAnalytics }] : []),
    ...(item.viewItemUrl ? [{ label: "View on eBay", icon: MENU_ICONS.view, onSelect: open }] : []),
    { label: "Copy item number", icon: MENU_ICONS.copy, onSelect: copyId },
    ...(onEnd ? [{ label: "End listing", icon: MENU_ICONS.end, danger: true, separated: true, onSelect: onEnd }] : []),
    ...(onDelete ? [{ label: "Delete permanently", icon: MENU_ICONS.trash, danger: true, separated: true, onSelect: onDelete }] : []),
  ];
  // eBay's ended-listings list can report 0 sold for one that did sell: an order Liston holds says otherwise.
  const sold = item.quantitySold > 0 || Boolean(item.lastSoldAt);
  const salesText = sold ? `${item.quantitySold > 0 ? `${item.quantitySold} sold` : "Sold"}${item.lastSoldAt ? `, last ${formatShortDate(item.lastSoldAt, timeZone)}` : ""}` : "No sales yet";
  const editable = (child: React.ReactNode, label: string, className = "") =>
    onPriceStock ? (
      <button type="button" onClick={stop(onPriceStock)} title={label} aria-label={label} className={`group/edit relative -mx-1.5 inline-flex items-center rounded-lg px-1.5 py-1 transition-colors hover:bg-[var(--color-primary-soft)] ${className}`}>
        {child}
        {/* Hung outside the figure, so the figure stays centred under its heading. */}
        <span className="pointer-events-none absolute -right-4 top-1/2 -translate-y-1/2 text-[var(--color-primary)] opacity-0 transition-opacity group-hover/edit:opacity-100 [@media(hover:none)]:hidden">{PencilIcon}</span>
      </button>
    ) : (
      <span className={className}>{child}</span>
    );

  return (
    <li
      onClick={open}
      // Dragged into team chat, it's shared as the listing's card.
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-liston-ref", JSON.stringify({ kind: "listing", id: String(item.itemId) }));
        e.dataTransfer.effectAllowed = "copy";
      }}
      className={`group px-4 py-3.5 transition-colors hover:bg-[var(--color-paper)]/70 sm:px-5 ${LISTING_COLUMNS} ${item.viewItemUrl ? "cursor-pointer" : ""}`}
    >
      {/* The listing */}
      <div className="flex min-w-0 items-center gap-3.5">
        <Thumb src={item.imageUrl} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[14px] font-medium leading-snug text-[var(--color-ink)] group-hover:text-[var(--color-primary)] xl:line-clamp-1" title={item.title}>
            {item.title}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[var(--color-muted)]">
            <span className="font-mono text-[11.5px] tracking-tight">#{item.itemId}</span>
            {item.sku && (
              <>
                <span aria-hidden>·</span>
                <span className="max-w-[160px] truncate">SKU {item.sku}</span>
              </>
            )}
            {item.startTime && (
              <>
                <span aria-hidden>·</span>
                <span>Listed {formatShortDate(item.startTime, timeZone)}</span>
              </>
            )}
            {item.lastEditedAt && (
              <>
                <span aria-hidden>·</span>
                <span title="Last edited from Liston">Edited {formatShortDate(item.lastEditedAt, timeZone)}</span>
              </>
            )}
            {/* Until the columns show (xl), the sales sit here. */}
            <span className="xl:hidden" aria-hidden>·</span>
            <span className={`xl:hidden ${sold ? "font-medium text-[var(--color-ink)]" : ""}`}>{salesText}</span>
            {copied && <span className="font-medium text-[var(--color-accent)]">Item number copied</span>}
          </p>
        </div>
      </div>

      {/* Price, stock and sales: a line of their own under the listing on a phone. */}
      <div className="mt-3 flex items-center gap-x-3 sm:pl-[4.375rem] xl:contents">
        <div className="xl:text-center">{editable(<span className="text-[15px] font-semibold tabular-nums tracking-tight text-[var(--color-ink)]">{formatMoney(item.price)}</span>, "Change the price or stock")}</div>
        <div className="xl:text-center">{editable(<StockBadge available={item.quantityAvailable} />, "Change the price or stock")}</div>
        <div className="hidden min-w-0 text-[12.5px] leading-tight xl:block xl:text-center">
          {sold ? (
            <>
              <span className="font-semibold tabular-nums text-[var(--color-ink)]">{item.quantitySold > 0 ? `${item.quantitySold} sold` : "Sold"}</span>
              {item.lastSoldAt && <span className="mt-0.5 block text-[11.5px] text-[var(--color-muted)]">Last {formatShortDate(item.lastSoldAt, timeZone)}</span>}
            </>
          ) : (
            <span className="text-[var(--color-muted)]">No sales yet</span>
          )}
        </div>

        {/* Actions */}
        <RowMenu label={item.title} items={menu} busy={editing} />
      </div>
    </li>
  );
}

// Who a draft is down to, for its column: who hunted it, else who drafted
// it. Drafts made before Liston recorded who drafts (24 Sept 2026) have no one.
function draftOwner(origin: DraftListing["origin"]): { name: string; role: "Hunted" | "Drafted" } | null {
  if (origin?.hunt?.hunter) return { name: origin.hunt.hunter.name, role: "Hunted" };
  if (origin?.draftedBy) return { name: origin.draftedBy.name, role: "Drafted" };
  return null;
}

function PersonCell({ person }: { person: { name: string; role: string } | null }) {
  if (!person) {
    return (
      <span className="text-[12px] text-[var(--color-muted)]" title="Drafted before Liston recorded who drafts and hunts (24 Sept 2026)">
        Not recorded
      </span>
    );
  }
  return (
    <span className="inline-flex max-w-full items-center gap-2 text-left">
      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-[12px] font-semibold text-[var(--color-primary)]" aria-hidden>
        {person.name.trim().charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[12.5px] font-medium text-[var(--color-ink)]">{person.name}</span>
        <span className="block text-[11px] text-[var(--color-muted)]">{person.role}</span>
      </span>
    </span>
  );
}

// The rest of a draft's story, in a line under its labels: where its hunted
// product was found (opening it), who approved it and who drafted it (when
// that isn't who hunted it), then who last worked on it.
function DraftOrigin({ draft, connectionId }: { draft: DraftListing; connectionId: string }) {
  const timeZone = useAccountTimeZone();
  const origin = draft.origin;
  if (!origin) return null;
  const who = (p: { name: string } | null | undefined) => (p ? <span className="font-medium text-[var(--color-ink)]">{p.name}</span> : null);
  const parts: React.ReactNode[] = [];
  if (origin.hunt) {
    parts.push(
      <Link key="hunt" href={`/accounts/${connectionId}/hunting?open=${encodeURIComponent(origin.hunt.id)}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
        {origin.hunt.addedFrom ? `Found in ${origin.hunt.addedFrom === "discover" ? "Discover" : "Product research"}` : "Hunted product"}
      </Link>
    );
    if (origin.hunt.reviewer) parts.push(<span key="approved">Approved by {who(origin.hunt.reviewer)}</span>);
    if (origin.draftedAutomatically) parts.push(<span key="auto">Drafted on approval</span>);
    else if (origin.draftedBy && origin.draftedBy.name !== origin.hunt.hunter?.name) parts.push(<span key="drafted">Drafted by {who(origin.draftedBy)}</span>);
  }
  if (origin.lastEdit) parts.push(<span key="edited">Edited{origin.lastEdit.by ? <> by {who(origin.lastEdit.by)}</> : null} {formatShortDate(origin.lastEdit.at, timeZone)}</span>);
  if (!parts.length) return null;
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[var(--color-muted)]">
      {parts.flatMap((part, i) => (i ? [<span key={`dot-${i}`} aria-hidden>·</span>, part] : [part]))}
    </p>
  );
}

// A draft, in the live listings' columns: its photo, title and labels (a
// publish eBay refused among them) and the rest of its story; its price (the
// lowest, "from" when options differ), how many it will list, and the team
// member who hunted or drafted it; a "…" menu, Edit first. A click
// elsewhere on the row opens it.
function DraftRow({ draft, connectionId, onDelete }: { draft: DraftListing; connectionId: string; onDelete: () => void }) {
  const router = useRouter();
  const timeZone = useAccountTimeZone();
  const content = draft.generated_data;
  const isVariation = isVariationDraft(content);
  const title = isVariation ? content.commonTitle : content.title;
  const image = content.imageUrls[0];
  const prices = (isVariation ? content.variants.map((v) => v.price) : [content.price]).filter((p) => p && Number(p.value) > 0);
  const lowest = prices.length ? prices.reduce((a, b) => (Number(b.value) < Number(a.value) ? b : a)) : null;
  const priceVaries = new Set(prices.map((p) => Number(p.value).toFixed(2))).size > 1;
  const quantity = isVariation ? content.variants.reduce((n, v) => n + (Number(v.quantity) || 0), 0) : Number(content.quantity ?? 0);
  const variantCount = isVariation ? content.variants.length : null;
  const href = `/accounts/${connectionId}/listings/draft/${draft.id}`;
  const failed = Boolean(draft.error_message);
  const menu: MenuItem[] = [
    { label: "Edit draft", icon: MENU_ICONS.edit, onSelect: () => router.push(href) },
    ...(draft.origin?.hunt ? [{ label: "Open hunted product", icon: MENU_ICONS.hunt, onSelect: () => router.push(`/accounts/${connectionId}/hunting?open=${encodeURIComponent(draft.origin!.hunt!.id)}`) }] : []),
    { label: "Delete draft", icon: MENU_ICONS.trash, danger: true, separated: true, onSelect: onDelete },
  ];
  return (
    <li onClick={() => router.push(href)} className={`group cursor-pointer px-4 py-3.5 transition-colors hover:bg-[var(--color-paper)]/70 sm:px-5 ${LISTING_COLUMNS}`}>
      <div className="flex min-w-0 items-center gap-3.5">
        <Thumb src={image || null} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[14px] font-medium leading-snug text-[var(--color-ink)] group-hover:text-[var(--color-primary)] xl:line-clamp-1" title={title}>
            {title}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[var(--color-muted)]">
            <span>{variantCount !== null ? `${variantCount} variations` : "Single listing"}</span>
            {draft.sku && (
              <>
                <span aria-hidden>·</span>
                <span className="max-w-[160px] truncate">SKU {draft.sku}</span>
              </>
            )}
            {draft.created_at && (
              <>
                <span aria-hidden>·</span>
                <span>Drafted {formatShortDate(draft.created_at, timeZone)}</span>
              </>
            )}
            {failed && (
              <>
                <span aria-hidden>·</span>
                <span className="font-medium text-rose-600" title={draft.error_message || undefined}>
                  Publish failed
                </span>
              </>
            )}
          </p>
          <DraftOrigin draft={draft} connectionId={connectionId} />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-x-3 sm:pl-[4.375rem] xl:contents">
        <div className="xl:text-center">
          {lowest ? (
            <span className="inline-flex flex-col items-start leading-tight xl:items-center">
              {priceVaries && <span className="text-[10.5px] font-medium uppercase tracking-wide text-[var(--color-muted)]">from</span>}
              <span className="text-[15px] font-semibold tabular-nums tracking-tight text-[var(--color-ink)]">{formatMoney({ amount: Number(lowest.value), currency: lowest.currency })}</span>
            </span>
          ) : (
            <span className="text-[12.5px] text-[var(--color-muted)]">No price</span>
          )}
        </div>
        <div className="xl:text-center">
          <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-[3px] text-[12px] font-medium ${quantity > 0 ? "bg-[var(--color-paper)] text-[var(--color-ink)]" : "bg-amber-50 text-amber-800"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${quantity > 0 ? "bg-[var(--color-primary)]" : "bg-amber-500"}`} />
            {quantity > 0 ? `${quantity} to list` : "No stock set"}
          </span>
        </div>
        <div className="min-w-0 xl:flex xl:justify-center">
          <PersonCell person={draftOwner(draft.origin)} />
        </div>
        <RowMenu label={title} items={menu} />
      </div>
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
  const relistedItemId = searchParams.get("relisted");
  const relistedFrom = searchParams.get("from");
  const [filter, setFilter] = useState<Tab>(urlFilter === "draft" || urlFilter === "inactive" ? urlFilter : "active");
  // ?q= opens the tab already searched (the analytics panel's "Open in
  // Listings" passes the item number).
  const urlSearch = searchParams.get("q") || "";
  const [search, setSearch] = useState(urlSearch);
  const [debounced, setDebounced] = useState(urlSearch.trim());
  const [page, setPage] = useState(1);
  // The order per tab, remembered for this account (lib/viewState).
  const sortKey = `listings-sort:${params.id}`;
  const [sorts, setSorts] = useState<{ active?: ListingSort; inactive?: ListingSort }>(() => readView<{ active: ListingSort; inactive: ListingSort }>(sortKey));
  const sort: ListingSort = (filter === "inactive" ? sorts.inactive : sorts.active) || "newest";
  function changeSort(next: ListingSort) {
    const tab = filter === "inactive" ? "inactive" : "active";
    setSorts((s) => ({ ...s, [tab]: next }));
    writeView(sortKey, { [tab]: next });
    setPage(1);
  }
  const [perPage, setPerPage] = useState<number | "all">(25);
  const [items, setItems] = useState<Listing[]>([]);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  // Bumped after a manual refresh so the load effect runs again.
  const [reloadKey, setReloadKey] = useState(0);
  const [drafts, setDrafts] = useState<DraftListing[]>([]);
  // Approved hunted products nobody has drafted yet, pointed to from Drafts.
  const [readyHunts, setReadyHunts] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [totalEntries, setTotalEntries] = useState(0);
  const [counts, setCounts] = useState<{ active?: number; inactive?: number; draft?: number }>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draftToDelete, setDraftToDelete] = useState<string | null>(null);
  const [deletingDraft, setDeletingDraft] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [analyticsItem, setAnalyticsItem] = useState<string | null>(null);
  const [itemToDelete, setItemToDelete] = useState<Listing | null>(null);
  const [itemToEnd, setItemToEnd] = useState<Listing | null>(null);
  // The live listing whose price and stock are open, and the note after a change went.
  const [priceStockItem, setPriceStockItem] = useState<Listing | null>(null);
  const [stockNote, setStockNote] = useState<string | null>(null);
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
        .huntBadge(connection.id)
        .then((b) => done(() => setReadyHunts(b.approved)))
        .catch(() => {});
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
        .getConnectionListings(connection.id, filter, page, perPage, debounced, sort)
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
  }, [connection, filter, page, perPage, debounced, sort, reloadKey]);

  // eBay (or one of our own publishes) changed this account: show it now.
  useAccountEvents(connection?.id, (event) => {
    if (event.kind === "listings" && filter !== "draft") setReloadKey((k) => k + 1);
  });

  const canSeeAnalytics = connection ? connection.permissions === undefined || Boolean(connection.permissions.analytics) : false;

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
      const { listing } = await api.startLiveEdit(connection.id, itemId, { inactive: filter === "inactive" });
      router.push(`/accounts/${connection.id}/listings/draft/${listing.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open this listing for editing. Try again.");
      setEditingItemId(null);
    }
  }

  // The row shows what eBay now has: the lowest price and everything left to buy.
  function applyStock(itemId: string, stock: ListingStock) {
    const prices = stock.rows.map((r) => r.price).filter((p): p is NonNullable<typeof p> => Boolean(p));
    const lowest = prices.length ? prices.reduce((a, b) => (b.amount < a.amount ? b : a)) : null;
    const available = stock.rows.reduce((n, r) => n + r.available, 0);
    setItems((list) => list.map((i) => (i.itemId === itemId ? { ...i, ...(lowest ? { price: { ...(i.price || lowest), amount: lowest.amount, currency: lowest.currency } } : {}), quantityAvailable: available } : i)));
    setStockNote(`Price and stock updated on eBay for "${stock.title}".`);
    setTimeout(() => setStockNote(null), 6000);
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
      <main className="min-h-screen bg-[var(--color-paper)] p-4 sm:p-10">
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
      sync={filter !== "draft" ? { syncedAt, onRefresh: handleRefresh, refreshing, note: refreshNote } : undefined}
      header={
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Listings</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
            {connection.label} · {connection.marketplace?.name ?? connection.platform_name}
          </p>
        </div>
      }
      subheader={
        <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Same control as the per-page selector in the footer: a bordered
            capsule with the active option filled. */}
        <PillTabs label="Listings" tabs={tabs.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] }))} value={filter} onChange={changeFilter} />
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto sm:flex-wrap sm:justify-end">
          {filter === "draft" && (
            <Link href={`/accounts/${connection.id}/listings/new`} className="btn btn-primary btn-sm">
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
              Draft a listing
            </Link>
          )}
          {filter !== "draft" && (
            <ViewMenu title="Sort listings" sections={[{ label: "Sort", value: sort, options: filter === "inactive" ? INACTIVE_SORT_OPTIONS : SORT_OPTIONS, onChange: (k) => changeSort(k as ListingSort) }]} />
          )}
        <div className="relative min-w-0 flex-1 sm:w-72 sm:flex-none">
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
              scrollPageToTop();
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
      {stockNote && (
        <div className="notice notice-success mb-4" role="status">
          <span className="flex-1">{stockNote}</span>
        </div>
      )}
      {endedItemId && (
        <div className="notice notice-success mb-4">
          <span className="flex-1">Listing #{endedItemId} has been ended on eBay. It now sits under Inactive.</span>
        </div>
      )}
      {relistedItemId && (
        <div className={`notice ${updateWarning ? "notice-warning" : "notice-success"} mb-4`}>
          <span className="flex-1">
            Relisted on eBay as #{relistedItemId}
            {relistedFrom ? ` (was #${relistedFrom})` : ""}. It can take a minute to show under Active.
            {updateWarning ? ` eBay noted: ${updateWarning}` : ""}
          </span>
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

      {filter === "draft" && readyHunts > 0 && (
        <Link
          href={`/accounts/${connection.id}/hunting?view=approved`}
          className="mb-4 flex items-center gap-3 rounded-[var(--radius-card)] border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-[13px] text-[var(--color-ink)] transition-colors hover:border-emerald-300"
        >
          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
              <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="2" />
              <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="2" />
            </svg>
          </span>
          <span className="min-w-0 flex-1">
            <b className="font-semibold">
              {readyHunts} approved hunted product{readyHunts === 1 ? "" : "s"}
            </b>{" "}
            {readyHunts === 1 ? "is" : "are"} ready to draft.
          </span>
          <span className="flex-shrink-0 font-semibold text-emerald-700">Open Hunting</span>
        </Link>
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
            <>
              <ListingColumnsHeader labels={["Draft", "Price", "Stock", "Hunted / drafted by"]} />
              <ul className="divide-y divide-[var(--color-line)]">
                {visibleDrafts.map((draft) => (
                  <DraftRow key={draft.id} draft={draft} connectionId={connection.id} onDelete={() => setDraftToDelete(draft.id)} />
                ))}
              </ul>
            </>
          )
        ) : items.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-sm font-medium text-[var(--color-ink)]">{debounced ? "Nothing matches that search" : `No ${filter} listings`}</p>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{debounced ? "Try a different title, SKU or item number." : "Listings on eBay show up here as soon as they're live."}</p>
          </div>
        ) : (
          <>
          <ListingColumnsHeader labels={["Listing", "Price", "Stock", "Sales"]} />
          <ul className="divide-y divide-[var(--color-line)]">
            {items.map((item) => (
              <ListingRow
                key={item.itemId}
                item={item}
                onAnalytics={filter === "active" && canSeeAnalytics ? () => setAnalyticsItem(item.itemId) : undefined}
                editing={editingItemId === item.itemId}
                onEdit={() => openLiveEdit(item.itemId)}
                relist={filter === "inactive"}
                onDelete={filter === "inactive" && !connection.permissions ? () => setItemToDelete(item) : undefined}
                onEnd={filter === "active" ? () => setItemToEnd(item) : undefined}
                onPriceStock={filter === "active" ? () => setPriceStockItem(item) : undefined}
              />
            ))}
          </ul>
          </>
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
        description={`"${itemToEnd?.title || ""}" comes off eBay straight away and moves to Inactive. Buyers can no longer purchase it; you can relist it from the Inactive tab later.`}
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
      {priceStockItem && (
        <PriceStockDialog
          connectionId={connection.id}
          itemId={priceStockItem.itemId}
          title={priceStockItem.title}
          imageUrl={priceStockItem.imageUrl}
          onClose={() => setPriceStockItem(null)}
          onSaved={(stock) => applyStock(priceStockItem.itemId, stock)}
        />
      )}
      {analyticsItem && (
        <ListingAnalyticsPanel
          connectionId={connection.id}
          itemId={analyticsItem}
          onClose={() => setAnalyticsItem(null)}
        />
      )}
    </AccountShell>
  );
}
