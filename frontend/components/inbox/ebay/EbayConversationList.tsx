"use client";

import { EbayConversationRow, EbayFolder, EbayInboxList, EbayShow } from "@/lib/api";
import { PillTabs } from "@/components/PillTabs";
import { useNow } from "@/lib/useMyEvents";
import { colorFor, initialOf, listTime, shortAgo } from "../inbox-format";

// The eBay Inbox's list: buyers and eBay kept apart (each with its unread
// count), the archive; all, unread, or the buyers waiting for an answer;
// found by buyer, item number or words. A row as eBay shows it (the item's
// photo with the buyer's initial on it, who, the item, the last line,
// when) with more: "You:" when you had the last word, how long a buyer's
// been waiting, and on every account together, which account.

export function EbayMark({ size = 36 }: { size?: number }) {
  return (
    <span className="flex flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-ink)] font-bold text-white" style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }} aria-label="eBay">
      eBay
    </span>
  );
}

function Row({ c, active, showAccount, onOpen, now }: { c: EbayConversationRow; active: boolean; showAccount: boolean; onOpen: () => void; now: number }) {
  const ebay = c.type === "FROM_EBAY";
  const unread = c.unread > 0;
  const waiting = c.waitingSince && !ebay;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-start gap-3 border-b border-[var(--color-line)] px-3 py-2.5 text-left transition-colors ${active ? "bg-[var(--color-primary-soft)]" : "hover:bg-[var(--color-paper)]"}`}
    >
      {ebay ? (
        <EbayMark size={44} />
      ) : (
        <span className="relative h-11 w-11 flex-shrink-0">
          {c.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.image} alt="" loading="lazy" className="h-11 w-11 rounded-lg border border-[var(--color-line)] object-cover" />
          ) : (
            <span className="block h-11 w-11 rounded-lg bg-[var(--color-paper)]" />
          )}
          <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-[var(--color-panel)] text-[10px] font-bold text-white" style={{ background: colorFor(c.otherParty) }} aria-hidden>
            {initialOf(c.otherParty)}
          </span>
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-[13px] ${unread ? "font-bold text-[var(--color-ink)]" : "font-semibold text-[var(--color-ink)]"}`}>{ebay ? "eBay" : c.otherParty || "Member"}</span>
          {c.latestAt && <span className={`flex-shrink-0 text-[11px] ${unread ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`}>{listTime(c.latestAt)}</span>}
        </span>
        <span className={`block truncate text-[12px] ${ebay && unread ? "font-semibold text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>{ebay ? c.latestSubject || c.title || "Message from eBay" : c.title || (c.referenceId ? `Item ${c.referenceId}` : "")}</span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className={`min-w-0 flex-1 truncate text-[12px] ${unread ? "text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>
            {c.latestFromSeller && !ebay && <span className="font-medium">You: </span>}
            {c.latestPreview || ""}
          </span>
          {unread && <span className="h-2 w-2 flex-shrink-0 rounded-full bg-[var(--color-primary)]" aria-label="Unread" />}
        </span>
        {(waiting || showAccount || c.assignee) && (
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            {waiting && (
              <span className={`inline-flex h-[18px] items-center rounded px-1.5 text-[10.5px] font-semibold ring-1 ring-inset ${now - new Date(c.waitingSince!).getTime() > 12 * 3600e3 ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-amber-50 text-amber-800 ring-amber-200"}`}>
                Waiting {shortAgo(c.waitingSince!, now)}
              </span>
            )}
            {showAccount && c.account.label && <span className="inline-flex h-[18px] items-center rounded bg-[var(--color-paper)] px-1.5 text-[10.5px] font-medium text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)]">{c.account.label}</span>}
            {c.assignee && <span className="inline-flex h-[18px] items-center rounded bg-[var(--color-primary-soft)] px-1.5 text-[10.5px] font-medium text-[var(--color-primary)]">{c.assignee.name}</span>}
          </span>
        )}
      </span>
    </button>
  );
}

