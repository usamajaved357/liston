"use client";

import { useMemo, useState } from "react";
import { ChatConversation, ChatList, ChatMessage, inboxApi } from "@/lib/api";
import { useQuietScrollbar } from "@/lib/useQuietScrollbar";
import { PersonAvatar } from "./PersonAvatar";
import { MenuItem, PopMenu } from "./ChatBubble";
import { messageIcons } from "./MessageParts";
import { listTime } from "./inbox-format";
import { LockIcon } from "./ChatThread";

// Team chat's sidebar, as Slack's: "Team chat" with a new-message button,
// "Find a conversation…" (names as you type; Enter searches every
// message), Threads (the ones you follow, with how many replies are new),
// then Channels (by name) and Direct messages (the latest first), each a
// section that folds away and can add to itself: a channel shows "#" (a
// lock when private), a person their picture, a group how many are in it.
// What's unread is bold, with a red count where it's for you (a direct
// message, a mention); a muted one is greyed. The open one is filled.

const FOLD_KEY = "liston.chatSections";

function readFolded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) || "{}");
  } catch {
    return {};
  }
}

function Row({ c, me, active, onOpen }: { c: ChatConversation; me: string; active: boolean; onOpen: () => void }) {
  const muted = c.notify === "none";
  const unread = c.unread > 0 && !muted;
  const forYou = unread && (c.kind === "dm" || c.unreadMentions > 0);
  const other = c.kind === "dm" ? c.members.find((m) => m.id !== me) || c.members[0] : null;
  const name = c.kind === "channel" ? c.title.slice(1) : c.title;
  const tone = active ? "text-white" : unread ? "font-bold text-[var(--color-ink)]" : muted ? "text-[var(--color-muted)]/70" : "text-[var(--color-ink)]/75";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      title={c.account ? `${c.title} · ${c.account.label}` : c.title}
      className={`group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[14px] transition-colors ${active ? "bg-[var(--color-primary)]" : "hover:bg-black/[0.05]"}`}
    >
      <span className={`flex w-5 flex-shrink-0 items-center justify-center ${active ? "text-white" : "text-[var(--color-ink)]/55"}`}>
        {c.kind === "channel" ? (
          c.private ? (
            <LockIcon className="h-[15px] w-[15px]" />
          ) : (
            <span className="text-[16px] font-medium leading-none">#</span>
          )
        ) : c.kind === "dm" ? (
          <PersonAvatar id={other?.id} name={other?.name || c.title} avatarUrl={other?.avatarUrl} size={20} online={other?.online} square />
        ) : (
          <span className={`flex h-5 w-5 items-center justify-center rounded-[5px] text-[10.5px] font-bold ${active ? "bg-white/25 text-white" : "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"}`}>{c.members.length}</span>
        )}
      </span>
      <span className={`min-w-0 flex-1 truncate ${tone}`}>{name}</span>
      {c.account && !active && <span className="hidden flex-shrink-0 text-[11px] text-[var(--color-muted)] group-hover:inline">{c.account.label}</span>}
      {muted && <span className={active ? "text-white/80" : "text-[var(--color-muted)]/70"}>{messageIcons.bellOff}</span>}
      {forYou && (
        <span className={`flex h-[18px] min-w-[18px] flex-shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold ${active ? "bg-white text-[var(--color-primary)]" : "bg-rose-500 text-white"}`}>
          {c.kind === "dm" ? (c.unread > 99 ? "99+" : c.unread) : c.unreadMentions > 99 ? "99+" : c.unreadMentions}
        </span>
      )}
    </button>
  );
}

