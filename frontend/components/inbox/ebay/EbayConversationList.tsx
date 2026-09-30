"use client";

import { EbayConversationRow, EbayInboxList } from "@/lib/api";
import { PillTabs } from "@/components/PillTabs";
import { useNow } from "@/lib/useMyEvents";
import { colorFor, initialOf, listTime, shortAgo } from "../inbox-format";

// The eBay Inbox's list, as WhatsApp's chat list: search at the top, tabs
// under it for the view (Unread with its count, Customers, From eBay), the
// archive as a row at the top of the list (a view of its own with a way
// back), then the conversations newest first: the item's photo with the
// buyer's initial on it, who, when, the item (with a mark for an open
// return, case or dispute, or a cancellation the buyer asked for), the last
// line (after a reply arrow, as eBay has it, when you had the last word),
// and what needs you: unread, or how long the buyer has been waiting.

export type EbayView = "buyers" | "unread" | "ebay" | "archived";

export function EbayMark({ size = 36, rounded = "rounded-full" }: { size?: number; rounded?: string }) {
  return (
    <span className={`flex flex-shrink-0 items-center justify-center bg-[var(--color-ink)] font-bold tracking-tight text-white ${rounded}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.3) }} aria-label="eBay">
      eBay
    </span>
  );
}

/** An open return, case or dispute on the buyer's order (rose), or a cancellation they asked for (amber). */
export function IssueBadge({ issue, className = "" }: { issue: NonNullable<EbayConversationRow["issue"]>; className?: string }) {
  const due = issue.respondBy ? new Date(issue.respondBy).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null;
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 text-[10px] font-semibold leading-4 ${issue.kind === "cancel" ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-600"} ${className}`}
      title={due ? `${issue.label}: respond by ${due}` : issue.label}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${issue.kind === "cancel" ? "bg-amber-500" : "bg-rose-500"}`} aria-hidden />
      {issue.label}
    </span>
  );
}

function Row({ c, active, showAccount, onOpen, now }: { c: EbayConversationRow; active: boolean; showAccount: boolean; onOpen: () => void; now: number }) {
  const ebay = c.type === "FROM_EBAY";
  const unread = c.unread > 0;
  // How long the buyer has waited for an answer (not for what's archived).
  const waitingMs = c.waitingSince && !ebay && c.status === "ACTIVE" ? now - new Date(c.waitingSince).getTime() : null;
  const subtitle = ebay ? c.latestSubject || c.title || "Message from eBay" : c.title || (c.referenceId ? `Item ${c.referenceId}` : "");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      className={`group flex w-full items-center gap-2.5 rounded-xl pl-2.5 text-left transition-colors ${active ? "bg-[var(--color-primary-soft)]" : "hover:bg-[var(--color-paper)]"}`}
    >
      {ebay ? (
        <EbayMark size={40} rounded="rounded-full" />
      ) : (
        <span className="relative h-10 w-10 flex-shrink-0">
          {c.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.image} alt="" loading="lazy" className="h-10 w-10 rounded-full object-cover ring-1 ring-black/5" />
          ) : (
            <span className="flex h-10 w-10 items-center justify-center rounded-full text-[14px] font-semibold text-white" style={{ background: colorFor(c.otherParty) }} aria-hidden>
              {initialOf(c.otherParty)}
            </span>
          )}
          {c.image && (
            <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[8.5px] font-bold text-white ring-2 ring-[var(--color-panel)]" style={{ background: colorFor(c.otherParty) }} aria-hidden>
              {initialOf(c.otherParty)}
            </span>
          )}
        </span>
      )}
      <span className={`min-w-0 flex-1 border-b py-[7px] pr-2.5 transition-colors ${active ? "border-transparent" : "border-[var(--color-line)]/60 group-hover:border-transparent"}`}>
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-[13.5px] leading-[18px] text-[var(--color-ink)] ${unread ? "font-semibold" : "font-medium"}`}>{ebay ? "eBay" : c.otherParty || "Member"}</span>
          {c.latestAt && <span className={`flex-shrink-0 text-[11px] tabular-nums ${unread ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`}>{listTime(c.latestAt)}</span>}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[11.5px] leading-4 text-[var(--color-muted)]/90">
            {showAccount && c.account.label ? <span className="font-medium text-[var(--color-ink)]/70">{c.account.label} · </span> : null}
            {subtitle}
          </span>
          {c.issue && <IssueBadge issue={c.issue} />}
        </span>
        <span className="flex items-center gap-2">
          <span className={`min-w-0 flex-1 truncate text-[12px] leading-[18px] ${unread ? "font-medium text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>
            {c.latestFromSeller && !ebay && (
              // Your last word, as eBay marks it: a reply arrow before it.
              <svg viewBox="0 0 16 16" fill="none" className="mr-1 inline-block h-3 w-3 -translate-y-px align-middle text-[var(--color-muted)]" role="img" aria-label="You:">
                <path d="M6 3.5L2.5 7 6 10.5M2.5 7h7a4 4 0 014 4v1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {c.latestPreview || ""}
          </span>
          {waitingMs !== null && !unread && (
            <span className={`flex-shrink-0 rounded-full px-1.5 text-[10px] font-semibold leading-4 tabular-nums ${waitingMs > 12 * 3600e3 ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-700"}`} title="Waiting for your answer">
              {shortAgo(c.waitingSince!, now)}
            </span>
          )}
          {unread && <span className="flex h-[18px] min-w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] px-1 text-[10.5px] font-semibold text-white">{c.unread > 9 ? "9+" : c.unread}</span>}
        </span>
      </span>
    </button>
  );
}

