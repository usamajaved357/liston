"use client";

import { EbayConversationRow, EbayInboxList } from "@/lib/api";
import { PillTabs } from "@/components/PillTabs";
import { useNow } from "@/lib/useMyEvents";
import { useQuietScrollbar } from "@/lib/useQuietScrollbar";
import { colorFor, initialOf, listTime, shortAgo } from "../inbox-format";
import { PersonDot } from "./EbayWork";

// The eBay Inbox's list, as WhatsApp's chat list: search at the top, tabs
// under it for the view (Unread with its count, Customers, From eBay), the
// archive as a row at the top of the list (a view of its own with a way
// back), then the conversations newest first: the item's photo with the
// buyer's initial on it, who, when, the item (with a mark for an open
// return, case or dispute, or a cancellation the buyer asked for), the last
// line (after a reply arrow, as eBay has it, when you had the last word),
// and what needs you: unread, or how long the buyer has been waiting.

export type EbayView = "buyers" | "unread" | "ebay" | "archived";

/** eBay's wordmark in its own colours (its 2023 logo). */
export function EbayLogo({ width, className = "" }: { width: number; className?: string }) {
  return (
    <svg viewBox="0 0 1000 400.751" width={width} height={(width * 400.75) / 1000} className={className} role="img" aria-label="eBay">
      <path fill="#f12c2d" d="m 199.63633,185.86602 c -1.94427,-46.87735 -35.77951,-64.41973 -71.94139,-64.41973 -38.99421,0 -70.12667,19.7327 -75.58026,64.41973 z M 51.034408,219.1909 c 2.704332,45.48365 34.069782,72.38437 77.197532,72.38437 29.88033,0 56.45979,-12.17498 65.35948,-38.66041 h 51.68424 c -10.05205,53.73979 -67.15384,71.98058 -116.303,71.98058 C 39.606424,324.89544 0,275.67889 0,209.30653 0,136.24203 40.965642,88.12194 129.78809,88.12194 c 70.69867,0 122.49992,36.99926 122.49992,117.75572 v 13.31324 z" />
      <path fill="#0968f6" d="m 380.83181,290.6235 c 46.57228,0 78.44078,-33.52181 78.44078,-84.10854 0,-50.58203 -31.8685,-84.10854 -78.44078,-84.10854 -46.31058,0 -78.44392,33.52651 -78.44392,84.10854 0,50.58673 32.13334,84.10854 78.44392,84.10854 z M 252.2854,0 h 50.10249 l -0.005,125.87707 c 24.55682,-29.25975 58.38892,-37.75513 91.68976,-37.75513 55.83503,0 117.85132,37.6773 117.85132,119.02875 0,68.12232 -49.32155,117.74475 -118.78114,117.74475 -36.35726,0 -70.58062,-13.04265 -91.68663,-38.88294 0,10.32107 -0.57618,20.72364 -1.70503,30.56413 h -49.17162 c 0.85513,-15.90944 1.70555,-35.7184 1.70555,-51.74693 z" />
      <path fill="#ffbc13" d="m 633.07803,212.53323 c -45.43873,1.48929 -73.6715,9.689 -73.6715,39.61897 0,19.37591 15.44713,40.38162 54.66334,40.38162 52.57698,0 80.64259,-28.65902 80.64259,-75.66331 l 0.003,-5.16994 c -18.43302,0 -41.16414,0.16089 -61.63704,0.83266 z m 111.75103,62.10248 c 0,14.58313 0.42155,28.9782 1.69406,41.94092 h -46.61408 c -1.24325,-10.67368 -1.6972,-21.27945 -1.6972,-31.56656 -25.20195,30.97941 -55.17735,39.88537 -96.76149,39.88537 -61.67674,0 -94.70072,-32.59982 -94.70072,-70.30689 0,-54.61215 44.91583,-73.86739 122.89013,-75.65391 21.32332,-0.48686 45.27419,-0.55894 65.07531,-0.55894 l -0.003,-5.33606 c 0,-36.56098 -23.44364,-51.59335 -64.06765,-51.59335 -30.15876,0 -52.38579,12.48057 -54.6764,34.0468 h -52.65168 c 5.57217,-53.77165 62.06643,-67.37115 111.74005,-67.37115 59.50837,0 109.77228,21.17288 109.77228,84.11481 z" />
      <path fill="#93c822" d="M 1000,96.45747 845.05541,400.75099 H 788.94926 L 833.49578,316.25589 716.89033,96.45747 h 58.6266 l 85.80469,171.73057 85.56283,-171.73057 z" />
    </svg>
  );
}

/** Who eBay's own messages are from: its wordmark on a white disc, where a buyer has their initial. */
export function EbayMark({ size = 36, rounded = "rounded-full" }: { size?: number; rounded?: string }) {
  return (
    <span className={`flex flex-shrink-0 items-center justify-center bg-white ring-1 ring-inset ring-[var(--color-line)] ${rounded}`} style={{ width: size, height: size }} title="eBay">
      <EbayLogo width={Math.round(size * 0.72)} className="translate-y-[6%]" />
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
  const waitingMs = c.waitingSince && !ebay && c.status === "ACTIVE" && c.workStatus !== "done" ? now - new Date(c.waitingSince).getTime() : null;
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
          {!ebay && c.workStatus === "done" && (
            <span className="flex-shrink-0 text-emerald-600" title="Done">
              <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" role="img" aria-label="Done">
                <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
                <path d="M5.3 8.2l1.8 1.8 3.6-3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          )}
          {!ebay && c.workStatus === "waiting" && (
            <span className="flex-shrink-0 text-amber-600" title="Waiting on the buyer, a supplier or eBay">
              <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" role="img" aria-label="Waiting">
                <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
                <path d="M8 4.8V8l2.2 1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </span>
          )}
          {!ebay && c.assignee && (
            <span title={`${c.assignee.name} has this conversation`}>
              <PersonDot person={c.assignee} size={16} />
            </span>
          )}
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
  const quietScroll = useQuietScrollbar<HTMLDivElement>();
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
      <div ref={quietScroll} className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
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