export function EbayConversationList({
  data,
  folder,
  show,
  q,
  activeKey,
  showAccount,
  loading,
  loadingMore,
  onFolder,
  onShow,
  onQ,
  onOpen,
  onRefresh,
  onMore,
  reconnectHref,
}: {
  data: EbayInboxList | null;
  folder: EbayFolder;
  show: EbayShow;
  q: string;
  activeKey: string | null;
  showAccount: boolean;
  loading: boolean;
  loadingMore: boolean;
  onFolder: (f: EbayFolder) => void;
  onShow: (s: EbayShow) => void;
  onQ: (q: string) => void;
  onOpen: (c: EbayConversationRow) => void;
  onRefresh: () => void;
  onMore: () => void;
  reconnectHref: string | null;
}) {
  const sync = data?.sync;
  const rows = data?.conversations || [];
  const now = useNow();
  return (
    <aside className="flex min-h-0 w-full flex-col border-r border-[var(--color-line)] bg-[var(--color-panel)] lg:w-[360px] lg:flex-shrink-0">
      <div className="space-y-2 border-b border-[var(--color-line)] px-3 pb-2.5 pt-3">
        <PillTabs
          tabs={[
            { key: "buyers" as const, label: "Buyers", count: data?.counts.buyers || undefined, countTone: "alert" },
            { key: "ebay" as const, label: "eBay", count: data?.counts.ebay || undefined, countTone: "alert" },
            { key: "archived" as const, label: "Archived" },
          ]}
          value={folder}
          onChange={onFolder}
          label="Folders"
        />
        {folder === "buyers" && (
          <PillTabs
            tabs={[
              { key: "all" as const, label: "All" },
              { key: "unread" as const, label: "Unread" },
              { key: "waiting" as const, label: "Waiting for you", count: data?.counts.waiting || undefined, countTone: "alert" },
              { key: "mine" as const, label: "Assigned to me" },
            ]}
            value={show}
            onChange={onShow}
            label="Show"
            role="radiogroup"
          />
        )}
        <div className="flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-1.5 focus-within:border-[var(--color-primary)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 flex-shrink-0 text-[var(--color-muted)]" aria-hidden>
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input value={q} onChange={(e) => onQ(e.target.value)} placeholder="Buyer, item number or words" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--color-muted)]" aria-label="Search messages" />
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-paper)]/60 px-3 py-1.5 text-[11.5px] text-[var(--color-muted)]">
        {sync?.error ? (
          <span className="min-w-0 flex-1 truncate text-rose-700" title={sync.error.message}>
            {sync.error.scope ? "Reconnect this eBay account to read its messages." : "Couldn't read eBay just now."}{" "}
            {sync.error.scope && reconnectHref && (
              <a href={reconnectHref} className="font-semibold underline">
                Reconnect
              </a>
            )}
          </span>
        ) : sync?.syncing || (sync?.neverSynced && !rows.length) ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-hidden />
            {sync?.neverSynced ? "Reading every conversation from eBay…" : "Checking eBay for new messages…"}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">{sync?.syncedAt ? `Up to date with eBay · ${listTime(sync.syncedAt)}` : ""}</span>
        )}
        <button type="button" onClick={onRefresh} className="flex-shrink-0 font-medium text-[var(--color-primary)] hover:underline">
          Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !data ? (
          <div className="space-y-2 p-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-[var(--color-paper)]" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12.5px] text-[var(--color-muted)]">
            {q ? "Nothing matches." : sync?.neverSynced ? "Your conversations will show here in a moment." : folder === "archived" ? "Nothing archived." : show === "waiting" ? "Nobody's waiting for an answer." : show === "unread" ? "Nothing unread." : show === "mine" ? "Nothing assigned to you." : "No messages here yet."}
          </p>
        ) : (
          <>
            {rows.map((c) => (
              <Row key={`${c.account.id}:${c.conversationId}`} c={c} active={activeKey === `${c.account.id}~${c.conversationId}`} showAccount={showAccount} onOpen={() => onOpen(c)} now={now} />
            ))}
            {data?.hasMore && (
              <button type="button" onClick={onMore} disabled={loadingMore} className="w-full px-3 py-3 text-[12.5px] font-medium text-[var(--color-primary)] hover:bg-[var(--color-paper)]">
                {loadingMore ? "Loading…" : "Load older conversations"}
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
