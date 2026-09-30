"use client";

import { ReactNode, useEffect, useState } from "react";
import { api, EbayOrderSummary, EbayThread, OrderCases } from "@/lib/api";
import { colorFor, initialOf, listTime, money } from "../inbox-format";

// A buyer conversation's details, beside the chat when asked for (the
// header's details button, or its name): who the buyer is, the order it's
// about (its state, what they paid, the way from ordered to delivered,
// tracking, what they bought, any open return or case with its deadline),
// the listing, the buyer's other orders and their other conversations.
// Orders and listings open in Liston in a new tab (a small "Open" pill in
// the section's heading), so the chat stays put.
// On a wide screen it sits beside the chat; on a smaller one over it.

const STATUS_TONE: Record<string, string> = {
  awaiting_payment: "bg-amber-50 text-amber-700",
  awaiting_dispatch: "bg-amber-50 text-amber-700",
  dispatched: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]",
  delivered: "bg-emerald-50 text-emerald-700",
  cancelled: "bg-slate-100 text-slate-600",
};
const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "");

// Any open return, item-not-received request or payment dispute on the order.
function useOpenCases(connectionId: string, orderId: string | null) {
  const [cases, setCases] = useState<{ key: string; label: string; respondBy: string | null }[] | null>(null);
  useEffect(() => {
    if (!orderId) return;
    let live = true;
    api
      .getOrderCases(connectionId, orderId)
      .then((c: OrderCases) => {
        if (!live || c.unavailable) return;
        setCases([
          ...c.returns.filter((r) => !r.closed).map((r) => ({ key: `r${r.id}`, label: "Return open", respondBy: r.respondBy })),
          ...c.inquiries.filter((r) => !r.closed).map((r) => ({ key: `i${r.id}`, label: "Item not received", respondBy: r.respondBy })),
          ...c.disputes.filter((r) => !r.closed).map((r) => ({ key: `d${r.id}`, label: "Payment dispute", respondBy: r.respondBy })),
        ]);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connectionId, orderId]);
  return cases;
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="border-t border-[var(--color-line)] px-5 py-4">
      <div className="mb-3 flex min-h-7 items-center justify-between gap-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

const arrow = (
  <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" aria-hidden>
    <path d="M8 5h7v7M15 5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Opens a Liston page in a new tab: a small soft pill in its section's heading, as the app's other quiet actions.
function OpenLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className="inline-flex h-7 items-center gap-1 rounded-full bg-[var(--color-primary-soft)] pl-2.5 pr-2 text-[12px] font-semibold text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary)] hover:text-white"
    >
      {children}
      {arrow}
    </a>
  );
}

function Copyable({ text, mono = true }: { text: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          })
          .catch(() => {})
      }
      title="Copy"
      className={`group inline-flex min-w-0 items-center gap-1.5 text-left text-[12.5px] text-[var(--color-ink)] hover:text-[var(--color-primary)] ${mono ? "font-mono text-[12px]" : ""}`}
    >
      <span className="truncate">{text}</span>
      <span className={`flex-shrink-0 text-[10.5px] font-sans font-medium ${copied ? "text-emerald-600" : "text-[var(--color-muted)] opacity-0 group-hover:opacity-100"}`}>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

// Ordered, dispatched, delivered: done steps filled in, the next one open with its date due.
function Journey({ order }: { order: EbayOrderSummary }) {
  if (order.status === "cancelled") return <p className="text-[12.5px] text-[var(--color-muted)]">Cancelled{order.createdAt ? ` · ordered ${date(order.createdAt)}` : ""}</p>;
  const due = order.estimatedDelivery ? `${order.estimatedDelivery.min ? `${date(order.estimatedDelivery.min)} – ` : ""}${date(order.estimatedDelivery.max)}` : "";
  const steps = [
    { label: "Ordered", done: true, when: date(order.paidAt || order.createdAt) },
    { label: order.shippedAt ? "Dispatched" : "Dispatch", done: Boolean(order.shippedAt), when: order.shippedAt ? date(order.shippedAt) : order.dispatchBy ? `by ${date(order.dispatchBy)}` : "" },
    { label: order.deliveredAt ? "Delivered" : "Delivery", done: Boolean(order.deliveredAt), when: order.deliveredAt ? date(order.deliveredAt) : due ? `due ${due}` : "" },
  ];
  return (
    <ol className="relative space-y-3">
      {steps.map((s, i) => (
        <li key={s.label} className="relative flex items-center gap-3">
          {i < steps.length - 1 && <span className={`absolute left-[5px] top-3 h-[calc(100%+2px)] w-0.5 ${steps[i + 1].done ? "bg-emerald-500" : "bg-[var(--color-line)]"}`} aria-hidden />}
          <span className={`relative z-10 h-3 w-3 flex-shrink-0 rounded-full ${s.done ? "bg-emerald-500" : "border-2 border-[var(--color-line-strong)] bg-[var(--color-panel)]"}`} aria-hidden />
          <span className={`flex-1 text-[12.5px] ${s.done ? "font-medium text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>{s.label}</span>
          <span className="text-[12px] tabular-nums text-[var(--color-muted)]">{s.when}</span>
        </li>
      ))}
    </ol>
  );
}

function OrderBlock({ order, connectionId }: { order: EbayOrderSummary; connectionId: string }) {
  const cases = useOpenCases(connectionId, order.orderId);
  const lines = order.items;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-2 text-[11px] font-semibold leading-5 ${STATUS_TONE[order.status] || STATUS_TONE.cancelled}`}>{order.statusLabel}</span>
        <span className="flex-1" />
        {order.total && <span className="text-[14px] font-semibold tabular-nums text-[var(--color-ink)]">{money(order.total.amount, order.total.currency)}</span>}
      </div>
      <dl className="grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-2 text-[12.5px]">
        <dt className="text-[var(--color-muted)]">Order</dt>
        <dd className="min-w-0">
          <Copyable text={order.orderId} />
        </dd>
        {order.tracking.map((t) => (
          <FragmentRow key={t.number} label={t.carrier || "Tracking"}>
            <Copyable text={t.number} />
          </FragmentRow>
        ))}
      </dl>
      {cases && cases.length > 0 && (
        <div className="space-y-1.5">
          {cases.map((c) => (
            <a key={c.key} href={`${order.url}#cases`} target="_blank" rel="noopener" className="flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-[12.5px] text-rose-800 transition-colors hover:bg-rose-100">
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-rose-500" aria-hidden />
              <span className="flex-1 font-semibold">{c.label}</span>
              {c.respondBy && <span className="text-[11.5px]">respond by {date(c.respondBy)}</span>}
            </a>
          ))}
        </div>
      )}
      <Journey order={order} />
      {lines.length > 0 && (
        <ul className="space-y-2.5">
          {lines.map((l, i) => (
            <li key={`${l.itemId}-${i}`} className="flex items-center gap-3">
              {l.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={l.image} alt="" className="h-11 w-11 flex-shrink-0 rounded-lg object-cover ring-1 ring-black/5" />
              ) : (
                <span className="h-11 w-11 flex-shrink-0 rounded-lg bg-[var(--color-paper)]" />
              )}
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-[12.5px] leading-[17px] text-[var(--color-ink)]">{l.title}</span>
                <span className="block truncate text-[11.5px] text-[var(--color-muted)]">
                  {l.variation ? `${l.variation} · ` : ""}Qty {l.quantity}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FragmentRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="truncate text-[var(--color-muted)]">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

export function EbayDetails({ data, onClose, onOpenConversation }: { data: EbayThread; onClose: () => void; onOpenConversation: (conversationId: string) => void }) {
  const conv = data.conversation;
  const { item, listing, order, orders, ordersHidden, otherConversations } = data.context;
  const connectionId = conv.account.id;
  const others = orders.filter((o) => o.orderId !== order?.orderId);
  const listingFacts = listing && !listing.locked && !listing.gone ? listing.facts : [];

  return (
    <aside className="absolute inset-0 z-30 flex flex-col bg-[var(--color-panel)] sm:left-auto sm:w-[340px] sm:border-l sm:border-[var(--color-line)] sm:shadow-[var(--shadow-pop)] 2xl:static 2xl:z-auto 2xl:flex-shrink-0 2xl:shadow-none">
      <header className="flex h-[60px] flex-shrink-0 items-center gap-2 px-3">
        <button type="button" onClick={onClose} aria-label="Close details" className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
            <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <h3 className="text-[14.5px] font-semibold text-[var(--color-ink)]">Details</h3>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        <div className="flex flex-col items-center px-5 pb-5 pt-2 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full text-[24px] font-semibold text-white" style={{ background: colorFor(conv.otherParty) }} aria-hidden>
            {initialOf(conv.otherParty)}
          </span>
          <p className="mt-3 max-w-full truncate text-[16px] font-semibold text-[var(--color-ink)]">{conv.otherParty || "Buyer"}</p>
          <p className="text-[12.5px] text-[var(--color-muted)]">Buyer{conv.account.label ? ` · ${conv.account.label}` : ""}</p>
        </div>

        {order ? (
          <Section title="Order" action={<OpenLink href={order.url}>Open order</OpenLink>}>
            <OrderBlock order={order} connectionId={connectionId} />
          </Section>
        ) : ordersHidden ? (
          <Section title="Order">
            <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">You don&apos;t have access to this account&apos;s orders, so the buyer&apos;s orders aren&apos;t shown.</p>
          </Section>
        ) : null}

        {item && (
          <Section title={order ? "Listing" : "Asked about"} action={item.url ? <OpenLink href={item.url}>Open listing</OpenLink> : undefined}>
            <div className="flex items-start gap-3">
              {item.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.image} alt="" className="h-14 w-14 flex-shrink-0 rounded-lg object-cover ring-1 ring-black/5" />
              ) : (
                <span className="h-14 w-14 flex-shrink-0 rounded-lg bg-[var(--color-paper)]" />
              )}
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[13px] font-medium leading-[18px] text-[var(--color-ink)]">{item.title || `Item ${item.itemId}`}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11.5px] text-[var(--color-muted)]">
                  <span className="font-mono">{item.itemId}</span>
                  {item.price && <span className="font-medium text-[var(--color-ink)]">{money(item.price.amount, item.price.currency)}</span>}
                </p>
              </div>
            </div>
            {listingFacts.some((f) => f.kind === "text") && (
              <p className="mt-2.5 flex flex-wrap gap-1.5">
                {listingFacts.map((f, i) =>
                  f.kind === "text" ? (
                    <span key={i} className="rounded-full bg-[var(--color-paper)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]">
                      {f.text}
                    </span>
                  ) : null
                )}
              </p>
            )}
            {!order && !ordersHidden && <p className="mt-2.5 text-[12px] text-[var(--color-muted)]">Asked before buying: no order from this buyer for it yet.</p>}
          </Section>
        )}

        {others.length > 0 && (
          <Section title={`Other orders · ${others.length}`}>
            <ul className="-mx-2 space-y-0.5">
              {others.map((o) => (
                <li key={o.orderId}>
                  <a href={o.url} target="_blank" rel="noopener" className="flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-[var(--color-paper)]">
                    {o.items[0]?.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={o.items[0].image} alt="" className="h-9 w-9 flex-shrink-0 rounded-lg object-cover ring-1 ring-black/5" />
                    ) : (
                      <span className="h-9 w-9 flex-shrink-0 rounded-lg bg-[var(--color-paper)]" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-[var(--color-ink)]">{o.items[0]?.title || o.orderId}</span>
                      <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-muted)]">
                        <span className={`rounded-full px-1.5 text-[10.5px] font-semibold leading-4 ${STATUS_TONE[o.status] || STATUS_TONE.cancelled}`}>{o.statusLabel}</span>
                        {o.createdAt && date(o.createdAt)}
                        {o.total && <span className="tabular-nums">· {money(o.total.amount, o.total.currency)}</span>}
                      </span>
                    </span>
                    <span className="text-[var(--color-muted)]">{arrow}</span>
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {otherConversations.length > 0 && (
          <Section title={`Other conversations · ${otherConversations.length}`}>
            <ul className="-mx-2 space-y-0.5">
              {otherConversations.map((c) => (
                <li key={c.conversationId}>
                  <button type="button" onClick={() => onOpenConversation(c.conversationId)} className="block w-full rounded-xl px-2 py-2 text-left transition-colors hover:bg-[var(--color-paper)]">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--color-ink)]">{c.title || (c.referenceId ? `Item ${c.referenceId}` : "Conversation")}</span>
                      {c.at && <span className="flex-shrink-0 text-[11px] text-[var(--color-muted)]">{listTime(c.at)}</span>}
                    </span>
                    {c.preview && <span className="block truncate text-[12px] text-[var(--color-muted)]">{c.preview}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </aside>
  );
}
