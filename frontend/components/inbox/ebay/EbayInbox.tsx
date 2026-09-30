"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, EbayConversationRow, EbayFolder, EbayInboxList, EbayShow, EbayThread, ebayInboxApi } from "@/lib/api";
import { useMyEvents, useViewing } from "@/lib/useMyEvents";
import { EbayConversationList } from "./EbayConversationList";
import { EbayThreadView } from "./EbayThreadView";
import { EbayContextPanel } from "./EbayContextPanel";
import { EbayComposer } from "./EbayComposer";

// The Inbox's eBay messages for one account (or every account the person
// may read): the list beside the open conversation and, on a wide screen,
// the order and case panel. The list comes from what Liston keeps and is
// read again from eBay in the background (at once when opened if it's over
// a minute old, every minute while the page is in view, and whenever
// Liston hears it changed); the open conversation follows.

const POLL_MS = 60 * 1000;

export function EbayInbox({ connectionId, activeKey, onActiveChange, reconnectHref }: { connectionId: string | null; activeKey: string | null; onActiveChange: (key: string | null) => void; reconnectHref: string | null }) {
  const [folder, setFolder] = useState<EbayFolder>("buyers");
  const [show, setShow] = useState<EbayShow>("all");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<EbayInboxList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // The open conversation, kept with the key it's for (another one opening shows nothing stale).
  const [loaded, setLoaded] = useState<{ key: string; thread: EbayThread | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const listTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [accountId, conversationId] = activeKey ? (activeKey.split("~") as [string, string]) : [null, null];
  const current = loaded && loaded.key === activeKey ? loaded : null;
  const thread = current?.thread || null;
  const threadError = current?.error || null;
  const threadLoading = Boolean(activeKey) && !current;
  const setThreadError = (error: string) => activeKey && setLoaded((l) => ({ key: activeKey, thread: l?.key === activeKey ? l.thread : null, error }));

  // Words typed settle before they're searched.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const loadList = useCallback(
    (opts: { refresh?: boolean } = {}) =>
      ebayInboxApi
        .list(connectionId, { folder, show: folder === "buyers" ? show : "all", q: query, refresh: opts.refresh })
        .then((d) => setData(d))
        .catch(() => {})
        .finally(() => setLoading(false)),
    [connectionId, folder, show, query]
  );
  useEffect(() => {
    loadList();
  }, [loadList]);

  const reloadList = useCallback(() => {
    if (listTimer.current) clearTimeout(listTimer.current);
    listTimer.current = setTimeout(() => loadList(), 400);
  }, [loadList]);

  // While the first read runs (or any read), look again shortly; every minute while in view.
  // (Every few seconds too until the first answer comes, as when the server was restarting.)
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
          // It's read now: the list's dot goes.
          setData((d) => d && { ...d, conversations: d.conversations.map((c) => (c.account.id === accountId && c.conversationId === conversationId ? { ...c, unread: 0 } : c)) });
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
      setThreadError(err instanceof ApiError ? err.message : "That didn't go through.");
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    const last = data?.conversations[data.conversations.length - 1];
    if (!last?.latestAt) return;
    setLoadingMore(true);
    try {
      const more = await ebayInboxApi.list(connectionId, { folder, show: folder === "buyers" ? show : "all", q: query, before: last.latestAt });
      setData((d) => d && { ...more, conversations: [...d.conversations, ...more.conversations.filter((c) => !d.conversations.some((x) => x.account.id === c.account.id && x.conversationId === c.conversationId))] });
    } finally {
      setLoadingMore(false);
    }
  }

  const conv = thread?.conversation;
  const actions = conv && (
    <div className="flex flex-shrink-0 items-center gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          act(async () => {
            await ebayInboxApi.setRead(conv.account.id, conv.conversationId, false);
            onActiveChange(null);
          })
        }
        className="btn btn-ghost btn-sm !px-2.5"
        title="Mark unread"
      >
        Mark unread
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          act(async () => {
            await ebayInboxApi.setStatus(conv.account.id, conv.conversationId, conv.status === "ARCHIVE" ? "ACTIVE" : "ARCHIVE");
            onActiveChange(null);
          })
        }
        className="btn btn-secondary btn-sm !px-2.5"
      >
        {conv.status === "ARCHIVE" ? "Move to inbox" : "Archive"}
      </button>
      {thread?.context.item && (
        <a href={thread.context.item.ebayUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm !px-2.5" title="The listing on eBay">
          On eBay
        </a>
      )}
    </div>
  );

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className={`${activeKey ? "hidden lg:flex" : "flex"} min-h-0 w-full lg:w-auto`}>
        <EbayConversationList
          data={data}
          folder={folder}
          show={show}
          q={q}
          activeKey={activeKey}
          showAccount={!connectionId}
          loading={loading}
          loadingMore={loadingMore}
          onFolder={(f) => {
            setFolder(f);
            setLoading(true);
          }}
          onShow={(s) => {
            setShow(s);
            setLoading(true);
          }}
          onQ={setQ}
          onOpen={(c: EbayConversationRow) => onActiveChange(`${c.account.id}~${c.conversationId}`)}
          onRefresh={() => loadList({ refresh: true })}
          onMore={loadMore}
          reconnectHref={reconnectHref}
        />
      </div>
      <div className={`${activeKey ? "flex" : "hidden lg:flex"} min-h-0 min-w-0 flex-1`}>
        {activeKey ? (
          <>
            <EbayThreadView
              data={thread}
              loading={threadLoading}
              error={threadError}
              onBack={() => onActiveChange(null)}
              actions={actions}
              composer={
                conv && conv.type === "FROM_MEMBERS" ? (
                  <EbayComposer
                    key={`${conv.account.id}~${conv.conversationId}`}
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
            {thread && <EbayContextPanel data={thread} onOpenConversation={(id) => onActiveChange(`${thread.conversation.account.id}~${id}`)} />}
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center bg-[var(--color-paper)] p-8 text-center">
            <p className="text-[15px] font-semibold text-[var(--color-ink)]">Your buyers and eBay, apart</p>
            <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-[var(--color-muted)]">
              Pick a conversation. Beside it: the order it&apos;s about, its tracking, any return or case with its deadline, and the buyer&apos;s other orders.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
