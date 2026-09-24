"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { api, ApiError, type OrderCases, type OrderDetailResponse, type OrderSourcing } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { formatPrice, formatDateTime, internationalPhone } from "@/lib/format";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import {
  SITE_TIMEZONES,
  Chevron,
  Chip,
  CopyIcon,
  Modal,
  MoneyRow,
  PostageInstructions,
  ProgressTrack,
  Row,
  cardClass,
  cleanTitle,
  daysUntil,
  formatDayMonth,
  formatDayMonthYear,
  formatDeadline,
  fulfillmentLabel,
  labelClass,
  money,
  paymentLabel,
} from "@/components/orders/order-ui";
import { SourcingCard } from "@/components/orders/SourcingCard";
import { ActionDialog, type ActionKind } from "@/components/orders/ActionDialog";
import { CaseDialog, CasesPanel, type CaseAction } from "@/components/orders/CaseDialogs";
import { AccountPageSkeleton, OrderDetailSkeleton } from "@/components/Skeleton";

// One eBay order, laid out the way Seller Hub's order page is — the
// dispatch deadline and its paid → dispatched → delivered track, Postage,
// Item, then Order and Payment (what the buyer paid, what eBay took, what
// you earned) down the side — plus the part Seller Hub never had: a Source
// section saying where each item was bought from, by whom, and the
// supplier's tracking, which dispatches the item on eBay when it is saved.

// --- page -----------------------------------------------------------------

