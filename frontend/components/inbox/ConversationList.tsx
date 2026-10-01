"use client";

import { useMemo, useState } from "react";
import { ChatConversation, ChatList, ChatMessage, ChatThreadSummary, inboxApi } from "@/lib/api";
import { PillTabs } from "@/components/PillTabs";
import { useQuietScrollbar } from "@/lib/useQuietScrollbar";
import { PersonAvatar } from "./PersonAvatar";
import { MenuItem, PopMenu } from "./ChatBubble";
import { listTime, plainOf } from "./inbox-format";
import { LockIcon } from "./ChatThread";

// Team chat's list, laid out as the eBay Inbox's: search and the "+" (a
// new message or group, a new channel for the owner or Manage channels,
// browsing the public channels to join) at the top (the views' tabs, in
// the page's header, sit under the search on a phone), then the
// conversations newest first: who or which channel, when, the last line
// and what's unread ("@" when it's for you). Views: All, Unread, Threads
// (the threads you follow, newest reply first, with what's new in each),
// Channels and Direct messages. Typing narrows the list by name; Enter
// searches every message.

export type ChatView = "all" | "unread" | "threads" | "channels" | "direct";

/** The views, as tabs (in the page's header; under the search on a phone). */
export function ChatViewTabs({ view, unread, onView }: { view: ChatView; unread: ChatList["unread"] | undefined; onView: (v: ChatView) => void }) {
  return (
    <PillTabs
      tabs={[
        { key: "all" as const, label: "All" },
        { key: "unread" as const, label: "Unread", count: unread?.unread || undefined, countTone: unread?.mentions ? "alert" : "default" },
        { key: "threads" as const, label: "Threads", count: unread?.threads || undefined, countTone: "alert", title: "Threads you follow: ones you started, replied in or were mentioned in" },
        { key: "channels" as const, label: "Channels" },
        { key: "direct" as const, label: "Direct" },
      ]}
      value={view}
      onChange={onView}
      label="Show"
    />
  );
}

function ConversationAvatar({ c, me, size = 40 }: { c: Pick<ChatConversation, "kind" | "private" | "members" | "title">; me: string; size?: number }) {
  if (c.kind === "dm") {
    const other = c.members.find((m) => m.id !== me) || c.members[0];
    return <PersonAvatar id={other?.id} name={other?.name || c.title} avatarUrl={other?.avatarUrl} size={size} online={other?.online} />;
  }
  return (
    <span className="flex flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-soft)] font-bold text-[var(--color-primary)]" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>
      {c.kind === "channel" ? c.private ? <LockIcon className="h-4 w-4" /> : "#" : c.members.length}
    </span>
  );
}

