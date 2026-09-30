"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, EbayMessage, SharedFile, ebayInboxApi, uploadFile } from "@/lib/api";
import { fileSize } from "../inbox-format";

// Replying to a buyer: text up to eBay's 2,000 characters (Ctrl/Cmd+Enter
// sends; Enter is a new line, as buyer messages often run to several), up to
// 5 photos, PDFs, Word documents or text files (attached, dropped or
// pasted), uploaded for eBay at once. Anything eBay blocks or flags
// (contact details, links off eBay, paying outside eBay) is shown before it
// goes, with "Send anyway". A real message to a real buyer: it goes only
// when Send is pressed.

const MAX = 2000;
const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,application/pdf,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";
type Pending = { key: string; name: string; size: number; progress: number; file?: SharedFile; error?: string; preview?: string };

// What's being written to each buyer, kept while you move between conversations.
const drafts = new Map<string, string>();

export function EbayComposer({ connectionId, conversationId, buyer, onSent }: { connectionId: string; conversationId: string; buyer: string | null; onSent: (m: EbayMessage) => void }) {
  const key = `${connectionId}~${conversationId}`;
  const [text, setText] = useState(() => drafts.get(key) || "");
  const [pending, setPending] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<{ kind: string; text: string }[] | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    drafts.set(key, text);
  }, [key, text]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [text]);

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
  const canSend = text.trim().length > 0 && text.length <= MAX && !uploading && !sending;

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

  return (
    <div
      className="border-t border-[var(--color-line)] bg-[var(--color-panel)] px-3 pb-3 pt-2"
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
      {warnings && (
        <div className="mb-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <p className="text-[12.5px] font-semibold text-amber-900">eBay may block or flag this message</p>
          <ul className="mt-1 space-y-0.5 text-[12px] text-amber-900">
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
      <div className="flex items-end gap-1.5 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-panel)] px-1.5 py-1 focus-within:border-[var(--color-primary)]">
        <button type="button" onClick={() => input.current?.click()} title="Attach photos or documents (or drop them here)" aria-label="Attach" className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
            <rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="9" cy="10" r="1.6" stroke="currentColor" strokeWidth="1.6" />
            <path d="M5 17l4.5-4.5 3.5 3.5 2.5-2.5L20 17" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          </svg>
        </button>
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
          onChange={(e) => {
            setText(e.target.value);
            if (warnings) setWarnings(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={`Reply to ${buyer || "the buyer"}`}
          className="max-h-[220px] min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-2 text-[13.5px] leading-snug text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
          aria-label="Reply"
        />
        <button type="button" onClick={() => send()} disabled={!canSend} aria-label="Send" title="Send (Ctrl/Cmd+Enter)" className="flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full bg-[var(--color-primary)] px-3.5 text-[13px] font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40">
          {sending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden /> : "Send"}
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between px-1 text-[11px] text-[var(--color-muted)]">
        <span>{error ? <span className="text-rose-600">{error}</span> : "Ctrl/Cmd+Enter to send · goes to the buyer on eBay"}</span>
        <span className={text.length > MAX ? "font-semibold text-rose-600" : ""}>
          {text.length.toLocaleString()} / {MAX.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
