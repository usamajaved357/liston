"use client";

import { useEffect, useState } from "react";
import { ApiError, QuickReply, QuickReplyList, ebayInboxApi } from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TOKENS, fillReply } from "@/components/inbox/ebay/quick-replies";
import { SettingsSection } from "./SettingsSection";
import { FillIn, TemplateEditor, TokenText } from "./TemplateEditor";

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

// Each fill-in in a word or two, for its chip (the full sentence is its tooltip).
const SHORT: Record<string, string> = { buyer: "First name", username: "eBay username", item: "Item", order: "Order number", carrier: "Delivery company", tracking: "Tracking number", delivery: "When it's due" };

type Draft = { id: string | null; name: string; body: string };

function Editor({ draft, tokens, limits, store, saving, error, onChange, onSave, onCancel }: { draft: Draft; tokens: QuickReplyList["tokens"]; limits: QuickReplyList["limits"]; store: string; saving: boolean; error: string | null; onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void }) {
  const fillIns: FillIn[] = tokens.map((t) => ({ key: t.key, label: SHORT[t.key] || t.key, hint: t.label }));
  return (
    <TemplateEditor
      id={`quick-body-${draft.id || "new"}`}
      value={draft.body}
      onChange={(body) => onChange({ ...draft, body })}
      fillIns={fillIns}
      limit={limits.body}
      preview={draft.body.trim() ? fillReply(draft.body, SAMPLE) : ""}
      from={store}
      to={SAMPLE.buyer}
      note="Filled in from the conversation when it's used. A fill-in the conversation doesn't have yet (tracking before it's sent, say) stays in the reply box to fill in by hand before it goes."
      top={
        <div>
          <label htmlFor={`quick-name-${draft.id || "new"}`} className="text-[12px] font-semibold text-[var(--color-ink)]">
            Name
          </label>
          <input id={`quick-name-${draft.id || "new"}`} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} maxLength={limits.name} placeholder="What you'll pick it by, e.g. Dispatched" className="input mt-1.5 w-full text-[13px]" autoFocus={!draft.id} />
        </div>
      }
      footer={
        <>
          {error && <span className="mr-auto text-[12.5px] text-[var(--color-danger)]">{error}</span>}
          <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={saving || !draft.name.trim() || !draft.body.trim()} className="btn btn-primary btn-sm">
            {saving ? "Saving…" : draft.id ? "Save" : "Add quick reply"}
          </button>
        </>
      }
    />
  );
}

export function QuickRepliesCard({ connectionId, store = "" }: { connectionId: string; store?: string }) {
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

  const full = Boolean(data && data.replies.length >= data.limits.count);
  const addButton = data?.canEdit && (
    <button type="button" onClick={() => edit({ id: null, name: "", body: "Hi {buyer},\n\n" })} disabled={full || Boolean(draft && !draft.id)} className="btn btn-secondary btn-sm flex-shrink-0 gap-1.5" title={full ? `Up to ${data.limits.count} quick replies` : undefined}>
      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
        <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      Add a quick reply
    </button>
  );
  const known = data?.tokens.map((t) => t.key) || [...TOKENS];

  return (
    <SettingsSection
      title="Quick replies"
      description={
        <>
          Type <kbd className="rounded border border-[var(--color-line)] bg-[var(--color-panel)] px-1 font-mono text-[12px]">/</kbd> in a buyer conversation to pick one. It loads into the reply box with its fill-ins completed, for you to check before sending.
        </>
      }
      action={addButton}
    >
      {!data ? (
        loadError ? <div className="card px-6 py-5 text-[13px] text-[var(--color-danger)]">{loadError}</div> : <div className="card h-48 animate-pulse" />
      ) : (
    <div className="card overflow-hidden">
      {draft && !draft.id && <Editor draft={draft} tokens={data.tokens} limits={data.limits} store={store} saving={saving} error={error} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} />}

      {data.replies.length === 0 && !draft ? (
        <p className="px-6 py-8 text-center text-[13px] text-[var(--color-muted)]">No quick replies yet. Add the messages you send most, and they&apos;re a &ldquo;/&rdquo; away in every conversation.</p>
      ) : (
        <ul className={`divide-y divide-[var(--color-line)] ${draft && !draft.id ? "border-t border-[var(--color-line)]" : ""}`}>
          {data.replies.map((r) =>
            draft?.id === r.id ? (
              <li key={r.id} className="[&>div]:border-t-0">
                <Editor draft={draft} tokens={data.tokens} limits={data.limits} store={store} saving={saving} error={error} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} />
              </li>
            ) : (
              <li key={r.id} className="group flex items-start gap-4 px-5 py-3.5 transition-colors hover:bg-[var(--color-paper)]/50 sm:px-6">
                <button type="button" onClick={() => data.canEdit && edit({ id: r.id, name: r.name, body: r.body })} className="min-w-0 flex-1 text-left" disabled={!data.canEdit}>
                  <span className="block text-[13.5px] font-semibold text-[var(--color-ink)]">{r.name}</span>
                  <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-[19px] text-[var(--color-muted)]">
                    <TokenText text={r.body.replace(/\s+/g, " ")} known={known} />
                  </span>
                </button>
                {data.canEdit && (
                  <span className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                    <button type="button" onClick={() => edit({ id: r.id, name: r.name, body: r.body })} aria-label={`Edit ${r.name}`} title="Edit" className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-primary-soft)] hover:text-[var(--color-primary)]">
                      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
                        <path d="M12.5 4.5l3 3L7 16H4v-3l8.5-8.5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <button type="button" onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`} title="Delete" className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-rose-50 hover:text-rose-600">
                      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
                        <path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.2a1 1 0 001 .8h4.6a1 1 0 001-.8L14 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </span>
                )}
              </li>
            )
          )}
        </ul>
      )}
      {data.replies.length > 0 && (
        <div className="border-t border-[var(--color-line)] px-5 py-2.5 text-[11.5px] text-[var(--color-muted)] sm:px-6">
          {data.replies.length} of up to {data.limits.count}
        </div>
      )}
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
    </SettingsSection>
  );
}
