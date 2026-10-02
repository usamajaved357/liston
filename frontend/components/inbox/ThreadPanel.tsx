"use client";

import { DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, ChatConversation, ChatMessage, ChatPerson, ChatThreadDetail, inboxApi, ListonRef } from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useQuietScrollbar } from "@/lib/useQuietScrollbar";
import { MyEvent, useMyEvents } from "@/lib/useMyEvents";
import { FlatMessage, NewDivider } from "./FlatMessage";
import { HeaderButton, PopMenu } from "./ChatBubble";
import { Composer, ComposerHandle, ComposerSend, LISTON_REF_TYPE } from "./Composer";

// A thread, as Slack opens one: a panel beside the conversation (over it on
// a smaller screen), flat on white rather than bubbles. "Thread" and where
// it is (#orders, a person) at the top with a "…" menu (follow or stop
// following, copy its link) and close; the message it started from, a
// "2 replies" rule, the replies (FlatMessage: a run from one person
// grouped, a "New" line above the ones that came since you last looked if
// you follow it), then "Reply…" with "Also send to #orders". Followers are
// told of new replies and see it under Threads. It's read up to the latest
// while it's open with the tab in front. Files dropped on it go into the
// reply.

const RUN_MS = 5 * 60 * 1000;

export function ThreadPanel({
  rootId,
  conversation,
  me,
  people,
  isOwner,
  focusId = null,
  onFocused,
  onClose,
}: {
  rootId: string;
  conversation: ChatConversation;
  me: string;
  people: Map<string, ChatPerson>;
  isOwner: boolean;
  // A reply to scroll to and light up (a notification's), and what's told once it's shown.
  focusId?: string | null;
  onFocused?: () => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<ChatThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [deleting, setDeleting] = useState<ChatMessage | null>(null);
  const [typing, setTyping] = useState<Map<string, { name: string; until: number }>>(new Map());
  const [dragging, setDragging] = useState(false);
  // The first reply that came since you last read it (as it was when opened): "New" goes above it.
  const [newFrom, setNewFrom] = useState<string | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const focused = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const scrollRef = useQuietScrollbar(scroller);
  const composer = useRef<ComposerHandle>(null);
  const lastRead = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    inboxApi
      .chatThread(rootId)
      .then((d) => {
        if (!live) return;
        setData(d);
        const since = d.readAt ? new Date(d.readAt).getTime() : 0;
        const first = d.following ? d.replies.find((r) => r.author?.id !== me && new Date(r.createdAt).getTime() > since) : undefined;
        setNewFrom(first?.id || null);
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Couldn't open this thread."));
    return () => {
      live = false;
    };
  }, [rootId, me]);

  const replies = useMemo(() => data?.replies || [], [data]);
  const latestId = replies.length ? replies[replies.length - 1].id : data?.root.id;

  // Opened at the latest reply, and kept there as new ones come in.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies.length, data?.root.id]);

  // A notification's reply (or the first message): scrolled to the middle and lit up, once.
  useEffect(() => {
    if (!data || !focusId || focused.current === focusId) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-message-id="${focusId}"]`);
    if (!el) return;
    focused.current = focusId;
    const frame = requestAnimationFrame(() => {
      el.scrollIntoView({ block: "center" });
      setHighlight(focusId);
      setTimeout(() => setHighlight((h) => (h === focusId ? null : h)), 2500);
      onFocused?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [data, focusId, onFocused]);

  // Read up to the latest while it's open and the tab is in front.
  const markRead = useCallback(() => {
    if (!data || !latestId || latestId === lastRead.current) return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    lastRead.current = latestId;
    inboxApi.chatThreadRead(rootId, replies.length ? latestId : null).catch(() => {});
  }, [data, latestId, rootId, replies.length]);
  useEffect(() => {
    markRead();
    window.addEventListener("focus", markRead);
    document.addEventListener("visibilitychange", markRead);
    return () => {
      window.removeEventListener("focus", markRead);
      document.removeEventListener("visibilitychange", markRead);
    };
  }, [markRead]);

  useMyEvents(
    (e: MyEvent) => {
      if (e.conversationId !== conversation.id) return;
      if (e.type === "chat.message") {
        const m = e.message as ChatMessage;
        if (m.threadId !== rootId) return;
        setData((d) => (d && !d.replies.some((r) => r.id === m.id) ? { ...d, replies: [...d.replies, m] } : d));
        setTyping((t) => {
          if (!m.author || !t.has(m.author.id)) return t;
          const next = new Map(t);
          next.delete(m.author.id);
          return next;
        });
      } else if (e.type === "chat.updated") {
        const m = e.message as ChatMessage;
        setData((d) => (!d ? d : m.id === d.root.id ? { ...d, root: m } : d.replies.some((r) => r.id === m.id) ? { ...d, replies: d.replies.map((r) => (r.id === m.id ? m : r)) } : d));
      } else if (e.type === "chat.typing" && e.threadId === rootId) {
        const user = e.user as { id: string; name: string };
        if (user.id !== me) setTyping((t) => new Map(t).set(user.id, { name: user.name, until: Date.now() + 5000 }));
      }
    },
    () => {
      inboxApi
        .chatThread(rootId)
        .then(setData)
        .catch(() => {});
    }
  );

  useEffect(() => {
    if (!typing.size) return;
    const t = setInterval(() => {
      setTyping((cur) => {
        const now = Date.now();
        const next = new Map([...cur].filter(([, v]) => v.until > now));
        return next.size === cur.size ? cur : next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [typing.size]);

  async function send(input: ComposerSend) {
    const sent = await inboxApi.chatSend(conversation.id, { ...input, threadId: rootId });
    setNewFrom(null);
    setData((d) => (d && !d.replies.some((r) => r.id === sent.id) ? { ...d, replies: [...d.replies, sent], following: true } : d));
  }

  async function saveEdit(messageId: string, body: string, mentions: string[]) {
    const saved = await inboxApi.chatEdit(messageId, body, mentions);
    setData((d) => (!d ? d : saved.id === d.root.id ? { ...d, root: saved } : { ...d, replies: d.replies.map((r) => (r.id === saved.id ? saved : r)) }));
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await inboxApi.chatDeleteMessage(deleting.id);
      const gone = (m: ChatMessage) => (m.id === deleting.id ? { ...m, deleted: true, body: "", files: [], cards: [], voice: null } : m);
      setData((d) => d && { ...d, root: gone(d.root), replies: d.replies.map(gone) });
    } finally {
      setDeleting(null);
    }
  }

  async function toggleFollow() {
    if (!data) return;
    const next = !data.following;
    setData({ ...data, following: next });
    await inboxApi.chatFollow(rootId, next).catch(() => setData((d) => d && { ...d, following: !next }));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const raw = e.dataTransfer.getData(LISTON_REF_TYPE);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ListonRef | ListonRef[];
        composer.current?.addRefs(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {}
      return;
    }
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) composer.current?.addFiles(files);
  }

  const typingNames = [...typing.values()].map((t) => t.name.split(" ")[0]);
  // Where it is: "#orders" (a channel's title has its "#"), the person, the group; and how a reply sent there too says it.
  const where = conversation.title;
  const alsoTo = conversation.kind === "dm" ? "the conversation" : where;
  const joins = (a: ChatMessage | undefined, b: ChatMessage) => Boolean(a && !a.deleted && a.author?.id === b.author?.id && !a.alsoInConversation && Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) < RUN_MS);
  const row = (m: ChatMessage, compact: boolean) => {
    const mine = m.author?.id === me;
    return (
      <FlatMessage
        key={m.id}
        message={m}
        me={me}
        people={people}
        compact={compact}
        canDelete={mine || isOwner}
        place={conversation}
        inThread
        alsoSentTo={m.threadId && m.alsoInConversation ? alsoTo : null}
        highlight={highlight === m.id}
        onEdit={() => setEditing(m)}
        onDelete={() => setDeleting(m)}
      />
    );
  };

  function copyLink() {
    const url = `${window.location.origin}/inbox?c=${conversation.id}&t=${rootId}`;
    navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  return (
    <aside
      className="absolute inset-0 z-30 flex min-h-0 flex-col bg-[var(--color-panel)] sm:left-auto sm:w-[420px] sm:border-l sm:border-[var(--color-line)] sm:shadow-[var(--shadow-pop)] xl:static xl:z-auto xl:flex-shrink-0 xl:shadow-none"
      aria-label="Thread"
      onDragOver={(e) => {
        const t = e.dataTransfer.types;
        if (t.includes("Files") || t.includes(LISTON_REF_TYPE)) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="flex h-[52px] flex-shrink-0 items-center gap-1 border-b border-[var(--color-line)] pl-4 pr-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-bold leading-5 text-[var(--color-ink)]">Thread</h3>
          <p className={`truncate text-[12px] leading-4 ${typingNames.length ? "font-medium text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`} aria-live="polite">
            {typingNames.length ? `${typingNames.slice(0, 2).join(" and ")} ${typingNames.length === 1 ? "is" : "are"} typing…` : copied ? "Link copied" : where}
          </p>
        </div>
        {data && (
          <HeaderButton label="More" onClick={(e) => setMenu(menu ? null : e.currentTarget)} active={Boolean(menu)}>
            <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden>
              <circle cx="4.5" cy="10" r="1.6" fill="currentColor" />
              <circle cx="10" cy="10" r="1.6" fill="currentColor" />
              <circle cx="15.5" cy="10" r="1.6" fill="currentColor" />
            </svg>
          </HeaderButton>
        )}
        <HeaderButton label="Close the thread" onClick={onClose}>
          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
            <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </HeaderButton>
        {menu && data && (
          <PopMenu
            anchor={menu}
            onClose={() => setMenu(null)}
            items={[
              {
                label: data.following ? "Turn off notifications for replies" : "Get notified about new replies",
                onSelect: toggleFollow,
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                    <path d="M6 16.5V11a6 6 0 1112 0v5.5l1.5 2h-15l1.5-2zM10 20.5a2 2 0 004 0" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                    {data.following && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
                  </svg>
                ),
              },
              {
                label: "Copy link to thread",
                onSelect: copyLink,
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                    <path d="M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66l-1 1M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1-1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                ),
              },
            ]}
          />
        )}
      </header>

      <div className="relative min-h-0 flex-1 bg-[var(--color-panel)]">
        <div ref={scrollRef} className="scroll-quiet h-full overflow-y-auto pb-4 pt-3">
          {error ? (
            <p className="px-6 py-10 text-center text-[12.5px] text-[var(--color-muted)]">{error}</p>
          ) : !data ? (
            <div className="flex h-full items-center justify-center">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-label="Loading" />
            </div>
          ) : (
            <>
              {row(data.root, false)}
              <div className="flex items-center gap-3 px-5 pb-1 pt-3" role="separator">
                <span className="flex-shrink-0 text-[12px] font-medium text-[var(--color-muted)]">{replies.length === 0 ? "No replies yet" : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}</span>
                <span className="h-px flex-1 bg-[var(--color-line)]" />
              </div>
              {replies.length === 0 && <p className="px-5 pt-1 text-[12px] leading-5 text-[var(--color-muted)]">Replies stay in this thread unless you also send them to {alsoTo}.</p>}
              {replies.map((m, i) => (
                <div key={m.id}>
                  {m.id === newFrom && <NewDivider />}
                  {row(m, m.id !== newFrom && joins(replies[i - 1], m))}
                </div>
              ))}
            </>
          )}
        </div>
        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--color-primary)] bg-[var(--color-primary-soft)]/85">
            <p className="text-[13.5px] font-semibold text-[var(--color-primary)]">Drop to add to your reply</p>
          </div>
        )}
      </div>

      {data && (
        <Composer
          ref={composer}
          conversationId={conversation.id}
          kind={conversation.kind}
          members={conversation.members}
          meId={me}
          replyTo={null}
          onCancelReply={() => {}}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
          onSend={send}
          onEditSave={saveEdit}
          onTyping={() => inboxApi.chatTyping(conversation.id, rootId).catch(() => {})}
          disabledReason={conversation.archived ? "This channel is archived." : null}
          threadId={rootId}
          alsoLabel={`Also send to ${alsoTo}`}
          placeholder="Reply…"
        />
      )}
      <ConfirmDialog open={Boolean(deleting)} title="Delete this message?" description="It shows as deleted for everyone, its text and files gone." confirmLabel="Delete" danger onConfirm={confirmDelete} onCancel={() => setDeleting(null)} />
    </aside>
  );
}
