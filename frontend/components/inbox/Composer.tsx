"use client";

import { forwardRef, KeyboardEvent, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ApiError, ChatMember, ChatMessage, inboxApi, ListonCard, ListonRef, SharedFile, uploadFile } from "@/lib/api";
import { ListonCardView, KindIcon, KIND_LABEL } from "./ListonCardView";
import { PersonAvatar } from "./PersonAvatar";
import { fileSize } from "./inbox-format";
import { useIsPhone } from "@/lib/useIsPhone";
import { RecordingBar, useVoiceRecorder } from "./VoiceNote";

// Writing a team chat message, in the eBay composer's shape (a rounded
// field with its tools inside): text that grows as it's typed (Enter sends,
// Shift+Enter a new line), @mentions picked from the people in it, Liston
// cards (an order number, item number or Liston link typed or pasted shows
// its card before sending; "Share from Liston" finds one by words), files
// attached, dropped or pasted (photos from the clipboard too), uploading at
// once with their progress, and, while the box is empty, the mic for a
// voice note. Replying shows what's quoted; editing a message puts its
// text back here. In a thread it keeps its own draft and can send the
// reply to the conversation too.

export const LISTON_REF_TYPE = "application/x-liston-ref";

// What's being written in each conversation (and each thread), kept while you move between them.
const drafts = new Map<string, string>();
const LOOKS_LIKE_A_CARD = /\d{2}-\d{5}-\d{5}|\d{12}|\/accounts\/|ebay\./i;

export type ComposerHandle = { addFiles: (files: File[]) => void; addRefs: (refs: ListonRef[]) => void; focus: () => void };
export type ComposerSend = {
  body: string;
  mentions: string[];
  fileIds: string[];
  refs: ListonRef[];
  replyToId: string | null;
  alsoInConversation?: boolean;
  voice?: { fileId: string; durationMs: number; peaks: number[] } | null;
};

