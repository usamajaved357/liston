"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { ApiError, QuickReply, QuickReplyList, ebayInboxApi } from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TOKENS, fillReply, unknownTokens } from "@/components/inbox/ebay/quick-replies";

// Settings → Messages: the account's quick replies, the messages the Inbox's
// reply box offers on "/". Each has a name (what's picked) and its text,
// with fill-ins ({buyer}, {username}, {item}, {order}, {carrier},
// {tracking}, {delivery}) completed from the conversation when it's used.
// The owner adds as many as they need, edits them in place with a preview
// of what the buyer reads, and deletes them; the account starts with
// Liston's set.

const SAMPLE = {
  buyer: "Jane",
  username: "jane_smith88",
  item: "Cat Water Fountain 2L - Colour: Black",
  order: "17-12345-67890",
  carrier: "Royal Mail",
  tracking: "RM123456789GB",
  delivery: "between 6 October and 9 October",
};

// Each fill-in in a word or two, for the strip above the list (the full sentence is its tooltip).
const SHORT: Record<string, string> = { buyer: "first name", username: "eBay username", item: "the item", order: "order number", carrier: "delivery company", tracking: "tracking number", delivery: "when it's due" };

/** A reply's text with its fill-ins marked (one Liston doesn't know in amber). */
function TokenText({ text }: { text: string }) {
  const parts = text.split(/(\{[a-z_]+\})/gi);
  return (
    <>
      {parts.map((part, i) => {
        const token = /^\{([a-z_]+)\}$/i.exec(part);
        if (!token) return <Fragment key={i}>{part}</Fragment>;
        const known = (TOKENS as readonly string[]).includes(token[1].toLowerCase());
        return (
          <span key={i} className={`rounded px-[3px] font-medium ${known ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]" : "bg-amber-50 text-amber-700"}`}>
            {part}
          </span>
        );
      })}
    </>
  );
}

type Draft = { id: string | null; name: string; body: string };

