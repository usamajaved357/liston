"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, EbayConversationRow, EbayFolder, EbayInboxList, EbayShow, EbayThread, ebayInboxApi } from "@/lib/api";
import { useMyEvents, useViewing } from "@/lib/useMyEvents";
import { EbayConversationList, EbayView } from "./EbayConversationList";
import { EbayThreadView } from "./EbayThreadView";
import { EbayComposer } from "./EbayComposer";
import { EbayDetails } from "./EbayDetails";
import { listTime } from "../inbox-format";

// The Inbox's eBay messages for one account (or every account the person
// may read), laid out like WhatsApp: the list (its own search and chips)
// beside the open conversation, whose order and listing open in a details
// panel when asked for. How fresh Liston's copy of eBay is sits in the
// page's header beside the bell (`syncSlot`) on an account's Inbox, or in a
// row above the panes with the mode switch on the Dashboard's. The list comes from
// what Liston keeps and is read again from eBay in the background (at once
// when opened if it's over a minute old, every minute while in view, and
// whenever Liston hears it changed); the open conversation follows.

const POLL_MS = 60 * 1000;
// Each view of the list, as the server's folder and filter.
const VIEWS: Record<EbayView, { folder: EbayFolder; show: EbayShow }> = {
  buyers: { folder: "buyers", show: "all" },
  unread: { folder: "all", show: "unread" },
  ebay: { folder: "ebay", show: "all" },
  archived: { folder: "archived", show: "all" },
};

function SyncStatus({ data, onRefresh, refreshing, reconnectHref }: { data: EbayInboxList | null; onRefresh: () => void; refreshing: boolean; reconnectHref: string | null }) {
  const sync = data?.sync;
  const busy = refreshing || sync?.syncing || (sync?.neverSynced && !sync?.error);
  let dot = "bg-emerald-500";
  let text: ReactNode = sync?.syncedAt ? `Synced ${listTime(sync.syncedAt)}` : "";
  if (sync?.error) {
    dot = "bg-rose-500";
    text = sync.error.scope ? (
      <>
        Reconnect needed{" "}
        {reconnectHref && (
          <a href={reconnectHref} className="font-semibold text-[var(--color-primary)] hover:underline">
            Reconnect
          </a>
        )}
      </>
    ) : (
      "Couldn't reach eBay"
    );
  } else if (busy) {
    dot = "bg-amber-400 animate-pulse";
    text = sync?.neverSynced ? "Reading your messages from eBay…" : "Checking eBay…";
  }
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-muted)]" title={sync?.error?.message || undefined}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      <span className="whitespace-nowrap">{text}</span>
      <button type="button" onClick={onRefresh} disabled={Boolean(busy)} title="Check eBay now" aria-label="Check eBay now" className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-[var(--color-panel)] hover:text-[var(--color-ink)] disabled:opacity-50">
        <svg viewBox="0 0 20 20" fill="none" className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden>
          <path d="M16 10a6 6 0 11-1.8-4.3M16 4v3.5h-3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </span>
  );
}

