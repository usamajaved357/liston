"use client";

import { useState } from "react";
import { api, ApiError, type OrderDetail } from "@/lib/api";
import { formatPrice } from "@/lib/format";
import { Modal, inputClass, labelClass, money } from "@/components/orders/order-ui";

// Seller Hub's "More actions" that change the order on eBay — each behind
// its own dialog, and a second confirmation where money moves.
export type ActionKind = "tracking" | "dispatched" | "refund" | "cancel";

export function ActionDialog({
  kind,
  connectionId,
  order,
  carriers,
  refundReasons,
  cancelReasons,
  currency,
  onClose,
  onDone,
}: {
  kind: ActionKind;
  connectionId: string;
  order: OrderDetail;
  carriers: { code: string; label: string }[];
  refundReasons: { code: string; label: string }[];
  cancelReasons: { code: string; label: string }[];
  currency: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState("");
  const [amount, setAmount] = useState(order.pricing.total ? order.pricing.total.value.toFixed(2) : "");
  const [full, setFull] = useState(true);
  const [reason, setReason] = useState(kind === "refund" ? refundReasons[0]?.code || "" : cancelReasons[0]?.code || "");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Money leaves the account on these two; a second, explicit confirmation
  // stands between the form and eBay.
  const [confirming, setConfirming] = useState(false);
  const pendingCancel = order.cancelRequests.find((r) => r.state === "REQUESTED") || null;
  const undispatched = order.lineItems.filter((li) => li.fulfillmentStatus !== "FULFILLED").length;
  const refundValue = full ? order.pricing.total?.value ?? null : Number(amount);
  const buyerName = order.shipTo?.name || order.buyer.username || "the buyer";

  async function run() {
    if ((kind === "refund" || kind === "cancel") && !confirming) {
      if (kind === "refund" && (!Number.isFinite(refundValue) || (refundValue as number) <= 0)) {
        setError("Enter a refund amount above zero.");
        return;
      }
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (kind === "tracking") {
        if (!tracking.trim()) throw new ApiError("Enter the tracking number.", 400);
        const r = await api.dispatchOrder(connectionId, order.orderId, { trackingNumber: tracking.trim(), ...(carrier ? { carrier } : {}) });
        onDone(`Marked dispatched on eBay with tracking ${tracking.trim()} (${r.lines} item${r.lines === 1 ? "" : "s"}).`);
      } else if (kind === "dispatched") {
        const r = await api.dispatchOrder(connectionId, order.orderId, {});
        onDone(`Marked dispatched on eBay without tracking (${r.lines} item${r.lines === 1 ? "" : "s"}).`);
      } else if (kind === "refund") {
        const r = await api.refundOrder(connectionId, order.orderId, { amount: full ? null : amount, reason, comment });
        onDone(`Refund of ${r.amount ? formatPrice(r.amount.value, r.amount.currency) : "the order"} sent to the buyer${r.status ? ` (${r.status.toLowerCase()})` : ""}.`);
      } else {
        const r = await api.cancelOrder(connectionId, order.orderId, { reason });
        onDone(r.approved ? "The buyer's cancellation was approved; eBay is refunding them." : "The order was cancelled on eBay; eBay is refunding the buyer.");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<ActionKind, string> = { tracking: "Add tracking number", dispatched: "Mark as dispatched", refund: "Send refund", cancel: "Cancel order" };

  return (
    <Modal title={titles[kind]} onClose={onClose}>
      <div className="mt-3 space-y-3 text-[13px] text-[var(--color-ink)]">
        {kind === "tracking" && (
          <>
            <p className="text-[var(--color-muted)]">
              Marks {undispatched === 1 ? "the item" : `all ${undispatched} undispatched items`} dispatched on eBay with this number. The buyer sees it straight away.
            </p>
            <div>
              <label className={labelClass}>Tracking number</label>
              <input className={`${inputClass} mt-1 font-mono`} value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="e.g. H06R4A0225077758" autoFocus />
            </div>
            <div>
              <label className={labelClass}>Carrier</label>
              <select className={`${inputClass} mt-1`} value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                <option value="">Detect from number</option>
                {carriers.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        {kind === "dispatched" && (
          <p>
            This marks {undispatched === 1 ? "the item" : `all ${undispatched} undispatched items`} dispatched on eBay <span className="font-semibold">without a tracking number</span>. eBay doesn&apos;t recommend it: with no tracking you have no proof of delivery if the buyer opens a case.
          </p>
        )}
        {kind === "refund" && (
          <>
            <p className="text-[var(--color-muted)]">eBay takes the refund from your balance and returns it to the buyer&apos;s original payment method.</p>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={full} onChange={() => setFull(true)} /> Full refund{order.pricing.total ? ` (${money(order.pricing.total, currency)})` : ""}
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={!full} onChange={() => setFull(false)} /> Partial
              </label>
            </div>
            {!full && (
              <div>
                <label className={labelClass}>Amount ({currency})</label>
                <input type="number" step="0.01" min="0.01" max={order.pricing.total?.value} className={`${inputClass} mt-1`} value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
            )}
            <div>
              <label className={labelClass}>Reason</label>
              <select className={`${inputClass} mt-1`} value={reason} onChange={(e) => setReason(e.target.value)}>
                {refundReasons.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Message to buyer (optional)</label>
              <input className={`${inputClass} mt-1`} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} />
            </div>
          </>
        )}
        {kind === "cancel" && (
          <>
            {pendingCancel ? (
              <p>
                The buyer asked to cancel this order{pendingCancel.reason ? ` (${pendingCancel.reason.replace(/_/g, " ").toLowerCase()})` : ""}. Approving it cancels the order and eBay refunds them in full.
              </p>
            ) : (
              <>
                <p className="text-[var(--color-muted)]">Cancelling refunds the buyer in full. Cancelling because you&apos;re out of stock counts against your seller performance.</p>
                <div>
                  <label className={labelClass}>Reason</label>
                  <select className={`${inputClass} mt-1`} value={reason} onChange={(e) => setReason(e.target.value)}>
                    {cancelReasons.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </>
        )}
        {confirming && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-[13px] text-[var(--color-ink)]">
            <p className="font-semibold">
              {kind === "refund"
                ? `Refund ${formatPrice(refundValue as number, currency)} to ${buyerName}?`
                : pendingCancel
                  ? `Approve the cancellation and refund ${money(order.pricing.total, currency)} to ${buyerName}?`
                  : `Cancel this order and refund ${money(order.pricing.total, currency)} to ${buyerName}?`}
            </p>
            <p className="mt-1 text-[var(--color-muted)]">This is sent to eBay straight away and can&apos;t be undone.</p>
          </div>
        )}
        {error && <p className="font-medium text-[var(--color-danger)]">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={confirming ? () => setConfirming(false) : onClose} className="btn btn-secondary btn-sm">
            Back
          </button>
          <button type="button" onClick={run} disabled={busy} className={`btn btn-sm ${kind === "cancel" || kind === "refund" ? "bg-[var(--color-danger)] text-white hover:opacity-90" : "btn-primary"}`}>
            {busy
              ? "Working…"
              : kind === "tracking"
                ? "Add tracking & dispatch"
                : kind === "dispatched"
                  ? "Mark as dispatched"
                  : kind === "refund"
                    ? confirming
                      ? "Yes, send the refund"
                      : "Send refund"
                    : pendingCancel
                      ? confirming
                        ? "Yes, approve it"
                        : "Approve cancellation"
                      : confirming
                        ? "Yes, cancel the order"
                        : "Cancel order"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

