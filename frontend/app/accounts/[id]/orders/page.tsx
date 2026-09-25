"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, Order, OrderCounts, OrderRange, OrderSort, OrderStatusFilter, SupplierFilter } from "@/lib/api";
import { readView, writeView } from "@/lib/viewState";
import { useConnection } from "@/lib/useConnection";
import { formatMoney, formatShortDate, formatTime, internationalPhone } from "@/lib/format";
import { useAccountTimeZone } from "@/lib/timezone";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import { AccountPageSkeleton, ListSkeleton } from "@/components/Skeleton";
import { ListFooter } from "@/components/ListFooter";
import { ViewMenu } from "@/components/ViewMenu";
import { useAccountEvents } from "@/lib/useAccountEvents";

// How the list is ordered, apart from which days it covers. Each status tab
// keeps its own choice; untouched, Awaiting dispatch shows the nearest
// dispatch deadline first and the rest newest first.
const SORT_LABELS: Record<OrderSort, string> = {
  newest: "Newest",
  oldest: "Oldest",
  dispatch_soonest: "Dispatch soonest",
  total_high: "Highest total",
};
const defaultSort = (status: OrderStatusFilter): OrderSort => (status === "awaiting_dispatch" ? "dispatch_soonest" : "newest");

const RANGE_LABELS: Record<OrderRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};
const RANGE_SHORT: Record<OrderRange, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days" };

// Where the supplier order stands (orders/order-supplier.js on the server).
// Each status tab keeps its own choice; untouched, the tabs where new orders
// land (All, Awaiting dispatch) show only those not yet ordered from the
// supplier, and the rest show everything.
const SUPPLIER_LABELS: Record<SupplierFilter, string> = {
  any: "Any",
  pending: "Not ordered yet",
  ordered: "Ordered",
  shipped: "Supplier shipped",
  delivered: "Supplier delivered",
  problem: "Problem",
};
const SUPPLIER_SHORT: Partial<Record<SupplierFilter, string>> = { pending: "To order", shipped: "Shipped", delivered: "Delivered" };
const SUPPLIER_PHRASE: Record<SupplierFilter, string> = {
  any: "",
  pending: "not yet ordered from the supplier",
  ordered: "ordered from the supplier",
  shipped: "shipped by the supplier",
  delivered: "delivered by the supplier",
  problem: "with a supplier problem",
};
const defaultSupplier = (status: OrderStatusFilter): SupplierFilter => (status === "all" || status === "awaiting_dispatch" ? "pending" : "any");

const STATUS_TABS: { key: OrderStatusFilter; label: string }[] = [
  { key: "all", label: "All orders" },
  { key: "awaiting_dispatch", label: "Awaiting dispatch" },
  { key: "dispatched", label: "Dispatched" },
  { key: "delivered", label: "Delivered" },
  { key: "cancelled", label: "Cancelled" },
];

// eBay's own table doesn't use colored badges for status — just bold text,
// occasionally tinted (red for cancelled). Matching that instead of a pill.
const STATUS_TEXT_STYLES: Record<OrderStatusFilter, string> = {
  all: "text-[var(--color-ink)]",
  awaiting_payment: "text-amber-700",
  awaiting_dispatch: "text-[var(--color-ink)]",
  dispatched: "text-emerald-700",
  delivered: "text-emerald-800",
  cancelled: "text-[var(--color-danger)]",
};

// Dates in the account's time zone (its eBay site's), as Seller Hub shows them.
function statusLabel(order: Order, timeZone?: string): string {
  switch (order.derivedStatus) {
    case "awaiting_payment":
      return "Awaiting payment";
    case "awaiting_dispatch":
      return order.dispatchByTime ? `Dispatch by ${formatShortDate(order.dispatchByTime, timeZone)}` : "Awaiting dispatch";
    case "dispatched":
      return order.shippedTime ? `Dispatched ${formatShortDate(order.shippedTime, timeZone)}` : "Dispatched";
    case "delivered":
      return order.deliveredAt ? `Delivered ${formatShortDate(order.deliveredAt, timeZone)}` : "Delivered";
    case "cancelled":
      return "Cancelled";
    default:
      return order.status;
  }
}

// eBay's order line items already bake "[Variation Specifics]" onto the end
// of the title string itself — rendering li.variation next to the raw title
// duplicated it. Strip that suffix so the title is clean, and show the
// specifics eBay's own style: "Color: X   Size: Y" underneath.
function cleanLineItemTitle(title: string | null): string {
  if (!title) return "";
  return title.replace(/\[[^[\]]*\]\s*$/, "").trim();
}

