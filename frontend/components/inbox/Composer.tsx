"use client";

import { forwardRef, KeyboardEvent, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError, ChatMember, ChatMessage, inboxApi, ListonCard, ListonRef, SharedFile, uploadFile } from "@/lib/api";
import { ListonCardView, KindIcon, KIND_LABEL } from "./ListonCardView";
import { PersonAvatar } from "./PersonAvatar";
import { fileSize } from "./inbox-format";
import { useIsPhone } from "@/lib/useIsPhone";
import { RecordingBar, useVoiceRecorder } from "./VoiceNote";

// Writing a team chat message, as Slack's composer: one bordered box with
// the formatting tools along its top (bold, italic, struck, a link, lists,
// code: marks put round what's selected, Cmd/Ctrl+B and +I and +Shift+X
// too; "Aa" hides or shows them, remembered), the text growing as it's
// typed (Enter sends, Shift+Enter a new line), what's attached, and along
// its foot: attach files, share from Liston (an order, listing, draft,
// hunted product or eBay conversation; typing an order number, item number
// or Liston link shows its card too), "Aa", @ to mention someone, the mic
// for a voice note, and send. Files can also be dropped or pasted (photos
// from the clipboard too), uploading at once with their progress. Who's
// typing shows under the box. Quoting shows what's quoted; editing a
// message puts its text back here. In a thread it keeps its own draft and
// can send the reply to the conversation too.

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

const toolClass = "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]";
const TOOLS_KEY = "liston.chatFormatting";
const FORMATS: { key: "bold" | "italic" | "strike" | "link" | "numbers" | "bullets" | "code"; label: string; gapBefore?: boolean }[] = [
  { key: "bold", label: "Bold (Cmd/Ctrl+B)" },
  { key: "italic", label: "Italic (Cmd/Ctrl+I)" },
  { key: "strike", label: "Strikethrough (Cmd/Ctrl+Shift+X)" },
  { key: "link", label: "Link", gapBefore: true },
  { key: "numbers", label: "Numbered list", gapBefore: true },
  { key: "bullets", label: "Bulleted list" },
  { key: "code", label: "Code", gapBefore: true },
];