type Pending = { key: string; name: string; size: number; progress: number; file?: SharedFile; error?: string; preview?: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toolClass = "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]";

export const Composer = forwardRef<
  ComposerHandle,
  {
    conversationId: string;
    kind: "dm" | "group" | "channel";
    members: ChatMember[];
    meId: string;
    replyTo: ChatMessage | null;
    onCancelReply: () => void;
    editing: ChatMessage | null;
    onCancelEdit: () => void;
    onSend: (input: ComposerSend) => Promise<void>;
    onEditSave: (messageId: string, body: string, mentions: string[]) => Promise<void>;
    onTyping: () => void;
    disabledReason?: string | null;
    // A thread's composer: its first message, and the choice to send the reply to the conversation too ("Also send to #orders").
    threadId?: string | null;
    alsoLabel?: string | null;
    placeholder?: string;
  }
>(function Composer({ conversationId, kind, members, meId, replyTo, onCancelReply, editing, onCancelEdit, onSend, onEditSave, onTyping, disabledReason, threadId = null, alsoLabel = null, placeholder }, ref) {
  const draftKey = threadId ? `${conversationId}:${threadId}` : conversationId;
  const [text, setText] = useState(() => drafts.get(draftKey) || "");
  const [pending, setPending] = useState<Pending[]>([]);
  const [refs, setRefs] = useState<{ ref: ListonRef; card: ListonCard | null }[]>([]);
  const [detected, setDetected] = useState<ListonCard[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mention, setMention] = useState<{ query: string; start: number; index: number } | null>(null);
  const [picker, setPicker] = useState(false);
  const [alsoSend, setAlsoSend] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const phone = useIsPhone();
  const sendVoiceRef = useRef<() => void>(() => {});
  const voice = useVoiceRecorder({ onLimit: () => sendVoiceRef.current() });

  const others = useMemo(() => members.filter((m) => m.id !== meId && !m.removed), [members, meId]);

  useEffect(() => {
    if (!editing) drafts.set(draftKey, text);
  }, [text, draftKey, editing]);

  // Editing: the message's text in the box (set as the edit starts, while rendering).
  const [editingFrom, setEditingFrom] = useState<ChatMessage | null>(null);
  if (editing !== editingFrom) {
    setEditingFrom(editing);
    if (editing) setText(editing.body);
  }
  useEffect(() => {
    if (editing) requestAnimationFrame(() => area.current?.focus());
  }, [editing]);
  useEffect(() => {
    if (replyTo) area.current?.focus();
  }, [replyTo]);

  // The box grows with the text, up to about eight lines.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [text]);

  // Cards for what the text points at, shown before it's sent.
  useEffect(() => {
    if (!LOOKS_LIKE_A_CARD.test(text)) return;
    const t = setTimeout(() => {
      inboxApi
        .detectCards(text)
        .then((r) => setDetected(r.cards.filter((c) => !c.locked)))
        .catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [text]);

  const addFiles = useCallback((files: File[]) => {
    for (const file of files) {
      const key = `${Date.now()}-${Math.random()}`;
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setPending((p) => [...p, { key, name: file.name || "file", size: file.size, progress: 0, preview }]);
      uploadFile(file, { onProgress: (share) => setPending((p) => p.map((x) => (x.key === key ? { ...x, progress: share } : x))) })
        .then((saved) => setPending((p) => p.map((x) => (x.key === key ? { ...x, progress: 1, file: saved } : x))))
        .catch((err) => setPending((p) => p.map((x) => (x.key === key ? { ...x, error: err instanceof ApiError ? err.message : "Couldn't upload it." } : x))));
    }
    area.current?.focus();
  }, []);

  const addRefs = useCallback((more: ListonRef[]) => {
    setRefs((now) => {
      const seen = new Set(now.map((r) => `${r.ref.kind}:${r.ref.id}`));
      const fresh = more.filter((r) => !seen.has(`${r.kind}:${r.id}`)).map((r) => ({ ref: r, card: null }));
      if (fresh.length) {
        inboxApi
          .resolveCards(fresh.map((f) => f.ref))
          .then((res) =>
            setRefs((cur) =>
              cur
                .map((c) => {
                  const i = fresh.findIndex((f) => f.ref.kind === c.ref.kind && f.ref.id === c.ref.id);
                  return i >= 0 ? { ...c, card: res.cards[i] } : c;
                })
                // Not found in Liston (or not yours to see): dropped.
                .filter((c) => {
                  const i = fresh.findIndex((f) => f.ref.kind === c.ref.kind && f.ref.id === c.ref.id);
                  return i < 0 || (res.cards[i] !== null && !res.cards[i]?.locked);
                })
            )
          )
          .catch(() => {});
      }
      return [...now, ...fresh].slice(0, 10);
    });
    area.current?.focus();
  }, []);

  useImperativeHandle(ref, () => ({ addFiles, addRefs, focus: () => area.current?.focus() }), [addFiles, addRefs]);

  const shownDetected = LOOKS_LIKE_A_CARD.test(text) ? detected : [];
  const uploading = pending.some((p) => !p.file && !p.error);
  const ready = pending.filter((p) => p.file);
  const hasContent = text.trim().length > 0 || ready.length > 0 || refs.some((r) => r.card && !r.card.locked && !r.card.gone);
  const canSend = !sending && !uploading && !disabledReason && hasContent;
  // An empty box offers the mic, as WhatsApp does; anything in it, the send arrow.
  const showMic = !editing && !hasContent && !uploading && pending.length === 0;

  function mentionIds(body: string) {
    return others.filter((m) => new RegExp(`@${escapeRe(m.name)}(?![\\w])`, "i").test(body)).map((m) => m.id);
  }

  function reset() {
    setText("");
    drafts.delete(draftKey);
    pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
    setPending([]);
    setRefs([]);
    setDetected([]);
    setAlsoSend(false);
    onCancelReply();
  }

  async function submit() {
    if (!canSend && !editing) return;
    setError(null);
    setSending(true);
    try {
      if (editing) {
        await onEditSave(editing.id, text, mentionIds(text));
        onCancelEdit();
        setText(drafts.get(draftKey) || "");
      } else {
        await onSend({
          body: text,
          mentions: mentionIds(text),
          fileIds: ready.map((p) => p.file!.id),
          refs: refs.filter((r) => r.card && !r.card.locked && !r.card.gone).map((r) => r.ref),
          replyToId: replyTo?.id || null,
          ...(threadId ? { alsoInConversation: alsoSend } : {}),
        });
        reset();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send it. Try again.");
    } finally {
      setSending(false);
      requestAnimationFrame(() => area.current?.focus());
    }
  }

  async function sendVoice() {
    if (sending) return;
    setError(null);
    setSending(true);
    try {
      const recorded = await voice.stop();
      if (!recorded) {
        setError("That was too short to send. Hold on a little longer.");
        return;
      }
      const file = await uploadFile(recorded.blob, { name: recorded.name });
      await onSend({
        body: "",
        mentions: [],
        fileIds: [file.id],
        refs: [],
        replyToId: replyTo?.id || null,
        voice: { fileId: file.id, durationMs: Math.round(recorded.durationMs), peaks: recorded.peaks },
        ...(threadId ? { alsoInConversation: alsoSend } : {}),
      });
      setAlsoSend(false);
      onCancelReply();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send the voice message. Try again.");
    } finally {
      setSending(false);
    }
  }
  useEffect(() => {
    sendVoiceRef.current = sendVoice;
  });

  // @mentions: the people whose names start with what's typed after "@".
  type MentionOption = { id: string; name: string; everyone: boolean; person: ChatMember | null };
  const mentionOptions = useMemo<MentionOption[]>(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const people = others.filter((m) => m.name.toLowerCase().startsWith(q) || m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
    const all: MentionOption[] = kind !== "dm" && "channel".startsWith(q) ? [{ id: "@channel", name: "channel", everyone: true, person: null }] : [];
    return [...people.map((p) => ({ id: p.id, name: p.name, everyone: false, person: p })), ...all].slice(0, 6);
  }, [mention, others, kind]);

  function onChange(value: string, caret: number) {
    setText(value);
    const before = value.slice(0, caret);
    const m = /(^|\s)@([\w.-]{0,30})$/.exec(before);
    setMention(m ? { query: m[2], start: caret - m[2].length - 1, index: 0 } : null);
    if (value === "/" && !editing) {
      setText("");
      setPicker(true);
    }
    const now = Date.now();
    if (value.trim() && now - lastTyping.current > 3000) {
      lastTyping.current = now;
      onTyping();
    }
  }

  function pickMention(option: { id: string; name: string }) {
    if (!mention) return;
    const el = area.current;
    const caret = el?.selectionStart ?? text.length;
    const insert = `@${option.name} `;
    const next = text.slice(0, mention.start) + insert + text.slice(caret);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      el?.focus();
      const at = mention.start + insert.length;
      el?.setSelectionRange(at, at);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && mentionOptions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setMention({ ...mention, index: (mention.index + step + mentionOptions.length) % mentionOptions.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentionOptions[mention.index]);
        return;
      }
      if (e.key === "Escape") {
        setMention(null);
        return;
      }
    }
    if (e.key === "Escape" && editing) {
      onCancelEdit();
      setText(drafts.get(draftKey) || "");
      return;
    }
    if (e.key === "Escape" && replyTo) {
      onCancelReply();
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey || (!e.shiftKey && !phone))) {
      e.preventDefault();
      submit();
    }
  }

  if (disabledReason) {
    return <div className="border-t border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-3 text-center text-[12.5px] text-[var(--color-muted)]">{disabledReason}</div>;
  }

  const hint = placeholder || (phone ? "Write a message" : threadId ? "Reply · @ to mention" : kind === "channel" ? "Message the channel · @ to mention · / to share from Liston" : "Write a message · / to share from Liston");

  return (
    <div
      className="relative border-t border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2"
      onPaste={(e) => {
        const files = Array.from(e.clipboardData?.files || []);
        if (files.length) {
          e.preventDefault();
          addFiles(files);
        }
      }}
    >
      {(replyTo || editing) && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border-l-[3px] border-[var(--color-primary)] bg-[var(--color-paper)] px-3 py-1.5">
          <div className="min-w-0 flex-1 text-[12px]">
            <p className="font-semibold text-[var(--color-ink)]">{editing ? "Editing your message" : `Quoting ${replyTo!.author?.name || "Someone"}`}</p>
            {!editing && <p className="truncate text-[var(--color-muted)]">{replyTo!.body || (replyTo!.voice ? "Voice message" : replyTo!.files.length ? "A file" : replyTo!.cards.length ? "A card" : "")}</p>}
          </div>
          <button
            type="button"
            onClick={() => {
              if (editing) {
                onCancelEdit();
                setText(drafts.get(draftKey) || "");
              } else onCancelReply();
            }}
            className="text-[12px] font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          >
            Cancel
          </button>
        </div>
      )}

      {(pending.length > 0 || refs.length > 0 || shownDetected.length > 0) && !editing && (
        <div className="mb-2 flex max-h-[180px] flex-wrap gap-2 overflow-y-auto">
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
                    <span className="block h-full rounded-full bg-[var(--color-primary)] transition-[width]" style={{ width: `${Math.round(p.progress * 100)}%` }} />
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
          {refs.map((r) =>
            r.card ? (
              <div key={`${r.ref.kind}:${r.ref.id}`} className="w-[300px] max-w-full">
                <ListonCardView card={r.card} compact onRemove={() => setRefs((all) => all.filter((x) => x !== r))} />
              </div>
            ) : (
              <div key={`${r.ref.kind}:${r.ref.id}`} className="flex h-[60px] w-[300px] max-w-full items-center gap-2 rounded-xl border border-[var(--color-line)] px-3 text-[12px] text-[var(--color-muted)]">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-hidden />
                Finding it in Liston…
              </div>
            )
          )}
          {shownDetected
            .filter((c) => !refs.some((r) => r.ref.kind === c.kind && r.ref.id === c.id))
            .map((c) => (
              <div key={c.key} className="w-[300px] max-w-full opacity-90">
                <ListonCardView card={c} compact />
              </div>
            ))}
        </div>
      )}

      {mention && mentionOptions.length > 0 && (
        <div className="absolute bottom-full left-3 z-20 mb-1 w-64 overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] py-1 shadow-[var(--shadow-pop)]" role="listbox">
          {mentionOptions.map((o, i) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={i === mention.index}
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(o);
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] ${i === mention.index ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]" : "text-[var(--color-ink)] hover:bg-[var(--color-paper)]"}`}
            >
              {o.person ? <PersonAvatar id={o.person.id} name={o.person.name} avatarUrl={o.person.avatarUrl} size={22} /> : <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[var(--color-paper)] text-[11px] font-bold">@</span>}
              <span className="truncate">{o.everyone ? "channel · everyone here" : o.name}</span>
            </button>
          ))}
        </div>
      )}

      {picker && (
        <CardPicker
          onPick={(card) => {
            addRefs([{ kind: card.kind, id: card.id, connectionId: "account" in card ? card.account.id : undefined }]);
            setPicker(false);
          }}
          onClose={() => {
            setPicker(false);
            area.current?.focus();
          }}
        />
      )}

      {voice.recording ? (
        <RecordingBar elapsed={voice.elapsed} recent={voice.recent} sending={sending} onCancel={voice.cancel} onSend={sendVoice} />
      ) : (
        <div className="flex items-end gap-1 rounded-[22px] border border-[var(--color-line)] bg-[var(--color-panel)] py-1 pl-1.5 pr-1 transition-colors focus-within:border-[var(--color-primary)]/60 focus-within:shadow-[0_0_0_3px_var(--color-primary-soft)]">
          {!editing && (
            <>
              <button type="button" onClick={() => fileInput.current?.click()} title="Attach photos or files (or drop them here)" aria-label="Attach files" className={toolClass}>
                <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
                  <path d="M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {!threadId && (
                <button
                  type="button"
                  onClick={() => setPicker((v) => !v)}
                  title="Share an order, listing, draft, hunted product or eBay conversation (or type /)"
                  aria-label="Share from Liston"
                  aria-expanded={picker}
                  className={`${toolClass} ${picker ? "!bg-[var(--color-primary-soft)] !text-[var(--color-primary)]" : ""}`}
                >
                  <KindIcon kind="order" className="h-[18px] w-[18px]" />
                </button>
              )}
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  addFiles(Array.from(e.target.files || []));
                  e.target.value = "";
                }}
              />
            </>
          )}
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
            onKeyDown={onKeyDown}
            placeholder={editing ? "Edit your message" : hint}
            className="max-h-[200px] min-h-[32px] flex-1 resize-none bg-transparent px-1 py-[6px] text-[13px] leading-[1.45] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
            aria-label={threadId ? "Reply in thread" : "Message"}
          />
          {showMic ? (
            <button type="button" onClick={voice.start} disabled={voice.state !== "idle"} title="Record a voice message" aria-label="Record a voice message" className={`${toolClass} disabled:opacity-50`}>
              {voice.state === "starting" ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--color-primary)]/30 border-t-[var(--color-primary)]" aria-hidden />
              ) : (
                <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
                  <rect x="9" y="3.5" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
                  <path d="M6 11.5a6 6 0 0012 0M12 17.5V20.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={editing ? sending || !text.trim() : !canSend}
              aria-label={editing ? "Save" : "Send"}
              title={editing ? "Save (Enter)" : phone ? "Send" : "Send (Enter)"}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:bg-[var(--color-line)] disabled:text-[var(--color-muted)]"
            >
              {sending ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />
              ) : editing ? (
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                  <path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                  <path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          )}
        </div>
      )}
      {threadId && alsoLabel && !editing && (
        <label className="mt-1.5 flex w-fit cursor-pointer items-center gap-2 px-2 text-[12px] text-[var(--color-muted)]">
          <input type="checkbox" checked={alsoSend} onChange={(e) => setAlsoSend(e.target.checked)} className="h-3.5 w-3.5 rounded border-[var(--color-line)] accent-[var(--color-primary)]" />
          {alsoLabel}
        </label>
      )}
      {(error || voice.error) && (
        <p className="mt-1.5 flex items-center gap-2 px-3 text-[11.5px] text-rose-600">
          {error || voice.error}
          {voice.error && (
            <button type="button" onClick={voice.clearError} className="font-medium underline">
              OK
            </button>
          )}
        </p>
      )}
    </div>
  );
});

