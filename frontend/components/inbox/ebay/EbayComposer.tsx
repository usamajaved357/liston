"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ApiError, EbayMessage, EbayNote, EbayThread, QuickReply, SharedFile, ebayInboxApi, uploadFile } from "@/lib/api";
import { useIsPhone } from "@/lib/useIsPhone";
import { fileSize } from "../inbox-format";
import { fillReply, matchReplies, replyFacts, unfilled } from "./quick-replies";

// Replying to a buyer: text up to eBay's 2,000 characters (Enter sends and
// Shift+Enter starts a new line, as in WhatsApp; on a phone Enter is a new
// line and the arrow sends), up to 5 photos, PDFs, Word documents or text
// files (attached, dropped or pasted), uploaded for eBay at once. "@" puts
// the buyer's name where it's typed (Backspace straight after gives the
// "@" back); "/" (or the quick-replies button) lists the account's quick
// replies by name, and picking one loads it, filled in, into the box to
// read and change; a fill-in the conversation can't complete ({tracking}
// before there is any) stays in the text and the box won't send until it's
// filled in. Anything eBay blocks or flags (contact details, links off eBay,
// paying outside eBay) is shown before it goes, with "Send anyway". A real
// message to a real buyer: it goes only when Enter or Send is pressed.
// The note button switches the box to a note for the team (amber, its own
// text so a note can't go to the buyer by mistake): it's kept in Liston
// and shown among the messages, never sent to eBay.

const MAX = 2000;
const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,application/pdf,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";
type Pending = { key: string; name: string; size: number; progress: number; file?: SharedFile; error?: string; preview?: string };

// What's being written to each buyer (and each note), kept while you move between conversations.
const drafts = new Map<string, string>();
const noteDrafts = new Map<string, string>();
// Each account's quick replies as last read, shown at once while they're read again.
const replyCache = new Map<string, { replies: QuickReply[]; canEdit: boolean }>();

// The quick replies open: from "/" typed at `start` (with what's typed after it), or from the button (start -1).
type Slash = { start: number; query: string; index: number };

