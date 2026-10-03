"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, Order, OrderCounts, OrderRange, OrderSort, OrderStatusFilter, SupplierFilter } from "@/lib/api";
import { readView, writeView } from "@/lib/viewState";
import { useConnection } from "@/lib/useConnection";
import { scrollPageToTop } from "@/lib/pageScroll";
import { formatMoney, formatShortDate, formatTime } from "@/lib/format";
import { useAccountTimeZone } from "@/lib/timezone";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import { AccountPageSkeleton, ListSkeleton } from "@/components/Skeleton";
import { ListFooter } from "@/components/ListFooter";
import { ViewMenu } from "@/components/ViewMenu";
import { useAccountEvents } from "@/lib/useAccountEvents";
import { PillTabs } from "@/components/PillTabs";
import { CsvButton, SelectBox } from "@/components/CsvExport";

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
  { key: "marked", label: "Marked dispatched" },
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
  marked: "text-emerald-700",
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
// lines up into real table columns: Status | Order | Supplier | Qty | Total
// | Date. One price (what the buyer paid) and one date (when they bought):
// the breakdown and who it goes to live on the order's own page.
const ROW_COLUMNS = "136px minmax(220px,1fr) 220px 48px 96px 96px";

// A tick box leads each row for the workspace owner and co-managers (the CSV download).
type RowSelect = { checked: boolean; onChange: () => void };

function OrderTableHeader({ select }: { select?: RowSelect & { indeterminate: boolean } }) {
  return (
    <div
      className="grid items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-paper)]/60 px-4 py-2 text-[10.5px] font-bold uppercase tracking-wider text-[var(--color-muted)]"
      style={{ gridTemplateColumns: select ? `20px ${ROW_COLUMNS}` : ROW_COLUMNS }}
    >
      {select && <SelectBox checked={select.checked} indeterminate={select.indeterminate} onChange={select.onChange} label="Select every order on this page" />}
      <span>Status</span>
      <span>Order</span>
      <span className="text-center">Supplier</span>
      <span className="text-center">Qty</span>
      <span className="text-right">Total</span>
      <span className="text-right">Date</span>
    </div>
  );
}

// Where the order stands with the supplier, the same states as the Supplier
// filter (orders/order-supplier.js on the server): only as far along as its
// least advanced line, a line with no supplier order not ordered yet, and
// dispatched or cancelled on eBay with nothing recorded "untracked".
type SupplierStage = "pending" | "ordered" | "shipped" | "delivered" | "problem" | "untracked";
const SUPPLIER_STEPS = ["ordered", "shipped", "delivered"];

const SUPPLIER_STYLES: Record<SupplierStage, { label: string; chip: string; dot: string; bar: string }> = {
  pending: { label: "To order", chip: "bg-amber-50 text-amber-800 ring-amber-200", dot: "bg-amber-500", bar: "bg-amber-400" },
  ordered: { label: "Ordered", chip: "bg-indigo-50 text-indigo-700 ring-indigo-200", dot: "bg-indigo-500", bar: "bg-indigo-500" },
  shipped: { label: "Shipped", chip: "bg-sky-50 text-sky-700 ring-sky-200", dot: "bg-sky-500", bar: "bg-sky-500" },
  delivered: { label: "Delivered", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500", bar: "bg-emerald-500" },
  problem: { label: "Problem", chip: "bg-rose-50 text-rose-700 ring-rose-200", dot: "bg-rose-500", bar: "bg-rose-500" },
  untracked: { label: "Not recorded", chip: "bg-[var(--color-paper)] text-[var(--color-muted)] ring-[var(--color-line)]", dot: "bg-slate-300", bar: "" },
};

const SUPPLIER_NAMES: Record<string, string> = { aliexpress: "AliExpress", amazon: "Amazon", temu: "Temu", cj: "CJ", cjdropshipping: "CJ" };
const supplierName = (platform: string | null | undefined) =>
  !platform ? "" : SUPPLIER_NAMES[platform.toLowerCase()] || platform.charAt(0).toUpperCase() + platform.slice(1);
const distinct = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => Boolean(v)))];

