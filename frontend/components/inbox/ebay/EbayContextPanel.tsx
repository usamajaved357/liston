"use client";

import { useEffect, useState } from "react";
import { api, EbayOrderSummary, EbayThread, OrderCases } from "@/lib/api";
import { ListonCardView } from "../ListonCardView";
import { listTime, money } from "../inbox-format";

// Beside an eBay conversation, what eBay's own Messages makes you open other
// tabs for: the order it's about (its state, what they paid, tracking, when
// it's due, its items), any return, item-not-received request or payment
// dispute with its state and deadline, the listing when they asked before
// buying, the buyer's other orders and their other conversations. Orders,
// returns and cases open in a new tab, so the Inbox stays where it was.

const TONE: Record<string, string> = {
  awaiting_payment: "bg-amber-50 text-amber-800 ring-amber-200",
  awaiting_dispatch: "bg-amber-50 text-amber-800 ring-amber-200",
  dispatched: "bg-[var(--color-primary-soft)] text-[var(--color-primary)] ring-indigo-200",
  delivered: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  cancelled: "bg-slate-50 text-slate-600 ring-slate-200",
};

const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null);

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="border-b border-[var(--color-line)] px-4 py-3.5">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">{title}</p>
        {action}
      </div>
      {children}
    </section>
  );
}

function OrderBlock({ order }: { order: EbayOrderSummary }) {
  const line = (label: string, value: string | null) =>
    value ? (
      <div className="flex justify-between gap-3 text-[12px]">
        <span className="text-[var(--color-muted)]">{label}</span>
        <span className="text-right font-medium text-[var(--color-ink)]">{value}</span>
      </div>
    ) : null;
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <a href={order.url} target="_blank" rel="noopener" className="font-mono text-[12.5px] font-semibold text-[var(--color-primary)] hover:underline">
          {order.orderId}
        </a>
        <span className={`inline-flex h-[20px] items-center rounded px-2 text-[11px] font-semibold ring-1 ring-inset ${TONE[order.status] || TONE.cancelled}`}>{order.statusLabel}</span>
      </div>
      {order.items.map((it) => (
        <div key={it.itemId + it.title} className="flex gap-2.5">
          {it.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={it.image} alt="" className="h-10 w-10 flex-shrink-0 rounded-md border border-[var(--color-line)] object-cover" />
          ) : (
            <span className="h-10 w-10 flex-shrink-0 rounded-md bg-[var(--color-paper)]" />
          )}
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-[12px] leading-snug text-[var(--color-ink)]">{it.title}</p>
            <p className="text-[11px] text-[var(--color-muted)]">
              {it.quantity > 1 ? `${it.quantity} × ` : ""}
              {it.variation || ""}
            </p>
          </div>
        </div>
      ))}
      <div className="space-y-1">
        {line("Paid", order.total ? money(order.total.amount, order.total.currency) : null)}
        {line("Ordered", date(order.createdAt))}
        {!order.shippedAt && order.status !== "cancelled" && line("Dispatch by", date(order.dispatchBy))}
        {line("Dispatched", date(order.shippedAt))}
        {!order.deliveredAt && order.estimatedDelivery && line("Due", `${date(order.estimatedDelivery.min) ? `${date(order.estimatedDelivery.min)} – ` : ""}${date(order.estimatedDelivery.max)}`)}
        {line("Delivered", date(order.deliveredAt))}
      </div>
      {order.tracking.map((t) => (
        <div key={t.number} className="rounded-lg bg-[var(--color-paper)] px-2.5 py-1.5 text-[12px]">
          <span className="text-[var(--color-muted)]">{t.carrier || "Tracking"} </span>
          <span className="font-mono font-medium text-[var(--color-ink)]">{t.number}</span>
        </div>
      ))}
      <a href={order.url} target="_blank" rel="noopener" className="btn btn-secondary btn-sm w-full">
        Open order
      </a>
    </div>
  );
}