function Section({ id, title, folded, onFold, action, children }: { id: string; title: string; folded: boolean; onFold: (id: string) => void; action?: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <div className="group flex h-7 items-center gap-1 pr-1">
        <button type="button" onClick={() => onFold(id)} aria-expanded={!folded} className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-0.5 text-left text-[13.5px] font-semibold text-[var(--color-ink)]/70 hover:bg-black/[0.05]">
          <svg viewBox="0 0 20 20" fill="none" className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${folded ? "-rotate-90" : ""}`} aria-hidden>
            <path d="M5.5 8l4.5 4.5L14.5 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {title}
        </button>
        {action && (
          <button type="button" onClick={action.onClick} title={action.label} aria-label={action.label} className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-muted)] opacity-0 transition-opacity hover:bg-black/[0.06] hover:text-[var(--color-ink)] focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
              <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      {!folded && <div className="mt-0.5 space-y-px">{children}</div>}
    </section>
  );
}

/** A quiet row at a section's end: "Add channels", "New message". */
function AddRow({ label, onClick }: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[14px] text-[var(--color-ink)]/60 transition-colors hover:bg-black/[0.05] hover:text-[var(--color-ink)]">
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[5px] bg-black/[0.06]">
        <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" aria-hidden>
          <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </span>
      {label}
    </button>
  );
}

export function ConversationList({
  data,
  me,
  activeId,
  threadsActive,
  onOpen,
  onShowThreads,
  onNewChat,
  onNewChannel,
  onBrowse,
  onOpenResult,
}: {
  data: ChatList | null;
  me: string;
  activeId: string | null;
  // The Threads page is what's open.
  threadsActive: boolean;
  onOpen: (id: string) => void;
  onShowThreads: () => void;
  onNewChat: () => void;
  onNewChannel: () => void;
  onBrowse: () => void;
  onOpenResult: (conversationId: string, message: ChatMessage) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ message: ChatMessage; conversation: { id: string; title: string } }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [folded, setFolded] = useState<Record<string, boolean>>(readFolded);
  const quietScroll = useQuietScrollbar<HTMLDivElement>();
  const words = q.trim().toLowerCase();

  const matches = (c: ChatConversation) => !words || c.title.toLowerCase().includes(words) || c.members.some((m) => m.name.toLowerCase().includes(words));
  const channels = useMemo(
    () => (data?.conversations || []).filter((c) => c.kind === "channel" && matches(c)).sort((a, b) => a.title.localeCompare(b.title)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, words]
  );
  const direct = useMemo(
    () =>
      (data?.conversations || [])
        .filter((c) => c.kind !== "channel" && matches(c))
        .sort((a, b) => new Date(b.lastMessage?.at || 0).getTime() - new Date(a.lastMessage?.at || 0).getTime()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, words]
  );

  function fold(id: string) {
    setFolded((f) => {
      const next = { ...f, [id]: !f[id] };
      try {
        localStorage.setItem(FOLD_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

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

  const addItems: MenuItem[] = [
    ...(data?.canManageChannels ? [{ label: "Create a channel", onSelect: onNewChannel }] : []),
    ...(data && (data.openChannels.length > 0 || data.canManageChannels) ? [{ label: data.openChannels.length ? `Browse channels (${data.openChannels.length} to join)` : "Browse channels", onSelect: onBrowse }] : []),
  ];
  const threadsNew = data?.unread.threads || 0;

  return (
    <aside className="flex min-h-0 w-full flex-col border-r border-[var(--color-line)] bg-[var(--color-paper)] lg:w-[268px] lg:flex-shrink-0">
      <div className="flex h-[52px] flex-shrink-0 items-center gap-2 pl-4 pr-3">
        <h2 className="min-w-0 flex-1 truncate text-[16px] font-bold text-[var(--color-ink)]">Workspace chat</h2>
        <button type="button" onClick={onNewChat} title="New message" aria-label="New message" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-ink)]/75 transition-colors hover:border-[var(--color-primary)]/40 hover:text-[var(--color-primary)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
            <path d="M12 5H6.5A2.5 2.5 0 004 7.5v10A2.5 2.5 0 006.5 20h10a2.5 2.5 0 002.5-2.5V12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M17.5 3.5l3 3L12 15l-4 1 1-4 8.5-8.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className="flex-shrink-0 px-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-2.5 transition-shadow focus-within:border-[var(--color-primary)]/50 focus-within:shadow-[0_0_0_3px_var(--color-primary-soft)]">
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
            placeholder="Find a conversation…"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--color-muted)]"
            aria-label="Find a conversation, or press Enter to search every message"
          />
          {q && (
            <button
              type="button"
              onClick={() => {
                setQ("");
                setResults(null);
              }}
              aria-label="Clear"
              className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </label>
      </div>

      <div ref={quietScroll} className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
        {!data ? (
          <div className="space-y-2 px-2 pt-2">
            {[70, 55, 80, 60, 45, 75].map((w, i) => (
              <span key={i} className="block h-4 animate-pulse rounded bg-black/[0.06]" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : results ? (
          <div>
            <div className="flex items-center justify-between px-2 pb-1 pt-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">Messages with &ldquo;{q.trim()}&rdquo;</p>
              <button type="button" onClick={() => setResults(null)} className="text-[11.5px] font-medium text-[var(--color-primary)]">
                Back
              </button>
            </div>
            {results.length === 0 && <p className="px-2 py-2 text-[12.5px] text-[var(--color-muted)]">No messages match.</p>}
            {results.map((r) => (
              <button key={r.message.id} type="button" onClick={() => onOpenResult(r.conversation.id, r.message)} className="block w-full rounded-lg px-2 py-2 text-left hover:bg-black/[0.05]">
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
        ) : (
          <>
            {!words && (
              <button
                type="button"
                onClick={onShowThreads}
                aria-current={threadsActive ? "page" : undefined}
                className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[14px] transition-colors ${threadsActive ? "bg-[var(--color-primary)] text-white" : threadsNew ? "font-bold text-[var(--color-ink)] hover:bg-black/[0.05]" : "text-[var(--color-ink)]/75 hover:bg-black/[0.05]"}`}
              >
                <span className={`flex w-5 justify-center ${threadsActive ? "text-white" : "text-[var(--color-ink)]/60"}`}>{messageIcons.thread}</span>
                <span className="flex-1">Threads</span>
                {threadsNew > 0 && <span className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold ${threadsActive ? "bg-white text-[var(--color-primary)]" : "bg-rose-500 text-white"}`}>{threadsNew > 99 ? "99+" : threadsNew}</span>}
              </button>
            )}

            <Section id="channels" title="Channels" folded={Boolean(folded.channels) && !words} onFold={fold} action={addItems.length ? { label: "Add channels", onClick: (e) => setAddAnchor(addAnchor ? null : e.currentTarget) } : undefined}>
              {channels.map((c) => (
                <Row key={c.id} c={c} me={me} active={c.id === activeId} onOpen={() => onOpen(c.id)} />
              ))}
              {!words && addItems.length > 0 && <AddRow label="Add channels" onClick={(e) => setAddAnchor(addAnchor ? null : e.currentTarget)} />}
              {!words && channels.length === 0 && addItems.length === 0 && <p className="px-2 py-1 text-[12.5px] text-[var(--color-muted)]">No channels yet.</p>}
            </Section>

            <Section id="direct" title="Direct messages" folded={Boolean(folded.direct) && !words} onFold={fold} action={{ label: "New message", onClick: onNewChat }}>
              {direct.map((c) => (
                <Row key={c.id} c={c} me={me} active={c.id === activeId} onOpen={() => onOpen(c.id)} />
              ))}
              {!words && <AddRow label="New message" onClick={onNewChat} />}
            </Section>

            {words && channels.length + direct.length === 0 && <p className="px-2 pt-4 text-[12.5px] text-[var(--color-muted)]">No conversation by that name.</p>}
            {words.length >= 2 && (
              <button type="button" onClick={searchMessages} disabled={searching} className="mt-3 w-full rounded-lg border border-dashed border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-left text-[12.5px] text-[var(--color-primary)] hover:border-[var(--color-primary)]/40">
                {searching ? "Searching…" : `Search every message for “${q.trim()}”`}
              </button>
            )}
          </>
        )}
      </div>
      {addAnchor && <PopMenu anchor={addAnchor} items={addItems} onClose={() => setAddAnchor(null)} align="left" />}
    </aside>
  );
}
