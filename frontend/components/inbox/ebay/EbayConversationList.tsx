"use client";

import { EbayConversationRow, EbayInboxList } from "@/lib/api";
import { useNow } from "@/lib/useMyEvents";
import { colorFor, initialOf, listTime, shortAgo } from "../inbox-format";

// The eBay Inbox's list, and only the list (the folders, the filter and
// search sit in the page's toolbar): newest first, each row the item's
// photo with the buyer's initial on it, who, when, the item, the last line
// ("You:" when you had the last word), and what needs you: unread, or how
// long the buyer has been waiting.

export function EbayMark({ size = 36, rounded = "rounded-full" }: { size?: number; rounded?: string }) {
  return (
    <span className={`flex flex-shrink-0 items-center justify-center bg-[var(--color-ink)] font-bold tracking-tight text-white ${rounded}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.3) }} aria-label="eBay">
      eBay
    </span>
  );
}

function Row({ c, active, showAccount, onOpen, now }: { c: EbayConversationRow; active: boolean; showAccount: boolean; onOpen: () => void; now: number }) {
  const ebay = c.type === "FROM_EBAY";
  const unread = c.unread > 0;
  const waitingMs = c.waitingSince && !ebay ? now - new Date(c.waitingSince).getTime() : null;
  const subtitle = ebay ? c.latestSubject || c.title || "Message from eBay" : c.title || (c.referenceId ? `Item ${c.referenceId}` : "");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      className={`group relative flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${active ? "bg-[var(--color-primary-soft)]" : "hover:bg-[var(--color-paper)]"}`}
    >
      {active && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--color-primary)]" aria-hidden />}
      {ebay ? (
        <EbayMark size={42} rounded="rounded-xl" />
      ) : (
        <span className="relative h-[42px] w-[42px] flex-shrink-0">
          {c.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.image} alt="" loading="lazy" className="h-[42px] w-[42px] rounded-xl object-cover ring-1 ring-black/5" />
          ) : (
            <span className="flex h-[42px] w-[42px] items-center justify-center rounded-xl text-[15px] font-semibold text-white" style={{ background: colorFor(c.otherParty) }} aria-hidden>
              {initialOf(c.otherParty)}
            </span>
          )}
          {c.image && (
            <span className="absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full text-[9.5px] font-bold text-white ring-2 ring-[var(--color-panel)]" style={{ background: colorFor(c.otherParty) }} aria-hidden>
              {initialOf(c.otherParty)}
            </span>
          )}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-[13px] leading-5 text-[var(--color-ink)] ${unread ? "font-semibold" : "font-medium"}`}>{ebay ? "eBay" : c.otherParty || "Member"}</span>
          {c.latestAt && <span className={`flex-shrink-0 text-[11px] tabular-nums ${unread ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`}>{listTime(c.latestAt)}</span>}
        </span>
        <span className="block truncate text-[11.5px] leading-4 text-[var(--color-muted)]">
          {showAccount && c.account.label ? <span className="font-medium text-[var(--color-ink)]/70">{c.account.label} · </span> : null}
          {subtitle}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={`min-w-0 flex-1 truncate text-[12px] leading-[18px] ${unread ? "text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>
            {c.latestFromSeller && !ebay && <span className="text-[var(--color-muted)]">You: </span>}
            {c.latestPreview || ""}
          </span>
          {waitingMs !== null && !unread && (
            <span className={`flex-shrink-0 rounded-full px-1.5 text-[10.5px] font-semibold leading-[18px] tabular-nums ${waitingMs > 12 * 3600e3 ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-700"}`} title="Waiting for your answer">
              {shortAgo(c.waitingSince!, now)}
            </span>
          )}
          {unread && <span className="flex h-[18px] min-w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] px-1.5 text-[10.5px] font-semibold text-white">{c.unread > 9 ? "9+" : c.unread}</span>}
        </span>
      </span>
    </button>
  );
}

export function EbayConversationList({
  data,
  loading,
  loadingMore,
  activeKey,
  showAccount,
  emptyText,
  onOpen,
  onMore,
}: {
  data: EbayInboxList | null;
  loading: boolean;
  loadingMore: boolean;
  activeKey: string | null;
  showAccount: boolean;
  emptyText: string;
  onOpen: (c: EbayConversationRow) => void;
  onMore: () => void;
}) {
  const now = useNow();
  const rows = data?.conversations || [];
  return (
    <aside className="flex min-h-0 w-full flex-col border-r border-[var(--color-line)] bg-[var(--color-panel)] lg:w-[340px] lg:flex-shrink-0">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !data ? (
          <div className="space-y-1 p-2">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-2.5">
                <span className="h-[42px] w-[42px] animate-pulse rounded-xl bg-[var(--color-paper)]" />
                <span className="flex-1 space-y-1.5">
                  <span className="block h-3 w-1/2 animate-pulse rounded bg-[var(--color-paper)]" />
                  <span className="block h-2.5 w-4/5 animate-pulse rounded bg-[var(--color-paper)]" />
                </span>
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-center text-[12.5px] leading-relaxed text-[var(--color-muted)]">{emptyText}</div>
        ) : (
          <div className="divide-y divide-[var(--color-line)]/70">
            {rows.map((c) => (
              <Row key={`${c.account.id}:${c.conversationId}`} c={c} active={activeKey === `${c.account.id}~${c.conversationId}`} showAccount={showAccount} onOpen={() => onOpen(c)} now={now} />
            ))}
            {data?.hasMore && (
              <button type="button" onClick={onMore} disabled={loadingMore} className="w-full px-4 py-3 text-[12px] font-medium text-[var(--color-primary)] hover:bg-[var(--color-paper)]">
                {loadingMore ? "Loading…" : "Older conversations"}
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
