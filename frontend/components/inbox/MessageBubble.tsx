"use client";

import { ReactNode, useState } from "react";
import { ChatMessage, ChatPerson } from "@/lib/api";
import { PersonAvatar } from "./PersonAvatar";
import { ListonCardView } from "./ListonCardView";
import { FileRow, PhotoGrid } from "./MessageFiles";
import { BUBBLE_MAX, Bubble, BubbleRow, BubbleText, MenuItem, Meta, NoteChip, PopMenu, Ticks } from "./ChatBubble";
import { colorFor, timeLabel } from "./inbox-format";

// One message in team chat, as a WhatsApp bubble: the other side's on the
// left (in a group their picture and name on the first of a run), yours on
// the right, tinted, with ticks that turn blue once everyone it went to has
// read it. Inside it, top to bottom: the message it replies to, its Liston
// cards, its photos as an album, its files, then its text with the time in
// the corner. The text keeps its line breaks, links open in a new tab,
// @mentions of people stand out. A chevron in the corner opens its actions.

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** The text with links, @mentions, `code` and **bold** made so. */
export function RichText({ text, mentionNames = [] }: { text: string; mentionNames?: string[] }) {
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
        <a key={key++} href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-[var(--color-primary)] underline underline-offset-2">
          {url}
        </a>
      );
    else if (mention)
      out.push(
        <span key={key++} className="font-semibold text-[var(--color-primary)]">
          {mention}
        </span>
      );
    else if (code)
      out.push(
        <code key={key++} className="rounded bg-black/[0.06] px-1 py-px font-mono text-[0.92em]">
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

const icons = {
  reply: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path d="M10 8L5 12l5 4M5 12h9a5 5 0 015 5v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  copy: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 15V6a1 1 0 011-1h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path d="M5 19h4l10-10-4-4L5 15v4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  ),
  delete: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

/** The chevron in a bubble's top corner (on hover; always on a touch screen), opening its actions. */
function BubbleActions({ mine, items }: { mine: boolean; items: MenuItem[] }) {
  // The open menu's button (null: closed).
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = Boolean(anchor);
  if (!items.length) return null;
  return (
    <>
      <button
        type="button"
        onClick={(e) => setAnchor(open ? null : e.currentTarget)}
        aria-label="Message actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`absolute right-1 top-1 z-10 flex h-6 w-7 items-center justify-end rounded-md pr-0.5 text-[var(--color-bubble-meta)] transition-opacity hover:text-[var(--color-ink)] [@media(hover:none)]:opacity-100 ${open ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100 focus-visible:opacity-100"} ${
          mine ? "bg-[radial-gradient(circle_at_70%_50%,var(--color-bubble-out)_55%,transparent_75%)]" : "bg-[radial-gradient(circle_at_70%_50%,var(--color-panel)_55%,transparent_75%)]"
        }`}
      >
        <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
          <path d="M5.5 8l4.5 4.5L14.5 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {anchor && <PopMenu anchor={anchor} items={items} onClose={() => setAnchor(null)} align={mine ? "right" : "left"} />}
    </>
  );
}

export function MessageBubble({
  message,
  me,
  mine,
  first,
  people,
  showAuthorName,
  read = null,
  canDelete,
  onReply,
  onEdit,
  onDelete,
  onJumpTo,
  highlight = false,
}: {
  message: ChatMessage;
  me: string;
  mine: boolean;
  // The first of a run from one person: the tail, and in a group their name and picture.
  first: boolean;
  people: Map<string, ChatPerson>;
  showAuthorName: boolean;
  // Your messages: whether everyone it went to has read it (null: no ticks).
  read?: boolean | null;
  canDelete: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onJumpTo: (id: string) => void;
  highlight?: boolean;
}) {
  const author = message.author;
  const mentionNames = message.mentions.map((id) => people.get(id)?.name).filter((n): n is string => Boolean(n));
  const photos = message.files.filter((f) => f.image);
  const docs = message.files.filter((f) => !f.image);
  const text = message.body.trimEnd();
  const inGroup = showAuthorName && !mine;
  const meta = (
    <>
      {message.editedAt && !message.deleted && <span>Edited</span>}
      <span>{timeLabel(message.createdAt)}</span>
      {mine && read !== null && !message.deleted && <Ticks read={read} />}
    </>
  );
  const actions: MenuItem[] = message.deleted
    ? []
    : [
        { label: "Reply", onSelect: onReply, icon: icons.reply },
        ...(message.body ? [{ label: "Copy text", onSelect: () => navigator.clipboard?.writeText(message.body).catch(() => {}), icon: icons.copy }] : []),
        ...(mine && message.body ? [{ label: "Edit", onSelect: onEdit, icon: icons.edit }] : []),
        ...(canDelete ? [{ label: "Delete", onSelect: onDelete, icon: icons.delete, danger: true }] : []),
      ];

  return (
    <BubbleRow mine={mine} first={first} className={`group/msg ${highlight ? "animate-[pulse_1.2s_ease-in-out_2]" : ""}`} data-message-id={message.id}>
      {inGroup && <div className="mr-1.5 w-7 flex-shrink-0">{first && <PersonAvatar id={author?.id} name={author?.name} avatarUrl={author?.avatarUrl} size={28} />}</div>}
      <div className={`flex min-w-0 flex-col ${BUBBLE_MAX} ${mine ? "items-end" : "items-start"}`}>
        <Bubble mine={mine} tail={first}>
          <BubbleActions mine={mine} items={actions} />
          {first && inGroup && (
            <p className="truncate px-[9px] pt-[5px] text-[12.5px] font-semibold leading-4" style={{ color: colorFor(author?.id) }}>
              {author?.name || "Someone"}
            </p>
          )}
          {message.deleted ? (
            <BubbleText meta={meta} className="italic text-[var(--color-muted)]">
              <span className="inline-flex items-center gap-1.5 align-middle">
                <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 not-italic" aria-hidden>
                  <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M5 15L15 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                {mine ? "You deleted this message" : "This message was deleted"}
              </span>
            </BubbleText>
          ) : (
            <>
              {message.replyTo && (
                <button
                  type="button"
                  onClick={() => onJumpTo(message.replyTo!.id)}
                  className="mx-[3px] mt-[3px] block w-[calc(100%-6px)] min-w-[180px] overflow-hidden rounded-md border-l-4 bg-black/[0.05] px-2 py-1.5 text-left transition-colors hover:bg-black/[0.08]"
                  style={{ borderColor: colorFor(message.replyTo.author?.id) }}
                >
                  <span className="block truncate text-[12px] font-semibold leading-4" style={{ color: colorFor(message.replyTo.author?.id) }}>
                    {message.replyTo.author?.id === me ? "You" : message.replyTo.author?.name || "Someone"}
                  </span>
                  <span className="line-clamp-2 text-[12.5px] leading-[17px] text-[var(--color-muted)]">{message.replyTo.text}</span>
                </button>
              )}
              {message.cards.length > 0 && (
                <div className="flex flex-col gap-[3px] p-[3px]">
                  {message.cards.map((card) => (
                    <ListonCardView key={card.key} card={card} />
                  ))}
                </div>
              )}
              {photos.length > 0 && (
                <div className="p-[3px]">
                  <PhotoGrid
                    photos={photos.map((f) => ({ src: f.url, thumb: f.thumbUrl, width: f.width, height: f.height, name: f.name, download: f.url }))}
                    overlay={!text && !docs.length ? <Meta onPhoto>{meta}</Meta> : undefined}
                  />
                </div>
              )}
              {docs.length > 0 && (
                <div className="flex flex-col gap-[3px] p-[3px]">
                  {docs.map((f) => (
                    <FileRow key={f.id} file={f} />
                  ))}
                </div>
              )}
              {text ? (
                <BubbleText meta={meta}>
                  <RichText text={text} mentionNames={mentionNames} />
                </BubbleText>
              ) : photos.length && !docs.length ? null : (
                <div className="flex justify-end px-[8px] pb-[5px] pt-0.5">
                  <Meta>{meta}</Meta>
                </div>
              )}
            </>
          )}
        </Bubble>
      </div>
    </BubbleRow>
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
    <NoteChip>
      {text} · {timeLabel(message.createdAt)}
    </NoteChip>
  );
}