const archiveIcon = (
  <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
    <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.7" />
    <path d="M5.5 9v9a1.5 1.5 0 001.5 1.5h10a1.5 1.5 0 001.5-1.5V9M10 13h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

export function EbayConversationList({
  data,
  loading,
  loadingMore,
  activeKey,
  showAccount,
  emptyText,
  view,
  onView,
  q,
  onQ,
  onOpen,
  onMore,
}: {
  data: EbayInboxList | null;
  loading: boolean;
  loadingMore: boolean;
  activeKey: string | null;
  showAccount: boolean;
  emptyText: string;
  view: EbayView;
  onView: (v: EbayView) => void;
  q: string;
  onQ: (q: string) => void;
  onOpen: (c: EbayConversationRow) => void;
  onMore: () => void;
}) {
  const now = useNow();
  const rows = data?.conversations || [];
  const counts = data?.counts;
  const unreadAll = (counts?.buyers || 0) + (counts?.ebay || 0);
  const showArchiveRow = view === "buyers" && !q.trim() && (counts?.archived || 0) > 0;
  return (
    <aside className="flex min-h-0 w-full flex-col border-r border-[var(--color-line)] bg-[var(--color-panel)] lg:w-[300px] lg:flex-shrink-0">
      {view === "archived" ? (
        <div className="flex h-[60px] flex-shrink-0 items-center gap-2 px-2">
          <button type="button" onClick={() => onView("buyers")} aria-label="Back to conversations" className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
              <path d="M19 12H5m0 0l6-6m-6 6l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <p className="text-[15px] font-semibold text-[var(--color-ink)]">Archived</p>
        </div>
      ) : (
        <div className="flex-shrink-0 space-y-2 px-3 pb-2 pt-3">
          <label className="flex h-9 items-center gap-2.5 rounded-full bg-[var(--color-paper)] px-3.5 ring-1 ring-transparent transition-shadow focus-within:bg-[var(--color-panel)] focus-within:ring-[var(--color-primary)]/50">
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 flex-shrink-0 text-[var(--color-muted)]" aria-hidden>
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.9" />
              <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
            <input value={q} onChange={(e) => onQ(e.target.value)} placeholder="Search buyer, item or message" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--color-muted)]" aria-label="Search messages" />
            {q && (
              <button type="button" onClick={() => onQ("")} aria-label="Clear search" className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--color-muted)] hover:text-[var(--color-ink)]">
                <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                  <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </label>
          <PillTabs
            tabs={[
              { key: "unread" as const, label: "Unread", count: unreadAll || undefined, countTone: "alert" },
              { key: "buyers" as const, label: "Customers" },
              { key: "ebay" as const, label: "From eBay", count: counts?.ebay || undefined, countTone: "alert" },
            ]}
            value={view}
            onChange={onView}
            label="Show"
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {showArchiveRow && (
          <button type="button" onClick={() => onView("archived")} className="flex w-full items-center gap-2.5 rounded-xl py-2 pl-2.5 pr-2.5 text-left transition-colors hover:bg-[var(--color-paper)]">
            <span className="flex w-10 flex-shrink-0 justify-center text-[var(--color-primary)]">{archiveIcon}</span>
            <span className="flex-1 text-[13.5px] font-medium text-[var(--color-ink)]">Archived</span>
            <span className="text-[12px] tabular-nums text-[var(--color-muted)]">{counts?.archived}</span>
          </button>
        )}
        {loading && !data ? (
          <div className="space-y-1 p-1.5">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="flex items-center gap-3 px-1.5 py-2.5">
                <span className="h-10 w-10 animate-pulse rounded-full bg-[var(--color-paper)]" />
                <span className="flex-1 space-y-1.5">
                  <span className="block h-3 w-1/2 animate-pulse rounded bg-[var(--color-paper)]" />
                  <span className="block h-2.5 w-4/5 animate-pulse rounded bg-[var(--color-paper)]" />
                </span>
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full min-h-[200px] items-center justify-center p-8 text-center text-[12.5px] leading-relaxed text-[var(--color-muted)]">{emptyText}</div>
        ) : (
          <div className="flex flex-col">
            {rows.map((c) => (
              <Row key={`${c.account.id}:${c.conversationId}`} c={c} active={activeKey === `${c.account.id}~${c.conversationId}`} showAccount={showAccount} onOpen={() => onOpen(c)} now={now} />
            ))}
            {data?.hasMore && (
              <button type="button" onClick={onMore} disabled={loadingMore} className="mt-1 w-full rounded-xl px-4 py-3 text-[12.5px] font-medium text-[var(--color-primary)] hover:bg-[var(--color-paper)]">
                {loadingMore ? "Loading…" : "Older conversations"}
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
