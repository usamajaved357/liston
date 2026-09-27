"use client";

import { FormEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { HuntReason } from "@/lib/api";

// A reviewer's decision: approve (a note if they like), reject (why, from
// the list, with a note), or send back to the hunter (what to change).

export type Decision = "approve" | "reject" | "send_back";

const COPY: Record<Decision, { title: string; lead: string; action: string; button: string; placeholder: string }> = {
  approve: {
    title: "Approve this product",
    lead: "It can be drafted straight away by anyone with Listings access.",
    action: "Approve",
    button: "btn-primary",
    placeholder: "A note for the hunter (optional)",
  },
  reject: {
    title: "Reject this product",
    lead: "The hunter sees why. Rejected products count against their approval rate.",
    action: "Reject",
    button: "btn-danger",
    placeholder: "Anything the hunter should know (optional)",
  },
  send_back: {
    title: "Send it back to the hunter",
    lead: "For a product worth another look: say what to change, such as a cheaper supplier or a better competitor. They resubmit it once fixed.",
    action: "Send back",
    button: "btn-primary",
    placeholder: "What should they change?",
  },
};

export function DecisionDialog({ decision, reasons, title, onClose, onSubmit }: { decision: Decision | null; reasons: HuntReason[]; title: string; onClose: () => void; onSubmit: (input: { decision: Decision; reason?: string; note?: string }) => Promise<void> }) {
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!decision) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decision, busy, onClose]);

  if (!decision || typeof document === "undefined") return null;
  const copy = COPY[decision];
  const needsNote = decision === "send_back" || (decision === "reject" && reason === "other");
  const ready = (decision !== "reject" || Boolean(reason)) && (!needsNote || note.trim().length >= 3);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || !decision) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ decision, reason: reason || undefined, note: note.trim() || undefined });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save. Try again.");
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-[rgba(15,23,42,0.45)] sm:items-center sm:p-4" onClick={() => !busy && onClose()}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={copy.title}
        className="w-full max-w-lg rounded-t-2xl bg-[var(--color-panel)] p-5 shadow-2xl animate-[fadeIn_150ms_ease-out] sm:rounded-2xl sm:p-6 max-h-[calc(100dvh-2rem)] overflow-y-auto pb-[max(20px,env(safe-area-inset-bottom))]"
      >
        <h2 className="text-[16px] font-semibold text-[var(--color-ink)]">{copy.title}</h2>
        <p className="mt-0.5 line-clamp-1 text-[12.5px] font-medium text-[var(--color-muted)]">{title}</p>
        <p className="mt-3 text-[13px] leading-relaxed text-[var(--color-muted)]">{copy.lead}</p>

        {decision === "reject" && (
          <fieldset className="mt-4">
            <legend className="label">Why</legend>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {reasons.map((r) => {
                const on = reason === r.key;
                return (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => setReason(r.key)}
                    aria-pressed={on}
                    className={`flex items-center justify-between rounded-xl border px-3 py-2.5 text-left text-[13px] font-medium transition-colors ${
                      on ? "border-rose-400 bg-rose-50 text-rose-800" : "border-[var(--color-line)] text-[var(--color-ink)] hover:border-[var(--color-line-strong)]"
                    }`}
                  >
                    {r.label}
                    <span className={`h-4 w-4 rounded-full border ${on ? "border-rose-500 bg-rose-500 shadow-[inset_0_0_0_3px_white]" : "border-[var(--color-line-strong)]"}`} aria-hidden />
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        <label className="mt-4 block">
          <span className="label">{needsNote ? "Note" : "Note (optional)"}</span>
          <textarea className="input mt-1.5 min-h-[88px] py-2" value={note} onChange={(e) => setNote(e.target.value)} placeholder={copy.placeholder} maxLength={1000} autoFocus={decision !== "reject"} />
        </label>

        {error && <div className="notice notice-danger mt-3">{error}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-ghost">
            Cancel
          </button>
          <button type="submit" disabled={busy || !ready} className={`btn ${copy.button}`}>
            {busy ? "Saving…" : copy.action}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
