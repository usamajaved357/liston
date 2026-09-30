"use client";

import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { EbayMessage, EbayThread } from "@/lib/api";
import { FileRow, PhotoGrid } from "../MessageFiles";
import { RichText } from "../MessageBubble";
import { BUBBLE_MAX, Bubble, BubbleRow, BubbleText, DayChip, LatestButton, MenuItem, Meta, PopMenu } from "../ChatBubble";
import { colorFor, dayLabel, initialOf, timeLabel } from "../inbox-format";
import { useQuietScrollbar } from "@/lib/useQuietScrollbar";
import { EbayMark, IssueBadge } from "./EbayConversationList";
import { NoticeCard } from "./EbayNotice";

// One eBay conversation, as WhatsApp shows a chat: a slim header (who,
// and what it's about: a tag for an order, a listing or neither, then the
// item; with a mark for an open return, case or dispute or a
// cancellation the buyer asked for that opens the order's page there; its name or the details button opens the order and
// listing beside it; "…" holds mark unread and archive), then the messages
// on the chat wallpaper, the day in a chip that stays at the top while its
// messages scroll by: the buyer's white on the left, yours tinted on the
// right, each run of one person's messages with a tail on its first, the
// time in each bubble's corner (8px between them, 16px before the other
// side's), photos as an album inside the bubble.
// eBay's own messages are drawn as eBay designs them (EbayNotice): the
// conversation opens at the top of the latest, older ones folded to a line
// above it; a notice with no layout of its own is a bubble, its links as
// buttons along the bottom. In a buyer's conversation a round button takes
// you back to the latest once you scroll up.

const RUN_MS = 5 * 60 * 1000;

// Where a conversation opens: a buyer's at its last message, eBay's with its latest notice's top just under the day chip.
function toLatest(el: HTMLElement, ebay: boolean) {
  const notice = ebay ? el.querySelector<HTMLElement>("[data-latest-notice]") : null;
  if (!notice) {
    el.scrollTop = el.scrollHeight;
    return;
  }
  el.scrollTop = Math.max(0, notice.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 48);
}

function HeaderButton({ label, onClick, active = false, children }: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${active ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]" : "text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"}`}
    >
      {children}
    </button>
  );
}

// What a buyer's conversation is about, as a small tag before the header's
// second line: an order (the buyer bought the item it's about), a listing (a
// question about an item they haven't bought, or whose orders this member
// can't see), or neither (General).
type Topic = { kind: "order" | "listing" | "general"; label: string; hint: string };

function topicOf(data: EbayThread): Topic {
  const { item, order, ordersHidden } = data.context;
  if (order) return { kind: "order", label: "Order", hint: `About order ${order.orderId} (${order.statusLabel})` };
  if (item) return { kind: "listing", label: "Listing", hint: ordersHidden ? "About this listing" : "A question about this listing: no order from this buyer for it" };
  return { kind: "general", label: "General", hint: "Not about a listing or an order" };
}

const TOPIC_STYLE: Record<Topic["kind"], string> = {
  order: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]",
  listing: "bg-sky-50 text-sky-700",
  general: "bg-slate-100 text-slate-600",
};

const TOPIC_ICON: Record<Topic["kind"], ReactNode> = {
  // a parcel
  order: <path d="M2.5 5 8 2.5 13.5 5v6L8 13.5 2.5 11zM2.5 5 8 7.5 13.5 5M8 7.5v6" />,
  // a price tag
  listing: <path d="M2.5 8.2V3.3a.8.8 0 0 1 .8-.8h4.9l5.3 5.3a.8.8 0 0 1 0 1.1l-4.8 4.8a.8.8 0 0 1-1.1 0zM5.4 5.4h.01" />,
  // a speech bubble
  general: <path d="M3 3.5h10a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5H7l-3 2.5v-2.5H3a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z" />,
};

function TopicTag({ topic }: { topic: Topic }) {
  return (
    <span className={`inline-flex h-4 flex-shrink-0 items-center gap-1 rounded-[4px] pl-1 pr-1.5 text-[10.5px] font-semibold leading-none ${TOPIC_STYLE[topic.kind]}`} title={topic.hint}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-[11px] w-[11px]" aria-hidden>
        {TOPIC_ICON[topic.kind]}
      </svg>
      {topic.label}
    </span>
  );
}