export default function OrderDetailPage() {
  const params = useParams<{ id: string; orderId: string }>();
  const { connection, user, loading: loadingConnection, error: connectionError } = useConnection(params.id);
  const [data, setData] = useState<OrderDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveNotes, setSaveNotes] = useState<Record<string, { tone: "ok" | "bad"; text: string } | null>>({});
  const [moreOpen, setMoreOpen] = useState(false);
  const [action, setAction] = useState<ActionKind | null>(null);
  const [actionNote, setActionNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [earnedOpen, setEarnedOpen] = useState(true);
  const [specificsOpen, setSpecificsOpen] = useState<Record<string, boolean>>({});
  const [reconnectPrompt, setReconnectPrompt] = useState(false);
  const [cases, setCases] = useState<OrderCases | null>(null);
  const [caseAction, setCaseAction] = useState<CaseAction | null>(null);
  const [declineCancelOpen, setDeclineCancelOpen] = useState(false);
  const [decliningCancel, setDecliningCancel] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const searchParams = useSearchParams();
  const justReconnected = searchParams.get("reconnected") === "1";

  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    api
      .getOrder(params.id, params.orderId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Couldn't load this order from eBay.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params.id, params.orderId, reloadKey]);

  // Post-sale cases load beside the order, never blocking it.
  useEffect(() => {
    if (!data?.actionsEnabled) return;
    let cancelled = false;
    api
      .getOrderCases(params.id, params.orderId)
      .then((c) => {
        if (!cancelled) setCases(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [params.id, params.orderId, reloadKey, data?.actionsEnabled]);

  useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [moreOpen]);

  const order = data?.order || null;
  const currency = order?.pricing.total?.currency || connection?.marketplace?.currency || "GBP";
  const dispatchBy = useMemo(() => {
    if (!order) return null;
    const dates = order.lineItems.map((li) => li.shipByDate).filter(Boolean) as string[];
    return dates.sort()[0] || null;
  }, [order]);
  const daysLeft = daysUntil(dispatchBy);

  const totalCost = useMemo(() => {
    if (!order) return null;
    const costs = order.lineItems.map((li) => li.sourcing?.cost?.value ?? null);
    if (costs.some((c) => c === null)) return null;
    return costs.reduce((a, b) => (a as number) + (b as number), 0) as number;
  }, [order]);

  function applySourcing(sourcing: OrderSourcing) {
    setData((current) => {
      if (!current) return current;
      return {
        ...current,
        order: {
          ...current.order,
          lineItems: current.order.lineItems.map((li) => (li.sourcingKey === sourcing.lineItemId ? { ...li, sourcing } : li)),
        },
      };
    });
  }

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Sends the owner through eBay's consent again for THIS account, coming
  // back here; the token then carries the order scopes.
  async function reconnect() {
    setReconnecting(true);
    try {
      const { authorizeUrl } = await api.reauthorizeConnection(params.id, `/accounts/${params.id}/orders/${encodeURIComponent(params.orderId)}`);
      window.location.href = authorizeUrl;
    } catch (err) {
      setReconnecting(false);
      setActionNote({ tone: "bad", text: err instanceof ApiError ? err.message : "Couldn't start the eBay reconnect." });
    }
  }

  async function declineCancel() {
    setDecliningCancel(true);
    try {
      await api.declineCancellation(params.id, params.orderId);
      setDeclineCancelOpen(false);
      setActionNote({ tone: "ok", text: "The buyer's cancellation request was declined; the order stands." });
      load();
    } catch (err) {
      setActionNote({ tone: "bad", text: err instanceof ApiError ? err.message : "Couldn't decline the request." });
    } finally {
      setDecliningCancel(false);
    }
  }

  // Order actions need the reconnected token; until then, each one explains
  // that instead of being greyed out.
  function guarded(fn: () => void) {
    return () => (data?.actionsEnabled ? fn() : setReconnectPrompt(true));
  }

  async function toggleArchived() {
    if (!order) return;
    setArchiving(true);
    try {
      const r = await api.archiveOrder(params.id, order.orderId, !order.archived);
      setData((current) => (current ? { ...current, order: { ...current.order, archived: r.archived } } : current));
      setActionNote({ tone: "ok", text: r.archived ? "Order archived. It's hidden from the order list under Archived." : "Order restored to the order list." });
    } catch (err) {
      setActionNote({ tone: "bad", text: err instanceof ApiError ? err.message : "Couldn't archive the order." });
    } finally {
      setArchiving(false);
    }
  }

  if (loadingConnection) return <AccountPageSkeleton rows={4} />;
  if (connectionError || !connection || !user) return <div className="p-8"><Alert>{connectionError || "This account connection doesn't exist, or isn't yours."}</Alert></div>;

  const host = connection.marketplace?.itemHost || "www.ebay.co.uk";
  const pay = order ? paymentLabel(order.paymentStatus) : null;
  const ful = order ? fulfillmentLabel(order) : null;
  const a = order?.shipTo || null;
  const addressText = a ? [a.name, a.street1, a.street2, [a.city, a.state].filter(Boolean).join(", "), a.postalCode, a.country, a.phone].filter(Boolean).join("\n") : "";
  const earnings = order?.earnings || null;
  const netToSeller = earnings?.earnings || order?.totalDueSeller || null;
  const netVsCost = netToSeller && totalCost !== null ? netToSeller.value - totalCost : null;
  const dispatched = order?.fulfillmentStatus === "FULFILLED";
  const cancelled = !!order && order.cancelState === "CANCELED";
  const paidAt = order?.payments[0]?.date || null;
  const shippedAt = order?.fulfillments.find((f) => f.shippedDate)?.shippedDate || null;
  const firstItem = order?.lineItems[0] || null;
  const promoted = !!earnings?.fees.some((f) => f.code.startsWith("AD_FEE"));
  const buyerUrl = order?.buyer.username ? `https://${host}/usr/${encodeURIComponent(order.buyer.username)}` : null;
  const messageUrl = order?.buyer.username ? `https://contact.${host.replace(/^www\./, "")}/ws/eBayISAPI.dll?M2MContact&requested=${encodeURIComponent(order.buyer.username)}${firstItem?.itemId ? `&item=${firstItem.itemId}` : ""}` : null;
  const ebayOrderUrl = order ? `https://${host}/mesh/ord/details?orderid=${encodeURIComponent(order.legacyOrderId || order.orderId)}` : null;
  // The actions that only exist on eBay's own pages open there.
  const couponUrl = `https://${host}/sh/mkt/couponcodes`;
  const reportBuyerUrl = order?.buyer.username ? `https://${host}/help/selling/resolving-buyer-issues/reporting-issue-buyer` : null;
  const relistUrl = firstItem?.itemId ? `https://${host}/sl/sell?mode=Relist&itemId=${firstItem.itemId}` : null;
  const sellSimilarUrl = firstItem?.itemId ? `https://${host}/sl/sell?mode=SellSimilar&itemId=${firstItem.itemId}` : null;

  const siteTz = connection.marketplace?.timeZone || SITE_TIMEZONES[connection.marketplace?.id || ""];
  const deadlineTone = cancelled ? "" : dispatched ? "" : daysLeft !== null && daysLeft < 0 ? "text-[var(--color-danger)]" : daysLeft !== null && daysLeft <= 1 ? "text-amber-800" : "";

  return (
    <AccountShell
      connectionId={connection.id}
      label={connection.label}
      platformKey={connection.platform_key}
      platformName={connection.platform_name}
      status={connection.status}
      marketplace={connection.marketplace}
      permissions={connection.permissions}
      user={user}
      header={
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href={`/accounts/${connection.id}/orders`}
              aria-label="Back to orders"
              title="Back to orders"
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-[var(--color-line)] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] print:hidden"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <h1 className="mt-1 text-[24px] font-extrabold tracking-tight text-[var(--color-ink)]">Order details</h1>
          </div>
          <button type="button" onClick={() => window.print()} className="btn btn-secondary btn-sm print:hidden">
            <svg viewBox="0 0 20 20" className="mr-1.5 h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 7V3h8v4M6 14H4a1 1 0 0 1-1-1V9a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4a1 1 0 0 1-1 1h-2M6 12h8v5H6z" />
            </svg>
            Print invoice
          </button>
        </div>
      }
    >
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {loading && !data && <OrderDetailSkeleton />}

      {data && order && (
        <div className="pb-8">
          {/* The item, as Seller Hub heads the page */}
          {firstItem && (
            <div className="flex items-center gap-3 border-b border-[var(--color-line)] pb-4">
              {firstItem.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={firstItem.imageUrl} alt="" className="h-12 w-12 flex-shrink-0 rounded-md border border-[var(--color-line)] bg-white object-cover" />
              ) : (
                <div className="h-12 w-12 flex-shrink-0 rounded-md border border-[var(--color-line)] bg-[var(--color-paper)]" />
              )}
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold text-[var(--color-ink)]">{cleanTitle(firstItem.title)}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-[var(--color-muted)] print:hidden">
                  {pay && <Chip text={pay.text} tone={pay.tone} />}
                  {ful && <Chip text={ful.text} tone={ful.tone} />}
                  {order.archived && <Chip text="Archived" tone="muted" />}
                  {order.lineItems.length > 1 && <span>+ {order.lineItems.length - 1} more item{order.lineItems.length > 2 ? "s" : ""}</span>}
                </p>
              </div>
            </div>
          )}

          <div className="mt-5 space-y-4 print:hidden">
            {actionNote && <Alert variant={actionNote.tone === "ok" ? "success" : undefined}>{actionNote.text}</Alert>}
            {justReconnected && data.actionsEnabled && <Alert variant="success">eBay account reconnected — dispatch, refunds and cancellations now work from here.</Alert>}
            {!data.actionsEnabled && (
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2.5 text-[12.5px] text-[var(--color-ink)]">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-2 w-2 flex-shrink-0 rounded-full bg-amber-500" aria-hidden />
                  <span>
                    <span className="font-semibold">Order actions are off for this account</span>
                    <span className="text-[var(--color-muted)]"> — it was linked before eBay order permissions existed. Reconnect once to send tracking, refunds and cancellations from here.</span>
                  </span>
                </span>
                <button type="button" onClick={reconnect} disabled={reconnecting} className="btn btn-secondary btn-sm flex-shrink-0">
                  {reconnecting ? "Opening eBay…" : "Reconnect"}
                </button>
              </div>
            )}
            {order.cancelRequests.some((r) => r.state === "REQUESTED") && (
              <Alert variant="warning">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    The buyer has asked to cancel this order
                    {order.cancelRequests.find((r) => r.state === "REQUESTED")?.reason ? ` (${String(order.cancelRequests.find((r) => r.state === "REQUESTED")?.reason).replace(/_/g, " ").toLowerCase()})` : ""}.
                    {dispatched ? " It has already been dispatched, so declining is the usual answer." : " Approving refunds them in full."}
                  </span>
                  <span className="flex gap-2">
                    <button type="button" onClick={guarded(() => setDeclineCancelOpen(true))} className="btn btn-secondary btn-sm">
                      Decline
                    </button>
                    {!dispatched && (
                      <button type="button" onClick={guarded(() => setAction("cancel"))} className="btn btn-primary btn-sm">
                        Approve
                      </button>
                    )}
                  </span>
                </span>
              </Alert>
            )}
            {cases && (cases.returns.length > 0 || cases.inquiries.length > 0 || cases.disputes.length > 0) && (
              <CasesPanel cases={cases} order={order} currency={currency} onAct={(c) => setCaseAction(c)} />
            )}
            {order.buyerCheckoutNotes && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-[13px] text-amber-900">
                <p className={labelClass}>Note from the buyer</p>
                <p className="mt-1 whitespace-pre-wrap">{order.buyerCheckoutNotes}</p>
              </div>
            )}
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            {/* ---- left column ---- */}
            <div className="space-y-4 lg:col-span-2">
              {/* Dispatch */}
              <div className={cardClass}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 basis-[320px]">
                    <h2 className={`text-[20px] font-bold text-[var(--color-ink)] ${deadlineTone}`}>
                      {cancelled ? "Order cancelled" : dispatched ? `Dispatched${shippedAt ? ` on ${formatDayMonthYear(shippedAt, siteTz)}` : ""}` : dispatchBy ? `Dispatch by ${formatDeadline(dispatchBy, siteTz)}` : "Awaiting dispatch"}
                    </h2>
                    {!cancelled && !dispatched && <p className="mt-1 text-[13px] text-[var(--color-ink)]">Make sure you send your order within the dispatch time you specified in the listing.</p>}
                    {(order.estimatedDelivery.min || order.estimatedDelivery.max) && (
                      <p className="mt-0.5 text-[13px] text-[var(--color-ink)]">
                        Estimated delivery date shown to buyer: {formatDayMonthYear(order.estimatedDelivery.min || order.estimatedDelivery.max, siteTz)}
                        {order.estimatedDelivery.min && order.estimatedDelivery.max ? ` - ${formatDayMonthYear(order.estimatedDelivery.max, siteTz)}` : ""}
                      </p>
                    )}
                    {!cancelled && !dispatched && daysLeft !== null && (
                      <p className={`mt-0.5 text-[13px] font-semibold ${daysLeft < 0 ? "text-[var(--color-danger)]" : daysLeft <= 1 ? "text-amber-800" : "text-[var(--color-ink)]"}`}>
                        {daysLeft < 0 ? `${-daysLeft} day${-daysLeft === 1 ? "" : "s"} late` : daysLeft === 0 ? "Due today" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
                      </p>
                    )}
                  </div>
                  {/* Seller Hub's pair: a filled "Get postage label" over an
                      outlined "More actions", both 245px, the menu hanging
                      under the second at the same width. Labels are bought
                      on eBay itself (no label API for UK sellers), so the
                      first opens eBay's page for this order. */}
                  <div className="flex w-[160px] flex-col items-stretch gap-1.5 print:hidden">
                    {!cancelled && !dispatched && ebayOrderUrl && (
                      <a href={ebayOrderUrl} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm rounded-full !h-8 !px-3 !text-[12.5px]">
                        Get postage label
                      </a>
                    )}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMoreOpen((v) => !v);
                        }}
                        className="btn btn-secondary btn-sm w-full rounded-full border-[var(--color-primary)] !h-8 !px-3 !text-[12.5px] text-[var(--color-primary)]"
                        aria-expanded={moreOpen}
                      >
                        More actions <Chevron open={moreOpen} />
                      </button>
                      {moreOpen && (
                        <div className="absolute right-0 z-20 mt-1 max-h-[300px] w-[176px] overflow-y-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] py-1 text-[12.5px] text-[var(--color-ink)] shadow-[0_6px_20px_rgba(0,0,0,0.12)]" onClick={(e) => e.stopPropagation()}>
                          {(
                            [
                              { label: "Print invoices and more", run: () => window.print() },
                              { label: "Print coupon", href: couponUrl },
                              { label: "Send coupon", href: couponUrl },
                              { label: dispatched ? "Edit tracking number" : "Add tracking number", run: guarded(() => setAction("tracking")) },
                              { label: "Mark as dispatched", run: guarded(() => setAction("dispatched")), disabled: dispatched },
                              { label: "Send refund", run: guarded(() => setAction("refund")), disabled: order.paymentStatus === "FULLY_REFUNDED" },
                              { label: "View payment details", run: () => scrollTo("payment") },
                              { label: order.cancelRequests.some((r) => r.state === "REQUESTED") ? "Approve cancellation" : "Cancel order", run: guarded(() => setAction("cancel")), disabled: dispatched || cancelled },
                              { label: "Message buyer", href: messageUrl },
                              { label: "Report buyer", href: reportBuyerUrl },
                              { label: "Relist", href: relistUrl },
                              { label: "Sell similar", href: sellSimilarUrl },
                              { label: order.archived ? "Unarchive" : "Archive", run: toggleArchived, disabled: archiving },
                            ] as { label: string; run?: () => void; href?: string | null; disabled?: boolean }[]
                          ).map((item) =>
                            item.href !== undefined ? (
                              item.href ? (
                                <a key={item.label} href={item.href} target="_blank" rel="noreferrer" className="block px-3 py-1.5 leading-5 hover:bg-[var(--color-paper)]">
                                  {item.label}
                                </a>
                              ) : null
                            ) : (
                              <button
                                key={item.label}
                                type="button"
                                disabled={item.disabled}
                                onClick={() => {
                                  setMoreOpen(false);
                                  item.run?.();
                                }}
                                className="block w-full px-3 py-1.5 text-left leading-5 hover:bg-[var(--color-paper)] disabled:cursor-not-allowed disabled:text-[var(--color-muted)]"
                              >
                                {item.label}
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <ProgressTrack
                  steps={[
                    { label: "Buyer paid", date: formatDayMonth(paidAt || order.createdAt, siteTz), done: order.paymentStatus === "PAID" || order.paymentStatus === "FULLY_REFUNDED" || order.paymentStatus === "PARTIALLY_REFUNDED" },
                    { label: dispatched ? "Dispatched" : "Dispatch by", date: formatDayMonth(dispatched ? shippedAt : dispatchBy, siteTz), done: dispatched },
                    order.deliveredAt
                      ? { label: "Delivered", date: formatDayMonth(order.deliveredAt, siteTz), done: true }
                      : { label: "Delivery", date: order.estimatedDelivery.max ? `est. ${formatDayMonth(order.estimatedDelivery.max, siteTz)}` : "", done: false },
                  ]}
                />
              </div>

              {/* Postage */}
              <div className={cardClass}>
                <h2 className="text-[20px] font-bold text-[var(--color-ink)]">Postage</h2>
                <div className="mt-3 print:hidden">
                  <PostageInstructions />
                </div>
                <div className="mt-4 grid gap-5 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]">
                  <div className="text-[13px] leading-relaxed text-[var(--color-ink)]">
                    <p className="flex items-center text-[var(--color-muted)]">
                      Post to
                      {addressText && <CopyIcon text={addressText} title="Copy address" />}
                    </p>
                    {a ? (
                      <>
                        <p>{a.name}</p>
                        {a.street1 && <p>{a.street1}</p>}
                        {a.street2 && <p>{a.street2}</p>}
                        <p>{[a.city, a.state, a.postalCode].filter(Boolean).join(", ")}</p>
                        <p>{connection.marketplace && a.country === connection.marketplace.country ? connection.marketplace.countryName : a.country}</p>
                        {a.phone && (
                          <>
                            <p className="mt-3 flex items-center text-[var(--color-muted)]">
                              Phone
                              <CopyIcon text={internationalPhone(a.phone, a.country || connection.marketplace?.country)} title="Copy phone number" />
                            </p>
                            <p>
                              <a href={`tel:${internationalPhone(a.phone, a.country || connection.marketplace?.country).replace(/\s+/g, "")}`} className="hover:underline">
                                {internationalPhone(a.phone, a.country || connection.marketplace?.country)}
                              </a>
                            </p>
                          </>
                        )}
                      </>
                    ) : (
                      <p className="text-[var(--color-muted)]">No delivery address on this order.</p>
                    )}
                  </div>
                  <div className="text-[13px] leading-relaxed text-[var(--color-ink)]">
                    <p className="text-[var(--color-muted)]">Buyer selected postage service</p>
                    <p>{order.shippingService ? order.shippingService.replace(/_/g, " ") : "—"}</p>
                    <p className="mt-3 text-[var(--color-muted)]">Tracking</p>
                    {order.fulfillments.length ? (
                      order.fulfillments.map((f, i) => (
                        <p key={f.fulfillmentId || i}>
                          {f.trackingNumber ? <span className="font-mono">{f.trackingNumber}</span> : "No tracking"}
                          {f.carrier ? ` · ${f.carrier}` : ""}
                          {f.shippedDate ? ` · ${formatDayMonth(f.shippedDate, siteTz)}` : ""}
                        </p>
                      ))
                    ) : (
                      <p>--</p>
                    )}
                  </div>
                  {!cancelled && (
                    <div className="print:hidden">
                      <button type="button" onClick={guarded(() => setAction("tracking"))} className="btn btn-secondary btn-sm rounded-full border-[var(--color-primary)] !h-8 !px-3 !text-[12.5px] text-[var(--color-primary)]">
                        {dispatched ? "Edit tracking" : "Add tracking"}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Item */}
              <div className={cardClass}>
                <h2 className="text-[20px] font-bold text-[var(--color-ink)]">{order.lineItems.length > 1 ? `Items · ${order.lineItems.length}` : "Item"}</h2>
                <div className="mt-3 divide-y divide-[var(--color-line)]">
                  {order.lineItems.map((li) => {
                    const open = !!specificsOpen[li.sourcingKey];
                    return (
                      <div key={li.sourcingKey} className="py-4 first:pt-1 last:pb-0">
                        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_repeat(3,minmax(80px,auto))]">
                          <div className="flex items-start gap-4">
                            {li.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={li.imageUrl} alt="" className="h-[120px] w-[120px] flex-shrink-0 rounded-md border border-[var(--color-line)] bg-white object-cover" />
                            ) : (
                              <div className="h-[120px] w-[120px] flex-shrink-0 rounded-md border border-[var(--color-line)] bg-[var(--color-paper)]" />
                            )}
                            <div className="min-w-0 text-[13px] text-[var(--color-ink)]">
                              {li.viewItemUrl ? (
                                <a href={li.viewItemUrl} target="_blank" rel="noreferrer" className="text-[14px] font-medium leading-snug underline hover:text-[var(--color-primary)]">
                                  {cleanTitle(li.title)}
                                </a>
                              ) : (
                                <p className="text-[14px] font-medium leading-snug">{cleanTitle(li.title)}</p>
                              )}
                              {li.variation.length > 0 && <p className="mt-1 text-[var(--color-muted)]">{li.variation.map((v) => `${v.name}: ${v.value}`).join(" · ")}</p>}
                              {li.sku && (
                                <p className="mt-2">
                                  Custom label (SKU): <span className="font-mono">{li.sku}</span>
                                </p>
                              )}
                              {li.itemId && <p className="mt-1.5 text-[var(--color-muted)]">Item ID: {li.itemId}</p>}
                              {promoted && <p className="mt-1.5 text-[var(--color-muted)]">Sold via Promoted Listings</p>}
                              {li.promotions.map((p, i) => p.description && (
                                <p key={i} className="mt-0.5 text-[var(--color-muted)]">
                                  Sold with {p.description}
                                </p>
                              ))}
                              {li.refunds.length > 0 && <p className="mt-1 text-[var(--color-danger)]">Refunded {money(li.refunds[0].amount, currency)}</p>}
                              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 print:hidden">
                                {!cancelled && (
                                  <button type="button" onClick={guarded(() => setAction("tracking"))} className="text-[var(--color-primary)] underline">
                                    {li.fulfillmentStatus === "FULFILLED" ? "Edit tracking" : "Add tracking"}
                                  </button>
                                )}
                                {li.listingId && (
                                  <Link href={`/accounts/${connection.id}/listings/draft/${li.listingId}`} className="text-[var(--color-primary)] underline">
                                    Open in Liston
                                  </Link>
                                )}
                              </div>
                              <button type="button" onClick={() => setSpecificsOpen((c) => ({ ...c, [li.sourcingKey]: !open }))} className="mt-3 flex items-center gap-1 text-[var(--color-ink)] underline print:hidden">
                                See more item specifics <Chevron open={open} />
                              </button>
                              {open && (
                                <dl className="mt-3 grid grid-cols-[minmax(120px,auto)_minmax(0,1fr)] gap-x-10 gap-y-2 text-[13px]">
                                  {Object.entries(li.itemSpecifics || {})
                                    .sort(([x], [y]) => x.localeCompare(y))
                                    .map(([name, values]) => (
                                      <Fragment key={name}>
                                        <dt className="text-[var(--color-muted)]">{name}</dt>
                                        <dd className="text-[var(--color-ink)]">{values.join(", ")}</dd>
                                      </Fragment>
                                    ))}
                                  {Object.keys(li.itemSpecifics || {}).length === 0 && <dd className="col-span-2 text-[var(--color-muted)]">No item specifics on this listing.</dd>}
                                </dl>
                              )}
                            </div>
                          </div>
                          <div className="text-[13px] sm:text-center">
                            <p className="text-[var(--color-muted)]">Quantity</p>
                            <p className="mt-1 font-semibold text-[var(--color-ink)]">{li.quantity}</p>
                            {li.quantityAvailable !== null && li.quantityAvailable !== undefined && <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">({li.quantityAvailable} available)</p>}
                          </div>
                          <div className="text-[13px] sm:text-center">
                            <p className="text-[var(--color-muted)]">Item price</p>
                            <p className="mt-1 text-[var(--color-ink)]">{money(li.unitPrice, currency)}</p>
                          </div>
                          <div className="text-[13px] sm:text-right">
                            <p className="text-[var(--color-muted)]">Item total</p>
                            <p className="mt-1 text-[var(--color-ink)]">{money(li.total, currency)}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Source — the part Seller Hub never had */}
              <div id="source" className={`${cardClass} scroll-mt-4 print:hidden`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-paper)] text-[var(--color-primary)]" aria-hidden>
                      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                        <path d="M3 7l9-4 9 4-9 4-9-4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                        <path d="M3 7v10l9 4 9-4V7M12 11v10" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <div>
                      <h2 className="text-[20px] font-bold text-[var(--color-ink)]">Source</h2>
                      <p className="text-[12.5px] text-[var(--color-muted)]">Supplier order for each item — a saved tracking number dispatches it on eBay.</p>
                    </div>
                  </div>
                </div>
                <div className="mt-3 space-y-3">
                  {order.lineItems.map((li) => (
                    <SourcingCard
                      key={`${li.sourcingKey}-${li.sourcing?.updatedAt || "new"}`}
                      connectionId={connection.id}
                      orderId={order.orderId}
                      line={li}
                      carriers={data.carriers}
                      actionsEnabled={data.actionsEnabled}
                      currency={currency}
                      onSaved={(sourcing, dispatch) => {
                        applySourcing(sourcing);
                        if (dispatch?.ok) load();
                      }}
                      defaultOpen={!li.sourcing || (li.sourcing.status !== "shipped" && li.sourcing.status !== "delivered")}
                      note={saveNotes[li.sourcingKey] || null}
                      onNote={(n) => setSaveNotes((current) => ({ ...current, [li.sourcingKey]: n }))}
                    />
                  ))}
                </div>
              </div>

            </div>

            {/* ---- right column ---- */}
            <div className="space-y-4">
              {/* Order */}
              <div className={cardClass}>
                <h2 className="text-[20px] font-bold text-[var(--color-ink)]">Order</h2>
                <div className="mt-2">
                  <Row
                    label="Order"
                    value={
                      <span className="flex items-center">
                        <span className="font-mono">{order.legacyOrderId || order.orderId}</span>
                        <CopyIcon text={order.legacyOrderId || order.orderId} title="Copy order number" />
                      </span>
                    }
                  />
                  {order.salesRecordReference && <Row label="Sales record no." value={order.salesRecordReference} />}
                  <Row label="Sold" value={formatDayMonthYear(order.createdAt, siteTz)} />
                  <Row label="Buyer paid" value={paidAt ? formatDayMonthYear(paidAt, siteTz) : pay?.text || "—"} />
                  <Row
                    label="Buyer"
                    value={
                      <span className="block">
                        {a?.name && <span className="block">{a.name}</span>}
                        {order.buyer.username && (
                          <span className="block">
                            {buyerUrl ? (
                              <a href={buyerUrl} target="_blank" rel="noreferrer" className="underline hover:text-[var(--color-primary)]">
                                {order.buyer.username}
                              </a>
                            ) : (
                              order.buyer.username
                            )}
                            {order.buyer.feedbackScore != null && <span className="ml-1">({order.buyer.feedbackScore})</span>}
                          </span>
                        )}
                        {order.buyer.repeatBuyer && <span className="block text-[var(--color-muted)]">Repeat buyer</span>}
                      </span>
                    }
                  />
                </div>
                <button type="button" onClick={() => setContactOpen((v) => !v)} className="mt-2 flex items-center gap-1 text-[13px] text-[var(--color-ink)] underline print:hidden">
                  {contactOpen ? "Hide contact info" : "Show contact info"} <Chevron open={contactOpen} />
                </button>
                {contactOpen && (
                  <div className="mt-2">
                    {a?.email && (
                      <Row
                        label="Email"
                        value={
                          <span className="flex items-start justify-between gap-1">
                            <span className="break-all">{a.email}</span>
                            <CopyIcon text={a.email} title="Copy email" />
                          </span>
                        }
                      />
                    )}
                    {a?.phone ? (
                      <Row
                        label="Phone"
                        value={
                          <span className="flex items-center justify-between gap-1">
                            <a href={`tel:${internationalPhone(a.phone, a.country || connection.marketplace?.country).replace(/\s+/g, "")}`} className="hover:underline">
                              {internationalPhone(a.phone, a.country || connection.marketplace?.country)}
                            </a>
                            <CopyIcon text={internationalPhone(a.phone, a.country || connection.marketplace?.country)} title="Copy phone number" />
                          </span>
                        }
                      />
                    ) : (
                      <p className="text-[13px] text-[var(--color-muted)]">No phone on this order.</p>
                    )}
                    {!a?.email && <p className="mt-1 text-[12px] text-[var(--color-muted)]">The buyer&apos;s email comes with the reconnected account.</p>}
                  </div>
                )}
                {messageUrl && (
                  <a href={messageUrl} target="_blank" rel="noreferrer" className="btn btn-secondary mt-4 w-full print:hidden">
                    Message buyer
                  </a>
                )}
              </div>

              {/* Payment */}
              <div id="payment" className={`${cardClass} scroll-mt-4`}>
                <h2 className="text-[20px] font-bold text-[var(--color-ink)]">Payment</h2>
                {order.paymentStatus === "PAID" && earnings && earnings.fundsStatusCode !== "PAYOUT" && earnings.fundsStatusCode !== "COMPLETED" && (
                  <div className="mt-3 flex gap-2.5 rounded-xl bg-[var(--color-paper)] p-3 text-[12.5px] text-[var(--color-ink)]">
                    <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--color-primary)]" fill="currentColor">
                      <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm.75-11.5a.75.75 0 0 0-1.5 0v.5a.75.75 0 0 0 1.5 0v-.5zM10 9a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-1.5 0v-4A.75.75 0 0 1 10 9z" clipRule="evenodd" />
                    </svg>
                    <p>
                      {earnings.fundsStatusCode === "FUNDS_ON_HOLD"
                        ? "eBay is holding the funds for this order. Once released, they will be available in your eBay balance."
                        : earnings.fundsStatusCode === "FUNDS_AVAILABLE_FOR_PAYOUT"
                          ? "Your buyer has paid for this order and the funds are available in your eBay balance."
                          : "Your buyer has paid for this order and eBay is processing the payment. Once complete, funds will be available in your eBay balance."}
                    </p>
                  </div>
                )}
                {order.paymentStatus === "PENDING" && (
                  <div className="mt-3 rounded-xl bg-amber-50 p-3 text-[12.5px] text-amber-900">The buyer hasn&apos;t paid for this order yet.</div>
                )}
                {order.paymentStatus === "PAID" && !earnings && (
                  <div className="mt-3 rounded-xl bg-[var(--color-paper)] p-3 text-[12.5px] text-[var(--color-ink)]">
                    {order.earningsUnavailable === "scope" ? (
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span>Fees and earnings need the finances permission this account was linked without. Reconnect once and they show here.</span>
                        <button type="button" onClick={reconnect} disabled={reconnecting} className="btn btn-secondary btn-sm flex-shrink-0">
                          {reconnecting ? "Opening eBay…" : "Reconnect"}
                        </button>
                      </span>
                    ) : order.earningsUnavailable === "error" ? (
                      "eBay's finances couldn't be read just now; the breakdown will fill in on the next load."
                    ) : (
                      "Your buyer has paid for this order. eBay hasn't posted the sale to your finances yet, so the fees aren't known — they appear here as soon as it does."
                    )}
                  </div>
                )}

                <div className="mt-3 flex items-start justify-between text-[13px]">
                  <span className="text-[var(--color-muted)]">Funds status</span>
                  <span className="text-right">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--color-ink)]">
                      <span className={`inline-block h-2.5 w-2.5 rounded-full ${earnings?.fundsStatusCode === "PAYOUT" || earnings?.fundsStatusCode === "COMPLETED" || earnings?.fundsStatusCode === "FUNDS_AVAILABLE_FOR_PAYOUT" ? "bg-emerald-500" : earnings?.fundsStatusCode === "FUNDS_ON_HOLD" ? "bg-amber-500" : "bg-[var(--color-line)]"}`} />
                      {earnings ? earnings.fundsStatus : order.paymentStatus === "PAID" ? "Pending" : pay?.text || "—"}
                    </span>
                    {earnings?.payoutId && <span className="block text-[11.5px] text-[var(--color-muted)]">Payout {earnings.payoutId}</span>}
                  </span>
                </div>

                <div className="mt-4 rounded-xl bg-[var(--color-paper)] p-4">
                  <p className="text-[14px] font-bold text-[var(--color-ink)]">What your buyer paid</p>
                  <div className="mt-2">
                    <MoneyRow label="Subtotal" value={money(order.pricing.subtotal, currency)} indent />
                    <MoneyRow label="Postage" value={money(order.pricing.delivery || { value: 0, currency }, currency)} indent />
                    {order.pricing.discount && order.pricing.discount.value !== 0 && <MoneyRow label="Discount" value={money(order.pricing.discount, currency)} indent negative />}
                    {order.pricing.deliveryDiscount && order.pricing.deliveryDiscount.value !== 0 && <MoneyRow label="Postage discount" value={money(order.pricing.deliveryDiscount, currency)} indent negative />}
                    {order.pricing.tax && order.pricing.tax.value !== 0 && <MoneyRow label="Tax" value={money(order.pricing.tax, currency)} indent />}
                    {order.pricing.adjustment && order.pricing.adjustment.value !== 0 && <MoneyRow label="Adjustment" value={money(order.pricing.adjustment, currency)} indent />}
                    <div className="mt-1 border-t border-[var(--color-line)] pt-1">
                      <MoneyRow label="Order total" value={money(order.pricing.total, currency)} bold />
                    </div>
                  </div>
                </div>

                <div className="mt-3 rounded-xl bg-[var(--color-paper)] p-4">
                  <button type="button" onClick={() => setEarnedOpen((v) => !v)} className="flex w-full items-center justify-between text-left">
                    <span className="text-[14px] font-bold text-[var(--color-ink)]">What you earned</span>
                    <Chevron open={earnedOpen} />
                  </button>
                  {earnedOpen && (
                    <div className="mt-2">
                      <MoneyRow label="Order total" value={money(earnings?.gross || order.pricing.total, currency)} bold />
                      <p className="mt-1 text-[13px] font-semibold text-[var(--color-ink)]">Selling costs</p>
                      {earnings ? (
                        earnings.fees.map((f) => <MoneyRow key={f.label} label={f.label} value={money(f.amount, currency)} indent negative />)
                      ) : order.totalMarketplaceFee ? (
                        <MoneyRow label="eBay fees" value={money(order.totalMarketplaceFee, currency)} indent negative />
                      ) : (
                        <p className="pl-4 text-[12.5px] text-[var(--color-muted)]">{order.earningsUnavailable === "scope" ? "Reconnect the account to see fees." : "Not posted by eBay yet."}</p>
                      )}
                      <div className="mt-1 border-t border-[var(--color-line)] pt-1">
                        <MoneyRow label="Order earnings" value={netToSeller ? money(netToSeller, currency) : "—"} bold />
                      </div>
                      {order.refunds.length > 0 && (
                        <div className="mt-1 border-t border-[var(--color-line)] pt-1">
                          {order.refunds.map((r, i) => (
                            <MoneyRow key={r.referenceId || i} label={`Refund${r.date ? ` ${formatDayMonth(r.date, siteTz)}` : ""}`} value={money(r.amount, currency)} indent negative />
                          ))}
                        </div>
                      )}
                      {totalCost !== null && (
                        <div className="mt-2 border-t border-dashed border-[var(--color-line)] pt-2">
                          <p className="text-[13px] font-semibold text-[var(--color-ink)]">Sourcing</p>
                          <MoneyRow label="Supplier cost" value={formatPrice(totalCost, currency)} indent negative />
                          {netVsCost !== null && (
                            <div className={`flex items-center justify-between py-1 text-[13px] font-bold ${netVsCost >= 0 ? "text-emerald-700" : "text-[var(--color-danger)]"}`}>
                              <span>Profit</span>
                              <span>{formatPrice(netVsCost, currency)}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {paidAt && <p className="mt-3 text-[11.5px] text-[var(--color-muted)]">Paid {formatDateTime(paidAt, siteTz)}{order.payments[0]?.method ? ` · ${order.payments[0].method.replace(/_/g, " ").toLowerCase()}` : ""}</p>}
              </div>
            </div>
          </div>
        </div>
      )}

      {declineCancelOpen && order && (
        <Modal title="Decline the cancellation request" onClose={() => setDeclineCancelOpen(false)}>
          <p className="mt-3 text-[13px] text-[var(--color-ink)]">
            The order stays as it is and the buyer is told you declined. eBay expects a decline only when the item has already been sent — otherwise it can count against you if the buyer opens a case.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setDeclineCancelOpen(false)} className="btn btn-secondary btn-sm">
              Back
            </button>
            <button type="button" onClick={declineCancel} disabled={decliningCancel} className="btn btn-primary btn-sm">
              {decliningCancel ? "Working…" : "Decline request"}
            </button>
          </div>
        </Modal>
      )}
      {caseAction && order && cases && (
        <CaseDialog
          connectionId={connection.id}
          order={order}
          currency={currency}
          carriers={data?.carriers || []}
          declineReasons={cases.returnDeclineReasons}
          action={caseAction}
          onClose={() => setCaseAction(null)}
          onDone={(message) => {
            setCaseAction(null);
            setActionNote({ tone: "ok", text: message });
            load();
          }}
        />
      )}
      {reconnectPrompt && (
        <Modal title="Reconnect this eBay account" onClose={() => setReconnectPrompt(false)}>
          <p className="mt-3 text-[13px] text-[var(--color-ink)]">
            This account was linked before Liston asked eBay for order permissions, so eBay won&apos;t accept tracking, refunds or cancellations from here yet. Reconnecting re-runs eBay&apos;s consent for the same account — one click, nothing else changes — and brings you straight back to this order.
          </p>
          <div className="mt-5 flex justify-end gap-3">
            <button type="button" onClick={() => setReconnectPrompt(false)} className="btn btn-ghost">
              Not now
            </button>
            <button type="button" onClick={reconnect} disabled={reconnecting} className="btn btn-primary">
              {reconnecting ? "Opening eBay…" : "Reconnect now"}
            </button>
          </div>
        </Modal>
      )}
      {action && order && data && (
        <ActionDialog
          kind={action}
          connectionId={connection.id}
          order={order}
          carriers={data.carriers}
          refundReasons={data.refundReasons || []}
          cancelReasons={data.cancelReasons || []}
          currency={currency}
          onClose={() => setAction(null)}
          onDone={(message) => {
            setAction(null);
            setActionNote({ tone: "ok", text: message });
            load();
          }}
        />
      )}
    </AccountShell>
  );
}

