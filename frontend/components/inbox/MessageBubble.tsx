"use client";

import { ReactNode } from "react";
import { ChatMessage, ChatPerson } from "@/lib/api";
import { PersonAvatar } from "./PersonAvatar";
import { ListonCardView } from "./ListonCardView";
import { MessageFiles } from "./MessageFiles";
import { timeLabel } from "./inbox-format";

// One message in team chat, as a bubble: the other side's on the left with
// their initial (shown on the last of a run), yours on the right in the
// brand colour, a run of messages from one person within a few minutes
// grouped with the tail on the last. The text keeps its line breaks, links
// open in a new tab, @mentions of people in it stand out; the message it
// replies to sits at the top; its Liston cards and files follow it. Hovering
// shows its actions.

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** The text with links, @mentions, `code` and **bold** made so. */
export function RichText({ text, mentionNames = [], onBrand = false }: { text: string; mentionNames?: string[]; onBrand?: boolean }) {
  const names = [...new Set(mentionNames.filter(Boolean))].sort((a, b) => b.length - a.length);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokens = new RegExp(
    `${URL_RE.source}|(@(?:channel|everyone|here)\\b${names.length ? `|@(?:${names.map(escape).join("|")})` : ""})|(\`[^\`\\n]+\`)|(\\*\\*[^*\\n]+\\*\\*)`,
    "gi"
  );
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(tokens)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const [whole, url, mention, code, bold] = m;
    if (url)
      out.push(
        <a key={key++} href={url} target="_blank" rel="noopener noreferrer nofollow" className={`underline underline-offset-2 break-all ${onBrand ? "text-white" : "text-[var(--color-primary)]"}`}>
          {url}
        </a>
      );
    else if (mention)
      out.push(
        <span key={key++} className={`rounded px-0.5 font-semibold ${onBrand ? "bg-white/20 text-white" : "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"}`}>
          {mention}
        </span>
      );
    else if (code)
      out.push(
        <code key={key++} className={`rounded px-1 py-px font-mono text-[0.92em] ${onBrand ? "bg-white/15" : "bg-[var(--color-paper)]"}`}>
          {code.slice(1, -1)}
        </code>
      );
    else if (bold) out.push(<strong key={key++}>{bold.slice(2, -2)}</strong>);
    else out.push(whole);
    last = m.index! + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

function Action({ label, onClick, children, danger = false }: { label: string; onClick: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className={`flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-paper)] ${danger ? "hover:text-rose-600" : "hover:text-[var(--color-ink)]"}`}>
      {children}
    </button>
  );
}

export function MessageBubble({
  message,
  mine,
  first,
  last,
  people,
  showAuthorName,
  seen,
  canDelete,
  onReply,
  onEdit,
  onDelete,
  onJumpTo,
  highlight = false,
}: {
  message: ChatMessage;
  mine: boolean;
  // The first and last of a run from one person (name above the first, avatar and tail on the last).
  first: boolean;
  last: boolean;
  people: Map<string, ChatPerson>;
  showAuthorName: boolean;
  // "Seen" under your last message in a direct message, once they've read it.
  seen?: string | null;
  canDelete: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onJumpTo: (id: string) => void;
  highlight?: boolean;
}) {
  const author = message.author;
  const mentionNames = message.mentions.map((id) => people.get(id)?.name).filter((n): n is string => Boolean(n));
  const side = mine ? "items-end" : "items-start";
  const hasText = Boolean(message.body) || message.deleted;
  const radius = mine ? `rounded-[18px] ${last ? "rounded-br-md" : ""}` : `rounded-[18px] ${last ? "rounded-bl-md" : ""}`;
  // The time sits in the bubble's corner ("edited" beside it); a message with no text shows it under its files.
  const stamp = `${timeLabel(message.createdAt)}${message.editedAt && !message.deleted ? " · edited" : ""}`;

  return (
    <div className={`group/msg relative flex items-end gap-2 px-5 ${mine ? "flex-row-reverse" : ""} ${first ? "mt-3" : "mt-0.5"} ${highlight ? "animate-[pulse_1.2s_ease-in-out_2]" : ""}`} data-message-id={message.id}>
      {!mine && <div className="w-7 flex-shrink-0">{last && <PersonAvatar id={author?.id} name={author?.name} avatarUrl={author?.avatarUrl} size={28} />}</div>}
      <div className={`flex min-w-0 max-w-[min(460px,68%)] flex-col gap-1 ${side}`}>
        {first && showAuthorName && !mine && <p className="px-3 text-[11px] font-semibold text-[var(--color-muted)]">{author?.name || "Someone"}</p>}
        {hasText && (
          <div
            className={`relative ${radius} px-3 py-[7px] text-[13px] leading-[1.45] ${
              message.deleted
                ? "border border-dashed border-[var(--color-line)] bg-transparent italic text-[var(--color-muted)]"
                : mine
                  ? "bg-[var(--color-primary)] text-white"
                  : "bg-[var(--color-panel)] text-[var(--color-ink)] shadow-[0_1px_1px_rgba(15,23,42,0.06),0_0_0_1px_rgba(15,23,42,0.04)]"
            }`}
          >
            {message.replyTo && !message.deleted && (
              <button
                type="button"
                onClick={() => onJumpTo(message.replyTo!.id)}
                className={`mb-1.5 block w-full rounded-lg border-l-[3px] px-2 py-1 text-left text-[12px] ${mine ? "border-white/60 bg-white/15 text-white/90" : "border-[var(--color-primary)] bg-[var(--color-paper)] text-[var(--color-muted)]"}`}
              >
                <span className={`block font-semibold ${mine ? "text-white" : "text-[var(--color-ink)]"}`}>{message.replyTo.author?.name || "Someone"}</span>
                <span className="line-clamp-2">{message.replyTo.text}</span>
              </button>
            )}
            <span className="flex flex-wrap items-end justify-end gap-x-2">
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message.deleted ? "Message deleted" : <RichText text={message.body} mentionNames={mentionNames} onBrand={mine} />}</span>
              <span className={`flex-shrink-0 translate-y-[2px] text-[10px] not-italic tabular-nums leading-none ${mine && !message.deleted ? "text-white/70" : "text-[var(--color-muted)]"}`}>{stamp}</span>
            </span>
          </div>
        )}
        {message.cards.length > 0 && (
          <div className={`flex w-full flex-col gap-1.5 ${side}`}>
            {message.cards.map((card) => (
              <ListonCardView key={card.key} card={card} />
            ))}
          </div>
        )}
        <MessageFiles files={message.files} align={mine ? "right" : "left"} />
        {(!hasText || seen) && (
          <p className="px-1 text-[10px] text-[var(--color-muted)]">
            {!hasText ? stamp : ""}
            {!hasText && seen ? " · " : ""}
            {seen || ""}
          </p>
        )}
      </div>
      {!message.deleted && (
        <div className={`pointer-events-none absolute -top-3 z-10 flex items-center gap-0.5 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5 opacity-0 shadow-sm transition-opacity group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 ${mine ? "right-14" : "left-14"}`}>
          <Action label="Reply" onClick={onReply}>
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
              <path d="M10 8L5 12l5 4M5 12h9a5 5 0 015 5v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Action>
          {message.body && (
            <Action label="Copy text" onClick={() => navigator.clipboard?.writeText(message.body).catch(() => {})}>
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                <rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                <path d="M5 15V6a1 1 0 011-1h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </Action>
          )}
          {mine && (
            <Action label="Edit" onClick={onEdit}>
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                <path d="M5 19h4l10-10-4-4L5 15v4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              </svg>
            </Action>
          )}
          {canDelete && (
            <Action label="Delete" onClick={onDelete} danger>
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Action>
          )}
        </div>
      )}
    </div>
  );
}