function Editor({ draft, tokens, limits, saving, error, onChange, onSave, onCancel }: { draft: Draft; tokens: QuickReplyList["tokens"]; limits: QuickReplyList["limits"]; saving: boolean; error: string | null; onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const strange = unknownTokens(draft.body);

  useEffect(() => {
    if (caret.current === null || !area.current) return;
    area.current.focus();
    area.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [draft.body]);

  // A fill-in goes where the cursor is (or at the end).
  function insert(key: string) {
    const el = area.current;
    const token = `{${key}}`;
    const from = el?.selectionStart ?? draft.body.length;
    const to = el?.selectionEnd ?? from;
    caret.current = from + token.length;
    onChange({ ...draft, body: `${draft.body.slice(0, from)}${token}${draft.body.slice(to)}` });
  }

  return (
    <div className="bg-[var(--color-paper)]/60 px-6 py-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="min-w-0 space-y-3">
          <div>
            <label htmlFor="quick-name" className="text-[12px] font-semibold text-[var(--color-ink)]">
              Name
            </label>
            <input id="quick-name" value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} maxLength={limits.name} placeholder="What you'll pick it by, e.g. Dispatched" className="input mt-1.5 w-full text-[13px]" autoFocus={!draft.id} />
          </div>
          <div>
            <label htmlFor="quick-body" className="text-[12px] font-semibold text-[var(--color-ink)]">
              Message
            </label>
            <textarea ref={area} id="quick-body" value={draft.body} onChange={(e) => onChange({ ...draft, body: e.target.value })} rows={10} maxLength={limits.body} placeholder={"Hi {buyer},\n\n…"} className="input mt-1.5 !h-auto w-full resize-y py-2 text-[13px] leading-relaxed" />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-[11.5px] text-[var(--color-muted)]">Add</span>
              {tokens.map((t) => (
                <button key={t.key} type="button" onClick={() => insert(t.key)} title={t.label} className="rounded-md bg-[var(--color-primary-soft)] px-1.5 py-0.5 font-mono text-[11.5px] text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary)] hover:text-white">
                  {`{${t.key}}`}
                </button>
              ))}
              <span className="ml-auto text-[11.5px] tabular-nums text-[var(--color-muted)]">
                {draft.body.length} / {limits.body.toLocaleString()}
              </span>
            </div>
            {strange.length > 0 && <p className="mt-1.5 text-[11.5px] text-amber-700">{strange.join(", ")} isn&apos;t a fill-in Liston knows, so it would reach the buyer as it is.</p>}
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-[var(--color-ink)]">What the buyer reads</p>
          <div className="mt-1.5 whitespace-pre-line rounded-2xl rounded-tl-sm bg-[var(--color-panel)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-ink)] shadow-[var(--shadow-bubble)]">{draft.body.trim() ? fillReply(draft.body, SAMPLE) : <span className="text-[var(--color-muted)]">Your message, filled in for an example order.</span>}</div>
          <p className="mt-2 text-[11.5px] leading-snug text-[var(--color-muted)]">
            Filled in from the conversation when it&apos;s used. A fill-in the conversation doesn&apos;t have yet (tracking before it&apos;s sent, say) stays in the reply box to fill in by hand before it goes.
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        {error && <span className="mr-auto text-[12.5px] text-[var(--color-danger)]">{error}</span>}
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
          Cancel
        </button>
        <button type="button" onClick={onSave} disabled={saving || !draft.name.trim() || !draft.body.trim()} className="btn btn-primary btn-sm">
          {saving ? "Saving…" : draft.id ? "Save" : "Add quick reply"}
        </button>
      </div>
    </div>
  );
}

export function QuickRepliesCard({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<QuickReplyList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<QuickReply | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);

  useEffect(() => {
    let live = true;
    ebayInboxApi
      .quickReplies(connectionId)
      .then((d) => live && setData(d))
      .catch((err) => live && setLoadError(err instanceof ApiError ? err.message : "Couldn't load the quick replies."));
    return () => {
      live = false;
    };
  }, [connectionId]);

  function edit(d: Draft) {
    setError(null);
    setDraft(d);
  }

  async function save() {
    if (!draft || !data) return;
    setSaving(true);
    setError(null);
    try {
      const input = { name: draft.name, body: draft.body };
      const saved = draft.id ? await ebayInboxApi.saveQuickReply(connectionId, draft.id, input) : await ebayInboxApi.addQuickReply(connectionId, input);
      setData({ ...data, replies: draft.id ? data.replies.map((r) => (r.id === saved.id ? saved : r)) : [...data.replies, saved] });
      setDraft(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!deleting || !data) return;
    setBusyDelete(true);
    try {
      await ebayInboxApi.deleteQuickReply(connectionId, deleting.id);
      setData({ ...data, replies: data.replies.filter((r) => r.id !== deleting.id) });
      if (draft?.id === deleting.id) setDraft(null);
      setDeleting(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete it. Try again.");
      setDeleting(null);
    } finally {
      setBusyDelete(false);
    }
  }

  if (!data) return loadError ? <div className="card px-6 py-5 text-[13px] text-[var(--color-danger)]">{loadError}</div> : <div className="card h-48 animate-pulse" />;
  const full = data.replies.length >= data.limits.count;

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-line)] px-6 py-5">
        <div className="min-w-[240px] flex-1">
          <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">Quick replies</h2>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
            Type <kbd className="rounded border border-[var(--color-line)] bg-[var(--color-paper)] px-1 font-mono text-[12px]">/</kbd> in a buyer conversation to pick one. It loads into the reply box with its fill-ins completed, for you to check before sending.
          </p>
        </div>
        {data.canEdit && (
          <button type="button" onClick={() => edit({ id: null, name: "", body: "Hi {buyer},\n\n" })} disabled={full || Boolean(draft && !draft.id)} className="btn btn-secondary btn-sm flex-shrink-0 gap-1.5" title={full ? `Up to ${data.limits.count} quick replies` : undefined}>
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
              <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            Add a quick reply
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-[var(--color-line)] px-6 py-3 text-[12px] text-[var(--color-muted)]">
        <span className="font-semibold text-[var(--color-ink)]">Fill-ins</span>
        {data.tokens.map((t) => (
          <span key={t.key} className="inline-flex items-center gap-1.5" title={t.label}>
            <code className="rounded bg-[var(--color-primary-soft)] px-1 font-mono text-[11.5px] text-[var(--color-primary)]">{`{${t.key}}`}</code>
            {SHORT[t.key] || t.label}
          </span>
        ))}
      </div>

      {draft && !draft.id && <Editor draft={draft} tokens={data.tokens} limits={data.limits} saving={saving} error={error} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} />}

      {data.replies.length === 0 && !draft ? (
        <p className="px-6 py-8 text-center text-[13px] text-[var(--color-muted)]">No quick replies yet. Add the messages you send most, and they&apos;re a &ldquo;/&rdquo; away in every conversation.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {data.replies.map((r) =>
            draft?.id === r.id ? (
              <li key={r.id}>
                <Editor draft={draft} tokens={data.tokens} limits={data.limits} saving={saving} error={error} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} />
              </li>
            ) : (
              <li key={r.id} className="group flex items-start gap-4 px-6 py-3.5">
                <button type="button" onClick={() => data.canEdit && edit({ id: r.id, name: r.name, body: r.body })} className="min-w-0 flex-1 text-left" disabled={!data.canEdit}>
                  <span className="block text-[13.5px] font-semibold text-[var(--color-ink)]">{r.name}</span>
                  <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-[19px] text-[var(--color-muted)]">
                    <TokenText text={r.body.replace(/\s+/g, " ")} />
                  </span>
                </button>
                {data.canEdit && (
                  <span className="flex flex-shrink-0 items-center gap-1 pt-0.5 opacity-70 transition-opacity group-hover:opacity-100">
                    <button type="button" onClick={() => edit({ id: r.id, name: r.name, body: r.body })} className="rounded-full px-2.5 py-1 text-[12px] font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]">
                      Edit
                    </button>
                    <button type="button" onClick={() => setDeleting(r)} className="rounded-full px-2.5 py-1 text-[12px] font-medium text-[var(--color-muted)] hover:bg-rose-50 hover:text-rose-600">
                      Delete
                    </button>
                  </span>
                )}
              </li>
            )
          )}
        </ul>
      )}
      {data.replies.length > 0 && (
        <div className="border-t border-[var(--color-line)] px-6 py-2.5 text-[11.5px] text-[var(--color-muted)]">
          {data.replies.length} of up to {data.limits.count}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        title={`Delete “${deleting?.name || ""}”?`}
        description="It's gone from the reply box for everyone on this account. Messages already sent aren't touched."
        confirmLabel="Delete"
        danger
        loading={busyDelete}
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
