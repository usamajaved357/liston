"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, EbayConversationRow, EbayFolder, EbayInboxList, EbayShow, EbayThread, ebayInboxApi } from "@/lib/api";
import { useMyEvents, useViewing } from "@/lib/useMyEvents";
import { PillTabs } from "@/components/PillTabs";
import { ViewMenu } from "@/components/ViewMenu";
import { EbayConversationList } from "./EbayConversationList";
import { EbayThreadView } from "./EbayThreadView";
import { EbayComposer } from "./EbayComposer";
import { listTime } from "../inbox-format";

// The Inbox's eBay messages for one account (or every account the person
// may read). The page's toolbar holds the controls (the mode, the folders,
// one Show menu, search, and how fresh the copy of eBay is), so the panes
// below are just the conversations and the open one. The list comes from
// what Liston keeps and is read again from eBay in the background (at once
// when opened if it's over a minute old, every minute while in view, and
// whenever Liston hears it changed); the open conversation follows.

const POLL_MS = 60 * 1000;

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

export function EbayInbox({ connectionId, activeKey, onActiveChange, reconnectHref, modeSwitch }: { connectionId: string | null; activeKey: string | null; onActiveChange: (key: string | null) => void; reconnectHref: string | null; modeSwitch: ReactNode }) {
  const [folder, setFolder] = useState<EbayFolder>("buyers");
  const [show, setShow] = useState<EbayShow>("all");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<EbayInboxList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // The open conversation, kept with the key it's for (another one opening shows nothing stale).
  const [loaded, setLoaded] = useState<{ key: string; thread: EbayThread | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const listTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [accountId, conversationId] = activeKey ? (activeKey.split("~") as [string, string]) : [null, null];
  const current = loaded && loaded.key === activeKey ? loaded : null;
  const thread = current?.thread || null;
  const threadError = current?.error || null;
  const threadLoading = Boolean(activeKey) && !current;
  const effectiveShow: EbayShow = folder === "buyers" ? show : "all";

  // Words typed settle before they're searched.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const loadList = useCallback(
    (opts: { refresh?: boolean } = {}) =>
      ebayInboxApi
        .list(connectionId, { folder, show: effectiveShow, q: query, refresh: opts.refresh })
        .then((d) => setData(d))
        .catch(() => {})
        .finally(() => setLoading(false)),
    [connectionId, folder, effectiveShow, query]
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
      const more = await ebayInboxApi.list(connectionId, { folder, show: effectiveShow, q: query, before: last.latestAt });
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

  const counts = data?.counts;
  const emptyText = query
    ? "Nothing matches your search."
    : data?.sync.neverSynced && !data.sync.error
      ? "Reading your conversations from eBay…"
      : folder === "archived"
        ? "Nothing archived."
        : folder === "ebay"
          ? "No messages from eBay."
          : effectiveShow === "waiting"
            ? "Nobody's waiting for an answer."
            : effectiveShow === "unread"
              ? "You're all caught up."
              : effectiveShow === "mine"
                ? "Nothing assigned to you."
                : "No buyer messages yet.";
  const conv = thread?.conversation;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* On a phone an open conversation has the screen; its back arrow brings the toolbar back. */}
      <div className={`${activeKey ? "hidden lg:flex" : "flex"} flex-wrap items-center gap-x-3 gap-y-2`}>
        {modeSwitch}
        <span className="hidden h-5 w-px bg-[var(--color-line)] sm:block" aria-hidden />
        <PillTabs
          tabs={[
            { key: "buyers" as const, label: "Buyers", count: counts?.buyers || undefined, countTone: "alert" },
            { key: "ebay" as const, label: "From eBay", count: counts?.ebay || undefined, countTone: "alert" },
            { key: "archived" as const, label: "Archived" },
          ]}
          value={folder}
          onChange={(f) => {
            setFolder(f);
            setLoading(true);
          }}
          label="Folders"
        />
        {folder === "buyers" && (
          <ViewMenu
            title="Show"
            sections={[
              {
                label: "Show",
                value: show,
                onChange: (k) => {
                  setShow(k as EbayShow);
                  setLoading(true);
                },
                options: [
                  { key: "all", label: "All conversations", short: "All conversations" },
                  { key: "unread", label: "Unread", short: "Unread" },
                  { key: "waiting", label: "Waiting for you", short: "Waiting for you", count: counts?.waiting || undefined },
                  { key: "mine", label: "Assigned to me", short: "Assigned to me" },
                ],
              },
            ]}
          />
        )}
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 sm:ml-auto sm:w-auto sm:flex-nowrap">
          <SyncStatus data={data} onRefresh={refresh} refreshing={refreshing} reconnectHref={reconnectHref} />
          <label className="flex w-full items-center sm:w-[240px] gap-2 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1.5 focus-within:border-[var(--color-primary)]/60">
            <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-muted)]" aria-hidden>
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
              <path d="M16 16l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search buyer, item or words" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-[var(--color-muted)]" aria-label="Search messages" />
          </label>
        </div>
      </div>

      <div className="card relative flex min-h-0 flex-1 overflow-hidden">
        <div className={`${activeKey ? "hidden lg:flex" : "flex"} min-h-0 w-full lg:w-auto`}>
          <EbayConversationList
            data={data}
            loading={loading}
            loadingMore={loadingMore}
            activeKey={activeKey}
            showAccount={!connectionId}
            emptyText={emptyText}
            onOpen={(c: EbayConversationRow) => onActiveChange(`${c.account.id}~${c.conversationId}`)}
            onMore={loadMore}
          />
        </div>
        <div className={`${activeKey ? "flex" : "hidden lg:flex"} min-h-0 min-w-0 flex-1`}>
          {activeKey ? (
            <EbayThreadView
              data={thread}
              loading={threadLoading}
              error={threadError}
              busy={busy}
              onBack={() => onActiveChange(null)}
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
                conv && conv.type === "FROM_MEMBERS" ? (
                  <EbayComposer
                    key={`composer-${conv.account.id}~${conv.conversationId}`}
                    connectionId={conv.account.id}
                    conversationId={conv.conversationId}
                    buyer={conv.otherParty}
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
              <p className="mt-1 max-w-xs text-[12.5px] leading-relaxed text-[var(--color-muted)]">The order it&apos;s about sits at the top of the chat, with its tracking and any open return or case.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
