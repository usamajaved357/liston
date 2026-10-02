"use client";

import { useState } from "react";
import { ChatMessage, ChatPerson } from "@/lib/api";
import { PersonAvatar } from "./PersonAvatar";
import { ListonCardView } from "./ListonCardView";
import { FileRow, PhotoGrid } from "./MessageFiles";
import { VoicePlayer } from "./VoiceNote";
import { MenuItem, PopMenu } from "./ChatBubble";
import { LinkPreviews, messageIcons, RichText, systemText } from "./MessageParts";
import { colorFor, timeLabel, whenAgo } from "./inbox-format";

// One team chat message as Slack draws it: flat on white, not a bubble.
// The sender's picture (a rounded square) and name with the time beside it,
// then the message: the one it quotes, its text, Liston cards, photos,
// files, voice note and link previews. The next from the same person
// within a few minutes is just its content, the time in the margin on
// hover. In the conversation, a message with a thread shows who replied,
// how many and when the last came ("View thread" on hover), and a reply
// also sent here says "replied to a thread: …". On hover the row tints and
// a small toolbar floats at its top right (reply in thread, quote, copy,
// edit, delete; a "…" on a touch screen). Lines about the conversation
// itself (someone joined, the topic changed) are quiet rows of their own.

export function FlatMessage({
  message,
  me,
  people,
  compact,
  canDelete,
  place,
  highlight = false,
  inThread = false,
  alsoSentTo = null,
  threadRootText = null,
  onOpenThread,
  onQuote,
  onJumpTo,
  onEdit,
  onDelete,
}: {
  message: ChatMessage;
  me: string;
  people: Map<string, ChatPerson>;
  // The next of a run from one person: no picture or name.
  compact: boolean;
  canDelete: boolean;
  place: { kind: "dm" | "group" | "channel"; title: string };
  // Lit up for a moment (the message a notification opened, or a quote jumped to).
  highlight?: boolean;
  // Drawn in the thread panel: no thread line, no "Reply in thread" or quote.
  inThread?: boolean;
  // "Also sent to #orders" under a thread reply sent to the conversation too.
  alsoSentTo?: string | null;
  // A reply also sent to the conversation: its thread's first message, for "replied to a thread: …".
  threadRootText?: string | null;
  onOpenThread?: (rootId: string) => void;
  onQuote?: () => void;
  onJumpTo?: (messageId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const author = message.author;
  const mine = author?.id === me;
  const text = message.body;
  const photos = message.files.filter((f) => f.image);
  const docs = message.files.filter((f) => !f.image);
  const mentionNames = message.mentions.map((id) => people.get(id)?.name).filter((n): n is string => Boolean(n));
  const myName = people.get(me)?.name || null;
  const canThread = Boolean(onOpenThread) && !inThread && !message.deleted && message.kind === "text";
  const broadcast = !inThread && message.threadId && message.alsoInConversation;

  const actions: MenuItem[] = message.deleted
    ? []
    : [
        ...(canThread ? [{ label: message.threadId ? "Open its thread" : "Reply in thread", icon: messageIcons.thread, onSelect: () => onOpenThread!(message.threadId || message.id) }] : []),
        ...(onQuote && !inThread ? [{ label: "Quote", icon: messageIcons.quote, onSelect: onQuote }] : []),
        ...(text
          ? [
              {
                label: copied ? "Copied" : "Copy text",
                icon: messageIcons.copy,
                onSelect: () => {
                  navigator.clipboard
                    ?.writeText(text)
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    })
                    .catch(() => {});
                },
              },
            ]
          : []),
        ...(mine && text ? [{ label: "Edit", icon: messageIcons.edit, onSelect: onEdit }] : []),
        ...(canDelete ? [{ label: "Delete", icon: messageIcons.delete, onSelect: onDelete, danger: true }] : []),
      ];

  return (
    <div
      className={`group/row relative flex gap-2.5 px-5 transition-colors duration-500 ${highlight ? "bg-amber-50" : "hover:bg-[var(--color-paper)]"} ${compact ? "py-0.5" : "pb-1 pt-2"}`}
      data-message-id={message.id}
    >
      <div className="w-9 flex-shrink-0">
        {compact ? (
          <span className="block pt-[3px] text-right text-[10.5px] leading-4 tabular-nums text-[var(--color-muted)] opacity-0 transition-opacity group-hover/row:opacity-100" title={new Date(message.createdAt).toLocaleString()}>
            {timeLabel(message.createdAt)}
          </span>
        ) : (
          <span className="block pt-0.5">
            <PersonAvatar id={author?.id} name={author?.name} avatarUrl={author?.avatarUrl} size={36} square />
          </span>
        )}
      </div>
      <div className={`min-w-0 flex-1 ${actions.length ? "[@media(hover:none)]:pr-6" : ""}`}>
        {!compact && (
          <p className="flex items-baseline gap-2 leading-5">
            <span className="truncate text-[14px] font-bold text-[var(--color-ink)]">{author?.name || "Someone"}</span>
            <span className="flex-shrink-0 text-[11.5px] tabular-nums text-[var(--color-muted)]" title={new Date(message.createdAt).toLocaleString()}>
              {timeLabel(message.createdAt)}
            </span>
          </p>
        )}
        {broadcast && (
          <button type="button" onClick={() => onOpenThread?.(message.threadId!)} className="group/rt flex max-w-full items-center gap-1 text-left text-[12.5px] leading-5 text-[var(--color-muted)]">
            <span className="flex-shrink-0">replied to a thread{threadRootText ? ":" : ""}</span>
            {threadRootText && <span className="truncate font-medium text-[var(--color-primary)] group-hover/rt:underline">{threadRootText}</span>}
          </button>
        )}
        {message.deleted ? (
          <p className="flex items-center gap-1.5 text-[13.5px] italic leading-[21px] text-[var(--color-muted)]">
            <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
              <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
              <path d="M5 15L15 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            {mine ? "You deleted this message" : "This message was deleted"}
          </p>
        ) : (
          <>
            {message.replyTo && (
              <button
                type="button"
                onClick={() => onJumpTo?.(message.replyTo!.id)}
                className="mb-1 mt-0.5 block max-w-[420px] border-l-[3px] pl-2.5 text-left transition-opacity hover:opacity-80"
                style={{ borderColor: colorFor(message.replyTo.author?.id) }}
              >
                <span className="block truncate text-[12px] font-semibold" style={{ color: colorFor(message.replyTo.author?.id) }}>
                  {message.replyTo.author?.id === me ? "You" : message.replyTo.author?.name || "Someone"}
                </span>
                <span className="line-clamp-2 text-[12.5px] leading-[18px] text-[var(--color-muted)]">{message.replyTo.text}</span>
              </button>
            )}
            {text && (
              <p className="whitespace-pre-wrap break-words text-[14px] leading-[21px] text-[var(--color-ink)] [overflow-wrap:anywhere]">
                <RichText text={text} mentionNames={mentionNames} myName={myName} />
                {message.editedAt && <span className="ml-1 text-[11.5px] text-[var(--color-muted)]">(edited)</span>}
              </p>
            )}
            {message.cards.length > 0 && (
              <div className="mt-1.5 flex max-w-[380px] flex-col gap-1.5">
                {message.cards.map((card) => (
                  <ListonCardView key={card.key} card={card} />
                ))}
              </div>
            )}
            {photos.length > 0 && (
              <div className="mt-1.5 w-fit max-w-full overflow-hidden rounded-lg">
                <PhotoGrid width={300} photos={photos.map((f) => ({ src: f.url, thumb: f.thumbUrl, width: f.width, height: f.height, name: f.name, download: f.url }))} />
              </div>
            )}
            {docs.length > 0 && (
              <div className="mt-1.5 flex flex-col gap-1">
                {docs.map((f) => (
                  <FileRow key={f.id} file={f} />
                ))}
              </div>
            )}
            {message.voice && (
              <div className="mt-1.5 w-fit max-w-full rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)]">
                <VoicePlayer tone="theirs" track={{ id: message.id, url: message.voice.url, durationMs: message.voice.durationMs, peaks: message.voice.peaks, author, mine, conversationId: message.conversationId, threadId: message.threadId, place }} />
              </div>
            )}
            <LinkPreviews links={message.links} />
            {alsoSentTo && (
              <p className="mt-0.5 flex items-center gap-1 text-[12px] text-[var(--color-muted)]">
                <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3" aria-hidden>
                  <path d="M15 10l5 5-5 5M20 15H10a6 6 0 01-6-6V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Also sent to {alsoSentTo}
              </p>
            )}
            {!inThread && message.thread && !message.threadId && <ThreadSummary thread={message.thread} onOpen={() => onOpenThread?.(message.id)} />}
          </>
        )}
      </div>

      {actions.length > 0 && (
        <>
          {/* A pointer: the toolbar on hover. */}
          <div className="absolute -top-3.5 right-4 z-10 hidden items-center gap-px rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5 shadow-[0_4px_12px_-6px_rgba(15,23,42,0.28)] group-focus-within/row:flex group-hover/row:flex [@media(hover:none)]:!hidden">
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={a.onSelect}
                title={a.label}
                aria-label={a.label}
                className={`flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] ${a.danger ? "hover:text-rose-600" : "hover:text-[var(--color-ink)]"}`}
              >
                {a.icon}
              </button>
            ))}
          </div>
          {/* A touch screen: a "…" opening the same. */}
          <button type="button" onClick={(e) => setMenu(menu ? null : e.currentTarget)} aria-label="Message actions" className="absolute right-2 top-1.5 hidden h-7 w-7 items-center justify-center rounded-md text-[var(--color-muted)] [@media(hover:none)]:flex">
            {messageIcons.more}
          </button>
          {menu && <PopMenu anchor={menu} items={actions} onClose={() => setMenu(null)} />}
        </>
      )}
    </div>
  );
}

