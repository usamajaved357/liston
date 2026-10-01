"use client";

import { DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { ApiError, ChatConversation, ChatMessage, ChatPerson, inboxApi, ListonRef } from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { MessageBubble, SystemLine } from "./MessageBubble";
import { DayChip, LatestButton } from "./ChatBubble";
import { Composer, ComposerHandle, LISTON_REF_TYPE } from "./Composer";
import { PersonAvatar } from "./PersonAvatar";
import { dayLabel } from "./inbox-format";
import { MyEvent, useMyEvents } from "@/lib/useMyEvents";

// One team chat conversation: its messages as WhatsApp bubbles on the chat
// wallpaper (a long thread stays at the bottom as messages arrive and loads
// older ones above without jumping), an "Unread messages" band where you
// left off, a round jump-to-latest button once you've scrolled up, "Sara is
// typing…" in the header, and the composer. Files and
// Liston rows (orders, listings, hunted products) dropped anywhere on it are
// shared. It's read once you're at the bottom with the tab in front.

const START = 1_000_000;
const RUN_MS = 5 * 60 * 1000;

type Row = { type: "day"; key: string; label: string } | { type: "new"; key: string } | { type: "message"; key: string; message: ChatMessage; first: boolean };

export function ChatThread({
  conversation,
  me,
  people,
  isOwner,
  onOpenDetails,
  onBack,
}: {
  conversation: ChatConversation;
  me: string;
  people: Map<string, ChatPerson>;
  isOwner: boolean;
  onOpenDetails: () => void;
  onBack?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // The first message row when the conversation opened, and where it sat: older messages
  // added above move the list's first index by as many rows (day lines included).
  const [anchor, setAnchor] = useState<{ key: string; offset: number } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // "Latest" once you've really scrolled up (the list says "not at the bottom" for a moment while it measures).
  const [showLatest, setShowLatest] = useState(false);
  const latestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unreadBelow, setUnreadBelow] = useState(0);
  const [typing, setTyping] = useState<Map<string, { name: string; until: number }>>(new Map());
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [deleting, setDeleting] = useState<ChatMessage | null>(null);
  const [dragging, setDragging] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [members, setMembers] = useState(conversation.members);
  // Where "New messages" goes: the first message after where you'd read to when you opened it.
  const [newFrom, setNewFrom] = useState<string | null>(null);
  const list = useRef<VirtuosoHandle>(null);
  const composer = useRef<ComposerHandle>(null);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRead = useRef<string | null>(null);
  const id = conversation.id;

  // The people (and how far each has read) follow the conversation's summary as it refreshes.
  const [membersFrom, setMembersFrom] = useState(conversation.members);
  if (membersFrom !== conversation.members) {
    setMembersFrom(conversation.members);
    setMembers(conversation.members);
  }

  // Opening it: the latest page, with where you'd read to.
  // (A new conversation is a new component: TeamChat keys it by id.)
  useEffect(() => {
    let cancelled = false;
    const myRead = conversation.members.find((m) => m.id === me)?.lastReadAt || null;
    inboxApi
      .chatMessages(id, { limit: 50 })
      .then((r) => {
        if (cancelled) return;
        setMessages(r.messages);
        setHasMore(r.hasMore);
        const firstNew = r.messages.find((m) => m.kind === "text" && m.author?.id !== me && (!myRead || new Date(m.createdAt) > new Date(myRead)));
        setNewFrom(firstNew ? firstNew.id : null);
        // The first message's row: after its day line (and "New messages" when it's the first new one).
        if (r.messages[0]) setAnchor({ key: r.messages[0].id, offset: firstNew?.id === r.messages[0].id ? 2 : 1 });
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn't open this conversation."));
    return () => {
      cancelled = true;
    };
    // Only when the conversation changes, not each time its summary refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, me]);

  // Read up to the latest while you're at the bottom and the tab is in front.
  const markRead = useCallback(() => {
    if (!messages?.length) return;
    const latest = messages[messages.length - 1];
    if (latest.id === lastRead.current) return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      lastRead.current = latest.id;
      inboxApi.chatRead(id, latest.id).catch(() => {});
    }, 400);
  }, [messages, id]);
  useEffect(() => {
    if (atBottom) markRead();
  }, [atBottom, markRead]);
  // Coming back to it: the window's focus, the tab shown again, or a click or key in the page (some embedded browsers send no focus event).
  useEffect(() => {
    const onBack = () => atBottom && markRead();
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    document.addEventListener("pointerdown", onBack);
    document.addEventListener("keydown", onBack);
    return () => {
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
      document.removeEventListener("pointerdown", onBack);
      document.removeEventListener("keydown", onBack);
    };
  }, [atBottom, markRead]);

  // Live: new messages, edits, reads, typing (and, after the connection dropped, what was said meanwhile).
  const atBottomRef = useRef(atBottom);
  const messagesRef = useRef(messages);
  useEffect(() => {
    atBottomRef.current = atBottom;
    messagesRef.current = messages;
  });
  useMyEvents(
    (e: MyEvent) => {
      if (e.conversationId !== id) return;
      if (e.type === "chat.message") {
        const message = e.message as ChatMessage;
        setMessages((cur) => (cur && !cur.some((m) => m.id === message.id) ? [...cur, message] : cur));
        setTyping((t) => {
          if (!message.author || !t.has(message.author.id)) return t;
          const next = new Map(t);
          next.delete(message.author.id);
          return next;
        });
        if (!atBottomRef.current && message.author?.id !== me) setUnreadBelow((n) => n + 1);
      } else if (e.type === "chat.updated") {
        const message = e.message as ChatMessage;
        setMessages((cur) => cur && cur.map((m) => (m.id === message.id ? message : m)));
      } else if (e.type === "chat.read") {
        setMembers((ms) => ms.map((m) => (m.id === e.userId ? { ...m, lastReadAt: String(e.at) } : m)));
      } else if (e.type === "chat.typing") {
        const user = e.user as { id: string; name: string };
        if (user.id !== me) setTyping((t) => new Map(t).set(user.id, { name: user.name, until: Date.now() + 5000 }));
      }
    },
    () => {
      const cur = messagesRef.current;
      if (!cur?.length) return;
      inboxApi
        .chatMessages(id, { after: cur[cur.length - 1].id, limit: 100 })
        .then((r) => setMessages((now) => (now ? [...now, ...r.messages.filter((m) => !now.some((c) => c.id === m.id))] : now)))
        .catch(() => {});
    }
  );

  // "Typing…" fades out on its own.
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

  const loadOlder = useCallback(async () => {
    if (!hasMore || loadingOlder || !messages?.length) return;
    setLoadingOlder(true);
    try {
      const r = await inboxApi.chatMessages(id, { before: messages[0].id, limit: 50 });
      setMessages((cur) => (cur ? [...r.messages, ...cur] : r.messages));
      setHasMore(r.hasMore);
    } catch {
      // Tried again on the next scroll.
    } finally {
      setLoadingOlder(false);
    }
  }, [hasMore, loadingOlder, messages, id]);

  // Rows: day chips, "Unread messages", and each message knowing whether it starts a run.
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const all = messages || [];
    all.forEach((m, i) => {
      const prev = all[i - 1];
      const day = new Date(m.createdAt).toDateString();
      if (!prev || new Date(prev.createdAt).toDateString() !== day) out.push({ type: "day", key: `day-${day}-${m.id}`, label: dayLabel(m.createdAt) });
      if (m.id === newFrom) out.push({ type: "new", key: `new-${m.id}` });
      const joins = (a?: ChatMessage, b?: ChatMessage) =>
        Boolean(a && b && a.kind === "text" && b.kind === "text" && a.author?.id === b.author?.id && Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) < RUN_MS && new Date(a.createdAt).toDateString() === new Date(b.createdAt).toDateString() && b.id !== newFrom);
      out.push({ type: "message", key: m.id, message: m, first: !joins(prev, m) });
    });
    return out;
  }, [messages, newFrom]);

  const firstIndex = useMemo(() => {
    if (!anchor) return START;
    const i = rows.findIndex((r) => r.key === anchor.key);
    return i < 0 ? START : START - (i - anchor.offset);
  }, [rows, anchor]);

  // Your messages' ticks: blue once everyone else in it (still in the team) has read that far.
  const readers = useMemo(() => members.filter((m) => m.id !== me && !m.removed).map((m) => (m.lastReadAt ? new Date(m.lastReadAt).getTime() : 0)), [members, me]);
  const readByAll = (m: ChatMessage) => (readers.length ? readers.every((at) => at >= new Date(m.createdAt).getTime()) : null);

  function jumpTo(messageId: string) {
    const index = rows.findIndex((r) => r.type === "message" && r.message.id === messageId);
    if (index < 0) return;
    list.current?.scrollToIndex({ index, align: "center", behavior: "smooth" });
    setHighlight(messageId);
    setTimeout(() => setHighlight(null), 2500);
  }

  async function send(input: { body: string; mentions: string[]; fileIds: string[]; refs: ListonRef[]; replyToId: string | null }) {
    const sent = await inboxApi.chatSend(id, input);
    setMessages((cur) => (cur && !cur.some((m) => m.id === sent.id) ? [...cur, sent] : cur));
    setNewFrom(null);
    requestAnimationFrame(() => list.current?.scrollToIndex({ index: "LAST", behavior: "smooth" }));
  }

  async function saveEdit(messageId: string, body: string, mentions: string[]) {
    const saved = await inboxApi.chatEdit(messageId, body, mentions);
    setMessages((cur) => cur && cur.map((m) => (m.id === saved.id ? saved : m)));
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await inboxApi.chatDeleteMessage(deleting.id);
      setMessages((cur) => cur && cur.map((m) => (m.id === deleting.id ? { ...m, deleted: true, body: "", files: [], cards: [] } : m)));
    } finally {
      setDeleting(null);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const raw = e.dataTransfer.getData(LISTON_REF_TYPE);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        composer.current?.addRefs(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {}
      return;
    }
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) {
      composer.current?.addFiles(files);
      return;
    }
    // A link dragged in (an order row, a Liston or eBay link): its card.
    const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (text)
      inboxApi
        .detectCards(text)
        .then((r) => composer.current?.addRefs(r.cards.filter((c) => !c.locked && !c.gone).map((c) => ({ kind: c.kind, id: c.id, connectionId: "account" in c ? c.account.id : undefined }))))
        .catch(() => {});
  }

  const others = members.filter((m) => m.id !== me);
  const subtitle =
    conversation.kind === "channel"
      ? conversation.topic || `${members.length} ${members.length === 1 ? "person" : "people"}`
      : conversation.kind === "dm"
        ? others[0]?.online
          ? "Online"
          : others[0]?.removed
            ? "No longer in the team"
            : others[0]?.email || ""
        : `${members.length} people`;
  const typingNames = [...typing.values()].map((t) => t.name);
  // Someone typing takes the header's second line, as WhatsApp has it.
  const typingText =
    typingNames.length === 0 ? null : conversation.kind === "dm" ? "typing…" : typingNames.length === 1 ? `${typingNames[0].split(" ")[0]} is typing…` : `${typingNames.slice(0, 2).map((n) => n.split(" ")[0]).join(" and ")}${typingNames.length > 2 ? " and others" : ""} are typing…`;

  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-panel)]"
      onDragOver={(e) => {
        const t = e.dataTransfer.types;
        if (t.includes("Files") || t.includes(LISTON_REF_TYPE) || t.includes("text/uri-list")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="flex items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2.5">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back to conversations" className="-ml-1 flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] lg:hidden">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {conversation.kind === "dm" ? (
          <PersonAvatar id={others[0]?.id} name={others[0]?.name} avatarUrl={others[0]?.avatarUrl} size={36} online={others[0]?.online} />
        ) : (
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary-soft)] text-[15px] font-bold text-[var(--color-primary)]">{conversation.kind === "channel" ? (conversation.private ? <LockIcon /> : "#") : members.length}</span>
        )}
        <button type="button" onClick={onOpenDetails} className="min-w-0 flex-1 text-left">
          <p className="flex items-center gap-2 truncate text-[14.5px] font-semibold text-[var(--color-ink)]">
            <span className="truncate">{conversation.title}</span>
            {conversation.account && <span className="chip flex-shrink-0 text-[10.5px]">{conversation.account.label}</span>}
            {conversation.archived && <span className="chip flex-shrink-0 text-[10.5px] text-[var(--color-muted)]">Archived</span>}
          </p>
          <p className={`truncate text-[12px] ${typingText ? "font-medium text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`} aria-live="polite">
            {typingText || subtitle}
          </p>
        </button>
        {conversation.kind !== "dm" && (
          <button type="button" onClick={onOpenDetails} className="hidden items-center -space-x-2 sm:flex" aria-label="People in it">
            {members.slice(0, 4).map((m) => (
              <span key={m.id} className="rounded-full ring-2 ring-[var(--color-panel)]">
                <PersonAvatar id={m.id} name={m.name} avatarUrl={m.avatarUrl} size={26} />
              </span>
            ))}
            {members.length > 4 && <span className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-[var(--color-paper)] text-[10.5px] font-semibold text-[var(--color-muted)] ring-2 ring-[var(--color-panel)]">+{members.length - 4}</span>}
          </button>
        )}
        <button type="button" onClick={onOpenDetails} title="Details" aria-label="Details" className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
            <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 11v5M12 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="chat-wallpaper relative min-h-0 flex-1">
        {error ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-[var(--color-muted)]">{error}</div>
        ) : !messages ? (
          <div className="flex h-full items-center justify-center">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-label="Loading" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <p className="text-[14px] font-semibold text-[var(--color-ink)]">{conversation.kind === "dm" ? `This is the start of your messages with ${conversation.title}` : `This is the start of ${conversation.title}`}</p>
            <p className="mt-1 max-w-sm text-[12.5px] text-[var(--color-muted)]">Share an order, listing or hunted product by pasting its number or link, or drop files here.</p>
          </div>
        ) : (
          <Virtuoso
            ref={list}
            className="h-full"
            data={rows}
            firstItemIndex={firstIndex}
            initialTopMostItemIndex={Math.max(0, rows.findIndex((r) => r.type === "new") >= 0 ? rows.findIndex((r) => r.type === "new") : rows.length - 1)}
            startReached={loadOlder}
            followOutput={(bottom) => (bottom ? "smooth" : false)}
            atBottomStateChange={(bottom) => {
              setAtBottom(bottom);
              if (latestTimer.current) clearTimeout(latestTimer.current);
              if (bottom) {
                setUnreadBelow(0);
                setShowLatest(false);
              } else latestTimer.current = setTimeout(() => setShowLatest(true), 600);
            }}
            atBottomThreshold={80}
            increaseViewportBy={{ top: 600, bottom: 300 }}
            computeItemKey={(_, row) => row.key}
            components={{
              Header: () => (hasMore ? <div className="py-3 text-center text-[11.5px] text-[var(--color-muted)]">{loadingOlder ? "Loading earlier messages…" : ""}</div> : <div className="h-2" />),
              Footer: () => <div className="h-3" />,
            }}
            itemContent={(_, row) => {
              if (row.type === "day") return <DayChip label={row.label} />;
              if (row.type === "new")
                return (
                  <div className="my-2 flex justify-center bg-[var(--color-panel)]/45 py-1.5">
                    <span className="rounded-full bg-[var(--color-panel)] px-3 py-1 text-[11.5px] font-medium text-[var(--color-primary)] shadow-[var(--shadow-bubble)]">Unread messages</span>
                  </div>
                );
              const m = row.message;
              if (m.kind === "system") return <SystemLine message={m} people={people} />;
              const mine = m.author?.id === me;
              return (
                <MessageBubble
                  message={m}
                  mine={mine}
                  first={row.first}
                  people={people}
                  showAuthorName={conversation.kind !== "dm"}
                  me={me}
                  read={mine ? readByAll(m) : null}
                  canDelete={mine || isOwner}
                  highlight={highlight === m.id}
                  onReply={() => {
                    setEditing(null);
                    setReplyTo(m);
                  }}
                  onEdit={() => {
                    setReplyTo(null);
                    setEditing(m);
                  }}
                  onDelete={() => setDeleting(m)}
                  onJumpTo={jumpTo}
                />
              );
            }}
          />
        )}
        {showLatest && !atBottom && messages && messages.length > 0 && <LatestButton count={unreadBelow} onClick={() => list.current?.scrollToIndex({ index: "LAST", behavior: "smooth" })} />}
        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--color-primary)] bg-[var(--color-primary-soft)]/85">
            <p className="text-[14px] font-semibold text-[var(--color-primary)]">Drop to share in {conversation.title}</p>
          </div>
        )}
      </div>

      <Composer
        ref={composer}
        conversationId={id}
        kind={conversation.kind}
        members={members}
        meId={me}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onSend={send}
        onEditSave={saveEdit}
        onTyping={() => inboxApi.chatTyping(id).catch(() => {})}
        disabledReason={conversation.archived ? "This channel is archived. Nothing new can be said in it." : null}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete this message?"
        description="It shows as deleted for everyone, its text and files gone."
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
}

export function LockIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 11V8a4 4 0 118 0v3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
