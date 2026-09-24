"use client";

import { useState } from "react";
import { api, ApiError, type OrderCases, type OrderDetail, type OrderDispute, type OrderInquiry, type OrderReturn } from "@/lib/api";
import { formatDateTime, formatPrice } from "@/lib/format";
import { useAccountTimeZone } from "@/lib/timezone";
import { Modal, cleanTitle, inputClass, labelClass, money } from "@/components/orders/order-ui";

// --- post-sale cases: returns, item-not-received, payment disputes ---------

export type CaseAction =
  | { kind: "return"; item: OrderReturn; action: "accept" | "decline" | "received" | "refund" | "message" }
  | { kind: "inquiry"; item: OrderInquiry; action: "shipment" | "refund" | "message" }
  | { kind: "dispute"; item: OrderDispute; action: "accept" | "contest" };

function humanise(code: string | null | undefined) {
  if (!code) return "";
  return String(code).replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export function CasesPanel({ cases, order, currency, onAct }: { cases: OrderCases; order: OrderDetail; currency: string; onAct: (c: CaseAction) => void }) {
  const timeZone = useAccountTimeZone();
  const itemTitle = (itemId: string | null) => cleanTitle(order.lineItems.find((li) => li.itemId === itemId)?.title || order.lineItems[0]?.title || null);
  const rows: { key: string; tone: string; title: string; detail: string; due: string | null; actions: { label: string; primary?: boolean; run: () => void }[] }[] = [];

  for (const r of cases.returns) {
    const awaitingDecision = /RETURN_REQUESTED/i.test(r.state || "") && !r.closed;
    const shipped = /ITEM_SHIPPED|ITEM_DELIVERED|RETURN_LABEL/i.test(r.state || "") && !r.closed;
    rows.push({
      key: `return-${r.id}`,
      tone: r.closed ? "muted" : "warn",
      title: `Return request${r.closed ? " (closed)" : ""} · ${itemTitle(r.itemId)}`,
      detail: [humanise(r.reason), r.buyerComment ? `“${r.buyerComment}”` : "", r.tracking ? `Return tracking ${r.carrier ? `${r.carrier} ` : ""}${r.tracking}` : "", humanise(r.state)].filter(Boolean).join(" · "),
      due: r.respondBy,
      actions: r.closed
        ? []
        : [
            ...(awaitingDecision ? [{ label: "Accept return", primary: true, run: () => onAct({ kind: "return", item: r, action: "accept" }) }, { label: "Decline", run: () => onAct({ kind: "return", item: r, action: "decline" }) }] : []),
            ...(shipped ? [{ label: "Mark as received", run: () => onAct({ kind: "return", item: r, action: "received" }) }] : []),
            { label: "Refund buyer", primary: !awaitingDecision, run: () => onAct({ kind: "return", item: r, action: "refund" }) },
            { label: "Message", run: () => onAct({ kind: "return", item: r, action: "message" }) },
          ],
    });
  }
  for (const i of cases.inquiries) {
    rows.push({
      key: `inquiry-${i.id}`,
      tone: i.closed ? "muted" : "warn",
      title: `Item not received${i.closed ? " (closed)" : ""} · ${itemTitle(i.itemId)}`,
      detail: [i.claimAmount ? `Claim ${money(i.claimAmount, currency)}` : "", humanise(i.state)].filter(Boolean).join(" · "),
      due: i.respondBy,
      actions: i.closed
        ? []
        : [
            { label: "Provide tracking", primary: true, run: () => onAct({ kind: "inquiry", item: i, action: "shipment" }) },
            { label: "Refund buyer", run: () => onAct({ kind: "inquiry", item: i, action: "refund" }) },
            { label: "Message", run: () => onAct({ kind: "inquiry", item: i, action: "message" }) },
          ],
    });
  }
  for (const d of cases.disputes) {
    rows.push({
      key: `dispute-${d.id}`,
      tone: d.closed ? "muted" : "bad",
      title: `Payment dispute${d.closed ? " (closed)" : ""}${d.amount ? ` · ${money(d.amount, currency)}` : ""}`,
      detail: [humanise(d.reason), humanise(d.status)].filter(Boolean).join(" · "),
      due: d.respondBy,
      actions: d.closed || !/OPEN|ACTION_NEEDED/i.test(d.status || "")
        ? []
        : [
            { label: "Contest", primary: true, run: () => onAct({ kind: "dispute", item: d, action: "contest" }) },
            { label: "Accept dispute", run: () => onAct({ kind: "dispute", item: d, action: "accept" }) },
          ],
    });
  }
  if (!rows.length) return null;
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.key} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-[13px] ${row.tone === "bad" ? "border-red-200 bg-red-50" : row.tone === "warn" ? "border-amber-200 bg-amber-50" : "border-[var(--color-line)] bg-[var(--color-panel)]"}`}>
          <div className="min-w-0">
            <p className="font-semibold text-[var(--color-ink)]">{row.title}</p>
            {row.detail && <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">{row.detail}</p>}
            {row.due && !row.actions.length ? null : row.due && <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">Respond by {formatDateTime(row.due, timeZone)}</p>}
          </div>
          {row.actions.length > 0 && (
            <div className="flex flex-wrap gap-2 print:hidden">
              {row.actions.map((a) => (
                <button key={a.label} type="button" onClick={a.run} className={`btn btn-sm ${a.primary ? "btn-primary" : "btn-secondary"}`}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function CaseDialog({
  connectionId,
  order,
  currency,
  carriers,
  declineReasons,
  action,
  onClose,
  onDone,
}: {
  connectionId: string;
  order: OrderDetail;
  currency: string;
  carriers: { code: string; label: string }[];
  declineReasons: { code: string; label: string }[];
  action: CaseAction;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [comment, setComment] = useState("");
  const [declineReason, setDeclineReason] = useState(declineReasons[0]?.code || "");
  const [full, setFull] = useState(true);
  const [amount, setAmount] = useState(order.pricing.total ? order.pricing.total.value.toFixed(2) : "");
  const [tracking, setTracking] = useState(order.fulfillments.find((f) => f.trackingNumber)?.trackingNumber || "");
  const [carrier, setCarrier] = useState(order.fulfillments.find((f) => f.carrier)?.carrier || "");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buyerName = order.shipTo?.name || order.buyer.username || "the buyer";
  const moneyMoves = (action.kind === "return" && (action.action === "refund" || action.action === "accept")) || (action.kind === "inquiry" && action.action === "refund") || (action.kind === "dispute" && action.action === "accept");
  const refundValue = full ? order.pricing.total?.value ?? null : Number(amount);

  const titles: Record<string, string> = {
    "return.accept": "Accept the return",
    "return.decline": "Decline the return",
    "return.received": "Mark the return as received",
    "return.refund": "Refund the buyer",
    "return.message": "Message the buyer about the return",
    "inquiry.shipment": "Provide tracking",
    "inquiry.refund": "Refund the buyer",
    "inquiry.message": "Message the buyer",
    "dispute.accept": "Accept the payment dispute",
    "dispute.contest": "Contest the payment dispute",
  };
  const key = `${action.kind}.${action.action}`;

  async function run() {
    if (moneyMoves && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (action.kind === "return") {
        await api.respondToReturn(connectionId, order.orderId, {
          returnId: action.item.id,
          action: action.action,
          comment: comment || undefined,
          ...(action.action === "decline" ? { declineReason } : {}),
          ...(action.action === "refund" ? { amount: full ? null : amount } : {}),
        });
        onDone(
          action.action === "accept"
            ? "Return accepted — the buyer can now send the item back."
            : action.action === "decline"
              ? "Return request declined."
              : action.action === "received"
                ? "Marked as received. Refund the buyer when you're ready."
                : action.action === "refund"
                  ? `Refund of ${full ? money(order.pricing.total, currency) : formatPrice(amount, currency)} sent for the return.`
                  : "Message sent."
        );
      } else if (action.kind === "inquiry") {
        await api.respondToInquiry(connectionId, order.orderId, {
          inquiryId: action.item.id,
          action: action.action,
          ...(action.action === "shipment" ? { trackingNumber: tracking, ...(carrier ? { carrier } : {}) } : {}),
          message: comment || undefined,
        });
        onDone(action.action === "shipment" ? "Tracking sent to the buyer and eBay." : action.action === "refund" ? "Refund sent; eBay closes the case." : "Message sent.");
      } else {
        await api.respondToDispute(connectionId, order.orderId, { disputeId: action.item.id, action: action.action });
        onDone(action.action === "accept" ? "Dispute accepted; the buyer keeps the payment." : "Dispute contested with the evidence on file.");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={titles[key] || "Respond"} onClose={onClose}>
      <div className="mt-3 space-y-3 text-[13px] text-[var(--color-ink)]">
        {key === "return.accept" && <p className="text-[var(--color-muted)]">The buyer gets a return label and sends the item back. You refund once it arrives (or eBay refunds them automatically if you don&apos;t act in time).</p>}
        {key === "return.decline" && (
          <div>
            <label className={labelClass}>Reason</label>
            <select className={`${inputClass} mt-1`} value={declineReason} onChange={(e) => setDeclineReason(e.target.value)}>
              {declineReasons.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[12px] text-[var(--color-muted)]">The buyer can ask eBay to step in after a decline; eBay usually sides with the buyer on &quot;not as described&quot; returns.</p>
          </div>
        )}
        {(key === "return.refund" || key === "inquiry.refund") && (
          <>
            {key === "return.refund" && (
              <div className="flex gap-4">
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={full} onChange={() => setFull(true)} /> Full refund{order.pricing.total ? ` (${money(order.pricing.total, currency)})` : ""}
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={!full} onChange={() => setFull(false)} /> Partial
                </label>
              </div>
            )}
            {key === "return.refund" && !full && (
              <div>
                <label className={labelClass}>Amount ({currency})</label>
                <input type="number" step="0.01" min="0.01" max={order.pricing.total?.value} className={`${inputClass} mt-1`} value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
            )}
            {key === "inquiry.refund" && <p className="text-[var(--color-muted)]">Refunds the buyer in full and closes the item-not-received case.</p>}
          </>
        )}
        {key === "inquiry.shipment" && (
          <>
            <p className="text-[var(--color-muted)]">Tells the buyer and eBay the item was sent. Tracking that shows delivery is what closes the case in your favour.</p>
            <div>
              <label className={labelClass}>Tracking number</label>
              <input className={`${inputClass} mt-1 font-mono`} value={tracking} onChange={(e) => setTracking(e.target.value)} autoFocus />
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
        {key === "dispute.accept" && <p className="text-[var(--color-muted)]">The buyer keeps the money and the dispute closes. Choose this when you can&apos;t show the item was delivered as described.</p>}
        {key === "dispute.contest" && <p className="text-[var(--color-muted)]">Contests with the evidence already on the dispute (eBay attaches your tracking itself). To add photos or documents first, use eBay&apos;s dispute page, then contest.</p>}
        {key !== "dispute.accept" && key !== "dispute.contest" && (
          <div>
            <label className={labelClass}>{key.endsWith(".message") ? "Message" : "Note to the buyer (optional)"}</label>
            <textarea className={`${inputClass} mt-1 h-20 resize-none`} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} autoFocus={key.endsWith(".message")} />
          </div>
        )}
        {confirming && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3">
            <p className="font-semibold">
              {key === "return.refund" || key === "inquiry.refund"
                ? `Refund ${formatPrice(key === "inquiry.refund" ? order.pricing.total?.value ?? 0 : (refundValue as number), currency)} to ${buyerName}?`
                : key === "dispute.accept"
                  ? `Accept the dispute and let ${buyerName} keep ${money(action.kind === "dispute" ? action.item.amount : null, currency)}?`
                  : `Accept the return from ${buyerName}?`}
            </p>
            <p className="mt-1 text-[var(--color-muted)]">This is sent to eBay straight away and can&apos;t be undone.</p>
          </div>
        )}
        {error && <p className="font-medium text-[var(--color-danger)]">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={confirming ? () => setConfirming(false) : onClose} className="btn btn-secondary btn-sm">
            Back
          </button>
          <button type="button" onClick={run} disabled={busy} className={`btn btn-sm ${moneyMoves ? "bg-[var(--color-danger)] text-white hover:opacity-90" : "btn-primary"}`}>
            {busy ? "Working…" : confirming ? "Yes, do it" : titles[key]?.split(" ")[0] === "Message" ? "Send message" : titles[key] || "Confirm"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

