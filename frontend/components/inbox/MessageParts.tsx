"use client";

import { ReactNode } from "react";
import { ChatMessage, ChatPerson } from "@/lib/api";
import { plainOf } from "./inbox-format";

// The pieces a team chat message is drawn with, wherever it shows (the
// conversation, a thread, the Threads page): its text with links,
// @mentions and formatting; the icons of its actions; previews of links to
// other sites; a line of it for lists; and what a system line says.

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/**
 * The text with [words](links), bare links, @mentions (a highlight, yellow
 * when it names you or everyone, as Slack has it), `code`, **bold**,
 * _italic_ and ~struck~ made so.
 */
export function RichText({ text, mentionNames = [], myName = null }: { text: string; mentionNames?: string[]; myName?: string | null }) {
  const names = [...new Set(mentionNames.filter(Boolean))].sort((a, b) => b.length - a.length);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokens = new RegExp(
    `\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)|${URL_RE.source}|(@(?:channel|everyone|here)\\b${names.length ? `|@(?:${names.map(escape).join("|")})` : ""})|(\`[^\`\\n]+\`)|(\\*\\*[^*\\n]+\\*\\*)|((?<![\\w*])_[^_\\n]+_(?![\\w]))|((?<![\\w~])~[^~\\n]+~(?![\\w]))`,
    "gi"
  );
  const mine = myName ? `@${myName}`.toLowerCase() : null;
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(tokens)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const [whole, linkText, linkUrl, url, mention, code, bold, italic, strike] = m;
    if (linkText && linkUrl)
      out.push(
        <a key={key++} href={linkUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-[var(--color-primary)] underline-offset-2 hover:underline">
          {linkText}
        </a>
      );
    else if (url)
      out.push(
        <a key={key++} href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-[var(--color-primary)] underline-offset-2 hover:underline">
          {url}
        </a>
      );
    else if (mention) {
      const forMe = /^@(channel|everyone|here)$/i.test(mention) || mention.toLowerCase() === mine;
      out.push(
        <span key={key++} className={`rounded-[4px] px-[3px] py-px font-medium ${forMe ? "bg-amber-100 text-amber-900" : "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"}`}>
          {mention}
        </span>
      );
    } else if (code)
      out.push(
        <code key={key++} className="rounded-[4px] border border-[var(--color-line)] bg-[var(--color-paper)] px-1 py-px font-mono text-[0.88em] text-rose-700">
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

const icon = (paths: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
    {paths}
  </svg>
);

export const messageIcons = {
  thread: icon(
    <>
      <path d="M4.5 6.5A2.5 2.5 0 017 4h10a2.5 2.5 0 012.5 2.5v6A2.5 2.5 0 0117 15h-5.5l-4 3.5V15H7a2.5 2.5 0 01-2.5-2.5v-6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M8.5 8.5h7M8.5 11.5h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  quote: icon(<path d="M10 8L5 12l5 4M5 12h9a5 5 0 015 5v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />),
  copy: icon(
    <>
      <rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 15V6a1 1 0 011-1h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  edit: icon(<path d="M5 19h4l10-10-4-4L5 15v4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />),
  delete: icon(<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />),
  more: (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <circle cx="4.5" cy="10" r="1.5" fill="currentColor" />
      <circle cx="10" cy="10" r="1.5" fill="currentColor" />
      <circle cx="15.5" cy="10" r="1.5" fill="currentColor" />
    </svg>
  ),
  bell: icon(<path d="M6 16.5V11a6 6 0 1112 0v5.5l1.5 2h-15l1.5-2zM10 20.5a2 2 0 004 0" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />),
  bellOff: icon(
    <>
      <path d="M6 16.5V11a6 6 0 1112 0v5.5l1.5 2h-15l1.5-2zM10 20.5a2 2 0 004 0" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  link: icon(<path d="M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66l-1 1M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1-1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />),
};

/** Previews of links to other sites, under a message's text. */
export function LinkPreviews({ links }: { links: ChatMessage["links"] }) {
  if (!links.length) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="group/link flex w-[420px] max-w-full overflow-hidden border-l-4 border-[var(--color-line)] pl-3 transition-colors hover:border-[var(--color-primary)]/40">
          <span className="min-w-0 flex-1 py-0.5">
            {l.site && <span className="block truncate text-[12px] font-semibold text-[var(--color-ink)]">{l.site}</span>}
            {l.title && <span className="line-clamp-2 block text-[13px] font-semibold leading-[18px] text-[var(--color-primary)] group-hover/link:underline">{l.title}</span>}
            {l.description && <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-[18px] text-[var(--color-muted)]">{l.description}</span>}
          </span>
          {l.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={l.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="ml-3 h-[72px] w-[72px] flex-shrink-0 rounded-md object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
          )}
        </a>
      ))}
    </div>
  );
}

/** A message in a line: its text without formatting marks, else what it is ("Voice message", "A photo"…). */
export function snippetOf(m: ChatMessage): string {
  if (m.deleted) return "Message deleted";
  const text = plainOf(m.body).replace(/\s+/g, " ").trim();
  if (text) return text;
  if (m.voice) return "Voice message";
  if (m.files.some((f) => f.image)) return "A photo";
  if (m.files.length) return "A file";
  if (m.cards.length) return "A Liston card";
  return "";
}

/** What a line about the conversation itself says: "Sara added Tom", "Owen renamed it to #orders" (empty for one it doesn't know). */
export function systemText(message: ChatMessage, people: Map<string, ChatPerson>): string {
  const d = message.detail;
  const who = (id?: string | null) => (id ? people.get(id)?.name || "Someone" : "Someone");
  const list = (ids?: string[]) => {
    const names = (ids || []).map((id) => who(id));
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] || "someone";
  };
  const by = who(d.by);
  return (
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
    }[d.action || ""] || ""
  );
}
