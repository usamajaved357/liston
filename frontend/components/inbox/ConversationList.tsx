"use client";

import { useMemo, useState } from "react";
import { ChatConversation, ChatList, inboxApi, ChatMessage } from "@/lib/api";
import { PersonAvatar } from "./PersonAvatar";
import { listTime } from "./inbox-format";
import { LockIcon } from "./ChatThread";

// Team chat's left pane: channels, then direct messages and groups, newest
// first, each with its last line, when it was said, and how much is unread
// (an "@" when it's for you). The box at the top narrows the list by name;
// Enter searches every message. "+" starts a direct message or a group;
// the owner (or Manage channels) makes channels; anyone browses the public
// ones to join.

function Row({ c, me, active, onOpen }: { c: ChatConversation; me: string; active: boolean; onOpen: () => void }) {
  const other = c.kind === "dm" ? c.members.find((m) => m.id !== me) : null;
  const last = c.lastMessage;
  const who = last?.author ? (last.author.id === me ? "You: " : c.kind === "dm" ? "" : `${last.author.name.split(" ")[0]}: `) : "";
  const unread = c.unread > 0 && c.notify !== "none";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors ${active ? "bg-[var(--color-primary-soft)]" : "hover:bg-[var(--color-paper)]"}`}
      aria-current={active ? "true" : undefined}
    >
      {c.kind === "dm" ? (
        <PersonAvatar id={other?.id} name={other?.name || c.title} avatarUrl={other?.avatarUrl} size={34} online={other?.online} />
      ) : (
        <span className={`flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-xl text-[14px] font-bold ${active ? "bg-[var(--color-panel)] text-[var(--color-primary)]" : "bg-[var(--color-paper)] text-[var(--color-muted)]"}`}>
          {c.kind === "channel" ? c.private ? <LockIcon className="h-3.5 w-3.5" /> : "#" : c.members.length}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-[13.5px] ${unread ? "font-semibold text-[var(--color-ink)]" : "font-medium text-[var(--color-ink)]"}`}>{c.kind === "channel" ? c.title.slice(1) : c.title}</span>
          {last && <span className={`flex-shrink-0 text-[11px] ${unread ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`}>{listTime(last.at)}</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={`min-w-0 flex-1 truncate text-[12px] ${unread ? "text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>
            {last ? (last.kind === "system" ? "" : `${who}${last.text || ""}`) : c.kind === "channel" ? c.topic || "No messages yet" : "No messages yet"}
          </span>
          {c.notify === "none" && (
            <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-muted)]" aria-label="Muted">
              <path d="M6 9h3l4-4v14l-4-4H6V9zM17 9l4 6M21 9l-4 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {unread && (
            <span className={`min-w-[18px] flex-shrink-0 rounded-full px-1.5 text-center text-[10.5px] font-semibold leading-[18px] text-white ${c.unreadMentions > 0 || c.kind === "dm" ? "bg-rose-500" : "bg-[var(--color-primary)]"}`}>
              {c.unreadMentions > 0 && c.kind !== "dm" ? "@" : c.unread > 99 ? "99+" : c.unread}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-3 first:mt-1">
      <div className="flex items-center justify-between px-2.5 pb-1">
        <p className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">{title}</p>
        {action}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

const plus = (
  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
    <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export function ConversationList({
  data,
  me,
  activeId,
  onOpen,
  onNewChat,
  onNewChannel,
  onBrowse,
  onOpenResult,
}: {
  data: ChatList | null;
  me: string;
  activeId: string | null;
  onOpen: (id: string) => void;
  onNewChat: () => void;
  onNewChannel: () => void;
  onBrowse: () => void;
  onOpenResult: (conversationId: string, messageId: string) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ message: ChatMessage; conversation: { id: string; title: string } }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const words = q.trim().toLowerCase();

  const { channels, direct } = useMemo(() => {
    const all = (data?.conversations || []).filter((c) => !words || c.title.toLowerCase().includes(words) || c.members.some((m) => m.name.toLowerCase().includes(words)));
    return { channels: all.filter((c) => c.kind === "channel"), direct: all.filter((c) => c.kind !== "channel") };
  }, [data, words]);

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

  return (
    <aside className="flex min-h-0 w-full flex-col border-r border-[var(--color-line)] bg-[var(--color-panel)] lg:w-[300px] lg:flex-shrink-0">
      <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-1.5 focus-within:border-[var(--color-primary)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 flex-shrink-0 text-[var(--color-muted)]" aria-hidden>
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setResults(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && searchMessages()}
            placeholder="Find a person, channel or message"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--color-muted)]"
            aria-label="Find a person, channel or message"
          />
          {q && (
            <button type="button" onClick={() => { setQ(""); setResults(null); }} aria-label="Clear" className="text-[var(--color-muted)] hover:text-[var(--color-ink)]">
              <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        <button type="button" onClick={onNewChat} title="New message" aria-label="New message" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
            <path d="M5 19h4l10-10-4-4L5 15v4zM13 7l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!data ? (
          <div className="space-y-2 p-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-xl bg-[var(--color-paper)]" />
            ))}
          </div>
        ) : results ? (
          <Section title={`Messages with “${q.trim()}”`} action={<button type="button" onClick={() => setResults(null)} className="text-[11.5px] font-medium text-[var(--color-primary)]">Back</button>}>
            {results.length === 0 && <p className="px-2.5 py-2 text-[12.5px] text-[var(--color-muted)]">No messages match.</p>}
            {results.map((r) => (
              <button key={r.message.id} type="button" onClick={() => onOpenResult(r.conversation.id, r.message.id)} className="rounded-xl px-2.5 py-2 text-left hover:bg-[var(--color-paper)]">
                <span className="flex items-baseline gap-2 text-[11.5px] text-[var(--color-muted)]">
                  <span className="min-w-0 flex-1 truncate font-semibold text-[var(--color-ink)]">{r.conversation.title}</span>
                  {listTime(r.message.createdAt)}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-[var(--color-ink)]">
                  <span className="font-medium">{r.message.author?.id === me ? "You" : r.message.author?.name}:</span> {r.message.body || (r.message.files[0]?.name ?? "")}
                </span>
              </button>
            ))}
          </Section>
        ) : (
          <>
            <Section
              title="Channels"
              action={
                <span className="flex items-center gap-1">
                  {(data.openChannels.length > 0 || data.canManageChannels) && (
                    <button type="button" onClick={onBrowse} className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]">
                      {data.openChannels.length ? `Browse ${data.openChannels.length}` : "Browse"}
                    </button>
                  )}
                  {data.canManageChannels && (
                    <button type="button" onClick={onNewChannel} title="New channel" aria-label="New channel" className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
                      {plus}
                    </button>
                  )}
                </span>
              }
            >
              {channels.length === 0 && <p className="px-2.5 py-1.5 text-[12px] text-[var(--color-muted)]">{words ? "No channel matches." : data.canManageChannels ? "No channels yet. Make one for a team or an account." : data.openChannels.length ? "Join a channel to see it here." : "No channels yet."}</p>}
              {channels.map((c) => (
                <Row key={c.id} c={c} me={me} active={c.id === activeId} onOpen={() => onOpen(c.id)} />
              ))}
            </Section>
            <Section
              title="Direct messages"
              action={
                <button type="button" onClick={onNewChat} title="New message or group" aria-label="New message or group" className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
                  {plus}
                </button>
              }
            >
              {direct.length === 0 && <p className="px-2.5 py-1.5 text-[12px] text-[var(--color-muted)]">{words ? "Nobody matches." : "Message anyone in your team with +."}</p>}
              {direct.map((c) => (
                <Row key={c.id} c={c} me={me} active={c.id === activeId} onOpen={() => onOpen(c.id)} />
              ))}
            </Section>
            {words.length >= 2 && (
              <button type="button" onClick={searchMessages} disabled={searching} className="mt-3 w-full rounded-xl border border-dashed border-[var(--color-line)] px-3 py-2 text-left text-[12.5px] text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]">
                {searching ? "Searching…" : `Search all messages for “${q.trim()}”`}
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