function supplierView(order: Order) {
  const rows = order.sourcing || [];
  const lineCount = Math.max(1, order.lineItems.length);
  const settled = Boolean(order.shippedTime) || ["dispatched", "delivered", "cancelled"].includes(order.derivedStatus || "");
  const statuses = rows.map((r) => r.status as string);
  const placed = statuses.filter((st) => SUPPLIER_STEPS.includes(st)).length;
  let stage: SupplierStage;
  if (!rows.length && settled) stage = "untracked";
  else if (statuses.includes("problem")) stage = "problem";
  else if (rows.length < lineCount || placed < statuses.length) stage = "pending";
  else stage = statuses.reduce((lowest, st) => (SUPPLIER_STEPS.indexOf(st) < SUPPLIER_STEPS.indexOf(lowest) ? st : lowest), "delivered") as SupplierStage;
  const latest = [...rows].filter((r) => r.placedAt).sort((a, b) => (a.placedAt! < b.placedAt! ? 1 : -1))[0];
  return {
    stage,
    // How many of its items are on a supplier order, while some still aren't.
    placed: stage === "pending" && placed > 0 ? `${placed} of ${lineCount} items ordered` : null,
    supplier: distinct(rows.map((r) => supplierName(r.sourcePlatform)))[0] || "",
    orderNos: distinct(rows.map((r) => r.sourceOrderNo)),
    tracking: distinct(rows.map((r) => (r.trackingNumber ? `${r.carrier ? `${r.carrier} ` : ""}${r.trackingNumber}` : null))),
    placedBy: latest?.placedBy?.name || null,
    placedAt: latest?.placedAt || null,
    notes: rows.find((r) => r.status === "problem")?.notes || null,
    cancelled: order.derivedStatus === "cancelled",
  };
}

// The stage as a tinted capsule and, for an order on its way, a three-step
// track (ordered, shipped, delivered) filled as far as it has got.
function SupplierBadge({ view, centred }: { view: ReturnType<typeof supplierView>; centred: boolean }) {
  const style = SUPPLIER_STYLES[view.stage];
  const label = view.stage === "untracked" && view.cancelled ? "Not needed" : style.label;
  const step = SUPPLIER_STEPS.indexOf(view.stage);
  const showTrack = view.stage !== "problem" && view.stage !== "untracked";
  return (
    <div className={`flex items-center gap-2 ${centred ? "justify-center" : ""}`}>
      <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-[3px] text-[11.5px] font-semibold leading-none ring-1 ring-inset ${style.chip}`}>
        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${style.dot}`} aria-hidden />
        {label}
      </span>
      {showTrack && (
        <span className="flex items-center gap-0.5" title="Ordered → Shipped → Delivered" aria-hidden>
          {SUPPLIER_STEPS.map((s, i) => (
            <span key={s} className={`h-1 w-3.5 rounded-full ${i <= step ? style.bar : "bg-slate-200"}`} />
          ))}
        </span>
      )}
    </div>
  );
}

// The Supplier column: the stage, then what backs it up: the supplier and
// its order number, its tracking once shipped, who ordered it and when, or
// what the problem is. Centred in the table, between the order and its
// quantity; on a phone's card, along the left.
function SupplierCell({ order, centred = false }: { order: Order; centred?: boolean }) {
  const timeZone = useAccountTimeZone();
  const view = supplierView(order);
  const reference = (view.supplier || view.orderNos.length) && (
    <p className="truncate">
      {view.supplier}
      {view.supplier && view.orderNos.length > 0 && " · "}
      {view.orderNos.length > 0 && <span className="font-mono tracking-tight text-[var(--color-ink)]">{view.orderNos.join(", ")}</span>}
    </p>
  );
  let detail: React.ReactNode = null;
  switch (view.stage) {
    case "pending":
      detail = <p className="truncate">{view.placed || "Not ordered from the supplier yet"}</p>;
      break;
    case "ordered":
      detail = (
        <>
          {reference}
          {(view.placedBy || view.placedAt) && (
            <p className="truncate">
              Ordered{view.placedBy ? ` by ${view.placedBy}` : ""}
              {view.placedAt ? ` · ${formatShortDate(view.placedAt, timeZone)}` : ""}
            </p>
          )}
        </>
      );
      break;
    case "shipped":
    case "delivered":
      detail = (
        <>
          {reference}
          {view.tracking.length > 0 ? (
            <p className="truncate font-mono tracking-tight" title={view.tracking.join(", ")}>
              {view.tracking.join(", ")}
            </p>
          ) : (
            <p className="truncate">No supplier tracking yet</p>
          )}
        </>
      );
      break;
    case "problem":
      detail = (
        <>
          <p className="line-clamp-2 text-rose-700/90">{view.notes || "Needs a look on the order page"}</p>
          {reference}
        </>
      );
      break;
    case "untracked":
      detail = <p className="truncate">{view.cancelled ? "Cancelled on eBay" : "No supplier order in Liston"}</p>;
      break;
  }
  return (
    <div className={`min-w-0 pt-0.5 ${centred ? "text-center" : ""}`}>
      <SupplierBadge view={view} centred={centred} />
      {detail && <div className="mt-1.5 space-y-0.5 text-[11.5px] leading-snug text-[var(--color-muted)]">{detail}</div>}
    </div>
  );
}

// Dispatched on the seller's word alone: no tracking number on any line.
function markedWithoutTracking(order: Order): boolean {
  return order.derivedStatus === "dispatched" && !order.markedDispatched?.tracked && !order.lineItems.some((li) => li.trackingNumber);
}

