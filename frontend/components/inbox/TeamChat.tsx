"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatConversation, ChatList, ChatPerson, inboxApi } from "@/lib/api";
import { setChatUnread, useMyEvents, useViewing } from "@/lib/useMyEvents";
import { ConversationList } from "./ConversationList";
import { ChatThread } from "./ChatThread";
import { BrowseChannelsDialog, ChannelDialog, ConversationDetails, NewChatDialog } from "./ChatDialogs";

// Team chat: the conversation list beside the open conversation (one at a
// time on a phone), kept live from the person's channel. The open
// conversation is in the address (?c=), so a notification or a link opens
// it.

export function TeamChat({ me, isOwner, activeId, onActiveChange }: { me: string; isOwner: boolean; activeId: string | null; onActiveChange: (id: string | null) => void }) {
  const [data, setData] = useState<ChatList | null>(null);
  const [people, setPeople] = useState<ChatPerson[]>([]);
  const [details, setDetails] = useState(false);
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
      .catch(() => setData((cur) => cur || { conversations: [], openChannels: [], canManageChannels: false, unread: { unread: 0, mentions: 0 } }));
  }, []);
  const reload = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 250);
  }, [load]);

  useEffect(() => {
    load();
    inboxApi.chatPeople().then((r) => setPeople(r.people)).catch(() => {});
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  useMyEvents(
    (e) => {
      if (!e.type.startsWith("chat.")) return;
      if (e.type === "chat.message" || e.type === "chat.conversation" || (e.type === "chat.read" && e.userId === me) || e.type === "chat.updated") reload();
      if (e.type === "chat.conversation" && e.removed && e.conversationId === activeId) onActiveChange(null);
    },
    () => load()
  );

  useViewing(activeId ? `chat:${activeId}` : null);

  // The open conversation: from the list, or read on its own (a link to one not in the list yet).
  const active = useMemo(() => data?.conversations.find((c) => c.id === activeId) || (fetched?.id === activeId ? fetched : null), [data, activeId, fetched]);
  useEffect(() => {
    if (!activeId || !data || data.conversations.some((c) => c.id === activeId)) return;
    inboxApi
      .chatGet(activeId)
      .then(setFetched)
      .catch(() => onActiveChange(null));
  }, [activeId, data, onActiveChange]);

  const peopleById = useMemo(() => {
    const map = new Map(people.map((p) => [p.id, p]));
    for (const c of data?.conversations || []) for (const m of c.members) if (!map.has(m.id)) map.set(m.id, m);
    return map;
  }, [people, data]);

  const opened = (c: ChatConversation) => {
    setDialog(null);
    setFetched(c);
    onActiveChange(c.id);
    load();
  };

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className={`${activeId ? "hidden lg:flex" : "flex"} min-h-0 w-full lg:w-auto`}>
        <ConversationList
          data={data}
          me={me}
          activeId={activeId}
          onOpen={(id) => {
            setDetails(false);
            onActiveChange(id);
          }}
          onNewChat={() => setDialog("chat")}
          onNewChannel={() => setDialog("channel")}
          onBrowse={() => setDialog("browse")}
          onOpenResult={(conversationId) => onActiveChange(conversationId)}
        />
      </div>
      <div className={`${activeId ? "flex" : "hidden lg:flex"} relative min-h-0 min-w-0 flex-1`}>
        {active ? (
          <ChatThread
            key={active.id}
            conversation={active}
            me={me}
            people={peopleById}
            isOwner={isOwner}
            onOpenDetails={() => setDetails((v) => !v)}
            onBack={() => onActiveChange(null)}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center bg-[var(--color-paper)] p-8 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
              <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden>
                <path d="M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v7a2.5 2.5 0 01-2.5 2.5H10l-4 4v-4h0A2 2 0 014 14V6.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              </svg>
            </span>
            <p className="mt-3 text-[15px] font-semibold text-[var(--color-ink)]">Talk to your team</p>
            <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-[var(--color-muted)]">
              Direct messages, groups and channels for everyone in your team. Paste an order number, item number or Liston link and it becomes a card anyone can open in the right account.
            </p>
            <button type="button" onClick={() => setDialog("chat")} className="btn btn-primary btn-sm mt-4">
              New message
            </button>
          </div>
        )}
        {details && active && (
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
              onActiveChange(null);
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
      {dialog === "browse" && data && (
        <BrowseChannelsDialog channels={data.openChannels} canManage={data.canManageChannels} onClose={() => setDialog(null)} onJoined={opened} onNew={() => setDialog("channel")} />
      )}
    </div>
  );
}
