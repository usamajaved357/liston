"use client";

import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, EbayMessage, EbayThread, OrderCases } from "@/lib/api";
import { PhotoStack } from "../MessageFiles";
import { RichText } from "../MessageBubble";
import { colorFor, dayLabel, initialOf, money, timeLabel } from "../inbox-format";
import { EbayMark } from "./EbayConversationList";

// One eBay conversation. The header says who it's with and holds its
// actions; under it, one strip for what it's about: the item, and the order
// (its state, what they paid, when it's due to go or arrive, tracking, and
// any open return or case with its deadline) or, asked before buying, the
// listing's price and stock; the order opens in a new tab. Then the
// messages as a chat: the buyer's on the left, yours on the right in the
// brand colour, each bubble with its time tucked in its corner, runs of one
// person's messages close together; eBay's own as notices with their links
// as buttons.

const STATUS_TONE: Record<string, string> = {
  awaiting_payment: "bg-amber-50 text-amber-700",
  awaiting_dispatch: "bg-amber-50 text-amber-700",
  dispatched: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]",
  delivered: "bg-emerald-50 text-emerald-700",
  cancelled: "bg-slate-100 text-slate-600",
};
const shortDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "");

function IconButton({ label, onClick, disabled, children, href }: { label: string; onClick?: () => void; disabled?: boolean; children: ReactNode; href?: string }) {
  const cls = "flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)] disabled:opacity-40";
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" title={label} aria-label={label} className={cls}>
      {children}
    </a>
  ) : (
    <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label} className={cls}>
      {children}
    </button>
  );
}

// Any open return, item-not-received request or payment dispute on the order, read when the strip shows.
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

const icon = (d: string) => (
  <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3 flex-shrink-0 opacity-70" aria-hidden>
    <path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ICONS = {
  clock: icon("M8 14A6 6 0 108 2a6 6 0 000 12zM8 5v3l2 1.5"),
  check: icon("M3.5 8.5l3 3 6-7"),
  truck: icon("M1.5 4h8v6.5h-8zM9.5 6.5H12l2.5 2.5v1.5h-5M4.5 13a1.2 1.2 0 100-2.4 1.2 1.2 0 000 2.4zM11.5 13a1.2 1.2 0 100-2.4 1.2 1.2 0 000 2.4z"),
  question: icon("M8 14A6 6 0 108 2a6 6 0 000 12zM6.5 6.3a1.6 1.6 0 113 .8c-.6.4-1.5.8-1.5 1.7M8 11h.01"),
};

function AboutStrip({ data }: { data: EbayThread }) {
  const item = data.context.item;
  const order = data.context.order;
  const connectionId = data.conversation.account.id;
  const cases = useOpenCases(connectionId, order?.orderId || null);
  if (!item) return null;
  // Each fact leads with its own small mark, so a line that wraps never starts on a stray separator.
  const facts: { key: string; icon?: ReactNode; text: ReactNode; mono?: boolean }[] = [];
  if (order) {
    if (order.total) facts.push({ key: "paid", text: money(order.total.amount, order.total.currency) });
    if (order.deliveredAt) facts.push({ key: "del", icon: ICONS.check, text: `Delivered ${shortDate(order.deliveredAt)}` });
    else if (order.shippedAt && order.estimatedDelivery) facts.push({ key: "due", icon: ICONS.clock, text: `Due ${order.estimatedDelivery.min ? `${shortDate(order.estimatedDelivery.min)}–` : ""}${shortDate(order.estimatedDelivery.max)}` });
    else if (!order.shippedAt && order.dispatchBy && order.status !== "cancelled") facts.push({ key: "by", icon: ICONS.clock, text: `Dispatch by ${shortDate(order.dispatchBy)}` });
    if (order.tracking[0]) facts.push({ key: "trk", icon: ICONS.truck, mono: true, text: `${order.tracking[0].carrier ? `${order.tracking[0].carrier} ` : ""}${order.tracking[0].number}` });
  } else {
    if (item.price) facts.push({ key: "price", text: money(item.price.amount, item.price.currency) });
    facts.push({ key: "asked", icon: ICONS.question, text: "Asked before buying" });
  }
  return (
    <div className="flex items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-panel)] px-5 py-2.5">
      {item.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.image} alt="" className="h-10 w-10 flex-shrink-0 rounded-lg object-cover ring-1 ring-black/5" />
      ) : (
        <span className="h-10 w-10 flex-shrink-0 rounded-lg bg-[var(--color-paper)]" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium leading-5 text-[var(--color-ink)]" title={item.title || undefined}>
          {item.title || `Item ${item.itemId}`}
        </p>
        <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] leading-5 text-[var(--color-muted)]">
          {order && (
            <>
              <a href={order.url} target="_blank" rel="noopener" className="font-mono text-[11.5px] text-[var(--color-primary)] hover:underline">
                {order.orderId}
              </a>
              <span className={`rounded-full px-2 text-[10.5px] font-semibold leading-[18px] ${STATUS_TONE[order.status] || STATUS_TONE.cancelled}`}>{order.statusLabel}</span>
            </>
          )}
          {cases?.map((c) => (
            <a key={c.key} href={`${order!.url}#cases`} target="_blank" rel="noopener" className="rounded-full bg-rose-50 px-2 text-[10.5px] font-semibold leading-[18px] text-rose-700 hover:bg-rose-100">
              {c.label}
              {c.respondBy ? ` · respond by ${shortDate(c.respondBy)}` : ""}
            </a>
          ))}
          {facts.map((f) => (
            <span key={f.key} className={`flex items-center gap-1 whitespace-nowrap ${f.mono ? "font-mono text-[11px]" : ""}`}>
              {f.icon}
              {f.text}
            </span>
          ))}
        </p>
      </div>
      <a href={order ? order.url : item.url || item.ebayUrl} target="_blank" rel="noopener" className="hidden flex-shrink-0 items-center gap-1 rounded-full border border-[var(--color-line)] px-3 py-1 text-[12px] font-medium text-[var(--color-ink)] transition-colors hover:border-[var(--color-primary)]/40 hover:text-[var(--color-primary)] sm:flex">
        {order ? "Open order" : "View listing"}
        <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" aria-hidden>
          <path d="M8 5h7v7M15 5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>
    </div>
  );
}