function Cases({ connectionId, order }: { connectionId: string; order: EbayOrderSummary }) {
  const [cases, setCases] = useState<OrderCases | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .getOrderCases(connectionId, order.orderId)
      .then((c) => live && setCases(c))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [connectionId, order.orderId]);
  if (failed) return null;
  if (!cases) return <p className="text-[12px] text-[var(--color-muted)]">Checking for returns and cases…</p>;
  if (cases.unavailable)
    return (
      <p className="text-[12px] text-[var(--color-muted)]">
        {cases.unavailable === "scope" ? "Reconnect this eBay account to see its returns and cases here." : "Couldn't check eBay for returns and cases just now."}{" "}
        <a href={`/accounts/${connectionId}/orders/${encodeURIComponent(order.orderId)}`} target="_blank" rel="noopener" className="font-medium text-[var(--color-primary)] hover:underline">
          Open the order
        </a>
      </p>
    );
  const open = [
    ...cases.returns.filter((r) => !r.closed).map((r) => ({ key: `r${r.id}`, label: "Return open", detail: r.reason, respondBy: r.respondBy })),
    ...cases.inquiries.filter((r) => !r.closed).map((r) => ({ key: `i${r.id}`, label: "Item not received", detail: r.status, respondBy: r.respondBy })),
    ...cases.disputes.filter((r) => !r.closed).map((r) => ({ key: `d${r.id}`, label: "Payment dispute", detail: r.reason, respondBy: r.respondBy })),
  ];
  const closed = cases.returns.filter((r) => r.closed).length + cases.inquiries.filter((r) => r.closed).length + cases.disputes.filter((r) => r.closed).length;
  if (!open.length) return <p className="text-[12px] text-[var(--color-muted)]">{closed ? `No open cases (${closed} closed).` : "No returns or cases."}</p>;
  return (
    <div className="space-y-2">
      {open.map((c) => (
        <a key={c.key} href={`/accounts/${connectionId}/orders/${encodeURIComponent(order.orderId)}#cases`} target="_blank" rel="noopener" className="block rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 hover:border-rose-300">
          <p className="text-[12.5px] font-semibold text-rose-800">{c.label}</p>
          {c.detail && <p className="text-[11.5px] text-rose-700">{String(c.detail).replace(/_/g, " ").toLowerCase()}</p>}
          {c.respondBy && <p className="mt-0.5 text-[11.5px] font-medium text-rose-800">Respond by {date(c.respondBy)}</p>}
        </a>
      ))}
    </div>
  );
}

export function EbayContextPanel({ data, onOpenConversation }: { data: EbayThread; onOpenConversation: (conversationId: string) => void }) {
  const ctx = data.context;
  const connectionId = data.conversation.account.id;
  const others = ctx.orders.filter((o) => o.orderId !== ctx.order?.orderId);
  if (data.conversation.type === "FROM_EBAY") {
    return (
      <aside className="hidden w-[300px] flex-shrink-0 overflow-y-auto border-l border-[var(--color-line)] bg-[var(--color-panel)] xl:block">
        <Section title="From eBay">
          <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">eBay&apos;s own messages: account notices, cases and policy updates. Their links open on eBay; the order and case pages open in Liston.</p>
        </Section>
      </aside>
    );
  }
  return (
    <aside className="hidden w-[300px] flex-shrink-0 overflow-y-auto border-l border-[var(--color-line)] bg-[var(--color-panel)] xl:block">
      {ctx.ordersHidden ? (
        <Section title="Order">
          <p className="text-[12px] text-[var(--color-muted)]">You don&apos;t have Orders on this account, so its orders aren&apos;t shown.</p>
        </Section>
      ) : ctx.order ? (
        <>
          <Section title="This order">
            <OrderBlock order={ctx.order} />
          </Section>
          <Section title="Returns and cases">
            <Cases connectionId={connectionId} order={ctx.order} />
          </Section>
        </>
      ) : ctx.listing ? (
        <Section title="Asked before buying">
          <ListonCardView card={ctx.listing} compact />
        </Section>
      ) : (
        <Section title="Order">
          <p className="text-[12px] text-[var(--color-muted)]">{ctx.orders.length ? "Not about one of their orders." : "No order from this buyer in the last 90 days."}</p>
        </Section>
      )}
      {!ctx.ordersHidden && others.length > 0 && (
        <Section title={`Their other orders (${others.length})`}>
          <div className="space-y-2">
            {others.map((o) => (
              <a key={o.orderId} href={o.url} target="_blank" rel="noopener" className="flex items-center gap-2.5 rounded-lg px-1 py-1 hover:bg-[var(--color-paper)]">
                {o.items[0]?.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={o.items[0].image} alt="" className="h-9 w-9 flex-shrink-0 rounded-md object-cover" />
                ) : (
                  <span className="h-9 w-9 flex-shrink-0 rounded-md bg-[var(--color-paper)]" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-[var(--color-ink)]">{o.items[0]?.title}</span>
                  <span className="block text-[11px] text-[var(--color-muted)]">
                    {o.statusLabel} · {date(o.createdAt)}
                  </span>
                </span>
              </a>
            ))}
          </div>
        </Section>
      )}
      {ctx.otherConversations.length > 0 && (
        <Section title="Their other conversations">
          <div className="space-y-1">
            {ctx.otherConversations.map((c) => (
              <button key={c.conversationId} type="button" onClick={() => onOpenConversation(c.conversationId)} className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-[var(--color-paper)]">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--color-ink)]">{c.title || (c.referenceId ? `Item ${c.referenceId}` : "Conversation")}</span>
                  {c.at && <span className="text-[10.5px] text-[var(--color-muted)]">{listTime(c.at)}</span>}
                </span>
                <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{c.preview}</span>
              </button>
            ))}
          </div>
        </Section>
      )}
    </aside>
  );
}