/** A line about the conversation itself: "Sara added Tom", "Owen renamed the channel to #orders". */
export function SystemLine({ message, people }: { message: ChatMessage; people: Map<string, ChatPerson> }) {
  const d = message.detail;
  const who = (id?: string | null) => (id ? people.get(id)?.name || "Someone" : "Someone");
  const list = (ids?: string[]) => {
    const names = (ids || []).map((id) => who(id));
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] || "someone";
  };
  const by = who(d.by);
  const text =
    {
      created_channel: `${by} made this channel`,
      created_group: `${by} started this group`,
      added: `${by} added ${list(d.userIds)}`,
      removed: `${by} took ${list(d.userIds)} out`,
      joined: `${by} joined`,
      left: `${by} left`,
      renamed: d.to ? `${by} renamed it to ${d.from !== undefined ? "#" : ""}${d.to}` : `${by} took the name off`,
      topic: d.to ? `${by} set the topic: ${d.to}` : `${by} cleared the topic`,
      archived: `${by} archived this channel`,
      unarchived: `${by} brought this channel back`,
    }[d.action || ""] || "";
  if (!text) return null;
  return (
    <p className="my-2 px-6 text-center text-[11.5px] text-[var(--color-muted)]">
      {text} · {timeLabel(message.createdAt)}
    </p>
  );
}