function Notice({ m }: { m: EbayMessage }) {
  return (
    <div className="mx-auto my-2 w-full max-w-[560px] px-5">
      <div className="rounded-2xl bg-[var(--color-panel)] p-4 shadow-[0_1px_2px_rgba(15,23,42,0.06),0_0_0_1px_rgba(15,23,42,0.04)]">
        <div className="flex items-start gap-2.5">
          <EbayMark size={26} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-5 text-[var(--color-ink)]">{m.subject || "Message from eBay"}</p>
            <p className="text-[11px] text-[var(--color-muted)]">{timeLabel(m.createdAt)}</p>
          </div>
        </div>
        {m.text && (
          <p className="mt-2.5 whitespace-pre-wrap break-words text-[12.5px] leading-[1.55] text-[var(--color-ink)]/90">
            <RichText text={m.text} />
          </p>
        )}
        {m.links.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {m.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="rounded-full border border-[var(--color-line)] px-3 py-1 text-[12px] font-medium text-[var(--color-ink)] hover:border-[var(--color-primary)]/40 hover:text-[var(--color-primary)]">
                {l.text}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Bubble({ m, buyer, first, last }: { m: EbayMessage; buyer: string | null; first: boolean; last: boolean }) {
  const mine = m.fromSeller;
  const photos = m.media.filter((x) => x.image);
  const files = m.media.filter((x) => !x.image);
  const corner = mine ? (last ? "rounded-[18px] rounded-br-md" : "rounded-[18px]") : last ? "rounded-[18px] rounded-bl-md" : "rounded-[18px]";
  return (
    <div className={`flex items-end gap-2 px-5 ${mine ? "flex-row-reverse" : ""} ${first ? "mt-3" : "mt-0.5"}`}>
      {!mine && (
        <span className="w-7 flex-shrink-0">
          {last && (
            <span className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: colorFor(buyer) }} aria-hidden>
              {initialOf(buyer)}
            </span>
          )}
        </span>
      )}
      <div className={`flex min-w-0 max-w-[min(460px,68%)] flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
        {m.text && (
          <div className={`${corner} px-3 py-[7px] text-[13px] leading-[1.45] ${mine ? "bg-[var(--color-primary)] text-white" : "bg-[var(--color-panel)] text-[var(--color-ink)] shadow-[0_1px_1px_rgba(15,23,42,0.06),0_0_0_1px_rgba(15,23,42,0.04)]"}`}>
            <span className="flex flex-wrap items-end justify-end gap-x-2">
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                <RichText text={m.text} onBrand={mine} />
              </span>
              <span className={`flex-shrink-0 translate-y-[2px] text-[10px] tabular-nums leading-none ${mine ? "text-white/70" : "text-[var(--color-muted)]"}`}>{timeLabel(m.createdAt)}</span>
            </span>
          </div>
        )}
        {photos.length > 0 && <PhotoStack align={mine ? "right" : "left"} size={200} photos={photos.map((p) => ({ src: p.url, name: p.name || "photo", download: p.url }))} />}
        {files.map((f) => (
          <a key={f.url} href={f.url} target="_blank" rel="noopener noreferrer" className="rounded-xl bg-[var(--color-panel)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-primary)] shadow-[0_0_0_1px_rgba(15,23,42,0.06)] hover:underline">
            {f.name || "Attachment"}
          </a>
        ))}
        {!m.text && (photos.length > 0 || files.length > 0) && <span className="px-1 text-[10px] text-[var(--color-muted)]">{timeLabel(m.createdAt)}</span>}
      </div>
    </div>
  );
}

export function EbayThreadView({
  data,
  loading,
  error,
  busy,
  onBack,
  onMarkUnread,
  onArchive,
  composer,
}: {
  data: EbayThread | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onBack?: () => void;
  onMarkUnread: () => void;
  onArchive: () => void;
  composer?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const conv = data?.conversation;
  const ebay = conv?.type === "FROM_EBAY";
  const count = data?.messages.length || 0;

  // Opened at the latest message; kept there as new ones arrive and photos load.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv?.conversationId, count]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const t = setTimeout(() => (el.scrollTop = el.scrollHeight), 400);
    return () => clearTimeout(t);
  }, [conv?.conversationId, count]);

  if (!data) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-paper)] p-8 text-center text-[13px] text-[var(--color-muted)]">
        {error ? error : loading ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-label="Loading" /> : null}
      </section>
    );
  }

  const messages = data.messages;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-paper)]">
      <header className="flex h-[58px] flex-shrink-0 items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-panel)] px-5">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back to conversations" className="-ml-2 flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] lg:hidden">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {ebay ? (
          <EbayMark size={34} />
        ) : (
          <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white" style={{ background: colorFor(conv?.otherParty) }} aria-hidden>
            {initialOf(conv?.otherParty)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold leading-5 text-[var(--color-ink)]">{ebay ? "eBay" : conv?.otherParty}</p>
          <p className="truncate text-[11.5px] leading-4 text-[var(--color-muted)]">{ebay ? "Messages from eBay" : `Buyer${conv?.account.label ? ` · ${conv.account.label}` : ""}`}</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          <IconButton label="Mark unread" onClick={onMarkUnread} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
              <path d="M20 12.5V17a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              <path d="M4.5 7.5L12 12.5l3.5-2.3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="19" cy="6" r="2.5" fill="currentColor" />
            </svg>
          </IconButton>
          <IconButton label={conv?.status === "ARCHIVE" ? "Move to inbox" : "Archive"} onClick={onArchive} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
              <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.7" />
              <path d="M5.5 9v9a1.5 1.5 0 001.5 1.5h10a1.5 1.5 0 001.5-1.5V9M10 13h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </IconButton>
          {data.context.item && (
            <IconButton label="The listing on eBay" href={data.context.item.ebayUrl}>
              <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
                <path d="M14 5h5v5M19 5l-8 8M18 14v4a1.5 1.5 0 01-1.5 1.5h-10A1.5 1.5 0 015 18V7.5A1.5 1.5 0 016.5 6H10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </IconButton>
          )}
        </div>
      </header>

      <AboutStrip key={`strip-${conv?.account.id}~${conv?.conversationId}`} data={data} />
      {data.stale && <div className="bg-amber-50 px-5 py-1.5 text-[11.5px] text-amber-800">Couldn&apos;t reach eBay just now: this is what Liston last read.</div>}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto pb-4 pt-1">
        {messages.length === 0 && <p className="px-6 py-10 text-center text-[12.5px] text-[var(--color-muted)]">{loading ? "Reading the conversation from eBay…" : "No messages in this conversation."}</p>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const day = new Date(m.createdAt).toDateString();
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== day;
          const joins = (a?: EbayMessage, b?: EbayMessage) =>
            Boolean(a && b && a.fromSeller === b.fromSeller && new Date(a.createdAt).toDateString() === new Date(b.createdAt).toDateString() && Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) < 5 * 60000);
          return (
            <div key={m.id}>
              {newDay && (
                <div className="flex justify-center pb-1 pt-4">
                  <span className="rounded-full bg-[var(--color-panel)] px-2.5 py-0.5 text-[10.5px] font-medium text-[var(--color-muted)] shadow-[0_0_0_1px_rgba(15,23,42,0.05)]">{dayLabel(m.createdAt)}</span>
                </div>
              )}
              {ebay ? <Notice m={m} /> : <Bubble m={m} buyer={conv?.otherParty || null} first={newDay || !joins(prev, m)} last={!joins(m, next)} />}
            </div>
          );
        })}
      </div>
      {composer}
    </section>
  );
}
