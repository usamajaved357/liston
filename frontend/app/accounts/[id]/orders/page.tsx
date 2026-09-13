"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, Order, OrderCounts, OrderRange, OrderStatusFilter } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { formatMoney, formatShortDate } from "@/lib/format";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import { EbayStylePagination } from "@/components/EbayStylePagination";

const RANGE_LABELS: Record<OrderRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

const STATUS_TABS: { key: OrderStatusFilter; label: string }[] = [
  { key: "all", label: "All orders" },
  { key: "awaiting_payment", label: "Awaiting payment" },
  { key: "awaiting_dispatch", label: "Awaiting dispatch" },
  { key: "dispatched", label: "Paid and dispatched" },
  { key: "cancelled", label: "Cancelled" },
];

const SOON_TABS = ["Archived", "Returns", "Requests and disputes"];

// eBay's own table doesn't use colored badges for status — just bold text,
// occasionally tinted (red for cancelled). Matching that instead of a pill.
const STATUS_TEXT_STYLES: Record<OrderStatusFilter, string> = {
  all: "text-[var(--color-ink)]",
  awaiting_payment: "text-amber-700",
  awaiting_dispatch: "text-[var(--color-ink)]",
  dispatched: "text-emerald-700",
  cancelled: "text-[var(--color-danger)]",
};

