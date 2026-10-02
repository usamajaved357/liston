"use client";

import { DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { ApiError, ChatConversation, ChatMessage, ChatPerson, inboxApi } from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PillTabs } from "@/components/PillTabs";
import { messageIcons, snippetOf } from "./MessageParts";
import { DayDivider, FlatMessage, NewDivider, SystemRow } from "./FlatMessage";
import { HeaderButton, LatestButton, MenuItem, PopMenu } from "./ChatBubble";
import { Composer, ComposerHandle, ComposerSend, LISTON_REF_TYPE } from "./Composer";
import { ConversationThreads } from "./ConversationThreads";
import { ConversationFiles } from "./ConversationFiles";
import { PersonAvatar } from "./PersonAvatar";
import { dayLabel } from "./inbox-format";
import { MyEvent, useMyEvents } from "@/lib/useMyEvents";
import { useQuietScrollbar } from "@/lib/useQuietScrollbar";

// One team chat conversation, as Slack draws a channel or a direct
// message: its name (the person's picture, "#" or a lock) opening its
// details, the people in it, notifications on or off, details and "…";
// then tabs: Messages, Threads (every thread in it) and Files and links
// (everything shared). Messages are flat on white (FlatMessage: picture,
// name and time, a run from one person grouped), days marked by a rule
// with the day in a pill (the day on screen floating at the top while
// scrolling), a red "New" line where you left off, a round jump-to-latest
// button once you've scrolled up, and the composer, who's typing under
// it. A long conversation stays at the bottom as messages arrive and loads
// older ones above without jumping. Any message can start a thread
// (onOpenThread): its replies stay in the thread, the message showing how
// many there are and who replied; a reply also sent here says so. Files
// and Liston rows dropped anywhere on it are shared. It's read once you're
// at the bottom with the tab in front.

const START = 1_000_000;
const RUN_MS = 5 * 60 * 1000;

type Row = { type: "intro"; key: string } | { type: "day"; key: string; label: string } | { type: "new"; key: string } | { type: "message"; key: string; message: ChatMessage; first: boolean };

