"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, ChatConversation, ChatMessage, inboxApi, SharedFile } from "@/lib/api";
import { PillTabs } from "@/components/PillTabs";
import { useMyEvents } from "@/lib/useMyEvents";
import { useQuietScrollbar } from "@/lib/useQuietScrollbar";
import { FileIcon, PhotoViewer } from "./MessageFiles";
import { fileSize, listTime } from "./inbox-format";

// A conversation's "Files and links" tab, as Slack has it: everything
// shared in it, newest first. Photos as a grid (a click opens the viewer),
// files and links as rows with who shared them and when; each can be shown
// where it was said (in the conversation, or its thread). Kept live as
// things are shared.

type Filter = "all" | "photos" | "files" | "links";
type Item =
  | { kind: "photo"; key: string; file: SharedFile; message: ChatMessage }
  | { kind: "file"; key: string; file: SharedFile; message: ChatMessage }
  | { kind: "link"; key: string; link: ChatMessage["links"][number]; message: ChatMessage };

export function ConversationFiles({ conversation, me, onShow }: { conversation: ChatConversation; me: string; onShow: (message: ChatMessage) => void }) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [viewing, setViewing] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const scrollRef = useQuietScrollbar(scroller);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    inboxApi
      .chatConversationFiles(conversation.id)
      .then((r) => {
        setMessages(r.messages);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load what's been shared."));
  }, [conversation.id]);

  useEffect(() => {
    load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  useMyEvents(
    (e) => {
      if (e.conversationId !== conversation.id || (e.type !== "chat.message" && e.type !== "chat.updated")) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 400);
    },
    load
  );

  const items = useMemo(() => {
    const out: Item[] = [];
    for (const m of messages || []) {
      for (const f of m.files) out.push(f.image ? { kind: "photo", key: f.id, file: f, message: m } : { kind: "file", key: f.id, file: f, message: m });
      for (const l of m.links) out.push({ kind: "link", key: `${m.id}:${l.url}`, link: l, message: m });
    }
    return out;
  }, [messages]);
  const photos = items.filter((i): i is Extract<Item, { kind: "photo" }> => i.kind === "photo");
  const files = items.filter((i): i is Extract<Item, { kind: "file" }> => i.kind === "file");
  const links = items.filter((i): i is Extract<Item, { kind: "link" }> => i.kind === "link");
  const who = (m: ChatMessage) => (m.author?.id === me ? "You" : m.author?.name || "Someone");

  const showPhotos = filter === "all" || filter === "photos";
  const showFiles = filter === "all" || filter === "files";
  const showLinks = filter === "all" || filter === "links";
  const nothing = (showPhotos ? photos.length : 0) + (showFiles ? files.length : 0) + (showLinks ? links.length : 0) === 0;

  const heading = (text: string) => <h4 className="px-5 pb-1.5 pt-4 text-[12px] font-bold uppercase tracking-wide text-[var(--color-muted)]">{text}</h4>;
  const show = (m: ChatMessage) => (
    <button type="button" onClick={() => onShow(m)} className="flex-shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-[var(--color-primary)] opacity-0 transition-opacity hover:bg-[var(--color-primary-soft)] focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
      Show
    </button>
  );

  return (
    <div ref={scrollRef} className="scroll-quiet min-h-0 flex-1 overflow-y-auto bg-[var(--color-panel)] pb-6">
      {error ? (
        <p className="px-6 py-10 text-center text-[12.5px] text-[var(--color-muted)]">{error}</p>
      ) : !messages ? (
        <div className="flex h-full items-center justify-center">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-label="Loading" />
        </div>
      ) : (
        <>
          {items.length > 0 && (
            <div className="px-5 pt-3">
              <PillTabs
                label="What to show"
                value={filter}
                onChange={setFilter}
                tabs={[
                  { key: "all", label: "All", count: items.length },
                  { key: "photos", label: "Photos", count: photos.length },
                  { key: "files", label: "Files", count: files.length },
                  { key: "links", label: "Links", count: links.length },
                ]}
              />
            </div>
          )}

          {items.length === 0 || nothing ? (
            <div className="flex min-h-[60%] flex-col items-center justify-center px-8 py-12 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
                  <path d="M7 3h7l5 5v12a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                </svg>
              </span>
              <p className="mt-3 text-[14px] font-semibold text-[var(--color-ink)]">Nothing shared {items.length ? "of this kind " : ""}yet</p>
              <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-[var(--color-muted)]">Photos, files and links shared in {conversation.title} show here, newest first.</p>
            </div>
          ) : (
            <>
              {showPhotos && photos.length > 0 && (
                <section>
                  {heading("Photos")}
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1.5 px-5">
                    {photos.map((p, i) => (
                      <button key={p.key} type="button" onClick={() => setViewing(i)} title={`${p.file.name} · ${who(p.message)}, ${listTime(p.message.createdAt)}`} className="group relative aspect-square overflow-hidden rounded-lg bg-[var(--color-paper)]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.file.thumbUrl || p.file.url} alt={p.file.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]" />
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {showFiles && files.length > 0 && (
                <section>
                  {heading("Files")}
                  <ul>
                    {files.map((f) => (
                      <li key={f.key} className="group flex items-center gap-3 px-5 py-2 transition-colors hover:bg-[var(--color-paper)]">
                        <FileIcon mime={f.file.mime} />
                        <a href={f.file.url} target="_blank" rel="noopener" className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-semibold text-[var(--color-ink)] hover:text-[var(--color-primary)]">{f.file.name}</span>
                          <span className="block truncate text-[12px] text-[var(--color-muted)]">
                            {who(f.message)} · {listTime(f.message.createdAt)}
                            {f.file.size ? ` · ${fileSize(f.file.size)}` : ""}
                          </span>
                        </a>
                        {show(f.message)}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {showLinks && links.length > 0 && (
                <section>
                  {heading("Links")}
                  <ul>
                    {links.map((l) => {
                      let host = l.link.site || "";
                      try {
                        host = host || new URL(l.link.url).hostname.replace(/^www\./, "");
                      } catch {}
                      return (
                        <li key={l.key} className="group flex items-center gap-3 px-5 py-2 transition-colors hover:bg-[var(--color-paper)]">
                          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-paper)] text-[13px] font-bold uppercase text-[var(--color-muted)]">
                            {l.link.image ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={l.link.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
                            ) : (
                              host.slice(0, 1)
                            )}
                          </span>
                          <a href={l.link.url} target="_blank" rel="noopener noreferrer nofollow" className="min-w-0 flex-1">
                            <span className="block truncate text-[13.5px] font-semibold text-[var(--color-ink)] hover:text-[var(--color-primary)]">{l.link.title || l.link.url}</span>
                            <span className="block truncate text-[12px] text-[var(--color-muted)]">
                              {host} · {who(l.message)} · {listTime(l.message.createdAt)}
                            </span>
                          </a>
                          {show(l.message)}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </>
          )}
        </>
      )}
      <PhotoViewer photos={photos.map((p) => ({ src: p.file.url, thumb: p.file.thumbUrl, width: p.file.width, height: p.file.height, name: p.file.name, download: p.file.url }))} index={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