export function EbayComposer({
  connectionId,
  conversationId,
  buyer,
  thread,
  onSent,
  onNoted,
}: {
  connectionId: string;
  conversationId: string;
  buyer: string | null;
  thread: EbayThread;
  onSent: (m: EbayMessage) => void;
  onNoted?: (n: EbayNote) => void;
}) {
  const key = `${connectionId}~${conversationId}`;
  // Writing a note for the team instead of a reply.
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState(() => noteDrafts.get(key) || "");
  const noteArea = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => drafts.get(key) || "");
  const [pending, setPending] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<{ kind: string; text: string }[] | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const phone = useIsPhone();
  const [slash, setSlash] = useState<Slash | null>(null);
  // The name "@" just put in, so Backspace straight after gives the "@" back.
  const [named, setNamed] = useState<{ start: number; end: number } | null>(null);
  // Where the cursor goes once the text it's in has rendered.
  const caret = useRef<number | null>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const facts = useMemo(() => replyFacts(thread), [thread]);
  const name = facts.buyer || buyer || "there";
  const [quick, setQuick] = useState(() => replyCache.get(connectionId) || null);
  const replies = quick?.replies || [];
  const options = slash ? matchReplies(replies, slash.query) : [];
  // From the button it opens even with nothing to show (to say where replies are made).
  const menuOpen = Boolean(slash) && (options.length > 0 || slash?.start === -1);
  const missing = unfilled(text);

  useEffect(() => {
    let live = true;
    ebayInboxApi
      .quickReplies(connectionId)
      .then((q) => {
        const next = { replies: q.replies, canEdit: q.canEdit };
        replyCache.set(connectionId, next);
        if (live) setQuick(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connectionId]);

  useEffect(() => {
    drafts.set(key, text);
  }, [key, text]);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
    if (caret.current !== null) {
      el.focus();
      el.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [text]);
  useEffect(() => {
    if (slash) optionRefs.current[slash.index]?.scrollIntoView({ block: "nearest" });
  }, [slash]);

  // "/" at the start of a word, with what's typed after it up to the cursor (a short run, no new line).
  function slashAt(value: string, at: number): Slash | null {
    const before = value.slice(0, at);
    const i = before.lastIndexOf("/");
    if (i < 0 || (i > 0 && !/\s/.test(before[i - 1]))) return null;
    const query = before.slice(i + 1);
    if (query.length > 30 || /\n/.test(query) || !matchReplies(replies, query).length) return null;
    return { start: i, query, index: slash && slash.start === i && slash.query === query ? slash.index : 0 };
  }

  function onType(value: string, at: number) {
    setNamed(null);
    // "@" typed where a word starts: the buyer's name in its place.
    if (value.length === text.length + 1 && value[at - 1] === "@" && (at === 1 || !/[\p{L}\p{N}]/u.test(value[at - 2]))) {
      setText(`${value.slice(0, at - 1)}${name}${value.slice(at)}`.slice(0, MAX + 200));
      caret.current = at - 1 + name.length;
      setNamed({ start: at - 1, end: at - 1 + name.length });
      setSlash(null);
      return;
    }
    setText(value);
    if (warnings) setWarnings(null);
    setSlash(slashAt(value, at));
  }

  function pick(reply: QuickReply) {
    const body = fillReply(reply.body, facts);
    const el = area.current;
    const from = slash && slash.start >= 0 ? slash.start : (el?.selectionStart ?? text.length);
    const to = slash && slash.start >= 0 ? slash.start + 1 + slash.query.length : (el?.selectionEnd ?? from);
    const before = text.slice(0, from);
    const after = text.slice(to);
    // Into an empty box (or one with only the "/" in it) it's the whole message.
    const next = before.trim() || after.trim() ? `${before}${body}${after}` : body;
    setText(next);
    caret.current = before.trim() || after.trim() ? before.length + body.length : body.length;
    setSlash(null);
    setNamed(null);
  }

  function addFiles(files: File[]) {
    const room = 5 - pending.length;
    if (room <= 0) {
      setError("eBay takes up to 5 attachments in a message.");
      return;
    }
    for (const file of files.slice(0, room)) {
      const k = `${Date.now()}-${Math.random()}`;
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setPending((p) => [...p, { key: k, name: file.name || "file", size: file.size, progress: 0, preview }]);
      uploadFile(file, { purpose: "ebay", onProgress: (share) => setPending((p) => p.map((x) => (x.key === k ? { ...x, progress: share } : x))) })
        .then((saved) => setPending((p) => p.map((x) => (x.key === k ? { ...x, progress: 1, file: saved } : x))))
        .catch((err) => setPending((p) => p.map((x) => (x.key === k ? { ...x, error: err instanceof ApiError ? err.message : "Couldn't upload it." } : x))));
    }
  }

  const uploading = pending.some((p) => !p.file && !p.error);
  const placeholder = phone ? `Reply to ${buyer || "the buyer"}` : `Reply to ${buyer || "the buyer"}  ·  "/" for quick replies, "@" for their name`;
  const canSend = text.trim().length > 0 && text.length <= MAX && !uploading && !sending && missing.length === 0;

  async function send(confirm = false) {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const out = await ebayInboxApi.reply(connectionId, conversationId, { text, fileIds: pending.filter((p) => p.file).map((p) => p.file!.id), confirm });
      if (!out.sent) {
        setWarnings(out.warnings);
        return;
      }
      setWarnings(null);
      setText("");
      drafts.delete(key);
      pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
      setPending([]);
      onSent(out.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send it. Nothing went to the buyer.");
    } finally {
      setSending(false);
    }
  }

  async function saveNote() {
    if (!note.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const out = await ebayInboxApi.addNote(connectionId, conversationId, note);
      setNote("");
      noteDrafts.delete(key);
      onNoted?.(out.note);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add the note.");
    } finally {
      setSending(false);
    }
  }

  if (noting) {
    return (
      <div className="relative border-t border-amber-200 bg-amber-50/60 px-3 py-2">
        <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
          <p className="text-[11.5px] font-semibold text-amber-800">Internal note · the buyer won&apos;t see it</p>
          <button
            type="button"
            onClick={() => {
              setNoting(false);
              setError(null);
              setTimeout(() => area.current?.focus(), 0);
            }}
            className="text-[11.5px] font-medium text-[var(--color-primary)] hover:underline"
          >
            Back to replying
          </button>
        </div>
        <div className="flex items-end gap-1 rounded-[22px] border border-amber-300 bg-white py-1 pl-3 pr-1 focus-within:shadow-[0_0_0_3px_rgb(251_191_36/0.25)]">
          <textarea
            ref={noteArea}
            rows={1}
            autoFocus
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              noteDrafts.set(key, e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(200, e.target.scrollHeight)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setNoting(false);
              if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey || (!e.shiftKey && !phone))) {
                e.preventDefault();
                saveNote();
              }
            }}
            placeholder="What everyone here should know: a supplier's answer, what was agreed…"
            className="max-h-[200px] min-h-[32px] flex-1 resize-none bg-transparent px-1 py-[6px] text-[13px] leading-[1.45] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
            aria-label="Internal note"
          />
          <button
            type="button"
            onClick={saveNote}
            disabled={!note.trim() || sending || note.length > 2000}
            title="Add the note (Enter)"
            className="flex h-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-500 px-3.5 text-[12px] font-semibold text-white transition-colors hover:bg-amber-600 disabled:bg-[var(--color-line)] disabled:text-[var(--color-muted)]"
          >
            {sending ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden /> : "Add note"}
          </button>
        </div>
        {error && <p className="mt-1.5 px-3 text-[11.5px] text-rose-600">{error}</p>}
      </div>
    );
  }

  return (
    <div
      className="relative border-t border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2"
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) {
          e.preventDefault();
          addFiles(files);
        }
      }}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData?.files || []);
        if (files.length) {
          e.preventDefault();
          addFiles(files);
        }
      }}
    >
      {menuOpen && slash && (
        <div className="absolute bottom-full left-3 right-3 z-20 mb-2 max-w-[480px] overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-pop)]">
          <div className="flex items-center justify-between gap-3 px-4 pb-1.5 pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">Quick replies</p>
            {!phone && options.length > 0 && <p className="text-[11px] text-[var(--color-muted)]">Enter to use · Esc to close</p>}
          </div>
          {options.length > 0 ? (
            <div className="max-h-[min(340px,50vh)] overflow-y-auto px-1.5 pb-1.5" role="listbox" aria-label="Quick replies">
              {options.map((r, i) => {
                const preview = fillReply(r.body, facts).replace(/^Hi [^\n]*\n+/, "").replace(/\s+/g, " ");
                const active = i === slash.index;
                return (
                  <button
                    key={r.id}
                    ref={(el) => {
                      optionRefs.current[i] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSlash({ ...slash, index: i })}
                    onClick={() => pick(r)}
                    className={`block w-full rounded-xl px-2.5 py-2 text-left transition-colors ${active ? "bg-[var(--color-primary-soft)]" : ""}`}
                  >
                    <span className={`block truncate text-[13px] font-semibold ${active ? "text-[var(--color-primary)]" : "text-[var(--color-ink)]"}`}>{r.name}</span>
                    <span className="mt-0.5 line-clamp-2 text-[12px] leading-[17px] text-[var(--color-muted)]">{preview}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="px-4 pb-3 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{quick ? "No quick replies yet." : "Loading your quick replies…"}</p>
          )}
          {quick?.canEdit && (
            <Link href={`/accounts/${connectionId}/settings?tab=messages`} target="_blank" rel="noopener" onMouseDown={(e) => e.preventDefault()} className="flex items-center justify-between border-t border-[var(--color-line)] px-4 py-2.5 text-[12.5px] font-medium text-[var(--color-primary)] hover:bg-[var(--color-paper)]">
              {replies.length ? "Edit or add quick replies" : "Add quick replies in Settings"}
              <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" aria-hidden>
                <path d="M8 5h7v7M15 5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          )}
        </div>
      )}
      {warnings && (
        <div className="mb-2.5 rounded-2xl bg-amber-50 p-3 ring-1 ring-inset ring-amber-200">
          <p className="text-[12.5px] font-semibold text-amber-900">eBay may block or flag this message</p>
          <ul className="mt-1 space-y-0.5 text-[12px] leading-snug text-amber-800">
            {warnings.map((w) => (
              <li key={w.kind}>• {w.text}</li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => setWarnings(null)} className="btn btn-secondary btn-sm">
              Edit it
            </button>
            <button type="button" onClick={() => send(true)} disabled={sending} className="btn btn-ghost btn-sm text-amber-900">
              Send anyway
            </button>
          </div>
        </div>
      )}
      {pending.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((p) => (
            <div key={p.key} className={`relative flex w-[190px] items-center gap-2 rounded-xl border bg-[var(--color-panel)] p-1.5 ${p.error ? "border-rose-300" : "border-[var(--color-line)]"}`}>
              {p.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.preview} alt="" className="h-9 w-9 flex-shrink-0 rounded-lg object-cover" />
              ) : (
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-soft)] text-[10.5px] font-semibold uppercase text-[var(--color-primary)]">{(p.name.split(".").pop() || "file").slice(0, 4)}</span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-[var(--color-ink)]">{p.name}</span>
                {p.error ? (
                  <span className="block truncate text-[11px] text-rose-600" title={p.error}>
                    {p.error}
                  </span>
                ) : p.file ? (
                  <span className="block text-[11px] text-[var(--color-muted)]">{fileSize(p.file.size)}</span>
                ) : (
                  <span className="mt-1 block h-1 overflow-hidden rounded-full bg-[var(--color-line)]">
                    <span className="block h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${Math.round(p.progress * 100)}%` }} />
                  </span>
                )}
              </span>
              <button type="button" onClick={() => setPending((all) => all.filter((x) => x.key !== p.key))} aria-label={`Take ${p.name} off`} className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:text-rose-600">
                <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                  <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1 rounded-[22px] border border-[var(--color-line)] bg-[var(--color-panel)] py-1 pl-1.5 pr-1 transition-colors focus-within:border-[var(--color-primary)]/60 focus-within:shadow-[0_0_0_3px_var(--color-primary-soft)]">
        <button type="button" onClick={() => input.current?.click()} title="Attach photos or documents (or drop them here)" aria-label="Attach" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
            <path d="M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            area.current?.focus();
            setSlash(slash ? null : { start: -1, query: "", index: 0 });
          }}
          title={'Quick replies (or type "/")'}
          aria-label="Quick replies"
          aria-expanded={menuOpen}
          className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors ${menuOpen ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]" : "text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"}`}
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
            <path d="M4.5 6.5A2.5 2.5 0 017 4h10a2.5 2.5 0 012.5 2.5v7A2.5 2.5 0 0117 16h-6.5l-4 3.5V16H7a2.5 2.5 0 01-2.5-2.5v-7z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            <path d="M8.5 8.5h7M8.5 11.5h4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
        {onNoted && (
          <button
            type="button"
            onClick={() => {
              setSlash(null);
              setNoting(true);
            }}
            title="Write an internal note (the buyer won't see it)"
            aria-label="Internal note"
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-amber-50 hover:text-amber-700"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
              <rect x="5" y="3.5" width="14" height="17" rx="2" stroke="currentColor" strokeWidth="1.7" />
              <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            addFiles(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
        <textarea
          ref={area}
          rows={1}
          value={text}
          onChange={(e) => onType(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={(e) => {
            if (menuOpen && slash) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setSlash({ ...slash, index: (slash.index + step + options.length) % options.length });
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pick(options[Math.min(slash.index, options.length - 1)]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlash(null);
                return;
              }
            }
            const el = e.currentTarget;
            if (e.key === "Backspace" && named && el.selectionStart === named.end && el.selectionEnd === named.end && text.slice(named.start, named.end) === name) {
              e.preventDefault();
              setText(`${text.slice(0, named.start)}@${text.slice(named.end)}`);
              caret.current = named.start + 1;
              setNamed(null);
              return;
            }
            if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey || (!e.shiftKey && !phone))) {
              e.preventDefault();
              send();
            }
          }}
          onClick={(e) => slash && slash.start >= 0 && setSlash(slashAt(text, e.currentTarget.selectionStart ?? text.length))}
          onBlur={() => setSlash(null)}
          placeholder={placeholder}
          className="max-h-[200px] min-h-[32px] flex-1 resize-none bg-transparent px-1 py-[6px] text-[13px] leading-[1.45] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
          aria-label="Reply"
        />
        {text.length > MAX - 400 && <span className={`flex-shrink-0 self-center px-1 text-[10.5px] tabular-nums ${text.length > MAX ? "font-semibold text-rose-600" : "text-[var(--color-muted)]"}`}>{MAX - text.length}</span>}
        <button type="button" onClick={() => send()} disabled={!canSend} aria-label="Send" title={phone ? "Send to the buyer on eBay" : "Send to the buyer on eBay (Enter)"} className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:bg-[var(--color-line)] disabled:text-[var(--color-muted)]">
          {sending ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
              <path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
      {missing.length > 0 && (
        <p className="mt-1.5 px-3 text-[11.5px] text-amber-700">
          Fill in {missing.join(", ")} before sending: this conversation doesn&apos;t have {missing.length === 1 ? "it" : "them"} yet.
        </p>
      )}
      {error && <p className="mt-1.5 px-3 text-[11.5px] text-rose-600">{error}</p>}
    </div>
  );
}
