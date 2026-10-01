"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, ebayInboxApi } from "@/lib/api";

// "Message buyer" from an order page: a message to the order's buyer about
// its item, sent through eBay from Liston (eBay threads it with anything
// already said, and it shows in the Inbox). What eBay blocks or flags is
// shown first with "Send anyway". A real message to a real buyer: it goes
// only when Send is pressed. Once sent, a link opens the conversation.

const MAX = 2000;

export function MessageBuyerDialog({ connectionId, orderId, buyer, item, onClose }: { connectionId: string; orderId: string; buyer: string; item: string | null; onClose: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<{ kind: string; text: string }[] | null>(null);
  const [sent, setSent] = useState<{ conversationId: string | null } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !sending && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

  async function send(confirm = false) {
    if (!text.trim() || text.length > MAX || sending) return;
    setSending(true);
    setError(null);
    try {
      const out = await ebayInboxApi.messageBuyer(connectionId, { orderId, text, confirm });
      if (!out.sent) {
        setWarnings(out.warnings);
        return;
      }
      setWarnings(null);
      setSent({ conversationId: out.conversationId });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send it. Nothing went to the buyer.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => !sending && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="message-buyer-title" className="w-full max-w-lg rounded-xl bg-[var(--color-panel)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {sent ? (
          <>
            <h2 id="message-buyer-title" className="text-[16px] font-semibold text-[var(--color-ink)]">
              Sent to {buyer}
            </h2>
            <p className="mt-1.5 text-[13px] text-[var(--color-muted)]">It went through eBay, and their answer will come to the Inbox.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn btn-ghost">
                Close
              </button>
              {sent.conversationId && (
                <Link href={`/accounts/${connectionId}/inbox?e=${connectionId}~${encodeURIComponent(sent.conversationId)}`} className="btn btn-primary">
                  Open in the Inbox
                </Link>
              )}
            </div>
          </>
        ) : (
          <>
            <h2 id="message-buyer-title" className="text-[16px] font-semibold text-[var(--color-ink)]">
              Message {buyer}
            </h2>
            <p className="mt-1 truncate text-[12.5px] text-[var(--color-muted)]">{item ? `About ${item}` : `About order ${orderId}`} · sent on eBay</p>
            <textarea
              autoFocus
              rows={6}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setWarnings(null);
              }}
              placeholder={`Write to ${buyer}…`}
              className="mt-3 w-full resize-y rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-[13px] leading-[1.5] text-[var(--color-ink)] outline-none focus:border-[var(--color-primary)]/60 focus:shadow-[0_0_0_3px_var(--color-primary-soft)]"
              aria-label={`Message to ${buyer}`}
            />
            <p className={`mt-1 text-right text-[11px] tabular-nums ${text.length > MAX ? "font-semibold text-rose-600" : "text-[var(--color-muted)]"}`}>
              {text.length.toLocaleString()} / {MAX.toLocaleString()}
            </p>
            {warnings && (
              <div className="mt-2 rounded-xl bg-amber-50 p-3 ring-1 ring-inset ring-amber-200">
                <p className="text-[12.5px] font-semibold text-amber-900">eBay may block or flag this message</p>
                <ul className="mt-1 space-y-0.5 text-[12px] leading-snug text-amber-800">
                  {warnings.map((w) => (
                    <li key={w.kind}>• {w.text}</li>
                  ))}
                </ul>
              </div>
            )}
            {error && <p className="mt-2 text-[12px] text-rose-600">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} disabled={sending} className="btn btn-ghost">
                Cancel
              </button>
              {warnings ? (
                <button type="button" onClick={() => send(true)} disabled={sending} className="btn btn-secondary text-amber-900">
                  Send anyway
                </button>
              ) : (
                <button type="button" onClick={() => send()} disabled={!text.trim() || text.length > MAX || sending} className="btn btn-primary">
                  {sending ? "Sending…" : "Send"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