// Who marked an order dispatched, and how: "Marked by Sam · no tracking"
// from Liston, or "Marked dispatched · no tracking" when it was marked in
// Seller Hub or the eBay app.
function MarkedLine({ order }: { order: Order }) {
  const m = order.markedDispatched;
  if (!m) {
    if (!markedWithoutTracking(order)) return null;
    return <p className="mt-1 text-[11px] leading-snug text-[var(--color-muted)]">Marked dispatched · no tracking</p>;
  }
  return (
    <p className="mt-1 text-[11px] leading-snug text-[var(--color-muted)]" title={m.pending ? "Marked dispatched on eBay from Liston; eBay's order list shows it within a few minutes" : undefined}>
      Marked{m.by ? ` by ${m.by}` : " from Liston"} · {m.tracked ? "with tracking" : "no tracking"}
      {m.pending && " · eBay updating"}
    </p>
  );
}

// One order per row: its eBay status, the order number over each item as a
// thumbnail beside a two-line title and its details, the supplier order,
// then the money and date at the top of the row, where the eye lands.
function OrderCard({ order, href, select }: { order: Order; href: string; select?: RowSelect }) {
  const router = useRouter();
  const timeZone = useAccountTimeZone();
  const statusStyle = STATUS_TEXT_STYLES[order.derivedStatus || "all"];
  const shippingCost =
    order.total && order.subtotal ? Math.round((order.total.amount - order.subtotal.amount) * 100) / 100 : null;
  const quantity = order.lineItems.reduce((n, li) => n + (li.quantityPurchased || 0), 0);
  const multi = order.lineItems.length > 1;

  return (
    <div
      className={`grid cursor-pointer items-start gap-3 border-b border-[var(--color-line)] px-4 py-3.5 last:border-b-0 ${select?.checked ? "bg-[var(--color-primary-soft)]/50" : "hover:bg-[var(--color-paper)]/40"}`}
      style={{ gridTemplateColumns: select ? `20px ${ROW_COLUMNS}` : ROW_COLUMNS }}
      title="Open order"
      onClick={(e) => {
        // The row opens the order; links, buttons and its tick box inside keep their own job.
        if ((e.target as HTMLElement).closest("a, button, label, input")) return;
        router.push(href);
      }}
    >
      {select && (
        <div className="pt-0.5">
          <SelectBox checked={select.checked} onChange={select.onChange} label={`Select order ${order.orderId}`} />
        </div>
      )}
      <div className="pt-0.5">
        <p className={`text-[12.5px] font-medium leading-snug ${statusStyle}`}>{statusLabel(order, timeZone)}</p>
        <MarkedLine order={order} />
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

      <SupplierCell order={order} centred />
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

// An order on a phone, where the table's six columns don't fit: status and
// total on top, the order number and date, each item, then the supplier order.
function OrderMobileCard({ order, href, select }: { order: Order; href: string; select?: RowSelect }) {
  const router = useRouter();
  const timeZone = useAccountTimeZone();
  const statusStyle = STATUS_TEXT_STYLES[order.derivedStatus || "all"];
  const quantity = order.lineItems.reduce((n, li) => n + (li.quantityPurchased || 0), 0);
  return (
    <div
      className={`cursor-pointer border-b border-[var(--color-line)] px-4 py-3.5 last:border-b-0 active:bg-[var(--color-paper)]/60 ${select?.checked ? "bg-[var(--color-primary-soft)]/50" : ""}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, label, input")) return;
        router.push(href);
      }}
    >
      <div className="flex items-start justify-between gap-3">
        {select && (
          <div className="pt-0.5">
            <SelectBox checked={select.checked} onChange={select.onChange} label={`Select order ${order.orderId}`} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className={`text-[13px] font-semibold leading-snug ${statusStyle}`}>{statusLabel(order, timeZone)}</p>
          <MarkedLine order={order} />
            <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">
            <Link href={href} className="font-mono tracking-tight text-[var(--color-ink)] underline decoration-[var(--color-line-strong)] underline-offset-2">
              {order.orderId}
            </Link>
            {" · "}
            {formatShortDate(order.createdAt, timeZone)}, {formatTime(order.createdAt, timeZone)}
          </p>
        </div>
        <div className="flex-shrink-0 text-right">
          <p className="text-[14px] font-semibold tabular-nums text-[var(--color-ink)]">{formatMoney(order.total)}</p>
          <p className="text-[11px] text-[var(--color-muted)]">Qty {quantity}</p>
        </div>
      </div>
      <div className="mt-2.5 space-y-2">
        {order.lineItems.map((li, i) => (
          <div key={`${li.itemId}-${i}`} className="flex items-start gap-3">
            {li.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={li.imageUrl} alt="" className="h-12 w-12 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-cover" />
            ) : (
              <div className="h-12 w-12 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)]" />
            )}
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[12.5px] font-medium leading-snug text-[var(--color-ink)]">{cleanLineItemTitle(li.title)}</p>
              <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-[var(--color-muted)]">
                {order.lineItems.length > 1 && <span>× {li.quantityPurchased}</span>}
                {li.variation.map((v) => (
                  <span key={v.name}>
                    {v.name}: {v.value}
                  </span>
                ))}
                {li.trackingNumber && <span>{li.trackingNumber}</span>}
              </p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t border-dashed border-[var(--color-line)] pt-2.5">
        <SupplierCell order={order} />
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
  const VALID_STATUSES: OrderStatusFilter[] = ["all", "awaiting_payment", "awaiting_dispatch", "dispatched", "marked", "delivered", "cancelled"];

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
  // Ticked orders for the CSV download, kept across pages; changing a filter
  // starts afresh (the ticks belong to the filters they were made under).
  const filterKey = [range, status, search, sort, archived, supplier].join("|");
  const [ticked, setTicked] = useState<{ key: string; ids: string[] }>({ key: "", ids: [] });
  const selectedIds = ticked.key === filterKey ? ticked.ids : [];
  function toggleOrder(id: string) {
    setTicked({ key: filterKey, ids: selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id] });
  }

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

  // Ticking rows is for the workspace owner and co-managers (the CSV download).
  const canTick = !connection.permissions;
  const pageTicked = orders.filter((o) => selectedIds.includes(o.orderId)).length;
  function togglePage() {
    const onPage = orders.map((o) => o.orderId);
    setTicked({ key: filterKey, ids: pageTicked === onPage.length ? selectedIds.filter((id) => !onPage.includes(id)) : [...new Set([...selectedIds, ...onPage])] });
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
      // The workspace owner and co-managers: these orders (or the ticked ones) as a CSV file.
      actions={
        !connection.permissions && (
          <CsvButton
            selected={selectedIds.length}
            noun="order"
            run={() => api.exportOrdersCsv(connection.id, { range, status, search, sort, archived, supplier, ids: selectedIds })}
          />
        )
      }
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
          <PillTabs label="Orders" tabs={STATUS_TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] ?? 0 }))} value={status} onChange={changeStatus} />
          <div className="flex w-full min-w-0 items-center gap-2 sm:ml-auto sm:w-auto sm:flex-wrap sm:justify-end">
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
            <form onSubmit={handleSearchSubmit} className="relative min-w-0 flex-1 sm:w-48 sm:min-w-[150px] sm:flex-none sm:flex-shrink">
              <svg viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted)]">
                <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={searchInput}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Order ID or item title"
                autoComplete="off"
                className="input input-sm !h-7 rounded-full !pl-8 !text-[12px]"
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
              scrollPageToTop();
            }}
            onPerPage={(next) => {
              setPerPage(next);
              setPage(1);
            }}
          />
        ) : null
      }
    >
      {status === "marked" && (
        <p className="mb-2 text-xs leading-relaxed text-[var(--color-muted)]">
          Orders marked dispatched without a tracking number, in Seller Hub, the eBay app or from Liston. The buyer can&apos;t follow these parcels and eBay can&apos;t confirm their delivery, so add tracking from the order page once you have it.
        </p>
      )}
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

      {canTick && selectedIds.length > 0 && (
        <p className="mb-2 text-xs text-[var(--color-muted)]">
          {`${selectedIds.length} order${selectedIds.length === 1 ? "" : "s"} ticked for the download · `}
          <button type="button" onClick={() => setTicked({ key: filterKey, ids: [] })} className="font-semibold text-[var(--color-primary)] hover:underline">
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
          <>
          <div className="hidden overflow-x-auto md:block">
            <div className="min-w-[980px]">
              <OrderTableHeader
                select={
                  canTick
                    ? {
                        checked: pageTicked === orders.length,
                        indeterminate: pageTicked > 0 && pageTicked < orders.length,
                        onChange: togglePage,
                      }
                    : undefined
                }
              />
              {orders.map((order) => (
                <OrderCard
                  key={order.orderId}
                  order={order}
                  href={`/accounts/${connection.id}/orders/${encodeURIComponent(order.orderId)}`}
                  select={canTick ? { checked: selectedIds.includes(order.orderId), onChange: () => toggleOrder(order.orderId) } : undefined}
                />
              ))}
            </div>
          </div>
          <div className="md:hidden">
            {orders.map((order) => (
              <OrderMobileCard
                key={order.orderId}
                order={order}
                href={`/accounts/${connection.id}/orders/${encodeURIComponent(order.orderId)}`}
                select={canTick ? { checked: selectedIds.includes(order.orderId), onChange: () => toggleOrder(order.orderId) } : undefined}
              />
            ))}
          </div>
          </>
        )}

      </div>
    </AccountShell>
  );
}