export function EbayInbox({
  connectionId,
  activeKey,
  onActiveChange,
  reconnectHref,
  modeSwitch = null,
  syncSlot = null,
}: {
  connectionId: string | null;
  activeKey: string | null;
  onActiveChange: (key: string | null) => void;
  reconnectHref: string | null;
  modeSwitch?: ReactNode;
  // Where in the page's header the sync state goes (an account's Inbox); without it, a row above the panes.
  syncSlot?: HTMLElement | null;
}) {
  const [view, setView] = useState<EbayView>("buyers");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<EbayInboxList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // The open conversation, kept with the key it's for (another one opening shows nothing stale).
  const [loaded, setLoaded] = useState<{ key: string; thread: EbayThread | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  // The details panel: hidden until asked for, closed again when another conversation opens.
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const detailsOpen = Boolean(activeKey) && detailsFor === activeKey;
  const listTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [accountId, conversationId] = activeKey ? (activeKey.split("~") as [string, string]) : [null, null];
  const current = loaded && loaded.key === activeKey ? loaded : null;
  const thread = current?.thread || null;
  const threadError = current?.error || null;
  const threadLoading = Boolean(activeKey) && !current;
  const { folder, show } = VIEWS[view];

  // Words typed settle before they're searched.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const loadList = useCallback(
    (opts: { refresh?: boolean } = {}) =>
      ebayInboxApi
        .list(connectionId, { folder, show, q: query, refresh: opts.refresh })
        .then((d) => setData(d))
        .catch(() => {})
        .finally(() => setLoading(false)),
    [connectionId, folder, show, query]
  );
  useEffect(() => {
    loadList();
  }, [loadList]);
  // The thread's read reloads the list without the thread depending on the list's filters.
  const loadListRef = useRef(loadList);
  useEffect(() => {
    loadListRef.current = loadList;
  }, [loadList]);

  const reloadList = useCallback(() => {
    if (listTimer.current) clearTimeout(listTimer.current);
    listTimer.current = setTimeout(() => loadList(), 400);
  }, [loadList]);

  // While a read runs (or until the first answer comes), look again every few seconds; else every minute while in view.
  const noAnswer = !data;
  useEffect(() => {
    const syncing = data?.sync.syncing || (data?.sync.neverSynced && !data.sync.error);
    const t = setInterval(() => document.visibilityState === "visible" && loadList(), syncing || noAnswer ? 3000 : POLL_MS);
    return () => clearInterval(t);
  }, [data?.sync.syncing, data?.sync.neverSynced, data?.sync.error, noAnswer, loadList]);

  const loadThread = useCallback(
    (quiet = false) => {
      if (!accountId || !conversationId) return;
      const key = `${accountId}~${conversationId}`;
      return ebayInboxApi
        .thread(accountId, conversationId)
        .then((t) => {
          setLoaded({ key, thread: t, error: null });
          // It's read now: its count goes from the row and the folder at once, and the server's figures follow.
          setData((d) => {
            const row = d?.conversations.find((c) => c.account.id === accountId && c.conversationId === conversationId);
            if (!d || !row?.unread) return d;
            const folderKey = row.type === "FROM_EBAY" ? "ebay" : "buyers";
            return {
              ...d,
              counts: { ...d.counts, [folderKey]: Math.max(0, (d.counts[folderKey] || 0) - 1) },
              conversations: d.conversations.map((c) => (c === row ? { ...c, unread: 0 } : c)),
            };
          });
          loadListRef.current();
        })
        .catch((err) => !quiet && setLoaded({ key, thread: null, error: err instanceof ApiError ? err.message : "Couldn't open this conversation." }));
    },
    [accountId, conversationId]
  );
  useEffect(() => {
    loadThread();
  }, [loadThread]);

  useViewing(accountId && conversationId ? `ebay:${accountId}:${conversationId}` : null);

  useMyEvents(
    (e) => {
      if (e.type !== "inbox.updated") return;
      if (connectionId && e.connectionId !== connectionId) return;
      reloadList();
      if (accountId && e.connectionId === accountId && (!e.conversationId || e.conversationId === conversationId)) loadThread(true);
    },
    () => reloadList()
  );

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await loadList();
    } catch (err) {
      if (activeKey) setLoaded((l) => ({ key: activeKey, thread: l?.key === activeKey ? l.thread : null, error: err instanceof ApiError ? err.message : "That didn't go through." }));
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    const last = data?.conversations[data.conversations.length - 1];
    if (!last?.latestAt) return;
    setLoadingMore(true);
    try {
      const more = await ebayInboxApi.list(connectionId, { folder, show, q: query, before: last.latestAt });
      setData((d) => d && { ...more, conversations: [...d.conversations, ...more.conversations.filter((c) => !d.conversations.some((x) => x.account.id === c.account.id && x.conversationId === c.conversationId))] });
    } finally {
      setLoadingMore(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    await loadList({ refresh: true });
    setTimeout(() => setRefreshing(false), 1500);
  }

  // The account's sidebar count follows the conversations as they're read here.
  const unreadNow = data ? data.counts.buyers + data.counts.ebay : null;
  useEffect(() => {
    if (connectionId && unreadNow !== null) window.dispatchEvent(new CustomEvent("liston:inbox-unread", { detail: { connectionId, unread: unreadNow } }));
  }, [connectionId, unreadNow]);

  const emptyText = query
    ? "Nothing matches your search."
    : data?.sync.neverSynced && !data.sync.error
      ? "Reading your conversations from eBay…"
      : { archived: "Nothing archived.", ebay: "No messages from eBay.", unread: "You're all caught up.", buyers: "No messages from customers yet." }[view];
  const conv = thread?.conversation;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {syncSlot && createPortal(<SyncStatus data={data} onRefresh={refresh} refreshing={refreshing} reconnectHref={reconnectHref} />, syncSlot)}
      {!syncSlot && (
        // On a phone an open conversation has the screen; its back arrow brings this row back.
        <div className={`${activeKey ? "hidden lg:flex" : "flex"} flex-wrap items-center justify-between gap-x-3 gap-y-2`}>
          {modeSwitch}
          <SyncStatus data={data} onRefresh={refresh} refreshing={refreshing} reconnectHref={reconnectHref} />
        </div>
      )}

      <div className="card relative flex min-h-0 flex-1 overflow-hidden">
        <div className={`${activeKey ? "hidden lg:flex" : "flex"} min-h-0 w-full lg:w-auto`}>
          <EbayConversationList
            data={data}
            loading={loading}
            loadingMore={loadingMore}
            activeKey={activeKey}
            showAccount={!connectionId}
            emptyText={emptyText}
            view={view}
            onView={(v) => {
              if (v === view) return;
              setView(v);
              setLoading(true);
            }}
            q={q}
            onQ={setQ}
            onOpen={(c: EbayConversationRow) => onActiveChange(`${c.account.id}~${c.conversationId}`)}
            onMore={loadMore}
          />
        </div>
        <div className={`${activeKey ? "flex" : "hidden lg:flex"} min-h-0 min-w-0 flex-1`}>
          {activeKey ? (
            <EbayThreadView
              data={thread}
              showAccount={!connectionId}
              loading={threadLoading}
              error={threadError}
              busy={busy}
              onBack={() => onActiveChange(null)}
              detailsOpen={detailsOpen}
              onToggleDetails={() => setDetailsFor(detailsOpen ? null : activeKey)}
              details={
                detailsOpen && thread && conv?.type === "FROM_MEMBERS" ? (
                  <EbayDetails key={`details-${activeKey}`} data={thread} onClose={() => setDetailsFor(null)} onOpenConversation={(id) => onActiveChange(`${conv.account.id}~${id}`)} />
                ) : null
              }
              onMarkUnread={() =>
                conv &&
                act(async () => {
                  await ebayInboxApi.setRead(conv.account.id, conv.conversationId, false);
                  onActiveChange(null);
                })
              }
              onArchive={() =>
                conv &&
                act(async () => {
                  await ebayInboxApi.setStatus(conv.account.id, conv.conversationId, conv.status === "ARCHIVE" ? "ACTIVE" : "ARCHIVE");
                  onActiveChange(null);
                })
              }
              composer={
                thread && conv && conv.type === "FROM_MEMBERS" ? (
                  <EbayComposer
                    key={`composer-${conv.account.id}~${conv.conversationId}`}
                    connectionId={conv.account.id}
                    conversationId={conv.conversationId}
                    buyer={conv.otherParty}
                    thread={thread}
                    onSent={(m) => {
                      setLoaded((l) => (l && l.thread ? { ...l, thread: { ...l.thread, messages: [...l.thread.messages.filter((x) => x.id !== m.id), m] } } : l));
                      reloadList();
                    }}
                  />
                ) : null
              }
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center bg-[var(--color-paper)] p-8 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-panel)] text-[var(--color-primary)] shadow-[0_0_0_1px_rgba(15,23,42,0.05)]">
                <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
                  <path d="M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v7a2.5 2.5 0 01-2.5 2.5H10l-4 4v-4A2 2 0 014 14V6.5z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                </svg>
              </span>
              <p className="mt-3 text-[14px] font-semibold text-[var(--color-ink)]">Pick a conversation</p>
              <p className="mt-1 max-w-xs text-[12.5px] leading-relaxed text-[var(--color-muted)]">Its order, tracking and listing are a click away in its details.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
