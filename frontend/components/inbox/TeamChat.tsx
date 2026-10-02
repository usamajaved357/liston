"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatConversation, ChatList, ChatPerson, inboxApi } from "@/lib/api";
import { setChatUnread, useMyEvents, useViewing } from "@/lib/useMyEvents";
import { ConversationList } from "./ConversationList";
import { ChatThread } from "./ChatThread";
import { ThreadPanel } from "./ThreadPanel";
import { ThreadsView } from "./ThreadsView";
import { BrowseChannelsDialog, ChannelDialog, ConversationDetails, NewChatDialog } from "./ChatDialogs";

// Team chat, laid out as Slack: the sidebar (Threads, Channels, Direct
// messages), then what's open (a conversation, or the Threads page), and on
// the right the open thread or the conversation's details. On a phone one
// at a time: the sidebar, then what's opened from it. Kept live from the
// person's channel. What's open is in the address (?c= a conversation, ?t=
// a thread in it, ?v=threads the Threads page), so a notification or a
// link opens it; a notification's message (?m=) is scrolled to and lit up,
// in its thread or the conversation.

const EMPTY: ChatList = { conversations: [], openChannels: [], canManageChannels: false, unread: { unread: 0, mentions: 0, threads: 0 } };

export function TeamChat({
  me,
  isOwner,
  activeId,
  threadId,
  showThreads = false,
  focusId = null,
  onFocused,
  onOpen,
  onShowThreads,
}: {
  me: string;
  isOwner: boolean;
  activeId: string | null;
  threadId: string | null;
  // The Threads page is what's open (when no conversation is).
  showThreads?: boolean;
  // A message to go to (from a notification), and what's told once it's shown.
  focusId?: string | null;
  onFocused?: () => void;
  // Opens a conversation (null: none), and a thread in it (null: none).
  onOpen: (conversationId: string | null, threadId?: string | null) => void;
  onShowThreads: () => void;
}) {
  const [data, setData] = useState<ChatList | null>(null);
  const [people, setPeople] = useState<ChatPerson[]>([]);
  const [details, setDetails] = useState(false);
  // Another conversation: its details start closed (set while rendering, as React suggests for a reset).
  const [detailsFor, setDetailsFor] = useState(activeId);
  if (detailsFor !== activeId) {
    setDetailsFor(activeId);
    setDetails(false);
  }
  const [dialog, setDialog] = useState<null | "chat" | "channel" | "browse" | "edit">(null);
  const [fetched, setFetched] = useState<ChatConversation | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    inboxApi
      .chatList()
      .then((d) => {
        setData(d);
        setChatUnread(d.unread);
      })
      .catch(() => setData((cur) => cur || EMPTY));
  }, []);
  const reload = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 250);
  }, [load]);

  useEffect(() => {
    load();
    inboxApi
      .chatPeople()
      .then((r) => setPeople(r.people))
      .catch(() => {});
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  useMyEvents(
    (e) => {
      if (!e.type.startsWith("chat.")) return;
      if (e.type === "chat.message" || e.type === "chat.conversation" || e.type === "chat.thread" || (e.type === "chat.read" && e.userId === me) || e.type === "chat.updated") reload();
      if (e.type === "chat.conversation" && e.removed && e.conversationId === activeId) onOpen(null);
    },
    load
  );

  // The tab says what it shows: the conversation, and the thread beside it.
  useViewing(activeId ? (threadId ? `chat:${activeId} chat:${activeId}:${threadId}` : `chat:${activeId}`) : null);

  // The open conversation: from the list, or read on its own (a link to one not in the list yet).
  const active = useMemo(() => data?.conversations.find((c) => c.id === activeId) || (fetched?.id === activeId ? fetched : null), [data, activeId, fetched]);
  useEffect(() => {
    if (!activeId || !data || data.conversations.some((c) => c.id === activeId)) return;
    inboxApi
      .chatGet(activeId)
      .then(setFetched)
      .catch(() => onOpen(null));
  }, [activeId, data, onOpen]);

  const peopleById = useMemo(() => {
    const map = new Map(people.map((p) => [p.id, p]));
    for (const c of data?.conversations || []) for (const m of c.members) if (!map.has(m.id)) map.set(m.id, m);
    return map;
  }, [people, data]);
  const conversationsById = useMemo(() => new Map((data?.conversations || []).map((c) => [c.id, c])), [data]);

  const opened = (c: ChatConversation) => {
    setDialog(null);
    setFetched(c);
    onOpen(c.id);
    load();
  };

  async function setNotify(notify: ChatConversation["notify"]) {
    if (!active) return;
    const c = await inboxApi.chatSetNotify(active.id, notify).catch(() => null);
    if (c) setFetched(c);
    load();
  }

  const showThread = Boolean(active && threadId);
  const threadsPage = showThreads && !activeId;
  // On a phone: the sidebar until something's open.
  const mainOpen = Boolean(activeId) || threadsPage;

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className={`${mainOpen ? "hidden lg:flex" : "flex"} min-h-0 w-full lg:w-auto`}>
        <ConversationList
          data={data}
          me={me}
          activeId={activeId}
          threadsActive={threadsPage}
          onOpen={(id) => onOpen(id, null)}
          onShowThreads={onShowThreads}
          onNewChat={() => setDialog("chat")}
          onNewChannel={() => setDialog("channel")}
          onBrowse={() => setDialog("browse")}
          onOpenResult={(conversationId, message) => onOpen(conversationId, message.threadId || null)}
        />
      </div>
      <div className={`${mainOpen ? "flex" : "hidden lg:flex"} relative min-h-0 min-w-0 flex-1`}>
        {active ? (
          <ChatThread
            key={active.id}
            conversation={active}
            me={me}
            people={peopleById}
            isOwner={isOwner}
            detailsOpen={details && !showThread}
            onOpenDetails={() => {
              if (showThread) onOpen(active.id, null);
              setDetails((v) => !v || showThread);
            }}
            onBack={() => onOpen(null)}
            onOpenThread={(rootId) => {
              setDetails(false);
              onOpen(active.id, rootId);
            }}
            onNotify={setNotify}
            activeThread={threadId}
            focusId={showThread ? null : focusId}
            onFocused={onFocused}
          />
        ) : threadsPage ? (
          <ThreadsView me={me} isOwner={isOwner} people={peopleById} conversations={conversationsById} onOpenThread={(c, root) => onOpen(c, root)} onBack={() => onOpen(null)} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center bg-[var(--color-panel)] p-8 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
              <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
                <path d="M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v7a2.5 2.5 0 01-2.5 2.5H10l-4 4v-4A2 2 0 014 14V6.5z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
              </svg>
            </span>
            <p className="mt-3 text-[15px] font-semibold text-[var(--color-ink)]">Talk to your team</p>
            <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-[var(--color-muted)]">
              Channels and direct messages for everyone in your team, with threads, voice messages and files. Paste an order number, item number or Liston link and it becomes a card anyone can open in the right account.
            </p>
            <button type="button" onClick={() => setDialog("chat")} className="btn btn-primary btn-sm mt-4">
              New message
            </button>
          </div>
        )}
        {showThread && active && threadId && (
          <ThreadPanel key={threadId} rootId={threadId} conversation={active} me={me} people={peopleById} isOwner={isOwner} focusId={focusId} onFocused={onFocused} onClose={() => onOpen(active.id, null)} />
        )}
        {details && !showThread && active && (
          <ConversationDetails
            conversation={active}
            me={me}
            people={people}
            onClose={() => setDetails(false)}
            onChanged={(c) => {
              setFetched(c);
              load();
            }}
            onLeft={() => {
              setDetails(false);
              onOpen(null);
              load();
            }}
            onEdit={() => setDialog("edit")}
          />
        )}
      </div>

      {dialog === "chat" && <NewChatDialog me={me} people={people} onClose={() => setDialog(null)} onOpened={opened} />}
      {(dialog === "channel" || (dialog === "edit" && active)) && (
        <ChannelDialog
          me={me}
          people={people}
          channel={dialog === "edit" ? active : null}
          onClose={() => setDialog(null)}
          onSaved={(c) => {
            if (dialog === "edit") {
              setDialog(null);
              setFetched(c);
              load();
            } else opened(c);
          }}
        />
      )}
      {dialog === "browse" && data && <BrowseChannelsDialog channels={data.openChannels} canManage={data.canManageChannels} onClose={() => setDialog(null)} onJoined={opened} onNew={() => setDialog("channel")} />}
    </div>
  );
}