/** "Share from Liston": find an order, listing, draft, hunted product or eBay conversation by its words, number, buyer or SKU. */
function CardPicker({ onPick, onClose }: { onPick: (card: ListonCard) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [cards, setCards] = useState<ListonCard[] | null>(null);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const typedEnough = q.trim().length >= 2;
  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(() => {
      setLoading(true);
      inboxApi
        .searchCards(q.trim())
        .then((r) => setCards(r.cards))
        .catch(() => setCards([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="absolute bottom-full left-3 right-3 z-20 mb-2 max-w-[520px] overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-pop)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-3 py-2">
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-[var(--color-muted)]" aria-hidden>
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onClose()}
          placeholder="Find an order, listing, draft, hunted product or buyer: a title, number or SKU"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--color-muted)]"
        />
        <button type="button" onClick={onClose} className="text-[12px] font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)]">
          Close
        </button>
      </div>
      <div className="max-h-[300px] overflow-y-auto p-1.5">
        {typedEnough && loading && !cards && <p className="px-2 py-3 text-[12.5px] text-[var(--color-muted)]">Searching your accounts…</p>}
        {!typedEnough && <p className="px-2 py-3 text-[12.5px] text-[var(--color-muted)]">Type two letters or more. Everything is from your accounts you can open.</p>}
        {typedEnough && cards && cards.length === 0 && !loading && <p className="px-2 py-3 text-[12.5px] text-[var(--color-muted)]">Nothing matches &ldquo;{q}&rdquo;.</p>}
        {(typedEnough ? cards : null)?.map((card) =>
          card.locked || card.gone ? null : (
            <button key={card.key} type="button" onClick={() => onPick(card)} className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--color-paper)]">
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-paper)] text-[var(--color-muted)]">
                {card.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={card.image} alt="" className="h-full w-full object-cover" />
                ) : (
                  <KindIcon kind={card.kind} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[var(--color-ink)]">{card.title}</span>
                <span className="block truncate text-[11.5px] text-[var(--color-muted)]">
                  {KIND_LABEL[card.kind]} · {card.account.label}
                  {card.status ? ` · ${card.status.label}` : ""}
                </span>
              </span>
            </button>
          )
        )}
      </div>
    </div>
  );
}