const formatIcon = (paths: React.ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" className="h-[17px] w-[17px]" aria-hidden>
    {paths}
  </svg>
);
const FORMAT_ICONS = {
  bold: formatIcon(<path d="M7 5h6a3.5 3.5 0 010 7H7V5zM7 12h7a3.5 3.5 0 010 7H7v-7z" stroke="currentColor" strokeWidth="2.1" strokeLinejoin="round" />),
  italic: formatIcon(<path d="M10 5h8M6 19h8M14 5l-4 14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />),
  strike: formatIcon(<path d="M5 12h14M16.5 7.5C16 5.9 14.3 5 12.2 5 9.6 5 7.8 6.4 7.8 8.4c0 1.3.8 2.3 2.4 2.9M8 16.4C8.6 18 10.4 19 12.6 19c2.8 0 4.6-1.4 4.6-3.5 0-.8-.3-1.5-.8-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />),
  link: formatIcon(<path d="M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66l-1 1M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1-1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />),
  bullets: formatIcon(
    <>
      <path d="M10 6.5h9M10 12h9M10 17.5h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="5.5" cy="6.5" r="1.3" fill="currentColor" />
      <circle cx="5.5" cy="12" r="1.3" fill="currentColor" />
      <circle cx="5.5" cy="17.5" r="1.3" fill="currentColor" />
    </>
  ),
  numbers: formatIcon(<path d="M10 6.5h9M10 12h9M10 17.5h9M4.5 5l1.5-1v5M4 14.2c.3-.7 1-1.2 1.8-1.2.9 0 1.6.6 1.6 1.4 0 1.3-3.4 2.1-3.4 3.6h3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />),
  code: formatIcon(<path d="M9 7l-5 5 5 5M15 7l5 5-5 5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />),
};

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
    // "Sara is typing…", under the box.
    typing?: string | null;
  }
>(function Composer({ conversationId, kind, members, meId, replyTo, onCancelReply, editing, onCancelEdit, onSend, onEditSave, onTyping, disabledReason, threadId = null, alsoLabel = null, placeholder, typing = null }, ref) {
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
  // The formatting tools along the box's top: shown unless you've hidden them ("Aa"), kept for next time.
  const [tools, setTools] = useState(() => {
    try {
      return localStorage.getItem(TOOLS_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const area = useRef<HTMLTextAreaElement>(null);
  // Where the selection goes once a formatting change is in the box (set as the text changes, before it's painted).
  const pendingSelection = useRef<[number, number] | null>(null);
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

  useLayoutEffect(() => {
    const el = area.current;
    const sel = pendingSelection.current;
    if (!el || !sel) return;
    pendingSelection.current = null;
    el.focus();
    el.setSelectionRange(sel[0], sel[1]);
  }, [text]);

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

  // Marks put round what's selected (or where the caret is, ready to type between them).
  function wrap(before: string, after = before) {
    const el = area.current;
    if (!el) return;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    pendingSelection.current = [a + before.length, b + before.length];
    setText(text.slice(0, a) + before + text.slice(a, b) + after + text.slice(b));
  }

  // A link: what's selected becomes its words, the caret left where the address goes.
  function link() {
    const el = area.current;
    if (!el) return;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    const words = text.slice(a, b) || "link";
    const insert = `[${words}](https://)`;
    pendingSelection.current = [a + insert.length - 1, a + insert.length - 1];
    setText(text.slice(0, a) + insert + text.slice(b));
  }

  // The lines the selection touches become a list ("• " or "1. ", "2. "…).
  function list(numbered: boolean) {
    const el = area.current;
    if (!el) return;
    const start = text.lastIndexOf("\n", el.selectionStart - 1) + 1;
    const endAt = text.indexOf("\n", el.selectionEnd);
    const end = endAt < 0 ? text.length : endAt;
    const block = text
      .slice(start, end)
      .split("\n")
      .map((line, i) => `${numbered ? `${i + 1}. ` : "• "}${line.replace(/^(•\s|\d+\.\s)/, "")}`)
      .join("\n");
    pendingSelection.current = [start + block.length, start + block.length];
    setText(text.slice(0, start) + block + text.slice(end));
  }

  // "@" from the foot of the box: typed at the caret, and the people to pick from shown.
  function startMention() {
    const el = area.current;
    if (!el) return;
    const a = el.selectionStart;
    const lead = a > 0 && !/\s/.test(text[a - 1]) ? " @" : "@";
    pendingSelection.current = [a + lead.length, a + lead.length];
    setText(text.slice(0, a) + lead + text.slice(el.selectionEnd));
    setMention({ query: "", start: a + lead.length - 1, index: 0 });
  }

  function toggleTools() {
    setTools((v) => {
      try {
        localStorage.setItem(TOOLS_KEY, v ? "off" : "on");
      } catch {}
      return !v;
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+B bold, +I italic, +Shift+X struck.
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "b" && !e.shiftKey) {
        e.preventDefault();
        wrap("**");
        return;
      }
      if (k === "i" && !e.shiftKey) {
        e.preventDefault();
        wrap("_");
        return;
      }
      if (k === "x" && e.shiftKey) {
        e.preventDefault();
        wrap("~");
        return;
      }
    }
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
    return <div className="mx-4 mb-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] px-4 py-3 text-center text-[12.5px] text-[var(--color-muted)]">{disabledReason}</div>;
  }

  const hint = placeholder || (threadId ? "Reply…" : "Write a message");
  function format(key: keyof typeof FORMAT_ICONS) {
    if (key === "bold") wrap("**");
    else if (key === "italic") wrap("_");
    else if (key === "strike") wrap("~");
    else if (key === "code") wrap("`");
    else if (key === "link") link();
    else list(key === "numbers");
  }
  const note = error || voice.error;

  return (
    <div
      className="relative flex-shrink-0 bg-[var(--color-panel)] px-4 pb-1 pt-1"
      onPaste={(e) => {
        const files = Array.from(e.clipboardData?.files || []);
        if (files.length) {
          e.preventDefault();
          addFiles(files);
        }
      }}
    >
      {(replyTo || editing) && (
        <div className="mb-1.5 flex items-start gap-2 rounded-lg border-l-[3px] border-[var(--color-primary)] bg-[var(--color-paper)] px-3 py-1.5">
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

      {mention && mentionOptions.length > 0 && (
        <div className="absolute bottom-full left-5 z-20 mb-1 w-64 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] py-1 shadow-[var(--shadow-pop)]" role="listbox">
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
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] ${i === mention.index ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-ink)] hover:bg-[var(--color-paper)]"}`}
            >
              {o.person ? <PersonAvatar id={o.person.id} name={o.person.name} avatarUrl={o.person.avatarUrl} size={20} square /> : <span className="flex h-5 w-5 items-center justify-center rounded-[5px] bg-[var(--color-paper)] text-[11px] font-bold text-[var(--color-ink)]">@</span>}
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
        <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] transition-[border-color,box-shadow] focus-within:border-[var(--color-ink)]/30 focus-within:shadow-[0_1px_6px_-1px_rgba(15,23,42,0.12)]">
          {tools && !phone && (
            <div className="flex items-center gap-0.5 px-1.5 pt-1.5" role="toolbar" aria-label="Formatting">
              {FORMATS.map((f) => (
                <span key={f.key} className="flex items-center">
                  {f.gapBefore && <span className="mx-1 h-5 w-px bg-[var(--color-line)]" aria-hidden />}
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => format(f.key)}
                    title={f.label}
                    aria-label={f.label}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
                  >
                    {FORMAT_ICONS[f.key]}
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
            onKeyDown={onKeyDown}
            placeholder={editing ? "Edit your message" : hint}
            className="block max-h-[240px] min-h-[42px] w-full resize-none bg-transparent px-3 py-2.5 text-[14px] leading-[21px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
            aria-label={threadId ? "Reply in thread" : "Message"}
          />

          {(pending.length > 0 || refs.length > 0 || shownDetected.length > 0) && !editing && (
            <div className="flex max-h-[180px] flex-wrap gap-2 overflow-y-auto px-3 pb-2">
              {pending.map((p) => (
                <div key={p.key} className={`relative flex w-[200px] items-center gap-2 rounded-lg border bg-[var(--color-panel)] p-1.5 ${p.error ? "border-rose-300" : "border-[var(--color-line)]"}`}>
                  {p.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.preview} alt="" className="h-9 w-9 flex-shrink-0 rounded-md object-cover" />
                  ) : (
                    <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-[var(--color-primary-soft)] text-[10.5px] font-semibold uppercase text-[var(--color-primary)]">{(p.name.split(".").pop() || "file").slice(0, 4)}</span>
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
                  <div key={`${r.ref.kind}:${r.ref.id}`} className="flex h-[60px] w-[300px] max-w-full items-center gap-2 rounded-lg border border-[var(--color-line)] px-3 text-[12px] text-[var(--color-muted)]">
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

          {threadId && alsoLabel && !editing && (
            <label className="mx-3 mb-1 flex w-fit cursor-pointer items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
              <input type="checkbox" checked={alsoSend} onChange={(e) => setAlsoSend(e.target.checked)} className="h-3.5 w-3.5 rounded border-[var(--color-line)] accent-[var(--color-primary)]" />
              {alsoLabel}
            </label>
          )}

          <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
            {!editing && (
              <>
                <button type="button" onClick={() => fileInput.current?.click()} title="Attach photos or files (or drop them here)" aria-label="Attach files" className="mr-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-paper)] text-[var(--color-ink)]/70 transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]">
                  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
                    <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
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
                    <KindIcon kind="order" className="h-[17px] w-[17px]" />
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
            {!phone && (
              <button type="button" onClick={toggleTools} title={tools ? "Hide formatting" : "Show formatting"} aria-label={tools ? "Hide formatting" : "Show formatting"} aria-pressed={tools} className={`${toolClass} text-[13px] font-semibold underline decoration-[1.5px] underline-offset-2`}>
                Aa
              </button>
            )}
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={startMention} title="Mention someone" aria-label="Mention someone" className={toolClass}>
              <svg viewBox="0 0 24 24" fill="none" className="h-[17px] w-[17px]" aria-hidden>
                <circle cx="12" cy="12" r="3.6" stroke="currentColor" strokeWidth="1.8" />
                <path d="M15.6 12v1.4a2.6 2.6 0 005.2 0V12A8.8 8.8 0 1017 19.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            {!editing && (
              <button type="button" onClick={voice.start} disabled={voice.state !== "idle" || uploading} title="Record a voice message" aria-label="Record a voice message" className={`${toolClass} disabled:opacity-50`}>
                {voice.state === "starting" ? (
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--color-primary)]/30 border-t-[var(--color-primary)]" aria-hidden />
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" className="h-[17px] w-[17px]" aria-hidden>
                    <rect x="9" y="3.5" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M6 11.5a6 6 0 0012 0M12 17.5V20.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            )}
            <span className="flex-1" />
            {editing && (
              <button
                type="button"
                onClick={() => {
                  onCancelEdit();
                  setText(drafts.get(draftKey) || "");
                }}
                className="mr-1 h-7 rounded-md border border-[var(--color-line)] px-2.5 text-[12px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-paper)]"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={editing ? sending || !text.trim() : !canSend}
              aria-label={editing ? "Save" : "Send"}
              title={editing ? "Save (Enter)" : phone ? "Send" : "Send (Enter)"}
              className={`flex h-7 flex-shrink-0 items-center justify-center rounded-md px-2.5 transition-colors disabled:bg-transparent disabled:text-[var(--color-muted)]/60 ${editing ? "bg-[var(--color-primary)] text-[12px] font-semibold text-white hover:bg-[var(--color-primary-hover)]" : "bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)]"}`}
            >
              {sending ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />
              ) : editing ? (
                "Save"
              ) : (
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                  <path d="M4.5 12L20 4.5 16.5 20l-4.2-6.3L4.5 12z" fill="currentColor" />
                  <path d="M12.3 13.7L20 4.5" stroke="var(--color-panel)" strokeWidth="1.3" strokeLinecap="round" opacity="0.6" />
                </svg>
              )}
            </button>
          </div>
        </div>
      )}
      <p className={`h-[18px] truncate px-1 pt-0.5 text-[11.5px] ${note ? "text-rose-600" : "text-[var(--color-muted)]"}`} aria-live="polite">
        {note ? (
          <>
            {note}
            {voice.error && (
              <button type="button" onClick={voice.clearError} className="ml-2 font-medium underline">
                OK
              </button>
            )}
          </>
        ) : (
          typing || ""
        )}
      </p>
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