// Fixed column widths shared by the header and every row, so everything
// lines up into real table columns: Status | Order | Customer | Qty | Total
// | Date. One price (what the buyer paid) and one date (when they bought):
// the breakdown lives on eBay's order page, not here.
const ROW_COLUMNS = "136px minmax(220px,1fr) 240px 48px 96px 96px";

function OrderTableHeader() {
  return (
    <div
      className="grid gap-3 border-b border-[var(--color-line)] bg-[var(--color-paper)]/60 px-4 py-2 text-[10.5px] font-bold uppercase tracking-wider text-[var(--color-muted)]"
      style={{ gridTemplateColumns: ROW_COLUMNS }}
    >
      <span>Status</span>
      <span>Order</span>
      <span className="text-center">Customer</span>
      <span className="text-center">Qty</span>
      <span className="text-right">Total</span>
      <span className="text-right">Date</span>
    </div>
  );
}

// International dialling codes for the markets Liston sells on. A buyer's
// phone comes from eBay as a local number; the account's marketplace says
// which country that is.

// Who it goes to: name, then the address as eBay gives it, then the phone
// — each on its own line, so it can be read straight onto a label. The name
// is a link-in-waiting: it opens a conversation once the Inbox exists.
function CustomerCell({ order, country, countryName }: { order: Order; country: string | undefined; countryName: string | undefined }) {
  const a = order.shippingAddress;
  const name = a?.name || order.buyerName || order.buyerUserId || "Unknown buyer";
  // Two lines: the street, then town · county · postcode · country. The
  // buyer's own country is what matters for the label; on a domestic order
  // it is the marketplace's and says nothing, so it is left off.
  const streetLine = a ? [a.street1, a.street2].filter(Boolean).join(", ") : "";
  const domestic = a?.country && countryName && a.country.toLowerCase() === countryName.toLowerCase();
  const placeLine = a ? [a.city, a.state, a.postalCode, domestic ? "" : a.country].filter(Boolean).join(" · ") : "";
  const addressLines = [streetLine, placeLine].filter(Boolean);
  const phone = a?.phone ? internationalPhone(a.phone, country) : null;
  return (
    <div className="min-w-0 pt-0.5 text-center text-[12.5px] leading-snug text-[var(--color-ink)]">
      <p className="truncate">
        <button type="button" title="Message this buyer (coming with Inbox)" className="font-medium underline decoration-[var(--color-line-strong)] underline-offset-2 hover:text-[var(--color-primary)] hover:decoration-[var(--color-primary)]">
          {name}
        </button>
      </p>
      {addressLines.map((line, i) => (
        <p key={i} className="line-clamp-2 text-[11.5px] leading-[1.35] text-[var(--color-muted)]">
          {line}
        </p>
      ))}
      {phone && (
        <p className="truncate text-[11.5px]">
          <a href={`tel:${phone.replace(/\s+/g, "")}`} className="text-[var(--color-muted)] underline decoration-[var(--color-line-strong)] underline-offset-2 hover:text-[var(--color-primary)] hover:decoration-[var(--color-primary)]">
            {phone}
          </a>
        </p>
      )}
      {!a && order.buyerUserId && <p className="truncate text-[var(--color-muted)]">@{order.buyerUserId}</p>}
    </div>
  );
}