/** Under a message with a thread, as Slack has it: faces, "3 replies", "Last reply 5 minutes ago" (on hover "View thread ›"). */
function ThreadSummary({ thread, onOpen }: { thread: NonNullable<ChatMessage["thread"]>; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group/ts -ml-1.5 mt-1 flex w-full max-w-[520px] items-center gap-2 rounded-lg border border-transparent px-1.5 py-1 text-left transition-colors hover:border-[var(--color-line)] hover:bg-[var(--color-panel)]">
      <span className="flex flex-shrink-0 gap-1">
        {thread.people.slice(0, 4).map((p) => (
          <PersonAvatar key={p.id} id={p.id} name={p.name} avatarUrl={p.avatarUrl} size={22} square />
        ))}
      </span>
      <span className="flex-shrink-0 text-[13px] font-semibold text-[var(--color-primary)] group-hover/ts:underline">
        {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
      </span>
      {thread.lastReplyAt && (
        <>
          <span className="min-w-0 truncate text-[12.5px] text-[var(--color-muted)] group-hover/ts:hidden">Last reply {whenAgo(thread.lastReplyAt)}</span>
          <span className="hidden text-[12.5px] text-[var(--color-muted)] group-hover/ts:inline">View thread</span>
        </>
      )}
      <svg viewBox="0 0 20 20" fill="none" className="ml-auto hidden h-4 w-4 flex-shrink-0 text-[var(--color-muted)] group-hover/ts:block" aria-hidden>
        <path d="M8 5.5l4.5 4.5L8 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** A line about the conversation itself ("Sara added Tom"), quiet, in the messages' column. */
export function SystemRow({ message, people }: { message: ChatMessage; people: Map<string, ChatPerson> }) {
  const text = systemText(message, people);
  if (!text) return null;
  return (
    <div className="flex gap-2.5 px-5 py-1.5">
      <span className="flex w-9 flex-shrink-0 justify-end pt-[3px] text-[var(--color-muted)]">
        <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
          <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10 9v4.5M10 6.5v.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
      <p className="text-[13px] leading-5 text-[var(--color-muted)]">
        {text} <span className="ml-1 text-[11.5px] tabular-nums">{timeLabel(message.createdAt)}</span>
      </p>
    </div>
  );
}

/** The day, as Slack marks it: a rule across with the day in a pill. */
export function DayDivider({ label }: { label: string }) {
  return (
    <div className="relative flex items-center justify-center px-5 py-3" role="separator" aria-label={label}>
      <span className="absolute inset-x-5 top-1/2 h-px bg-[var(--color-line)]" />
      <span className="relative rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-3.5 py-1 text-[12px] font-semibold text-[var(--color-ink)]/80">{label}</span>
    </div>
  );
}

/** Where you'd read to: a red rule with "New" at its end. */
export function NewDivider() {
  return (
    <div className="flex items-center gap-2 px-5 py-1.5" role="separator" aria-label="New messages">
      <span className="h-px flex-1 bg-rose-400" />
      <span className="text-[11.5px] font-semibold text-rose-500">New</span>
    </div>
  );
}
