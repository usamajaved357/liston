"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, ChatConversation, ChatMessage, ChatPerson, ChatThreadSummary, inboxApi } from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useMyEvents } from "@/lib/useMyEvents";
import { useQuietScrollbar } from "@/lib/useQuietScrollbar";
import { setChatUnread } from "@/lib/useMyEvents";
import { FlatMessage, NewDivider } from "./FlatMessage";
import { Composer, ComposerSend } from "./Composer";
import { messageIcons } from "./MessageParts";
import { LockIcon } from "./ChatThread";

// Threads, as Slack's page: every thread you follow (you started it,
// replied in it or were mentioned in it), the latest reply first, each a
// card: the conversation it's in and who's in the thread, the message it
// started from, "3 more replies" when there are more than the latest two,
// the latest two (a red "New" above what's new), and a reply box right
// there ("Also send to #orders"). Opening the conversation's name or "more
// replies" shows the whole thread beside its conversation. What's shown is
// read once it's on screen. Kept live as replies come.

const RUN_MS = 5 * 60 * 1000;

export function ThreadsView({
  me,
  isOwner,
  people,
  conversations,
  onOpenThread,
  onBack,
}: {
  me: string;
  isOwner: boolean;
  people: Map<string, ChatPerson>;
  conversations: Map<string, ChatConversation>;
  onOpenThread: (conversationId: string, rootId: string) => void;
  onBack?: () => void;
}) {
  const [threads, setThreads] = useState<ChatThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ChatMessage | null>(null);
  // What was new when the page opened, kept marked while it's open (it's read meanwhile).
  const [newAt, setNewAt] = useState<Map<string, number>>(new Map());
  const scroller = useRef<HTMLDivElement | null>(null);
  const scrollRef = useQuietScrollbar(scroller);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const marked = useRef(false);

  const load = useCallback(() => {
    inboxApi
      .chatThreads()
      .then((r) => {
        setThreads(r.threads);
        setChatUnread(r.unread);
        setError(null);
        if (!marked.current) {
          marked.current = true;
          setNewAt(new Map(r.threads.filter((t) => t.unread > 0).map((t) => [t.root.id, t.unread])));
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load your threads."));
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  useMyEvents(
    (e) => {
      const reply = e.type === "chat.message" && Boolean((e.message as { threadId?: string | null })?.threadId);
      if (!reply && e.type !== "chat.thread" && e.type !== "chat.updated") return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 300);
    },
    load
  );

  // What's on screen with replies new to you is read (its "New" line stays until you leave).
  useEffect(() => {
    if (!threads || document.visibilityState !== "visible") return;
    const unread = threads.filter((t) => t.unread > 0);
    if (!unread.length) return;
    const t = setTimeout(() => {
      for (const th of unread) inboxApi.chatThreadRead(th.root.id, th.latest[th.latest.length - 1]?.id || null).catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [threads]);

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await inboxApi.chatDeleteMessage(deleting.id);
      load();
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-panel)]">
      <header className="flex h-[52px] flex-shrink-0 items-center gap-2 border-b border-[var(--color-line)] pl-2 pr-4 sm:pl-5">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back to conversations" className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] lg:hidden">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <h2 className="text-[16px] font-bold text-[var(--color-ink)]">Threads</h2>
        <p className="hidden truncate text-[12.5px] text-[var(--color-muted)] sm:block">Ones you started, replied in or were mentioned in</p>
      </header>
      <div ref={scrollRef} className="scroll-quiet min-h-0 flex-1 overflow-y-auto bg-[var(--color-paper)]/50">
        {error ? (
          <p className="px-6 py-10 text-center text-[12.5px] text-[var(--color-muted)]">{error}</p>
        ) : !threads ? (
          <div className="flex h-full items-center justify-center">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-label="Loading" />
          </div>
        ) : threads.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">{messageIcons.thread}</span>
            <p className="mt-3 text-[15px] font-semibold text-[var(--color-ink)]">No threads yet</p>
            <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-[var(--color-muted)]">Threads you start, reply in or are mentioned in show here, the latest reply first, so you can answer them in one place.</p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-3 py-5 sm:px-6">
            {threads.map((t) => (
              <ThreadCard
                key={t.root.id}
                thread={t}
                me={me}
                isOwner={isOwner}
                people={people}
                conversation={conversations.get(t.conversation.id)}
                newCount={newAt.get(t.root.id) || 0}
                onOpen={() => onOpenThread(t.conversation.id, t.root.id)}
                onSent={load}
                onDelete={setDeleting}
              />
            ))}
          </div>
        )}
      </div>
      <ConfirmDialog open={Boolean(deleting)} title="Delete this message?" description="It shows as deleted for everyone, its text and files gone." confirmLabel="Delete" danger onConfirm={confirmDelete} onCancel={() => setDeleting(null)} />
    </section>
  );
}

function ThreadCard({
  thread,
  me,
  isOwner,
  people,
  conversation,
  newCount,
  onOpen,
  onSent,
  onDelete,
}: {
  thread: ChatThreadSummary;
  me: string;
  isOwner: boolean;
  people: Map<string, ChatPerson>;
  conversation: ChatConversation | undefined;
  newCount: number;
  onOpen: () => void;
  onSent: () => void;
  onDelete: (m: ChatMessage) => void;
}) {
  const root = thread.root;
  const place = { kind: thread.conversation.kind, title: thread.conversation.title };
  const replies = root.thread?.replyCount || 0;
  const more = Math.max(0, replies - thread.latest.length);
  // Who's in it: who started it and who replied.
  const names = useMemo(() => {
    const seen = new Map<string, string>();
    if (root.author) seen.set(root.author.id, root.author.id === me ? "you" : root.author.name.split(" ")[0]);
    for (const p of root.thread?.people || []) if (!seen.has(p.id)) seen.set(p.id, p.id === me ? "you" : p.name.split(" ")[0]);
    const list = [...seen.values()];
    return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0] || "";
  }, [root, me]);
  // Where "New" goes: before the first of the latest replies that came since you last read it.
  const firstNew = newCount > 0 ? thread.latest[Math.max(0, thread.latest.length - newCount)]?.id : null;
  const alsoTo = thread.conversation.kind === "dm" ? "the conversation" : thread.conversation.title;

  async function send(input: ComposerSend) {
    await inboxApi.chatSend(thread.conversation.id, { ...input, threadId: root.id });
    onSent();
  }

  const row = (m: ChatMessage, compact: boolean) => (
    <FlatMessage
      key={m.id}
      message={m}
      me={me}
      people={people}
      compact={compact}
      canDelete={m.author?.id === me || isOwner}
      place={place}
      inThread
      alsoSentTo={m.threadId && m.alsoInConversation ? alsoTo : null}
      onEdit={onOpen}
      onDelete={() => onDelete(m)}
    />
  );

  return (
    <article>
      <button type="button" onClick={onOpen} className="group mb-2 block px-1 text-left">
        <span className="flex items-center gap-1.5 text-[15px] font-bold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">
          {thread.conversation.kind === "channel" ? <span className="text-[var(--color-ink)]/60">{conversation?.private ? <LockIcon className="h-[15px] w-[15px]" /> : "#"}</span> : null}
          {thread.conversation.kind === "channel" ? thread.conversation.title.slice(1) : thread.conversation.title}
        </span>
        {names && <span className="mt-0.5 block text-[12.5px] text-[var(--color-muted)]">{names}</span>}
      </button>
      <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="pt-1">{row(root, false)}</div>
        {more > 0 && (
          <button type="button" onClick={onOpen} className="ml-[68px] mt-1 text-[13px] font-semibold text-[var(--color-primary)] hover:underline">
            {more} more {more === 1 ? "reply" : "replies"}
          </button>
        )}
        <div className="pb-1">
          {thread.latest.map((m, i) => {
            const prev = thread.latest[i - 1];
            const compact = Boolean(prev && prev.author?.id === m.author?.id && m.id !== firstNew && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < RUN_MS);
            return (
              <div key={m.id}>
                {m.id === firstNew && <NewDivider />}
                {row(m, compact)}
              </div>
            );
          })}
        </div>
        {conversation && (
          <div className="pb-1 pt-1">
            <Composer
              conversationId={thread.conversation.id}
              kind={thread.conversation.kind}
              members={conversation.members}
              meId={me}
              replyTo={null}
              onCancelReply={() => {}}
              editing={null}
              onCancelEdit={() => {}}
              onSend={send}
              onEditSave={async () => {}}
              onTyping={() => inboxApi.chatTyping(thread.conversation.id, root.id).catch(() => {})}
              disabledReason={conversation.archived ? "This channel is archived." : null}
              threadId={root.id}
              alsoLabel={`Also send to ${alsoTo}`}
              placeholder="Reply…"
            />
          </div>
        )}
      </div>
    </article>
  );
}