function Notice({ m, first, latest }: { m: EbayMessage; first: boolean; latest: boolean }) {
  return (
    <BubbleRow mine={false} first={first} roomy data-latest-notice={latest || undefined}>
      <div className="flex min-w-0 max-w-[92%] flex-col sm:max-w-[min(80%,540px)]">
        <Bubble mine={false} tail={first} sharp>
          {m.subject && <p className="px-[9px] pt-[7px] text-[13.5px] font-semibold leading-[19px] text-[var(--color-ink)]">{m.subject}</p>}
          <BubbleText meta={<span>{timeLabel(m.createdAt)}</span>} className="text-[var(--color-ink)]/90">
            {m.text ? <RichText text={m.text.trimEnd()} /> : null}
          </BubbleText>
          {m.links.length > 0 && (
            <div className="border-t border-black/[0.07]">
              {m.links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-1.5 border-t border-black/[0.07] px-3 py-2.5 text-[13px] font-medium text-[var(--color-primary)] transition-colors first:border-t-0 hover:bg-black/[0.03]">
                  {l.text}
                  <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                    <path d="M8 5h7v7M15 5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </a>
              ))}
            </div>
          )}
        </Bubble>
      </div>
    </BubbleRow>
  );
}

function Message({ m, first }: { m: EbayMessage; first: boolean }) {
  const mine = m.fromSeller;
  const photos = m.media.filter((x) => x.image);
  const files = m.media.filter((x) => !x.image);
  const text = m.text.trimEnd();
  const meta = <span>{timeLabel(m.createdAt)}</span>;
  return (
    <BubbleRow mine={mine} first={first} roomy>
      <div className={`flex min-w-0 flex-col ${BUBBLE_MAX} ${mine ? "items-end" : "items-start"}`}>
        <Bubble mine={mine} tail={first} sharp>
          {photos.length > 0 && (
            <div className="p-[3px]">
              <PhotoGrid photos={photos.map((p) => ({ src: p.url, name: p.name || "photo", download: p.url }))} overlay={!text && !files.length ? <Meta onPhoto>{meta}</Meta> : undefined} />
            </div>
          )}
          {files.length > 0 && (
            <div className="flex flex-col gap-[3px] p-[3px]">
              {files.map((f) => (
                <FileRow key={f.url} file={{ url: f.url, name: f.name || "Attachment", mime: f.type === "PDF" ? "application/pdf" : f.type || "" }} />
              ))}
            </div>
          )}
          {text ? (
            <BubbleText meta={meta}>
              <RichText text={text} />
            </BubbleText>
          ) : photos.length && !files.length ? null : (
            <div className="flex justify-end px-[8px] pb-[5px] pt-0.5">
              <Meta>{meta}</Meta>
            </div>
          )}
        </Bubble>
      </div>
    </BubbleRow>
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
  detailsOpen,
  onToggleDetails,
  details,
  composer,
  showAccount = true,
}: {
  data: EbayThread | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onBack?: () => void;
  onMarkUnread: () => void;
  onArchive: () => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  // The details panel, drawn beside the chat (or over it on a smaller screen).
  details?: ReactNode;
  composer?: ReactNode;
  // Every account together: which account the conversation is with.
  showAccount?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // Its scrollbar shows only while someone is scrolling.
  const scrollerRef = useQuietScrollbar(scroller);
  // The "…" menu's button while it's open.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  // eBay's notices opened or folded here (by default only the latest is open).
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const conv = data?.conversation;
  const ebay = conv?.type === "FROM_EBAY";
  const count = data?.messages.length || 0;

  // Opened at the latest message (eBay's: at the top of its latest notice, to read down from its headline); kept there as new ones arrive and photos load.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) toLatest(el, ebay);
  }, [conv?.conversationId, count, ebay]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const t = setTimeout(() => toLatest(el, ebay), 400);
    return () => clearTimeout(t);
  }, [conv?.conversationId, count, ebay]);
  // At the latest, a buyer's conversation stays there when the pane changes size (the window, the details panel).
  const away = useRef(false);
  useEffect(() => {
    away.current = awayFromLatest;
  }, [awayFromLatest]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || ebay || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      if (!away.current) el.scrollTop = el.scrollHeight;
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [conv?.conversationId, ebay]);

  if (!data) {
    return (
      <section className="chat-wallpaper flex min-h-0 flex-1 items-center justify-center p-8 text-center text-[13px] text-[var(--color-muted)]">
        {error ? error : loading ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-label="Loading" /> : null}
      </section>
    );
  }

  const messages = data.messages;
  const item = data.context.item;
  const account = showAccount ? conv?.account.label : null;
  // The header's second line: a tag for what it's about (an order, a listing, neither), then the item.
  const topic = ebay ? null : topicOf(data);
  const about = ebay ? "Messages from eBay" : `${account ? `${account} · ` : ""}${item?.title || conv?.title || "Buyer"}`;
  const menu: MenuItem[] = [
    ...(!ebay ? [{ label: detailsOpen ? "Hide details" : "Details", onSelect: onToggleDetails }] : []),
    { label: "Mark as unread", onSelect: onMarkUnread },
    { label: conv?.status === "ARCHIVE" ? "Move back to the inbox" : "Archive", onSelect: onArchive },
  ];

  // Messages by day: each day's chip stays at the top while its messages scroll under it.
  const days: { key: string; label: string; items: EbayMessage[] }[] = [];
  for (const m of messages) {
    const key = new Date(m.createdAt).toDateString();
    if (days[days.length - 1]?.key !== key) days.push({ key, label: dayLabel(m.createdAt), items: [] });
    days[days.length - 1].items.push(m);
  }
  const latestId = messages[messages.length - 1]?.id;
  const joins = (a: EbayMessage | undefined, b: EbayMessage) => Boolean(a && a.fromSeller === b.fromSeller && Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) < RUN_MS);

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-[60px] flex-shrink-0 items-center gap-1 border-b border-[var(--color-line)] bg-[var(--color-panel)] pl-2 pr-2 sm:pl-4">
          {onBack && (
            <button type="button" onClick={onBack} aria-label="Back to conversations" className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] lg:hidden">
              <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          <button type="button" onClick={ebay ? undefined : onToggleDetails} disabled={ebay} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-1 pr-2 text-left disabled:cursor-default" title={ebay ? undefined : "Order and listing details"}>
            {ebay ? (
              <EbayMark size={38} />
            ) : (
              <span className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-full text-[14px] font-semibold text-white" style={{ background: colorFor(conv?.otherParty) }} aria-hidden>
                {initialOf(conv?.otherParty)}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14.5px] font-semibold leading-5 text-[var(--color-ink)]">{ebay ? "eBay" : conv?.otherParty}</span>
              <span className="mt-px flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-[var(--color-muted)]">
                {topic && <TopicTag topic={topic} />}
                <span className="truncate">{about}</span>
              </span>
            </span>
          </button>
          {conv?.issue && (
            // An open return, case or dispute, or a cancellation the buyer asked for: handled on the order's page, opened at that part.
            <a
              href={conv.issue.orderId ? `/accounts/${conv.account.id}/orders/${encodeURIComponent(conv.issue.orderId)}#${conv.issue.kind === "cancel" ? "cancel-request" : "cases"}` : data.context.order?.url || "#"}
              target="_blank"
              rel="noopener"
              className="mr-1 hidden flex-shrink-0 transition-opacity hover:opacity-80 sm:inline-flex"
              title="Open on the order's page to answer it"
            >
              <IssueBadge issue={conv.issue} className="!px-2 !py-0.5 !text-[11px]" />
            </a>
          )}
          {!ebay && (
            <HeaderButton label={detailsOpen ? "Hide details" : "Order and listing details"} onClick={onToggleDetails} active={detailsOpen}>
              <svg viewBox="0 0 24 24" fill="none" className="h-[19px] w-[19px]" aria-hidden>
                <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
                <path d="M14.5 4.5v15" stroke="currentColor" strokeWidth="1.7" />
                <path d="M6.5 9h5M6.5 12h5M6.5 15h3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </HeaderButton>
          )}
          <HeaderButton label="More" onClick={(e) => setMenuAnchor(menuAnchor ? null : e.currentTarget)} active={Boolean(menuAnchor)}>
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
              <circle cx="5.5" cy="12" r="1.7" fill="currentColor" />
              <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              <circle cx="18.5" cy="12" r="1.7" fill="currentColor" />
            </svg>
          </HeaderButton>
          {menuAnchor && !busy && <PopMenu anchor={menuAnchor} items={menu} onClose={() => setMenuAnchor(null)} />}
        </header>

        {data.stale && <div className="bg-amber-50 px-5 py-1.5 text-[11.5px] text-amber-800">Couldn&apos;t reach eBay just now: this is what Liston last read.</div>}

        <div className="chat-wallpaper relative min-h-0 flex-1">
          <div
            ref={scrollerRef}
            className="scroll-quiet h-full overflow-y-auto pb-3"
            onScroll={(e) => {
              const el = e.currentTarget;
              const away = el.scrollHeight - el.scrollTop - el.clientHeight > 160;
              if (away !== awayFromLatest) setAwayFromLatest(away);
            }}
          >
            {messages.length === 0 && <p className="px-6 py-10 text-center text-[12.5px] text-[var(--color-muted)]">{loading ? "Reading the conversation from eBay…" : "No messages in this conversation."}</p>}
            {days.map((day) => (
              <div key={day.key} className="pb-1">
                <DayChip label={day.label} sticky />
                {day.items.map((m, i) => {
                  const first = !joins(day.items[i - 1], m);
                  if (!ebay) return <Message key={m.id} m={m} first={first} />;
                  const latest = m.id === latestId;
                  if (!m.html) return <Notice key={m.id} m={m} first={first} latest={latest} />;
                  const open = opened[m.id] ?? latest;
                  return <NoticeCard key={m.id} m={{ ...m, html: m.html }} open={open} latest={latest} onToggle={() => setOpened((was) => ({ ...was, [m.id]: !open }))} />;
                })}
              </div>
            ))}
          </div>
          {awayFromLatest && !ebay && <LatestButton onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" })} />}
        </div>
        {composer}
      </div>
      {details}
    </section>
  );
}
