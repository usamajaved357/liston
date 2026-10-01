"use client";

import { ReactNode, useState } from "react";
import { ChatMessage, ChatPerson } from "@/lib/api";
import { PersonAvatar } from "./PersonAvatar";
import { ListonCardView } from "./ListonCardView";
import { FileRow, PhotoGrid } from "./MessageFiles";
import { BUBBLE_MAX, Bubble, BubbleRow, BubbleText, MenuItem, Meta, NoteChip, PopMenu, Ticks } from "./ChatBubble";
import { VoicePlayer } from "./VoiceNote";
import { colorFor, listTime, timeLabel } from "./inbox-format";

// One message in team chat, as a bubble drawn like the eBay Inbox's (a
// crisp edge, the same spacing): the other side's on the left (in a group
// their picture and name on the first of a run), yours on the right,
// tinted, with ticks that turn blue once everyone it went to has read it.
// Inside it, top to bottom: the message it quotes, its Liston cards, its
// photos as an album, its files, a voice note's player, its text with the
// time in the corner, then previews of links to other sites. The text
// keeps its line breaks; links open in a new tab; @mentions stand out;
// **bold**, _italic_, ~struck~ and `code` are drawn so. Under a message
// with a thread: who replied, how many, when the last came, opening it.
// On hover a round button beside the bubble replies in its thread; a
// chevron in its corner opens the rest (quote, copy, edit, delete).

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** The text with links, @mentions, `code`, **bold**, _italic_ and ~struck~ made so. */
export function RichText({ text, mentionNames = [] }: { text: string; mentionNames?: string[] }) {
  const names = [...new Set(mentionNames.filter(Boolean))].sort((a, b) => b.length - a.length);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokens = new RegExp(
    `${URL_RE.source}|(@(?:channel|everyone|here)\\b${names.length ? `|@(?:${names.map(escape).join("|")})` : ""})|(\`[^\`\\n]+\`)|(\\*\\*[^*\\n]+\\*\\*)|((?<![\\w*])_[^_\\n]+_(?![\\w]))|((?<![\\w~])~[^~\\n]+~(?![\\w]))`,
    "gi"
  );
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(tokens)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const [whole, url, mention, code, bold, italic, strike] = m;
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
    else if (italic) out.push(<em key={key++}>{italic.slice(1, -1)}</em>);
    else if (strike) out.push(<s key={key++}>{strike.slice(1, -1)}</s>);
    else out.push(whole);
    last = m.index! + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

const icons = {
  thread: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path d="M4.5 6.5A2.5 2.5 0 017 4h10a2.5 2.5 0 012.5 2.5v6A2.5 2.5 0 0117 15h-5.5l-4 3.5V15H7a2.5 2.5 0 01-2.5-2.5v-6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M8.5 8.5h7M8.5 11.5h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  quote: (
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

/** Previews of links to other sites, inside the bubble under its text. */
function LinkPreviews({ links }: { links: ChatMessage["links"] }) {
  if (!links.length) return null;
  return (
    <div className="flex flex-col gap-[3px] px-[3px] pb-[3px]">
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="flex w-[300px] max-w-full overflow-hidden rounded-md border-l-[3px] border-[var(--color-primary)]/50 bg-black/[0.04] transition-colors hover:bg-black/[0.07]">
          <span className="min-w-0 flex-1 px-2.5 py-2">
            {l.site && <span className="block truncate text-[11px] font-semibold text-[var(--color-muted)]">{l.site}</span>}
            {l.title && <span className="line-clamp-2 block text-[12.5px] font-semibold leading-[17px] text-[var(--color-primary)]">{l.title}</span>}
            {l.description && <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-4 text-[var(--color-muted)]">{l.description}</span>}
          </span>
          {l.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={l.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-auto w-[72px] flex-shrink-0 object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
          )}
        </a>
      ))}
    </div>
  );
}