function statusLabel(order: Order): string {
  switch (order.derivedStatus) {
    case "awaiting_payment":
      return "Awaiting payment";
    case "awaiting_dispatch":
      return order.dispatchByTime ? `Dispatch by ${formatShortDate(order.dispatchByTime)}` : "Awaiting dispatch";
    case "dispatched":
      return order.shippedTime ? `Dispatched ${formatShortDate(order.shippedTime)}` : "Dispatched";
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
// lines up into real table columns the way eBay's "Manage all orders" does:
// Status | Order | Quantity | Subtotal | Total | Date sold | Date paid.
const ROW_COLUMNS = "132px minmax(280px,1fr) 96px 84px 84px 92px 92px";

function OrderTableHeader() {
  return (
    <div
      className="grid gap-4 px-5 py-3 border-b border-[var(--color-line)] text-[11px] font-bold uppercase tracking-wide text-[var(--color-muted)]"
      style={{ gridTemplateColumns: ROW_COLUMNS }}
    >
      <span>Status</span>
      <span>Order</span>
      <span className="text-center">Quantity</span>
      <span>Subtotal</span>
      <span>Total</span>
      <span>Date sold</span>
      <span>Date paid</span>
    </div>
  );
}

function OrderCard({ order }: { order: Order }) {
  const statusStyle = STATUS_TEXT_STYLES[order.derivedStatus || "all"];
  const lastIndex = order.lineItems.length - 1;
  const shippingCost =
    order.total && order.subtotal ? Math.round((order.total.amount - order.subtotal.amount) * 100) / 100 : null;

  return (
    <div className="border-b border-[var(--color-line)] last:border-b-0 px-5 py-5">
      {order.lineItems.map((li, i) => {
        const isLast = i === lastIndex;
        return (
          <div
            key={`${li.itemId}-${i}`}
            className="grid gap-4 items-start py-3"
            style={{ gridTemplateColumns: ROW_COLUMNS }}
          >
            {/* Status — only on the first line item, aligned with the order id/buyer top row */}
            <div>{i === 0 && <p className={`text-xs ${statusStyle}`}>{statusLabel(order)}</p>}</div>

            {/* Order: order id + buyer on one top row (first item only), then image + title + specifics below */}
            <div className="min-w-0">
              {i === 0 && (
                <div className="flex items-baseline gap-4 mb-3">
                  <span className="w-28 flex-shrink-0 text-xs text-[var(--color-ink)]">{order.orderId}</span>
                  <span className="text-xs text-[var(--color-muted)]">
                    {order.buyerName || "Unknown buyer"}
                    {order.buyerUserId && <> &nbsp;@{order.buyerUserId}</>}
                  </span>
                </div>
              )}
              <div className="flex items-start gap-4">
                <div className="relative flex-shrink-0">
                  {li.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={li.imageUrl}
                      alt=""
                      className="h-28 w-28 rounded-xl object-cover border border-[var(--color-line)]"
                    />
                  ) : (
                    <div className="h-28 w-28 rounded-xl bg-[var(--color-paper)] border border-[var(--color-line)]" />
                  )}
                  <button
                    type="button"
                    aria-label="Expand image"
                    className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-[var(--color-ink)] shadow-sm border border-[var(--color-line)] hover:bg-white transition-colors"
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3">
                      <path
                        d="M4 14v6h6M20 10V4h-6M4 20l7-7M20 4l-7 7"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
                <div className="min-w-0 pt-0.5">
                  {li.viewItemUrl ? (
                    <a
                      href={li.viewItemUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-[var(--color-ink)] leading-snug line-clamp-2 underline decoration-[var(--color-line)] hover:decoration-[var(--color-ink)] underline-offset-2"
                    >
                      {cleanLineItemTitle(li.title)}
                    </a>
                  ) : (
                    <p className="text-xs text-[var(--color-ink)] leading-snug line-clamp-2">
                      {cleanLineItemTitle(li.title)}
                    </p>
                  )}
                  <p className="text-xs text-[var(--color-muted)] mt-1">Item {li.itemId}</p>
                  {li.variation.length > 0 && (
                    <p className="text-xs text-[var(--color-ink)] mt-1">
                      {li.variation.map((v, vi) => (
                        <span key={v.name}>
                          {vi > 0 && "   "}
                          {v.name}: <span className="font-semibold">{v.value}</span>
                        </span>
                      ))}
                    </p>
                  )}
                  {li.trackingNumber && (
                    <p className="text-xs text-[var(--color-muted)] mt-1">
                      {li.trackingCarrier ? `${li.trackingCarrier} · ` : ""}
                      {li.trackingNumber}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Quantity */}
            <div className="text-[13px] text-[var(--color-ink)] text-center">
              <span className="font-bold">{li.quantityPurchased}</span>
              {li.quantityAvailable !== null && (
                <span className="text-[var(--color-muted)]"> ({li.quantityAvailable} available)</span>
              )}
            </div>

            {/* Subtotal — order-level, shown once on the last item */}
            <div className="text-[13px] text-[var(--color-ink)]">
              {isLast && (
                <>
                  {formatMoney(order.subtotal)}
                  <p className="text-xs text-[var(--color-muted)]">
                    {shippingCost === 0 ? "Free postage" : shippingCost !== null ? `+${formatMoney({ amount: shippingCost, currency: order.total?.currency })}` : ""}
                  </p>
                </>
              )}
            </div>

            {/* Total */}
            <div className="text-[13px] font-bold text-[var(--color-ink)]">{isLast && formatMoney(order.total)}</div>

            {/* Date sold */}
            <div className="text-xs text-[var(--color-ink)]">
              {isLast && (
                <>
                  <p className="font-bold">{formatShortDate(order.createdAt)}</p>
                  <p className="text-[var(--color-muted)] font-normal">
                    {new Date(order.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  </p>
                </>
              )}
            </div>

            {/* Date paid */}
            <div className="text-xs text-[var(--color-ink)]">{isLast && formatShortDate(order.paidTime)}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function AccountOrdersPage() {
  const params = useParams<{ id: string }>();
  const { connection, loading: loadingConnection, error: connectionError } = useConnection(params.id);

  const [range, setRange] = useState<OrderRange>("7d");
  const [status, setStatus] = useState<OrderStatusFilter>("all");
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
    cancelled: 0,
  });
  const [totalPages, setTotalPages] = useState(1);
  const [totalEntries, setTotalEntries] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connection) return;
    setLoading(true);
    setError(null);
    api
      .getConnectionOrders(connection.id, { range, status, search, page, perPage })
      .then((data) => {
        setOrders(data.orders);
        setCounts(data.counts);
        setTotalPages(data.totalPages);
        setTotalEntries(data.totalEntries);
      })
      .catch(() => setError("Couldn't load orders from eBay. Try again."))
      .finally(() => setLoading(false));
  }, [connection, range, status, search, page, perPage]);

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

  function clearSearch() {
    setSearchInput("");
    setSearch("");
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
      {/* Status tabs */}
      <div className="flex flex-wrap items-center gap-1.5 mb-4 border-b border-[var(--color-line)] pb-3">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => changeStatus(tab.key)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              status === tab.key
                ? "bg-[var(--color-primary)] text-white"
                : "text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
            }`}
          >
            {tab.label} ({counts[tab.key]})
          </button>
        ))}
        {SOON_TABS.map((label) => (
          <span
            key={label}
            title="Not available yet — needs eBay's returns/cases API"
            className="rounded-full px-3.5 py-1.5 text-xs font-semibold text-[var(--color-muted)]/50 cursor-not-allowed"
          >
            {label}
          </span>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <label className="flex items-center gap-2 rounded-full border border-[var(--color-line)] px-3.5 py-1.5 text-xs font-medium text-[var(--color-ink)]">
          Period:
          <select
            value={range}
            onChange={(e) => changeRange(e.target.value as OrderRange)}
            className="bg-transparent font-bold focus:outline-none"
          >
            {(Object.keys(RANGE_LABELS) as OrderRange[]).map((key) => (
              <option key={key} value={key}>
                {RANGE_LABELS[key]}
              </option>
            ))}
          </select>
        </label>

        <form onSubmit={handleSearchSubmit} className="flex items-center flex-1 min-w-[220px] max-w-sm">
          <div className="group flex items-center flex-1 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] pl-3.5 pr-1.5 py-1 transition-colors focus-within:border-[var(--color-accent)]">
            <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 text-[var(--color-muted)] flex-shrink-0">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search by order ID or item title"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent border-0 px-2 py-1 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-muted)] outline-none ring-0 focus:outline-none focus:ring-0"
            />
            {searchInput && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label="Clear search"
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)] transition-colors mr-1"
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            )}
            <button
              type="submit"
              className="rounded-full bg-[var(--color-primary)] px-3 py-1 text-xs font-semibold text-white hover:bg-[var(--color-primary-hover)] transition-colors flex-shrink-0"
            >
              Search
            </button>
          </div>
        </form>
      </div>

      {search && (
        <p className="text-xs text-[var(--color-muted)] mb-3">
          Showing results for &ldquo;{search}&rdquo;
        </p>
      )}

      <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] overflow-hidden">
        {error && (
          <div className="p-5">
            <Alert>{error}</Alert>
          </div>
        )}

        {!error && loading && <p className="px-5 py-10 text-center text-sm text-[var(--color-muted)]">Loading…</p>}

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
                <OrderCard key={order.orderId} order={order} />
              ))}
            </div>
          </div>
        )}

        {!error && !loading && orders.length > 0 && (
          <EbayStylePagination
            page={page}
            totalPages={totalPages}
            perPage={perPage}
            totalEntries={totalEntries}
            onPage={setPage}
            onPerPage={(next) => {
              setPerPage(next);
              setPage(1);
            }}
          />
        )}
      </div>
    </AccountShell>
  );
}
