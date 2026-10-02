"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, ChatConversation, ChatConversationThread, inboxApi } from "@/lib/api";
import { PillTabs } from "@/components/PillTabs";
import { useMyEvents } from "@/lib/useMyEvents";
import { useQuietScrollbar } from "@/lib/useQuietScrollbar";
import { PersonAvatar } from "./PersonAvatar";
import { messageIcons, snippetOf } from "./MessageParts";
import { clockOf } from "./VoiceNote";
import { listTime, whenAgo } from "./inbox-format";

// A conversation's Threads tab: every thread in it, the latest reply
// first (who started it and when, what they said, the faces of who
// replied, how many replies and when the last came, "2 new" on one you
// follow), All or only the ones you follow. Opening one shows it beside
// the conversation, as Slack does. Kept live as replies come.

type Filter = "all" | "following";

export function ConversationThreads({ conversation, me, activeThread, onOpen }: { conversation: ChatConversation; me: string; activeThread: string | null; onOpen: (rootId: string) => void }) {
  const [threads, setThreads] = useState<ChatConversationThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const scroller = useRef<HTMLDivElement | null>(null);
  const scrollRef = useQuietScrollbar(scroller);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    inboxApi
      .chatConversationThreads(conversation.id)
      .then((r) => {
        setThreads(r.threads);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load the threads."));
  }, [conversation.id]);

  useEffect(() => {
    load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  // A reply, a thread read or followed: read the list again (once for a burst).
  useMyEvents(
    (e) => {
      if (e.conversationId !== conversation.id) return;
      const reply = e.type === "chat.message" && Boolean((e.message as { threadId?: string | null })?.threadId);
      if (!reply && e.type !== "chat.thread" && e.type !== "chat.updated") return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 300);
    },
    load
  );

  const following = useMemo(() => (threads || []).filter((t) => t.following), [threads]);
  const shown = filter === "following" ? following : threads || [];
  const unread = following.reduce((n, t) => n + t.unread, 0);

  return (
    <div ref={scrollRef} className="scroll-quiet min-h-0 flex-1 overflow-y-auto bg-[var(--color-panel)]">
      {error ? (
        <p className="px-6 py-10 text-center text-[12.5px] text-[var(--color-muted)]">{error}</p>
      ) : !threads ? (
        <div className="flex h-full items-center justify-center">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-label="Loading" />
        </div>
      ) : (
        <>
          {threads.length > 0 && (
            <div className="px-5 pb-1 pt-3">
              <PillTabs
                label="Which threads"
                value={filter}
                onChange={setFilter}
                tabs={[
                  { key: "all", label: "All", count: threads.length },
                  { key: "following", label: "Following", count: unread ? `${unread} new` : following.length, countTone: unread ? "alert" : "default" },
                ]}
              />
            </div>
          )}
          {shown.length === 0 ? (
            <div className="flex min-h-[60%] flex-col items-center justify-center px-8 py-12 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">{messageIcons.thread}</span>
              <p className="mt-3 text-[14px] font-semibold text-[var(--color-ink)]">{filter === "following" ? "You're not following any threads here" : "No threads yet"}</p>
              <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                {filter === "following" ? "You follow a thread once you start it, reply in it or are mentioned in it." : "Hover a message and choose Reply in thread to start one. Replies stay out of the conversation, so it stays easy to read."}
              </p>
            </div>
          ) : (
            <ul className="pb-4 pt-1">
              {shown.map((t) => (
                <li key={t.root.id}>
                  <ThreadCard thread={t} me={me} active={activeThread === t.root.id} onOpen={() => onOpen(t.root.id)} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function ThreadCard({ thread, me, active, onOpen }: { thread: ChatConversationThread; me: string; active: boolean; onOpen: () => void }) {
  const root = thread.root;
  const who = root.author?.id === me ? "You" : root.author?.name || "Someone";
  const text = root.voice ? `Voice message (${clockOf(root.voice.durationMs)})` : snippetOf(root);
  const replies = root.thread?.replyCount || 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      className={`group flex w-full gap-3 border-b border-[var(--color-line)]/70 px-5 py-3 text-left transition-colors ${active ? "bg-[var(--color-primary-soft)]/70" : "hover:bg-[var(--color-paper)]"}`}
    >
      <PersonAvatar id={root.author?.id} name={root.author?.name} avatarUrl={root.author?.avatarUrl} size={36} square />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[14px] font-bold text-[var(--color-ink)]">{who}</span>
          <span className="flex-shrink-0 text-[11.5px] tabular-nums text-[var(--color-muted)]">{listTime(root.createdAt)}</span>
          {thread.unread > 0 && <span className="ml-auto flex-shrink-0 rounded-full bg-rose-500 px-1.5 text-[10.5px] font-semibold leading-[18px] text-white">{thread.unread} new</span>}
        </span>
        <span className={`mt-0.5 line-clamp-2 text-[14px] leading-[21px] ${root.deleted ? "italic text-[var(--color-muted)]" : "text-[var(--color-ink)]"}`}>{text || "A message"}</span>
        <span className="mt-1.5 flex items-center gap-2">
          {root.thread && root.thread.people.length > 0 && (
            <span className="flex flex-shrink-0 gap-1">
              {root.thread.people.slice(0, 4).map((p) => (
                <PersonAvatar key={p.id} id={p.id} name={p.name} avatarUrl={p.avatarUrl} size={20} square />
              ))}
            </span>
          )}
          <span className="flex-shrink-0 text-[13px] font-semibold text-[var(--color-primary)] group-hover:underline">
            {replies} {replies === 1 ? "reply" : "replies"}
          </span>
          {thread.lastReplyAt && <span className="min-w-0 truncate text-[12.5px] text-[var(--color-muted)]">Last reply {whenAgo(thread.lastReplyAt)}</span>}
          {thread.following && (
            <span className="ml-auto flex-shrink-0 text-[var(--color-muted)]" title="You follow this thread" aria-label="Following">
              {messageIcons.bell}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