/** Under a message with a thread: who replied, how many replies, when the last came; opens it. */
export function ThreadLine({ thread, mine, onOpen, unread = 0 }: { thread: NonNullable<ChatMessage["thread"]>; mine: boolean; onOpen: () => void; unread?: number }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`mt-1 flex max-w-full items-center gap-1.5 rounded-lg border border-transparent bg-[var(--color-panel)]/80 py-1 pl-1 pr-2.5 text-left shadow-[var(--shadow-bubble)] transition-colors hover:border-[var(--color-line)] hover:bg-[var(--color-panel)] ${mine ? "self-end" : "self-start"}`}
    >
      <span className="flex -space-x-1.5">
        {thread.people.slice(0, 3).map((p) => (
          <span key={p.id} className="rounded-full ring-2 ring-[var(--color-panel)]">
            <PersonAvatar id={p.id} name={p.name} avatarUrl={p.avatarUrl} size={20} />
          </span>
        ))}
      </span>
      <span className="text-[12px] font-semibold text-[var(--color-primary)]">
        {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
      </span>
      {unread > 0 && <span className="rounded-full bg-[var(--color-primary)] px-1.5 text-[10px] font-semibold leading-4 text-white">{unread} new</span>}
      {thread.lastReplyAt && <span className="truncate text-[11.5px] text-[var(--color-muted)]">Last reply {listTime(thread.lastReplyAt).toLowerCase()}</span>}
    </button>
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
  onOpenThread,
  inThread = false,
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
  // Opens this message's thread (or, for a reply also sent to the conversation, the thread it's in).
  onOpenThread?: (rootId: string) => void;
  // Drawn in the thread panel: no thread line under it, no "Reply in thread".
  inThread?: boolean;
  highlight?: boolean;
}) {
  const author = message.author;
  const mentionNames = message.mentions.map((id) => people.get(id)?.name).filter((n): n is string => Boolean(n));
  const photos = message.files.filter((f) => f.image);
  const docs = message.files.filter((f) => !f.image);
  const text = message.body.trimEnd();
  const inGroup = showAuthorName && !mine;
  const threadRoot = message.threadId || message.id;
  const canThread = Boolean(onOpenThread) && !inThread && !message.deleted && message.kind === "text";
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
        ...(canThread ? [{ label: message.threadId ? "Open its thread" : "Reply in thread", onSelect: () => onOpenThread!(threadRoot), icon: icons.thread }] : []),
        ...(!inThread ? [{ label: "Quote", onSelect: onReply, icon: icons.quote }] : []),
        ...(message.body ? [{ label: "Copy text", onSelect: () => navigator.clipboard?.writeText(message.body).catch(() => {}), icon: icons.copy }] : []),
        ...(mine && message.body ? [{ label: "Edit", onSelect: onEdit, icon: icons.edit }] : []),
        ...(canDelete ? [{ label: "Delete", onSelect: onDelete, icon: icons.delete, danger: true }] : []),
      ];
  const onlyPhotos = photos.length > 0 && !docs.length && !text && !message.voice && !message.links.length;
  // A voice note with nothing under it carries the time and ticks itself, under its wave.
  const voiceMeta = Boolean(message.voice) && !text;

  // The round "reply in thread" button beside the bubble, on hover.
  const threadButton = canThread && !message.threadId && (
    <button
      type="button"
      onClick={() => onOpenThread!(message.id)}
      aria-label="Reply in thread"
      title="Reply in thread"
      className="mx-1.5 flex h-7 w-7 flex-shrink-0 items-center justify-center self-center rounded-full bg-[var(--color-panel)] text-[var(--color-muted)] opacity-0 shadow-[var(--shadow-bubble)] transition-opacity hover:text-[var(--color-primary)] focus-visible:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:hidden"
    >
      {icons.thread}
    </button>
  );

  return (
    <BubbleRow mine={mine} first={first} roomy className={`group/msg ${highlight ? "animate-[pulse_1.2s_ease-in-out_2]" : ""}`} data-message-id={message.id}>
      {inGroup && <div className="mr-1.5 w-7 flex-shrink-0">{first && <PersonAvatar id={author?.id} name={author?.name} avatarUrl={author?.avatarUrl} size={28} />}</div>}
      {mine && threadButton}
      <div className={`flex min-w-0 flex-col ${BUBBLE_MAX} ${mine ? "items-end" : "items-start"}`}>
        {message.threadId && message.alsoInConversation && !inThread && (
          <button type="button" onClick={() => onOpenThread?.(message.threadId!)} className="mb-0.5 px-1 text-[11px] font-medium text-[var(--color-muted)] hover:text-[var(--color-primary)]">
            Replied in a thread
          </button>
        )}
        <Bubble mine={mine} tail={first} sharp>
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
                  <PhotoGrid photos={photos.map((f) => ({ src: f.url, thumb: f.thumbUrl, width: f.width, height: f.height, name: f.name, download: f.url }))} overlay={onlyPhotos ? <Meta onPhoto>{meta}</Meta> : undefined} />
                </div>
              )}
              {docs.length > 0 && (
                <div className="flex flex-col gap-[3px] p-[3px]">
                  {docs.map((f) => (
                    <FileRow key={f.id} file={f} />
                  ))}
                </div>
              )}
              {message.voice && <VoicePlayer voice={message.voice} mine={mine} author={author} meta={voiceMeta ? <Meta>{meta}</Meta> : undefined} />}
              {text ? (
                <BubbleText meta={meta}>
                  <RichText text={text} mentionNames={mentionNames} />
                </BubbleText>
              ) : onlyPhotos || voiceMeta ? null : (
                <div className="flex justify-end px-[8px] pb-[5px] pt-0.5">
                  <Meta>{meta}</Meta>
                </div>
              )}
              <LinkPreviews links={message.links} />
            </>
          )}
        </Bubble>
        {!inThread && message.thread && !message.threadId && <ThreadLine thread={message.thread} mine={mine} onOpen={() => onOpenThread?.(message.id)} />}
      </div>
      {!mine && threadButton}
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
