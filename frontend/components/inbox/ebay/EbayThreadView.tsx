"use client";

import { ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { EbayMessage, EbayThread } from "@/lib/api";
import { PhotoStack } from "../MessageFiles";
import { RichText } from "../MessageBubble";
import { colorFor, dayLabel, initialOf, money, timeLabel } from "../inbox-format";
import { EbayMark } from "./EbayConversationList";

// One eBay conversation: the item it's about at the top (its photo, title,
// and the order number or price, opening in a new tab), then the messages
// as a chat (the buyer on the left with their initial, yours on the right
// in the brand colour, a day line between days), eBay's own as notices
// with their links as buttons, photos as a stack that opens a viewer.

function Notice({ m }: { m: EbayMessage }) {
  return (
    <div className="mx-4 my-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-2.5">
        <EbayMark size={28} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-[var(--color-ink)]">{m.subject || "Message from eBay"}</p>
          <p className="text-[11px] text-[var(--color-muted)]">{timeLabel(m.createdAt)}</p>
        </div>
      </div>
      {m.text && (
        <p className="mt-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--color-ink)]">
          <RichText text={m.text} />
        </p>
      )}
      {m.links.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {m.links.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">
              {l.text}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Bubble({ m, buyer, first, last }: { m: EbayMessage; buyer: string | null; first: boolean; last: boolean }) {
  const mine = m.fromSeller;
  const photos = m.media.filter((x) => x.image);
  const files = m.media.filter((x) => !x.image);
  return (
    <div className={`flex gap-2 px-4 ${mine ? "flex-row-reverse" : ""} ${first ? "mt-3" : "mt-0.5"}`}>
      {!mine && (
        <div className="w-8 flex-shrink-0 self-end">
          {last && (
            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full text-[12px] font-semibold text-white" style={{ background: colorFor(buyer) }} aria-hidden>
              {initialOf(buyer)}
            </span>
          )}
        </div>
      )}
      <div className={`flex min-w-0 max-w-[min(560px,78%)] flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
        {m.text && (
          <div
            className={`rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed shadow-[0_1px_1px_rgba(15,23,42,0.04)] ${
              mine ? `bg-[var(--color-primary)] text-white ${last ? "rounded-br-md" : ""}` : `border border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-ink)] ${last ? "rounded-bl-md" : ""}`
            }`}
          >
            <span className="whitespace-pre-wrap break-words">
              <RichText text={m.text} onBrand={mine} />
            </span>
          </div>
        )}
        {photos.length > 0 && <PhotoStack align={mine ? "right" : "left"} photos={photos.map((p) => ({ src: p.url, name: p.name || "photo", download: p.url }))} />}
        {files.map((f) => (
          <a key={f.url} href={f.url} target="_blank" rel="noopener noreferrer" className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-[12.5px] font-medium text-[var(--color-primary)] hover:border-[var(--color-primary)]/50">
            {f.name || "Attachment"}
          </a>
        ))}
        {last && <p className="px-1 text-[10.5px] text-[var(--color-muted)]">{timeLabel(m.createdAt)}</p>}
      </div>
    </div>
  );
}

export function EbayThreadView({ data, loading, error, onBack, actions, composer }: { data: EbayThread | null; loading: boolean; error: string | null; onBack?: () => void; actions?: ReactNode; composer?: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const conv = data?.conversation;
  const ebay = conv?.type === "FROM_EBAY";
  const item = data?.context.item;
  const order = data?.context.order;

  // Opened at the latest message; kept there as new ones arrive.
  const count = data?.messages.length || 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv?.conversationId, count]);
  // Photos load after the first paint: stay at the bottom as they do.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const t = setTimeout(() => (el.scrollTop = el.scrollHeight), 400);
    return () => clearTimeout(t);
  }, [conv?.conversationId, count]);

  if (!data) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-paper)] p-8 text-center text-[13px] text-[var(--color-muted)]">
        {error ? error : loading ? <span className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-label="Loading" /> : null}
      </section>
    );
  }

  const messages = data.messages;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-paper)]">
      <header className="flex items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2.5">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back to conversations" className="-ml-1 flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] lg:hidden">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {ebay ? (
          <EbayMark size={36} />
        ) : (
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[14px] font-semibold text-white" style={{ background: colorFor(conv?.otherParty) }} aria-hidden>
            {initialOf(conv?.otherParty)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px] font-semibold text-[var(--color-ink)]">{ebay ? "eBay" : conv?.otherParty}</p>
          <p className="truncate text-[12px] text-[var(--color-muted)]">{ebay ? conv?.latestSubject || conv?.title || "Messages from eBay" : conv?.account.label ? `Buyer · ${conv.account.label}` : "Buyer"}</p>
        </div>
        {actions}
      </header>

      {item && (
        <div className="border-b border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2.5">
          <div className="flex items-center gap-3">
            {item.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.image} alt="" className="h-12 w-12 flex-shrink-0 rounded-lg border border-[var(--color-line)] object-cover" />
            ) : (
              <span className="h-12 w-12 flex-shrink-0 rounded-lg bg-[var(--color-paper)]" />
            )}
            <div className="min-w-0 flex-1">
              <a href={item.url || item.ebayUrl} target="_blank" rel="noopener" className="line-clamp-1 text-[13px] font-medium text-[var(--color-ink)] hover:text-[var(--color-primary)] hover:underline">
                {item.title || `Item ${item.itemId}`}
              </a>
              <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">
                {order ? (
                  <>
                    Order number{" "}
                    <a href={order.url} target="_blank" rel="noopener" className="font-medium text-[var(--color-primary)] underline underline-offset-2">
                      {order.orderId}
                    </a>
                    {" · "}
                    {order.statusLabel}
                  </>
                ) : item.price ? (
                  <>
                    {money(item.price.amount, item.price.currency)} · asked before buying · item {item.itemId}
                  </>
                ) : (
                  <>Item {item.itemId}</>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {data.stale && <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-[12px] text-amber-900">Couldn&apos;t read eBay just now, so this shows what Liston last read.</div>}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto pb-3">
        {messages.length === 0 && <p className="px-6 py-10 text-center text-[12.5px] text-[var(--color-muted)]">{loading ? "Reading the conversation from eBay…" : "No messages in this conversation."}</p>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const day = new Date(m.createdAt).toDateString();
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== day;
          const joins = (a?: EbayMessage, b?: EbayMessage) => Boolean(a && b && a.fromSeller === b.fromSeller && new Date(a.createdAt).toDateString() === new Date(b.createdAt).toDateString() && Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) < 5 * 60000);
          return (
            <div key={m.id}>
              {newDay && (
                <div className="flex items-center gap-3 px-6 py-3">
                  <span className="h-px flex-1 bg-[var(--color-line)]" />
                  <span className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-0.5 text-[11px] font-medium text-[var(--color-muted)]">{dayLabel(m.createdAt)}</span>
                  <span className="h-px flex-1 bg-[var(--color-line)]" />
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
