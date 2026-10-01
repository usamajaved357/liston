"use client";

import { ReactNode, useEffect, useState } from "react";
import { api, EbayListingInsights, EbayOrderSummary, EbayThread, OrderCases, OrderMoney } from "@/lib/api";
import { colorFor, initialOf, listTime, money } from "../inbox-format";
import { useQuietScrollbar } from "@/lib/useQuietScrollbar";

// A buyer conversation's details, beside the chat when asked for (the
// header's details button, or its name): who the buyer is, the order it's
// about (its state, what they paid, the way from ordered to delivered,
// tracking, what they bought, any open return or case with its deadline
// and a cancellation they asked for, each opening the order's page at the
// part that answers it; its postage, where it's going and the supplier
// order behind it), what it made (eBay's fees, the earnings and where the
// funds are, the supplier cost, the profit), the listing (live or ended,
// watchers, sales and views over 30 days, when listed, its supplier, item
// specifics: all from Liston's own copies), the buyer's other orders and
// their other conversations.
// Orders and listings open in Liston in a new tab ("Order details",
// "Listing details": underlined links in the section's heading), so the
// chat stays put.
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
          ...c.returns.filter((r) => !r.closed && !r.refunded).map((r) => ({ key: `r${r.id}`, label: "Return open", respondBy: r.respondBy })),
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