const muteIcon = (
  <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-muted)]" aria-label="Muted">
    <path d="M6 9h3l4-4v14l-4-4H6V9zM17 9l4 6M21 9l-4 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Row({ c, me, active, onOpen }: { c: ChatConversation; me: string; active: boolean; onOpen: () => void }) {
  const last = c.lastMessage;
  const who = last?.author ? (last.author.id === me ? "You: " : c.kind === "dm" ? "" : `${last.author.name.split(" ")[0]}: `) : "";
  const unread = c.unread > 0 && c.notify !== "none";
  const title = c.kind === "channel" ? c.title.slice(1) : c.title;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      className={`group flex w-full items-center gap-2.5 rounded-xl pl-2.5 text-left transition-colors ${active ? "bg-[var(--color-primary-soft)]" : "hover:bg-[var(--color-paper)]"}`}
    >
      <ConversationAvatar c={c} me={me} />
      <span className={`min-w-0 flex-1 border-b py-[9px] pr-2.5 transition-colors ${active ? "border-transparent" : "border-[var(--color-line)]/60 group-hover:border-transparent"}`}>
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-[13.5px] leading-[18px] text-[var(--color-ink)] ${unread ? "font-semibold" : "font-medium"}`}>
            {c.kind === "channel" && <span className="mr-0.5 text-[var(--color-muted)]">#</span>}
            {title}
          </span>
          {last && <span className={`flex-shrink-0 text-[11px] tabular-nums ${unread ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`}>{listTime(last.at)}</span>}
        </span>
        <span className="mt-px flex items-center gap-2">
          <span className={`min-w-0 flex-1 truncate text-[12px] leading-[18px] ${unread ? "font-medium text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>
            {c.account && <span className="font-medium text-[var(--color-ink)]/70">{c.account.label} · </span>}
            {last ? (last.kind === "system" ? (c.topic || "") : `${who}${last.text || ""}`) : c.kind === "channel" ? c.topic || "No messages yet" : "No messages yet"}
          </span>
          {c.notify === "none" && muteIcon}
          {unread && (
            <span className={`flex h-[18px] min-w-[18px] flex-shrink-0 items-center justify-center rounded-full px-1 text-[10.5px] font-semibold text-white ${c.unreadMentions > 0 || c.kind === "dm" ? "bg-rose-500" : "bg-[var(--color-primary)]"}`}>
              {c.unreadMentions > 0 && c.kind !== "dm" ? "@" : c.unread > 99 ? "99+" : c.unread}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/** A thread you follow: its conversation, the message it started from, how many replies and what's new. */
function ThreadRow({ t, me, conversation, active, onOpen }: { t: ChatThreadSummary; me: string; conversation: ChatConversation | undefined; active: boolean; onOpen: () => void }) {
  const root = t.root;
  const starter = root.author?.id === me ? "You" : root.author?.name.split(" ")[0] || "Someone";
  const text = root.deleted ? "Message deleted" : plainOf(root.body) || (root.voice ? "Voice message" : root.files.length ? "A file" : root.cards.length ? "A card" : "");
  const replies = root.thread?.replyCount || 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      className={`group flex w-full items-start gap-2.5 rounded-xl pl-2.5 text-left transition-colors ${active ? "bg-[var(--color-primary-soft)]" : "hover:bg-[var(--color-paper)]"}`}
    >
      <span className="pt-[9px]">{conversation ? <ConversationAvatar c={conversation} me={me} /> : <PersonAvatar id={root.author?.id} name={root.author?.name} avatarUrl={root.author?.avatarUrl} size={40} />}</span>
      <span className={`min-w-0 flex-1 border-b py-[9px] pr-2.5 transition-colors ${active ? "border-transparent" : "border-[var(--color-line)]/60 group-hover:border-transparent"}`}>
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-[13.5px] leading-[18px] text-[var(--color-ink)] ${t.unread ? "font-semibold" : "font-medium"}`}>{t.conversation.title}</span>
          {t.lastReplyAt && <span className={`flex-shrink-0 text-[11px] tabular-nums ${t.unread ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`}>{listTime(t.lastReplyAt)}</span>}
        </span>
        <span className="mt-px block truncate text-[12px] leading-[18px] text-[var(--color-muted)]">
          <span className="font-medium text-[var(--color-ink)]/80">{starter}:</span> {text}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-[var(--color-primary)]">
            {replies} {replies === 1 ? "reply" : "replies"}
          </span>
          {t.unread > 0 && <span className="flex h-[18px] min-w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] px-1 text-[10.5px] font-semibold text-white">{t.unread > 99 ? "99+" : t.unread}</span>}
        </span>
      </span>
    </button>
  );
}

export function ConversationList({
  data,
  threads,
  me,
  view,
  onView,
  activeId,
  activeThread,
  onOpen,
  onOpenThread,
  onNewChat,
  onNewChannel,
  onBrowse,
  onOpenResult,
}: {
  data: ChatList | null;
  threads: ChatThreadSummary[] | null;
  me: string;
  view: ChatView;
  onView: (v: ChatView) => void;
  activeId: string | null;
  activeThread: string | null;
  onOpen: (id: string) => void;
  onOpenThread: (conversationId: string, rootId: string) => void;
  onNewChat: () => void;
  onNewChannel: () => void;
  onBrowse: () => void;
  onOpenResult: (conversationId: string, message: ChatMessage) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ message: ChatMessage; conversation: { id: string; title: string } }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [newAnchor, setNewAnchor] = useState<HTMLElement | null>(null);
  const quietScroll = useQuietScrollbar<HTMLDivElement>();
  const words = q.trim().toLowerCase();

  const shown = useMemo(() => {
    const all = (data?.conversations || []).filter((c) => !words || c.title.toLowerCase().includes(words) || c.members.some((m) => m.name.toLowerCase().includes(words)));
    if (view === "unread") return all.filter((c) => c.unread > 0 && c.notify !== "none");
    if (view === "channels") return all.filter((c) => c.kind === "channel");
    if (view === "direct") return all.filter((c) => c.kind !== "channel");
    return all;
  }, [data, words, view]);
  const byId = useMemo(() => new Map((data?.conversations || []).map((c) => [c.id, c])), [data]);
  const shownThreads = useMemo(() => (threads || []).filter((t) => !words || t.conversation.title.toLowerCase().includes(words) || (t.root.body || "").toLowerCase().includes(words)), [threads, words]);

  async function searchMessages() {
    if (words.length < 2) return;
    setSearching(true);
    try {
      setResults((await inboxApi.chatSearch(q.trim())).results);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  const newItems: MenuItem[] = [
    { label: "New message or group", onSelect: onNewChat },
    ...(data?.canManageChannels ? [{ label: "New channel", onSelect: onNewChannel }] : []),
    ...(data && (data.openChannels.length > 0 || data.canManageChannels) ? [{ label: data.openChannels.length ? `Browse channels (${data.openChannels.length} to join)` : "Browse channels", onSelect: onBrowse }] : []),
  ];

  const empty =
    view === "threads"
      ? words
        ? "No thread matches."
        : "No threads yet. Reply in a thread on any message, and the threads you start, reply in or are mentioned in show here."
      : words
        ? "Nothing matches. Press Enter to search every message."
        : {
            all: "Message anyone in your team with +.",
            unread: "You're all caught up.",
            channels: data?.canManageChannels ? "No channels yet. Make one for a team or an account with +." : data?.openChannels.length ? "Join a channel with + to see it here." : "No channels yet.",
            direct: "Message anyone in your team with +.",
          }[view];

  return (
    <aside className="flex min-h-0 w-full flex-col border-r border-[var(--color-line)] bg-[var(--color-panel)] lg:w-[300px] lg:flex-shrink-0">
      <div className="flex-shrink-0 space-y-2 px-3 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-[var(--color-paper)] px-3.5 ring-1 ring-transparent transition-shadow focus-within:bg-[var(--color-panel)] focus-within:ring-[var(--color-primary)]/50">
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 flex-shrink-0 text-[var(--color-muted)]" aria-hidden>
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.9" />
              <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setResults(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && searchMessages()}
              placeholder="Search people, channels, messages"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--color-muted)]"
              aria-label="Search people, channels and messages"
            />
            {q && (
              <button
                type="button"
                onClick={() => {
                  setQ("");
                  setResults(null);
                }}
                aria-label="Clear search"
                className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              >
                <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                  <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </label>
          <button
            type="button"
            onClick={(e) => setNewAnchor(newAnchor ? null : e.currentTarget)}
            title="New message, group or channel"
            aria-label="New message, group or channel"
            aria-haspopup="menu"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-white transition-colors hover:bg-[var(--color-primary-hover)]"
          >
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
              <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          {newAnchor && <PopMenu anchor={newAnchor} items={newItems} onClose={() => setNewAnchor(null)} />}
        </div>
        {/* On a phone the header has no room for the views: they sit here. */}
        <div className="overflow-x-auto sm:hidden">
          <ChatViewTabs view={view} unread={data?.unread} onView={onView} />
        </div>
      </div>

      <div ref={quietScroll} className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {!data ? (
          <div className="space-y-1 p-1.5">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-3 px-1.5 py-2.5">
                <span className="h-10 w-10 animate-pulse rounded-full bg-[var(--color-paper)]" />
                <span className="flex-1 space-y-1.5">
                  <span className="block h-3 w-1/2 animate-pulse rounded bg-[var(--color-paper)]" />
                  <span className="block h-2.5 w-4/5 animate-pulse rounded bg-[var(--color-paper)]" />
                </span>
              </div>
            ))}
          </div>
        ) : results ? (
          <div>
            <div className="flex items-center justify-between px-2.5 pb-1 pt-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">Messages with &ldquo;{q.trim()}&rdquo;</p>
              <button type="button" onClick={() => setResults(null)} className="text-[11.5px] font-medium text-[var(--color-primary)]">
                Back
              </button>
            </div>
            {results.length === 0 && <p className="px-2.5 py-2 text-[12.5px] text-[var(--color-muted)]">No messages match.</p>}
            {results.map((r) => (
              <button key={r.message.id} type="button" onClick={() => onOpenResult(r.conversation.id, r.message)} className="block w-full rounded-xl px-2.5 py-2 text-left hover:bg-[var(--color-paper)]">
                <span className="flex items-baseline gap-2 text-[11.5px] text-[var(--color-muted)]">
                  <span className="min-w-0 flex-1 truncate font-semibold text-[var(--color-ink)]">
                    {r.conversation.title}
                    {r.message.threadId && <span className="font-normal text-[var(--color-muted)]"> · in a thread</span>}
                  </span>
                  {listTime(r.message.createdAt)}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-[var(--color-ink)]">
                  <span className="font-medium">{r.message.author?.id === me ? "You" : r.message.author?.name}:</span> {r.message.body || (r.message.files[0]?.name ?? "")}
                </span>
              </button>
            ))}
          </div>
        ) : view === "threads" ? (
          !threads ? (
            <p className="p-6 text-center text-[12.5px] text-[var(--color-muted)]">Loading your threads…</p>
          ) : shownThreads.length === 0 ? (
            <div className="flex min-h-[200px] items-center justify-center p-8 text-center text-[12.5px] leading-relaxed text-[var(--color-muted)]">{empty}</div>
          ) : (
            shownThreads.map((t) => <ThreadRow key={t.root.id} t={t} me={me} conversation={byId.get(t.conversation.id)} active={activeThread === t.root.id} onOpen={() => onOpenThread(t.conversation.id, t.root.id)} />)
          )
        ) : (
          <>
            {view === "channels" && !words && data.openChannels.length > 0 && (
              <button type="button" onClick={onBrowse} className="flex w-full items-center gap-2.5 rounded-xl py-2 pl-2.5 pr-2.5 text-left transition-colors hover:bg-[var(--color-paper)]">
                <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--color-primary)]/50 text-[var(--color-primary)]">#</span>
                <span className="flex-1 text-[13px] font-medium text-[var(--color-ink)]">Browse channels</span>
                <span className="text-[12px] tabular-nums text-[var(--color-muted)]">{data.openChannels.length} to join</span>
              </button>
            )}
            {shown.length === 0 ? (
              <div className="flex min-h-[200px] items-center justify-center p-8 text-center text-[12.5px] leading-relaxed text-[var(--color-muted)]">{empty}</div>
            ) : (
              shown.map((c) => <Row key={c.id} c={c} me={me} active={c.id === activeId} onOpen={() => onOpen(c.id)} />)
            )}
            {words.length >= 2 && (
              <button type="button" onClick={searchMessages} disabled={searching} className="mt-2 w-full rounded-xl border border-dashed border-[var(--color-line)] px-3 py-2 text-left text-[12.5px] text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]">
                {searching ? "Searching…" : `Search every message for “${q.trim()}”`}
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