// One order per row. The Order column carries the order number and buyer
// on a quiet first line, then each item as a thumbnail beside a two-line
// title and its details; the money and dates sit in their columns at the
// top of the row, where the eye lands.
const SOURCING_LABELS: Record<string, { text: string; className: string }> = {
  to_order: { text: "To order", className: "bg-amber-50 text-amber-800 border-amber-200" },
  ordered: { text: "Ordered", className: "bg-[var(--color-paper)] text-[var(--color-muted)] border-[var(--color-line)]" },
  shipped: { text: "Shipped", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  delivered: { text: "Delivered", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  problem: { text: "Problem", className: "bg-red-50 text-[var(--color-danger)] border-red-200" },
};

// The supplier-order state of the whole order, from its lines: the least
// advanced line wins, so "Shipped" means every item has shipped.
function sourcingSummary(order: Order) {
  const rows = order.sourcing || [];
  if (!rows.length) return null;
  const rank = ["problem", "to_order", "ordered", "shipped", "delivered"];
  const lowest = rows.map((r) => r.status).sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0];
  const partial = rows.length < order.lineItems.length;
  return { ...SOURCING_LABELS[lowest], partial };
}

function OrderCard({ order, country, countryName, href }: { order: Order; country: string | undefined; countryName: string | undefined; href: string }) {
  const router = useRouter();
  const timeZone = useAccountTimeZone();
  const statusStyle = STATUS_TEXT_STYLES[order.derivedStatus || "all"];
  const sourcing = sourcingSummary(order);
  const shippingCost =
    order.total && order.subtotal ? Math.round((order.total.amount - order.subtotal.amount) * 100) / 100 : null;
  const quantity = order.lineItems.reduce((n, li) => n + (li.quantityPurchased || 0), 0);
  const multi = order.lineItems.length > 1;

  return (
    <div
      className="grid cursor-pointer items-start gap-3 border-b border-[var(--color-line)] px-4 py-3.5 last:border-b-0 hover:bg-[var(--color-paper)]/40"
      style={{ gridTemplateColumns: ROW_COLUMNS }}
      title="Open order"
      onClick={(e) => {
        // The row opens the order; links and buttons inside keep their own job.
        if ((e.target as HTMLElement).closest("a, button")) return;
        router.push(href);
      }}
    >
      <div className="pt-0.5">
        <p className={`text-[12.5px] font-medium leading-snug ${statusStyle}`}>{statusLabel(order, timeZone)}</p>
        {sourcing && (
          <span className={`mt-1.5 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${sourcing.className}`} title="Supplier order">
            {sourcing.text}
            {sourcing.partial ? " (some)" : ""}
          </span>
        )}
      </div>

      <div className="min-w-0">
        <p className="mb-2 pt-0.5 text-[12.5px] leading-snug">
          <Link href={href} className="block font-mono text-[12.5px] leading-snug tracking-tight text-[var(--color-ink)] underline decoration-[var(--color-line-strong)] underline-offset-2 hover:text-[var(--color-primary)] hover:decoration-[var(--color-primary)]">
            {order.orderId}
          </Link>
        </p>
        <div className="space-y-2.5">
          {order.lineItems.map((li, i) => (
            <div key={`${li.itemId}-${i}`} className="flex items-start gap-3">
              {li.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={li.imageUrl} alt="" className="h-14 w-14 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-cover" />
              ) : (
                <div className="h-14 w-14 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)]" />
              )}
              <div className="min-w-0 flex-1">
                {li.viewItemUrl ? (
                  <a href={li.viewItemUrl} target="_blank" rel="noreferrer" className="line-clamp-2 max-w-[400px] text-[12.5px] font-medium leading-snug text-[var(--color-ink)] hover:text-[var(--color-primary)]">
                    {cleanLineItemTitle(li.title)}
                  </a>
                ) : (
                  <p className="line-clamp-2 max-w-[400px] text-[12.5px] font-medium leading-snug text-[var(--color-ink)]">{cleanLineItemTitle(li.title)}</p>
                )}
                <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-[var(--color-muted)]">
                  <span className="font-mono tracking-tight">#{li.itemId}</span>
                  {multi && <span>× {li.quantityPurchased}</span>}
                  {li.variation.map((v) => (
                    <span key={v.name}>
                      <span className="font-bold text-[var(--color-ink)]">{v.name}:</span> {v.value}
                    </span>
                  ))}
                  {li.quantityAvailable !== null && <span>{li.quantityAvailable} in stock</span>}
                  {li.trackingNumber && (
                    <span>
                      {li.trackingCarrier ? `${li.trackingCarrier} ` : ""}
                      {li.trackingNumber}
                    </span>
                  )}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <CustomerCell order={order} country={country} countryName={countryName} />
      <p className="pt-0.5 text-center text-[12.5px] font-semibold leading-snug text-[var(--color-ink)]">{quantity}</p>
      <div className="pt-0.5 text-right text-[12.5px] font-semibold leading-snug text-[var(--color-ink)]">
        {formatMoney(order.total)}
        {shippingCost !== null && shippingCost > 0 && (
          <p className="mt-0.5 text-[11px] font-normal text-[var(--color-muted)]">incl. {formatMoney({ amount: shippingCost, currency: order.total?.currency })} postage</p>
        )}
      </div>
      <div className="pt-0.5 text-right text-[12.5px] leading-snug text-[var(--color-ink)]">
        <p>{formatShortDate(order.createdAt, timeZone)}</p>
        <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">{formatTime(order.createdAt, timeZone)}</p>
      </div>
    </div>
  );
}

export default function AccountOrdersPage() {
  return (
    <Suspense fallback={null}>
      <AccountOrdersContent />
    </Suspense>
  );
}

// Reads the optional ?status=&range= query params so a link from
// Overview's operational summary (e.g. "12 awaiting dispatch") lands here
// pre-filtered to the exact same numbers the viewer just saw, instead of
// always resetting to the "last 7 days / all orders" defaults.
function AccountOrdersContent() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const { connection, user, loading: loadingConnection, error: connectionError } = useConnection(params.id);

  const initialRange = searchParams.get("range");
  const initialStatus = searchParams.get("status");
  const VALID_RANGES: OrderRange[] = ["7d", "30d", "90d"];
  const VALID_STATUSES: OrderStatusFilter[] = ["all", "awaiting_payment", "awaiting_dispatch", "dispatched", "delivered", "cancelled"];

  const [range, setRange] = useState<OrderRange>(
    initialRange && VALID_RANGES.includes(initialRange as OrderRange) ? (initialRange as OrderRange) : "7d"
  );
  const [status, setStatus] = useState<OrderStatusFilter>(
    initialStatus && VALID_STATUSES.includes(initialStatus as OrderStatusFilter) ? (initialStatus as OrderStatusFilter) : "all"
  );
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);

  const [orders, setOrders] = useState<Order[]>([]);
  const [counts, setCounts] = useState<OrderCounts>({
    all: 0,
    awaiting_payment: 0,
    awaiting_dispatch: 0,
    dispatched: 0,
    delivered: 0,
    cancelled: 0,
  });
  const [supplierCounts, setSupplierCounts] = useState<Partial<Record<SupplierFilter, number>> | null>(null);
  const [totalPages, setTotalPages] = useState(1);
  const [totalEntries, setTotalEntries] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const sortKey = `orders-sort:${params.id}`;
  const [sorts, setSorts] = useState<Partial<Record<OrderStatusFilter, OrderSort>>>(() => readView<Record<OrderStatusFilter, OrderSort>>(sortKey));
  const sort: OrderSort = sorts[status] || defaultSort(status);
  function changeSort(next: OrderSort) {
    setSorts((s) => ({ ...s, [status]: next }));
    writeView(sortKey, { [status]: next });
    setPage(1);
  }
  const supplierKey = `orders-supplier:${params.id}`;
  const [suppliers, setSuppliers] = useState<Partial<Record<OrderStatusFilter, SupplierFilter>>>(() => readView<Record<OrderStatusFilter, SupplierFilter>>(supplierKey));
  const supplier: SupplierFilter = suppliers[status] || defaultSupplier(status);
  function changeSupplier(next: SupplierFilter) {
    setSuppliers((s) => ({ ...s, [status]: next }));
    writeView(supplierKey, { [status]: next });
    setPage(1);
  }
  // Orders the team put away (Seller Hub's "Archive"): shown on their own.
  const [archived, setArchived] = useState(false);
  const [archivedCount, setArchivedCount] = useState(0);

  useEffect(() => {
    if (!connection) return;
    setLoading(true);
    setError(null);
    api
      .getConnectionOrders(connection.id, { range, status, search, sort, page, perPage, archived, supplier })
      .then((data) => {
        setOrders(data.orders);
        setCounts(data.counts);
        setSupplierCounts(data.supplierCounts || null);
        setTotalPages(data.totalPages);
        setTotalEntries(data.totalEntries);
        setSyncedAt(data.syncedAt);
        setArchivedCount(data.archivedCount || 0);
      })
      .catch(() => setError("Couldn't load orders from eBay. Try again."))
      .finally(() => setLoading(false));
  }, [connection, range, status, search, sort, page, perPage, archived, supplier, reloadKey]);

  useAccountEvents(connection?.id, (event) => {
    if (event.kind === "orders") setReloadKey((k) => k + 1);
  });

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

  function changeRange(next: OrderRange) {
    setRange(next);
    setPage(1);
  }

  function changeStatus(next: OrderStatusFilter) {
    setStatus(next);
    setPage(1);
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
  }

  function handleSearchChange(value: string) {
    setSearchInput(value);
    // Clearing the box should immediately drop back to the unfiltered list —
    // no need to press Search/Enter just to undo a search.
    if (value.trim() === "" && search !== "") {
      setSearch("");
      setPage(1);
    }
  }

  if (loadingConnection) {
    return <AccountPageSkeleton />;
  }

  if (connectionError || !connection || !user) {
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
      marketplace={connection.marketplace}
      status={connection.status}
      permissions={connection.permissions}
      user={user}
      sync={{ syncedAt, onRefresh: handleRefresh, refreshing, note: refreshNote }}
      header={
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Orders</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
            {connection.label} · {connection.marketplace?.name ?? connection.platform_name}
          </p>
        </div>
      }
      subheader={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex flex-shrink-0 items-center rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => changeStatus(tab.key)}
                className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors ${
                  status === tab.key ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                }`}
              >
                {tab.label}
                <span className={status === tab.key ? "text-white/70" : "text-[var(--color-muted)]/70"}>{counts[tab.key]}</span>
              </button>
            ))}
          </div>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
            {(archivedCount > 0 || archived) && (
              <button
                type="button"
                onClick={() => {
                  setArchived((v) => !v);
                  setPage(1);
                }}
                className={`btn btn-sm flex-shrink-0 ${archived ? "btn-primary" : "btn-secondary"}`}
                title={archived ? "Back to current orders" : "Show archived orders"}
              >
                Archived{archivedCount ? ` · ${archivedCount}` : ""}
              </button>
            )}
            <ViewMenu
              title="Period, supplier and sort"
              sections={[
                { label: "Period", value: range, options: (Object.keys(RANGE_LABELS) as OrderRange[]).map((key) => ({ key, label: RANGE_LABELS[key], short: RANGE_SHORT[key] })), onChange: (k) => changeRange(k as OrderRange) },
                {
                  label: "Supplier order",
                  value: supplier,
                  // "Any" says nothing on the button; a filter does.
                  hideInSummary: supplier === "any",
                  options: (Object.keys(SUPPLIER_LABELS) as SupplierFilter[]).map((key) => ({ key, label: SUPPLIER_LABELS[key], short: SUPPLIER_SHORT[key], count: supplierCounts ? supplierCounts[key] ?? 0 : undefined })),
                  onChange: (k) => changeSupplier(k as SupplierFilter),
                },
                { label: "Sort", value: sort, options: (Object.keys(SORT_LABELS) as OrderSort[]).map((key) => ({ key, label: SORT_LABELS[key] })), onChange: (k) => changeSort(k as OrderSort) },
              ]}
            />
            <form onSubmit={handleSearchSubmit} className="relative w-56 min-w-[160px] flex-shrink">
              <svg viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]">
                <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={searchInput}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Order ID or item title"
                autoComplete="off"
                className="input input-sm !pl-10"
              />
            </form>
          </div>
        </div>
      }
      footer={
        !error && !loading && orders.length > 0 ? (
          <ListFooter
            page={page}
            totalPages={totalPages}
            totalEntries={totalEntries}
            perPage={perPage}
            sizes={[25, 50, 100, 200]}
            onPage={(p) => {
              setPage(p);
              document.querySelector("[data-scroller]")?.scrollTo({ top: 0, behavior: "smooth" });
            }}
            onPerPage={(next) => {
              setPerPage(next);
              setPage(1);
            }}
          />
        ) : null
      }
    >
      {supplier !== "any" && !loading && (
        <p className="mb-2 text-xs text-[var(--color-muted)]">
          Showing {totalEntries} of {counts[status]} {status === "all" ? "" : `${STATUS_TABS.find((t) => t.key === status)?.label.toLowerCase()} `}order{counts[status] === 1 ? "" : "s"}, {SUPPLIER_PHRASE[supplier]} ·{" "}
          <button type="button" onClick={() => changeSupplier("any")} className="font-semibold text-[var(--color-primary)] hover:underline">
            Show all
          </button>
        </p>
      )}
      {search && (
        <p className="mb-2 text-xs text-[var(--color-muted)]">
          Showing results for &ldquo;{search}&rdquo; ·{" "}
          <button
            type="button"
            onClick={() => {
              setSearchInput("");
              setSearch("");
              setPage(1);
            }}
            className="font-semibold text-[var(--color-primary)] hover:underline"
          >
            Clear
          </button>
        </p>
      )}

      <div className="card overflow-hidden">
        {error && (
          <div className="p-5">
            <Alert>{error}</Alert>
          </div>
        )}

        {!error && loading && <ListSkeleton count={8} />}

        {!error && !loading && orders.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-[var(--color-muted)]">
            No orders match these filters.
          </p>
        )}

        {!error && !loading && orders.length > 0 && (
          <div className="overflow-x-auto">
            <div className="min-w-[980px]">
              <OrderTableHeader />
              {orders.map((order) => (
                <OrderCard key={order.orderId} order={order} country={connection.marketplace?.country} countryName={connection.marketplace?.countryName} href={`/accounts/${connection.id}/orders/${encodeURIComponent(order.orderId)}`} />
              ))}
            </div>
          </div>
        )}

      </div>
    </AccountShell>
  );
}