// The buyer's other orders open in a new tab: a small arrow at each row's end.
const arrow = (
  <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" aria-hidden>
    <path d="M8 5h7v7M15 5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Opens a Liston page in a new tab: an underlined link in its section's heading, the line firming up on hover.
function OpenLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className="text-[12.5px] font-medium text-[var(--color-primary)] underline decoration-[var(--color-primary)]/35 decoration-1 underline-offset-[3px] transition-colors hover:decoration-[var(--color-primary)]"
    >
      {children}
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
        {order.postage && (
          <FragmentRow label="Postage">
            <span className="block truncate text-[var(--color-ink)]" title={order.postage}>
              {order.postage}
            </span>
          </FragmentRow>
        )}
        {order.shipTo && (
          <FragmentRow label="Ships to">
            <span className="block truncate text-[var(--color-ink)]" title={order.shipTo}>
              {order.shipTo}
            </span>
          </FragmentRow>
        )}
      </dl>
      <SupplierOrders order={order} />
      {order.cancelRequested && (
        <a href={`${order.url}#cancel-request`} target="_blank" rel="noopener" className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 transition-colors hover:bg-amber-100">
          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-500" aria-hidden />
          <span className="flex-1 font-semibold">Cancellation requested</span>
          <span className="text-[11.5px]">approve or decline</span>
        </a>
      )}
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

// What the order made: eBay's fees and earnings as Liston keeps them (read
// from eBay once when it has none), the supplier cost and the profit. The
// order page has every fee on its own line.
function useOrderMoney(connectionId: string, order: EbayOrderSummary) {
  const [state, setState] = useState<{ orderId: string; money: OrderMoney | null } | null>(null);
  const unpaid = order.status === "awaiting_payment";
  useEffect(() => {
    if (unpaid) return;
    let live = true;
    api
      .getOrderMoney(connectionId, order.orderId)
      .then((m) => live && setState({ orderId: order.orderId, money: m }))
      .catch(() => live && setState({ orderId: order.orderId, money: null }));
    return () => {
      live = false;
    };
  }, [connectionId, order.orderId, unpaid]);
  const loaded = state?.orderId === order.orderId;
  return { money: loaded ? state.money : null, loading: !unpaid && !loaded, unpaid };
}

const FUNDS_TONE: Record<string, string> = { "Paid out": "bg-emerald-500", Available: "bg-emerald-500", "On hold": "bg-amber-500" };
const minus = (value: number, currency: string) => `\u2212${money(Math.abs(value), currency)}`;

function MoneyLine({ label, value, strong = false, muted = false }: { label: ReactNode; value: ReactNode; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-[3px] text-[12.5px] ${strong ? "font-semibold text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>
      <span className="min-w-0">{label}</span>
      <span className={`tabular-nums ${strong ? "" : muted ? "text-[var(--color-muted)]" : "text-[var(--color-ink)]"}`}>{value}</span>
    </div>
  );
}

function EarningsSection({ order, connectionId }: { order: EbayOrderSummary; connectionId: string }) {
  const { money: m, loading, unpaid } = useOrderMoney(connectionId, order);
  const currency = m?.currency || order.total?.currency || "GBP";
  const gross = m?.gross ?? order.total?.amount ?? null;
  const why = unpaid
    ? "The buyer hasn't paid yet."
    : m?.unavailable === "scope"
      ? "Reconnect this account to see its fees and earnings."
      : m?.unavailable === "error"
        ? "Couldn't read the fees from eBay just now."
        : m?.unavailable === "pending" || (!loading && !m)
          ? "eBay hasn't posted this sale's fees yet. They show here once it does."
          : null;
  const status = m?.fundsStatus ? (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--color-muted)]" title="Where the money for this order is">
      <span className={`h-1.5 w-1.5 rounded-full ${FUNDS_TONE[m.fundsStatus] || "bg-slate-400"}`} aria-hidden />
      {m.fundsStatus}
    </span>
  ) : undefined;
  return (
    <Section title="Earnings" action={status}>
      {loading ? (
        <div className="space-y-2.5 rounded-xl bg-[var(--color-paper)] px-3.5 py-3" aria-label="Loading">
          {[70, 55, 62].map((w) => (
            <div key={w} className="flex justify-between">
              <span className="h-3 animate-pulse rounded bg-[var(--color-line)]" style={{ width: `${w}px` }} />
              <span className="h-3 w-12 animate-pulse rounded bg-[var(--color-line)]" />
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl bg-[var(--color-paper)] px-3.5 py-2.5">
          {gross !== null && <MoneyLine label="Order total" value={money(gross, currency)} />}
          {m && m.earnings !== null ? (
            <>
              <MoneyLine label="eBay fees" value={minus(m.fees || 0, currency)} />
              {!!m.adFees && <MoneyLine label="Promoted listing fee" value={minus(m.adFees, currency)} />}
              {!!m.refunds && <MoneyLine label="Refunds" value={minus(m.refunds, currency)} />}
              <div className="mt-1 border-t border-[var(--color-line)] pt-1">
                <MoneyLine label="You earned" value={money(m.earnings, currency)} strong />
              </div>
            </>
          ) : (
            why && <p className="py-1 text-[12px] leading-[17px] text-[var(--color-muted)]">{why}</p>
          )}
          <MoneyLine label="Supplier cost" value={m?.cost ? minus(m.cost.value, m.cost.currency || currency) : "Not entered"} muted={!m?.cost} />
          {m && m.profit !== null && (
            <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-[var(--color-line)] pt-1.5 text-[13px] font-semibold">
              <span className="text-[var(--color-ink)]">Profit</span>
              <span className="flex items-baseline gap-2">
                {m.margin !== null && <span className="text-[11px] font-medium text-[var(--color-muted)]">{m.margin}% margin</span>}
                <span className={`tabular-nums ${m.profit >= 0 ? "text-emerald-700" : "text-[var(--color-danger)]"}`}>{m.profit < 0 ? minus(m.profit, currency) : money(m.profit, currency)}</span>
              </span>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

const SUPPLIER_TONE: Record<string, string> = {
  to_order: "bg-amber-50 text-amber-700",
  ordered: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]",
  shipped: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]",
  delivered: "bg-emerald-50 text-emerald-700",
  problem: "bg-rose-50 text-rose-600",
};

// The supplier order behind each line (the order page's Source section),
// for answering "where's my order": its state, number, tracking and when
// it was placed. Nothing recorded on an order still to dispatch says so.
function SupplierOrders({ order }: { order: EbayOrderSummary }) {
  const lines = order.supplier || [];
  const waiting = !lines.length && order.status === "awaiting_dispatch";
  if (!lines.length && !waiting) return null;
  return (
    <div className="rounded-xl border border-[var(--color-line)] px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-[var(--color-ink)]">Supplier order</span>
        {waiting && <span className={`rounded-full px-2 text-[11px] font-semibold leading-5 ${SUPPLIER_TONE.to_order}`}>Not ordered yet</span>}
        {lines.length === 1 && <span className={`rounded-full px-2 text-[11px] font-semibold leading-5 ${SUPPLIER_TONE[lines[0].status] || SUPPLIER_TONE.ordered}`}>{lines[0].statusLabel}</span>}
      </div>
      {lines.map((l, i) => (
        <div key={i} className={lines.length > 1 ? "mt-2.5 border-t border-[var(--color-line)] pt-2.5" : "mt-2"}>
          {lines.length > 1 && <span className={`rounded-full px-2 text-[11px] font-semibold leading-5 ${SUPPLIER_TONE[l.status] || SUPPLIER_TONE.ordered}`}>{l.statusLabel}</span>}
          <dl className={`grid grid-cols-[76px_1fr] items-center gap-x-3 gap-y-1.5 text-[12.5px] ${lines.length > 1 ? "mt-2" : ""}`}>
            {l.orderNo && (
              <FragmentRow label="Order no.">
                <Copyable text={l.orderNo} />
              </FragmentRow>
            )}
            {l.tracking && (
              <FragmentRow label={l.carrier || "Tracking"}>
                <Copyable text={l.tracking} />
              </FragmentRow>
            )}
            {l.placedAt && (
              <FragmentRow label="Ordered">
                <span className="text-[var(--color-ink)]">
                  {date(l.placedAt)}
                  {l.placedBy && <span className="text-[var(--color-muted)]"> by {l.placedBy}</span>}
                </span>
              </FragmentRow>
            )}
          </dl>
          {!l.orderNo && !l.tracking && !l.placedAt && <p className="text-[12px] text-[var(--color-muted)]">No supplier order number yet.</p>}
        </div>
      ))}
    </div>
  );
}

const fullDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const hostOf = (url: string) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return /aliexpress\./.test(host) ? "AliExpress" : host;
  } catch {
    return "Supplier";
  }
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-[var(--color-paper)] px-2.5 py-2">
      <p className="truncate text-[10.5px] font-medium text-[var(--color-muted)]">{label}</p>
      <p className="mt-0.5 text-[14px] font-semibold tabular-nums text-[var(--color-ink)]">{value}</p>
    </div>
  );
}

const SPECIFICS_SHOWN = 5;

// What Liston keeps about the listing: watchers, sales and views over the
// last 30 days, when it was listed, its supplier and item specifics (to
// answer "is it real leather?" without opening eBay).
function ListingInsights({ insights: x }: { insights: EbayListingInsights }) {
  const [allSpecifics, setAllSpecifics] = useState(false);
  const stats = [
    x.watchers !== null ? { label: "Watchers", value: x.watchers.toLocaleString() } : null,
    x.sold !== null ? { label: `Sold ${x.days}d`, value: x.sold.toLocaleString() } : null,
    x.views !== null ? { label: `Views ${x.days}d`, value: x.views.toLocaleString() } : null,
    x.conversion !== null ? { label: "Conversion", value: `${x.conversion}%` } : null,
  ].filter(Boolean) as { label: string; value: string }[];
  const specifics = allSpecifics ? x.specifics : x.specifics.slice(0, SPECIFICS_SHOWN);
  return (
    <div className="mt-3 space-y-3">
      {stats.length > 0 && (
        // Up to three in a row; four as two pairs, so no label is cut short.
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${stats.length === 4 ? 2 : stats.length}, minmax(0, 1fr))` }}>
          {stats.map((st) => (
            <Stat key={st.label} label={st.label} value={st.value} />
          ))}
        </div>
      )}
      {(x.listedAt || x.endedAt || x.supplierUrl) && (
        <dl className="grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-2 text-[12.5px]">
          {x.listedAt && (
            <FragmentRow label="Listed">
              <span className="text-[var(--color-ink)]">{fullDate(x.listedAt)}</span>
            </FragmentRow>
          )}
          {x.endedAt && (
            <FragmentRow label="Ended">
              <span className="text-[var(--color-ink)]">{fullDate(x.endedAt)}</span>
            </FragmentRow>
          )}
          {x.supplierUrl && (
            <FragmentRow label="Supplier">
              <a href={x.supplierUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-[var(--color-primary)] underline decoration-[var(--color-primary)]/35 decoration-1 underline-offset-[3px] transition-colors hover:decoration-[var(--color-primary)]">
                {hostOf(x.supplierUrl)}
              </a>
            </FragmentRow>
          )}
        </dl>
      )}
      {x.specifics.length > 0 && (
        <div>
          <p className="mb-1.5 text-[12px] font-semibold text-[var(--color-ink)]">Item specifics</p>
          <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1 text-[12px]">
            {specifics.map((sp) => (
              <FragmentRow key={sp.name} label={sp.name}>
                <span className="block truncate text-[var(--color-ink)]" title={sp.value}>
                  {sp.value}
                </span>
              </FragmentRow>
            ))}
          </dl>
          {x.specifics.length > SPECIFICS_SHOWN && (
            <button type="button" onClick={() => setAllSpecifics((v) => !v)} className="mt-1.5 text-[12px] font-medium text-[var(--color-primary)] hover:underline">
              {allSpecifics ? "Show fewer" : `Show all ${x.specifics.length}`}
            </button>
          )}
        </div>
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
  const quietScroll = useQuietScrollbar<HTMLDivElement>();
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

      <div ref={quietScroll} className="scroll-quiet min-h-0 flex-1 overflow-y-auto pb-6">
        <div className="flex flex-col items-center px-5 pb-5 pt-2 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full text-[24px] font-semibold text-white" style={{ background: colorFor(conv.otherParty) }} aria-hidden>
            {initialOf(conv.otherParty)}
          </span>
          <p className="mt-3 max-w-full truncate text-[16px] font-semibold text-[var(--color-ink)]">{conv.otherParty || "Buyer"}</p>
          <p className="text-[12.5px] text-[var(--color-muted)]">Buyer{conv.account.label ? ` · ${conv.account.label}` : ""}</p>
        </div>

        {order ? (
          <>
            <Section title="Order" action={<OpenLink href={order.url}>Order details</OpenLink>}>
              <OrderBlock order={order} connectionId={connectionId} />
            </Section>
            <EarningsSection key={order.orderId} order={order} connectionId={connectionId} />
          </>
        ) : ordersHidden ? (
          <Section title="Order">
            <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">You don&apos;t have access to this account&apos;s orders, so the buyer&apos;s orders aren&apos;t shown.</p>
          </Section>
        ) : null}

        {item && (
          <Section title={order ? "Listing" : "Asked about"} action={item.url ? <OpenLink href={item.url}>Listing details</OpenLink> : undefined}>
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
                  {item.insights?.live !== null && item.insights?.live !== undefined && (
                    <span className={`inline-flex items-center gap-1 font-medium ${item.insights.live ? "text-emerald-700" : "text-[var(--color-muted)]"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${item.insights.live ? "bg-emerald-500" : "bg-slate-400"}`} aria-hidden />
                      {item.insights.live ? "Live" : "Ended"}
                    </span>
                  )}
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
            {item.insights && <ListingInsights insights={item.insights} />}
            {!order && !ordersHidden && <p className="mt-3 text-[12px] text-[var(--color-muted)]">Asked before buying: no order from this buyer for it yet.</p>}
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
