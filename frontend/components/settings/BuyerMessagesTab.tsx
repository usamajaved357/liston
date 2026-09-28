"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, ApiError, BuyerMessageSettings } from "@/lib/api";
import { Alert } from "@/components/Alert";

// Settings → Messages: the message Liston sends a buyer once their order is
// delivered, asking for feedback on the item and the service and inviting
// them to reply if anything's wrong. Off until the owner switches it on;
// {buyer} and {item} are filled in per order. Each order gets it once,
// within a few days of delivery, only for deliveries after it's switched on.

const SAMPLE = { buyer: "Jane", item: "Cat Water Fountain 2L" };
const fill = (text: string) => text.replace(/\{buyer\}/gi, SAMPLE.buyer).replace(/\{item\}/gi, SAMPLE.item);

export function BuyerMessagesTab({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<BuyerMessageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getConnectionMessages(connectionId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setEnabled(d.delivered.enabled);
        setText(d.delivered.text || d.delivered.defaultText);
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn't load the message settings."));
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const dirty = useMemo(() => Boolean(data) && (enabled !== data!.delivered.enabled || text.trim() !== (data!.delivered.text || data!.delivered.defaultText).trim()), [data, enabled, text]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const d = await api.updateConnectionMessages(connectionId, { enabled, text: text.trim() || null });
      setData(d);
      setText(d.delivered.text || d.delivered.defaultText);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!data) return error ? <Alert>{error}</Alert> : <div className="card h-64 animate-pulse" />;

  return (
    <div className="space-y-6">
      <div className="card overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-6 py-5">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">Message buyers when their order is delivered</h2>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
              A thank-you once eBay shows the order delivered, asking for feedback on the item and your service, and inviting them to reply if anything isn&apos;t right. Sent once per order, from your eBay account.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Message buyers when their order is delivered"
            onClick={() => setEnabled((v) => !v)}
            className={`relative mt-1 inline-flex h-[22px] w-[38px] flex-shrink-0 items-center rounded-full transition-colors ${enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-line-strong)]"}`}
          >
            <span className={`absolute left-[3px] h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0"}`} />
          </button>
        </div>

        {!data.canMessage && (
          <div className="notice notice-warning mx-6 mt-4">
            <span className="flex-1">
              This account&apos;s eBay sign-in doesn&apos;t allow messages yet. <Link href="/connections" className="font-semibold underline">Reconnect it</Link> (one click) and switch this on again.
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 px-6 py-5 lg:grid-cols-2">
          <div>
            <label htmlFor="delivered-text" className="text-[12px] font-semibold text-[var(--color-ink)]">
              The message
            </label>
            <textarea
              id="delivered-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={11}
              maxLength={2000}
              className="input mt-1.5 !h-auto w-full resize-y py-2 text-[13px] leading-relaxed"
            />
            <div className="mt-1 flex items-center justify-between text-[11.5px] text-[var(--color-muted)]">
              <span>
                <code className="rounded bg-[var(--color-paper)] px-1">{"{buyer}"}</code> their first name · <code className="rounded bg-[var(--color-paper)] px-1">{"{item}"}</code> what they bought
              </span>
              <span className="tabular-nums">{text.length} / 2,000</span>
            </div>
            {text.trim() !== data.delivered.defaultText.trim() && (
              <button type="button" onClick={() => setText(data.delivered.defaultText)} className="mt-1.5 text-[12px] font-medium text-[var(--color-primary)] hover:underline">
                Use Liston&apos;s wording
              </button>
            )}
          </div>
          <div>
            <p className="text-[12px] font-semibold text-[var(--color-ink)]">What the buyer sees</p>
            <div className="mt-1.5 rounded-2xl rounded-tl-sm bg-[var(--color-paper)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-ink)] whitespace-pre-line">{fill(text || data.delivered.defaultText)}</div>
            <p className="mt-2 text-[11.5px] leading-snug text-[var(--color-muted)]">
              Sent within a few days of delivery, once per order, and only for orders delivered after you switch it on. A buyer&apos;s reply lands in your eBay Messages.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-[var(--color-line)] px-6 py-3">
          {(error || saved) && <span className={`text-[12.5px] ${error ? "text-[var(--color-danger)]" : "text-[var(--color-accent)]"}`}>{error || (enabled ? "Saved: it's on" : "Saved")}</span>}
          <button type="button" onClick={save} disabled={saving || !dirty} className="btn btn-primary btn-sm">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-6 py-4">
          <div>
            <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Sent lately</h2>
            <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">
              Last 30 days: {data.recent.last30.sent} sent{data.recent.last30.failed ? `, ${data.recent.last30.failed} eBay didn't take` : ""}.
            </p>
          </div>
        </div>
        {data.recent.items.length ? (
          <ul className="divide-y divide-[var(--color-line)]">
            {data.recent.items.map((m) => (
              <li key={`${m.orderId}-${m.kind}`} className="flex items-center gap-3 px-6 py-2.5 text-[12.5px]">
                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${m.status === "sent" ? "bg-emerald-500" : "bg-rose-500"}`} aria-hidden />
                <Link href={`/accounts/${connectionId}/orders/${encodeURIComponent(m.orderId)}`} className="font-mono text-[12px] text-[var(--color-ink)] hover:text-[var(--color-primary)] hover:underline">
                  {m.orderId}
                </Link>
                <span className="min-w-0 flex-1 truncate text-[var(--color-muted)]">
                  {m.buyer}
                  {m.status === "failed" && m.error ? ` · not sent: ${m.error}` : ""}
                </span>
                <span className="flex-shrink-0 text-[11.5px] text-[var(--color-muted)]">{new Date(m.sentAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-6 py-6 text-center text-[12.5px] text-[var(--color-muted)]">Nothing sent yet.</p>
        )}
      </div>
    </div>
  );
}