export function ChatThread({
  conversation,
  me,
  people,
  isOwner,
  detailsOpen = false,
  onOpenDetails,
  onBack,
  onOpenThread,
  onNotify,
  activeThread = null,
  focusId = null,
  onFocused,
}: {
  conversation: ChatConversation;
  me: string;
  people: Map<string, ChatPerson>;
  isOwner: boolean;
  detailsOpen?: boolean;
  onOpenDetails: () => void;
  // The thread open beside it (marked in the Threads tab).
  activeThread?: string | null;
  // A message to scroll to and light up (a notification's), and what's told once it's shown.
  focusId?: string | null;
  onFocused?: () => void;
  onBack?: () => void;
  onOpenThread: (rootId: string) => void;
  // Mutes the conversation or turns its notifications back on.
  onNotify: (notify: ChatConversation["notify"]) => void;
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
  // The "…" menu's button while it's open; the day floating at the top while scrolling.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [floatingDay, setFloatingDay] = useState<string | null>(null);
  const [scrolling, setScrolling] = useState(false);
  // Where "New messages" goes: the first message after where you'd read to when you opened it.
  const [newFrom, setNewFrom] = useState<string | null>(null);
  const [tab, setTab] = useState<"messages" | "threads" | "files">("messages");
  // A message to go to from the Files tab ("Show"), as a notification's would be.
  const [jump, setJump] = useState<string | null>(null);
  const list = useRef<VirtuosoHandle>(null);
  // Until when the list keeps going to the end: just after you send, so your
  // message ends up fully in view once it's been drawn and measured (a voice
  // note or photos are taller than the list guesses before then).
  const toEndUntil = useRef(0);
  // Its scrollbar shows only while someone is scrolling, as the eBay Inbox's does.
  const quietScroll = useQuietScrollbar<HTMLElement>();
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
        // The first message's row: after the beginning's intro (when there's nothing older), its day line, and "New" when it's the first new one.
        if (r.messages[0]) setAnchor({ key: r.messages[0].id, offset: (r.hasMore ? 0 : 1) + (firstNew?.id === r.messages[0].id ? 2 : 1) });
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
        // A thread reply stays in its thread (the message it started from says how many there are now).
        if (message.threadId && !message.alsoInConversation) return;
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
      } else if (e.type === "chat.typing" && !e.threadId) {
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

  // Rows: the beginning's intro (once there's nothing older), day lines, "New", and each message knowing whether it starts a run.
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const all = messages || [];
    if (all.length && !hasMore) out.push({ type: "intro", key: "intro" });
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
  }, [messages, newFrom, hasMore]);

  const firstIndex = useMemo(() => {
    if (!anchor) return START;
    const i = rows.findIndex((r) => r.key === anchor.key);
    return i < 0 ? START : START - (i - anchor.offset);
  }, [rows, anchor]);

  // A notification's message: scrolled to the middle and lit up once it's loaded (one too old to be loaded is left).
  const focused = useRef<string | null>(null);
  const target = focusId || jump;
  useEffect(() => {
    if (!target || focused.current === target || tab !== "messages") return;
    const index = rows.findIndex((r) => r.type === "message" && r.message.id === target);
    if (index < 0) return;
    focused.current = target;
    const frame = requestAnimationFrame(() => {
      list.current?.scrollToIndex({ index, align: "center" });
      setHighlight(target);
      setTimeout(() => setHighlight((h) => (h === target ? null : h)), 2500);
      if (target === focusId) onFocused?.();
      else setJump(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, focusId, rows, tab, onFocused]);

  // "Show" from the Files tab: a thread reply in its thread, anything else here.
  function showShared(m: ChatMessage) {
    if (m.threadId && !m.alsoInConversation) {
      onOpenThread(m.threadId);
      return;
    }
    focused.current = null;
    setJump(m.id);
    setTab("messages");
  }

  // A thread's first message in a line, for a reply also sent here ("Replied to a thread: …"); null when it isn't loaded.
  const messagesById = useMemo(() => new Map((messages || []).map((m) => [m.id, m])), [messages]);
  const rootText = (id: string) => {
    const root = messagesById.get(id);
    return root ? snippetOf(root) || null : null;
  };

  function jumpTo(messageId: string) {
    const index = rows.findIndex((r) => r.type === "message" && r.message.id === messageId);
    if (index < 0) return;
    list.current?.scrollToIndex({ index, align: "center", behavior: "smooth" });
    setHighlight(messageId);
    setTimeout(() => setHighlight(null), 2500);
  }

  async function send(input: ComposerSend) {
    const sent = await inboxApi.chatSend(id, input);
    setMessages((cur) => (cur && !cur.some((m) => m.id === sent.id) ? [...cur, sent] : cur));
    setNewFrom(null);
    toEndUntil.current = Date.now() + 1500;
    requestAnimationFrame(toEnd);
  }

  function toEnd() {
    list.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" });
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
  const name = conversation.kind === "channel" ? conversation.title.slice(1) : conversation.title;
  const typingNames = [...typing.values()].map((t) => t.name.split(" ")[0]);
  // Who's typing, under the composer as Slack has it.
  const typingText =
    typingNames.length === 0 ? null : typingNames.length === 1 ? `${typingNames[0]} is typing…` : typingNames.length === 2 ? `${typingNames[0]} and ${typingNames[1]} are typing…` : "Several people are typing…";
  const muted = conversation.notify === "none";

  // The very beginning of it (above the first message, once there's nothing older), as Slack opens one.
  const intro = (
    <div className="px-5 pb-2 pt-8">
      {conversation.kind === "dm" ? (
        <PersonAvatar id={others[0]?.id} name={others[0]?.name} avatarUrl={others[0]?.avatarUrl} size={64} square />
      ) : (
        <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--color-primary-soft)] text-[26px] font-bold text-[var(--color-primary)]">
          {conversation.kind === "channel" ? conversation.private ? <LockIcon className="h-7 w-7" /> : "#" : members.length}
        </span>
      )}
      <p className="mt-3 text-[18px] font-bold text-[var(--color-ink)]">{conversation.kind === "dm" ? others[0]?.name || conversation.title : conversation.title}</p>
      <p className="mt-1 max-w-xl text-[13.5px] leading-relaxed text-[var(--color-muted)]">
        {conversation.kind === "dm"
          ? `This is the very beginning of your direct messages with ${others[0]?.name || conversation.title}. Only the two of you are in this conversation.`
          : conversation.kind === "channel"
            ? `This is the very beginning of the ${conversation.title} channel.${conversation.topic ? ` ${conversation.topic}` : ""}`
            : `This is the very beginning of your group with ${others.map((m) => m.name.split(" ")[0]).join(", ")}.`}
      </p>
    </div>
  );

  const menu: MenuItem[] = [
    { label: detailsOpen ? "Hide details" : "Details", onSelect: onOpenDetails },
    muted ? { label: "Turn notifications back on", onSelect: () => onNotify("all") } : { label: "Mute this conversation", onSelect: () => onNotify("none") },
  ];

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
      <header className="flex h-[52px] flex-shrink-0 items-center gap-1 pl-2 pr-2 sm:pl-4">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back to conversations" className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] lg:hidden">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <button type="button" onClick={onOpenDetails} className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-paper)]" title="Details">
          {conversation.kind === "dm" ? (
            <PersonAvatar id={others[0]?.id} name={others[0]?.name} avatarUrl={others[0]?.avatarUrl} size={26} online={others[0]?.online} square />
          ) : conversation.kind === "channel" ? (
            <span className="flex h-[26px] w-[18px] flex-shrink-0 items-center justify-center text-[18px] font-semibold text-[var(--color-ink)]/70">{conversation.private ? <LockIcon className="h-[17px] w-[17px]" /> : "#"}</span>
          ) : (
            <span className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-[6px] bg-[var(--color-primary-soft)] text-[12px] font-bold text-[var(--color-primary)]">{members.length}</span>
          )}
          <span className="truncate text-[16px] font-bold leading-6 text-[var(--color-ink)]">{name}</span>
          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 flex-shrink-0 text-[var(--color-muted)]" aria-hidden>
            <path d="M5.5 8l4.5 4.5L14.5 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {conversation.account && <span className="hidden flex-shrink-0 rounded-[4px] bg-[var(--color-primary-soft)] px-1.5 text-[10.5px] font-semibold leading-4 text-[var(--color-primary)] sm:inline">{conversation.account.label}</span>}
        {conversation.archived && <span className="flex-shrink-0 rounded-[4px] bg-[var(--color-paper)] px-1.5 text-[10.5px] font-semibold leading-4 text-[var(--color-muted)]">Archived</span>}
        <span className="min-w-0 flex-1" />
        {conversation.kind !== "dm" && (
          <button type="button" onClick={onOpenDetails} className="mr-1 hidden h-8 items-center gap-1.5 rounded-lg border border-[var(--color-line)] pl-1 pr-2 transition-colors hover:bg-[var(--color-paper)] md:flex" aria-label={`${members.length} people in it`} title="People in it">
            <span className="flex -space-x-1.5">
              {members.slice(0, 3).map((m) => (
                <span key={m.id} className="rounded-[6px] ring-2 ring-[var(--color-panel)]">
                  <PersonAvatar id={m.id} name={m.name} avatarUrl={m.avatarUrl} size={22} square />
                </span>
              ))}
            </span>
            <span className="text-[12.5px] font-semibold tabular-nums text-[var(--color-ink)]/80">{members.length}</span>
          </button>
        )}
        <HeaderButton label={muted ? "Muted: turn notifications back on" : "Mute this conversation"} onClick={() => onNotify(muted ? "all" : "none")} active={muted}>
          {muted ? messageIcons.bellOff : messageIcons.bell}
        </HeaderButton>
        <HeaderButton label={detailsOpen ? "Hide details" : "Details"} onClick={onOpenDetails} active={detailsOpen}>
          <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
            <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
            <path d="M14.5 4.5v15" stroke="currentColor" strokeWidth="1.7" />
          </svg>
        </HeaderButton>
        <HeaderButton label="More" onClick={(e) => setMenuAnchor(menuAnchor ? null : e.currentTarget)} active={Boolean(menuAnchor)}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
            <circle cx="12" cy="5.5" r="1.7" fill="currentColor" />
            <circle cx="12" cy="12" r="1.7" fill="currentColor" />
            <circle cx="12" cy="18.5" r="1.7" fill="currentColor" />
          </svg>
        </HeaderButton>
        {menuAnchor && <PopMenu anchor={menuAnchor} items={menu} onClose={() => setMenuAnchor(null)} />}
      </header>
      <div className="flex-shrink-0 overflow-x-auto border-b border-[var(--color-line)] px-3 pb-2 sm:px-5">
        <PillTabs
          label="Show"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "messages", label: "Messages" },
            { key: "threads", label: "Threads" },
            { key: "files", label: "Files and links" },
          ]}
        />
      </div>

      {tab === "threads" ? (
        <ConversationThreads conversation={conversation} me={me} activeThread={activeThread} onOpen={onOpenThread} />
      ) : tab === "files" ? (
        <ConversationFiles conversation={conversation} me={me} onShow={showShared} />
      ) : (
        <>
          <div className="relative min-h-0 flex-1 bg-[var(--color-panel)]">
            {error ? (
              <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-[var(--color-muted)]">{error}</div>
            ) : !messages ? (
              <div className="flex h-full items-center justify-center">
                <span className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-label="Loading" />
              </div>
            ) : rows.length === 0 ? (
              <div className="flex h-full flex-col items-start justify-end px-5 pb-6">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-primary-soft)] text-[20px] font-bold text-[var(--color-primary)]">
                  {conversation.kind === "dm" ? <PersonAvatar id={others[0]?.id} name={others[0]?.name} avatarUrl={others[0]?.avatarUrl} size={48} square /> : conversation.kind === "channel" ? conversation.private ? <LockIcon className="h-5 w-5" /> : "#" : members.length}
                </span>
                <p className="mt-3 text-[18px] font-bold text-[var(--color-ink)]">{conversation.kind === "dm" ? `This is the start of your messages with ${conversation.title}` : `This is the very beginning of ${conversation.title}`}</p>
                <p className="mt-1 max-w-lg text-[13.5px] text-[var(--color-muted)]">{conversation.topic || "Share an order, listing or hunted product by pasting its number or link, or drop files here."}</p>
              </div>
            ) : (
              <Virtuoso
                ref={list}
                className="scroll-quiet h-full"
                scrollerRef={(el) => quietScroll(el instanceof HTMLElement ? el : null)}
                data={rows}
                firstItemIndex={firstIndex}
                // Opened at "New" (at the top), else with the latest message at the bottom.
                initialTopMostItemIndex={rows.some((r) => r.type === "new") ? { index: rows.findIndex((r) => r.type === "new"), align: "start" } : { index: Math.max(0, rows.length - 1), align: "end" }}
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
                // Measured now (the message you sent among them): aim at the end again with its real height.
                totalListHeightChanged={() => {
                  if (Date.now() < toEndUntil.current) toEnd();
                }}
                isScrolling={(on) => setScrolling(on)}
                rangeChanged={({ startIndex }) => {
                  // The day of the top message on screen, for the pill floating there while scrolling.
                  const at = startIndex - firstIndex;
                  for (let i = Math.min(at, rows.length - 1); i >= 0; i--) {
                    const r = rows[i];
                    if (r?.type === "day") {
                      setFloatingDay(r.label);
                      return;
                    }
                    if (r?.type === "message") {
                      setFloatingDay(dayLabel(r.message.createdAt));
                      return;
                    }
                  }
                }}
                increaseViewportBy={{ top: 600, bottom: 300 }}
                // A short conversation sits at the foot, just above the composer, as Slack's does.
                alignToBottom
                computeItemKey={(_, row) => row.key}
                components={{
                  Header: () => (hasMore ? <div className="py-3 text-center text-[11.5px] text-[var(--color-muted)]">{loadingOlder ? "Loading earlier messages…" : ""}</div> : <div className="h-2" />),
                  Footer: () => <div className="h-2" />,
                }}
                itemContent={(_, row) => {
                  if (row.type === "intro") return intro;
                  if (row.type === "day") return <DayDivider label={row.label} />;
                  if (row.type === "new") return <NewDivider />;
                  const m = row.message;
                  if (m.kind === "system") return <SystemRow message={m} people={people} />;
                  const mine = m.author?.id === me;
                  return (
                    <FlatMessage
                      message={m}
                      me={me}
                      people={people}
                      compact={!row.first}
                      canDelete={mine || isOwner}
                      place={conversation}
                      highlight={highlight === m.id}
                      threadRootText={m.threadId && m.alsoInConversation ? rootText(m.threadId) : null}
                      onOpenThread={onOpenThread}
                      onQuote={() => {
                        setEditing(null);
                        setReplyTo(m);
                      }}
                      onJumpTo={jumpTo}
                      onEdit={() => {
                        setReplyTo(null);
                        setEditing(m);
                      }}
                      onDelete={() => setDeleting(m)}
                    />
                  );
                }}
              />
            )}
            {floatingDay && rows.length > 0 && (
              <div className={`pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center transition-opacity duration-300 ${scrolling ? "opacity-100" : "opacity-0"}`} aria-hidden>
                <span className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-3.5 py-1 text-[12px] font-semibold text-[var(--color-ink)]/80 shadow-[0_2px_8px_-4px_rgba(15,23,42,0.25)]">{floatingDay}</span>
              </div>
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
            placeholder={`Message ${conversation.title}`}
            typing={typingText}
          />
        </>
      )}
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
