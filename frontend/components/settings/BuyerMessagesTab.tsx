"use client";

import { ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError, BuyerMessageKind, BuyerMessageSettings } from "@/lib/api";
import { Alert } from "@/components/Alert";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Switch } from "@/components/team/team-shared";
import { QuickRepliesCard } from "./QuickRepliesCard";
import { FillIn, TemplateEditor, TokenText } from "./TemplateEditor";
import { SettingsSection } from "./SettingsSection";

// Settings → Messages, in three parts:
//   Automatic messages  what Liston sends buyers by itself from the eBay
//                       account: an order confirmation as soon as they order,
//                       and a thank-you asking for feedback once it's
//                       delivered. Each switched on here (after a word on
//                       what it means) and worded in place, with the buyer's
//                       name, the item, the order number and the store
//                       filled in per order. Each order gets each once (the
//                       server makes sure): switched on, the last day's
//                       orders (the last few days' deliveries) and after.
//   Quick replies       the Inbox's "/" replies (QuickRepliesCard).
//   Sent lately         what went, what eBay refused and what was skipped.

const FILL_INS: FillIn[] = [
  { key: "buyer", label: "First name", hint: "the buyer's first name, else their eBay username" },
  { key: "item", label: "Item", hint: "what they bought, with the option chosen" },
  { key: "order", label: "Order number" },
  { key: "store", label: "Store name", hint: "your store, as the message signs off" },
];
const KNOWN = FILL_INS.map((f) => f.key);
const SAMPLE = { buyer: "Jane", item: "Cat Water Fountain 2L (Colour: Black)", order: "17-12345-67890" };

const fill = (text: string, store: string) =>
  text
    .replace(/\{buyer\}/gi, SAMPLE.buyer)
    .replace(/\{item\}/gi, SAMPLE.item)
    .replace(/\{order\}/gi, SAMPLE.order)
    .replace(/\{store\}/gi, store)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const KINDS: {
  kind: BuyerMessageKind;
  title: string;
  when: string;
  confirm: { title: string; text: string };
  note: string;
  icon: ReactNode;
}[] = [
  {
    kind: "placed",
    title: "Order confirmation",
    when: "As soon as a buyer places an order: thanks them, and asks them to reply here first if anything isn't right.",
    confirm: {
      title: "Send order confirmations?",
      text: "From now on, every buyer who orders gets this message from your eBay account: once per order, and no more than once a day per buyer. Paid orders from the last 24 hours that aren't dispatched yet get it too; older orders aren't messaged.",
    },
    note: "Sent within a minute or so of the order, for paid orders not yet dispatched. A buyer with a second order the same day isn't messaged again. Replies land in your Inbox.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
        <path d="M5 8h14l-1.2 11.1a2 2 0 01-2 1.9H8.2a2 2 0 01-2-1.9L5 8z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M9 10V7a3 3 0 016 0v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M9.5 14.5l1.8 1.8 3.4-3.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    kind: "delivered",
    title: "Delivery thank-you",
    when: "Once eBay shows the order delivered: hopes they're happy, and asks for feedback on the item and your service.",
    confirm: {
      title: "Send delivery thank-yous?",
      text: "From now on, each buyer whose order eBay shows as delivered gets this message from your eBay account, once per order, within a few days of delivery. Orders delivered in the last 3 days get it too; earlier deliveries aren't messaged.",
    },
    note: "Sent within a few days of delivery, once per order, including deliveries in the 3 days before you switched it on. Replies land in your Inbox.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
        <path d="M4 8l8-4 8 4v8l-8 4-8-4V8z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M4 8l8 4 8-4M12 12v8" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      </svg>
    ),
  },
];
const nameOf = (kind: BuyerMessageKind) => KINDS.find((k) => k.kind === kind)?.title || kind;

function AutomaticMessage({
  spec,
  data,
  connectionId,
  onSaved,
}: {
  spec: (typeof KINDS)[number];
  data: BuyerMessageSettings;
  connectionId: string;
  onSaved: (d: BuyerMessageSettings) => void;
}) {
  const setting = data[spec.kind];
  const current = setting.text || setting.defaultText;
  const [draft, setDraft] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sent = data.recent.last30.byKind?.[spec.kind]?.sent || 0;

  async function save(change: { enabled: boolean; text?: string | null }) {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateConnectionMessages(connectionId, { [spec.kind]: change }));
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function switchOn() {
    setAsking(false);
    await save({ enabled: true });
  }

  async function saveText() {
    if (draft === null) return;
    if (await save({ enabled: setting.enabled, text: draft.trim() || null })) setDraft(null);
  }

  const status = setting.enabled ? (
    <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-[1px] text-[11px] font-semibold text-[var(--color-accent)]">On</span>
  ) : (
    <span className="rounded-full bg-[var(--color-paper)] px-2 py-[1px] text-[11px] font-semibold text-[var(--color-muted)]">Off</span>
  );

  return (
    <div>
      <div className="flex items-start gap-4 px-5 py-4 sm:px-6">
        <span className={`mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${setting.enabled ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]" : "bg-[var(--color-paper)] text-[var(--color-muted)]"}`}>{spec.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-[var(--color-ink)]">{spec.title}</h3>
            {status}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{spec.when}</p>
          {draft === null && (
            <div className="mt-2.5 rounded-lg bg-[var(--color-paper)] px-3 py-2">
              <p className="line-clamp-2 text-[12.5px] leading-[19px] text-[var(--color-ink)]/80">
                <TokenText text={current.replace(/\s+/g, " ")} known={KNOWN} />
              </p>
            </div>
          )}
          {draft === null && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--color-muted)]">
              <button type="button" onClick={() => setDraft(current)} className="font-medium text-[var(--color-primary)] hover:underline">
                Edit message
              </button>
              <span aria-hidden>·</span>
              <span>{setting.text ? "Your wording" : "Liston's wording"}</span>
              {(setting.enabled || sent > 0) && (
                <>
                  <span aria-hidden>·</span>
                  <span>{sent} sent in the last 30 days</span>
                </>
              )}
              {error && <span className="basis-full text-[var(--color-danger)]">{error}</span>}
            </div>
          )}
        </div>
        <div className="pt-1">
          <Switch
            on={setting.enabled}
            disabled={busy || (!setting.enabled && !data.canMessage)}
            label={`${spec.title}: ${setting.enabled ? "on" : "off"}`}
            onChange={() => (setting.enabled ? save({ enabled: false }) : setAsking(true))}
          />
        </div>
      </div>

      {draft !== null && (
        <TemplateEditor
          id={`message-${spec.kind}`}
          value={draft}
          onChange={setDraft}
          fillIns={FILL_INS}
          limit={2000}
          preview={fill(draft || setting.defaultText, data.store)}
          from={data.store}
          to={SAMPLE.buyer}
          note={spec.note}
          autoFocus
          footer={
            <>
              {error && <span className="mr-auto text-[12.5px] text-[var(--color-danger)]">{error}</span>}
              {draft.trim() !== setting.defaultText.trim() && (
                <button type="button" onClick={() => setDraft(setting.defaultText)} className={`${error ? "" : "mr-auto"} text-[12.5px] font-medium text-[var(--color-primary)] hover:underline`}>
                  Use Liston&apos;s wording
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setError(null);
                }}
                className="btn btn-ghost btn-sm"
              >
                Cancel
              </button>
              <button type="button" onClick={saveText} disabled={busy || draft.trim() === current.trim()} className="btn btn-primary btn-sm">
                {busy ? "Saving…" : "Save message"}
              </button>
            </>
          }
        />
      )}

      <ConfirmDialog open={asking} title={spec.confirm.title} description={spec.confirm.text} confirmLabel="Switch on" loading={busy} onConfirm={switchOn} onCancel={() => setAsking(false)} />
    </div>
  );
}

function SentLately({ data, connectionId }: { data: BuyerMessageSettings; connectionId: string }) {
  const { items, last30 } = data.recent;
  const skipped = Object.values(last30.byKind || {}).reduce((n, k) => n + (k?.skipped || 0), 0);
  const summary = [`${last30.sent} sent`, last30.failed ? `${last30.failed} not sent` : null, skipped ? `${skipped} skipped` : null].filter(Boolean).join(" · ");
  return (
    <SettingsSection title="Sent lately" description={`The latest automatic messages. Last 30 days: ${summary}.`}>
      <div className="card overflow-hidden">
        {items.length ? (
          <ul className="divide-y divide-[var(--color-line)]">
            {items.map((m) => {
              const tone =
                m.status === "sent"
                  ? { dot: "bg-emerald-500", label: "Sent", text: "text-emerald-700" }
                  : m.status === "skipped"
                    ? { dot: "bg-slate-300", label: "Skipped", text: "text-[var(--color-muted)]" }
                    : { dot: "bg-rose-500", label: "Not sent", text: "text-rose-700" };
              return (
                <li key={`${m.orderId}-${m.kind}`} className="flex items-center gap-3 px-5 py-3 sm:px-6">
                  <span className={`h-2 w-2 flex-shrink-0 rounded-full ${tone.dot}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
                      <span className="font-semibold text-[var(--color-ink)]">{nameOf(m.kind)}</span>
                      <span className="text-[var(--color-muted)]">to {m.buyer || "the buyer"}</span>
                      <Link href={`/accounts/${connectionId}/orders/${encodeURIComponent(m.orderId)}`} className="font-mono text-[12px] text-[var(--color-muted)] hover:text-[var(--color-primary)] hover:underline">
                        {m.orderId}
                      </Link>
                    </div>
                    {m.status !== "sent" && m.error && <p className="mt-0.5 truncate text-[12px] text-[var(--color-muted)]" title={m.error}>{m.error}</p>}
                  </div>
                  <span className={`flex-shrink-0 text-[12px] font-medium ${tone.text}`}>{tone.label}</span>
                  <span className="w-[52px] flex-shrink-0 text-right text-[12px] tabular-nums text-[var(--color-muted)]">{new Date(m.sentAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-6 py-8 text-center text-[13px] text-[var(--color-muted)]">Nothing sent yet. Switch on a message above and it shows here as it goes out.</p>
        )}
      </div>
    </SettingsSection>
  );
}

export function BuyerMessagesTab({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<BuyerMessageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getConnectionMessages(connectionId)
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn't load the message settings."));
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  return (
    <div className="space-y-9">
      <SettingsSection
        title="Automatic messages"
        description={
          <>
            Sent by Liston from your eBay account, once per order. They sign off as <span className="font-medium text-[var(--color-ink)]">{data?.store || "your store"}</span>, the store name in your description template.
          </>
        }
      >
        {!data ? (
          error ? <Alert>{error}</Alert> : <div className="card h-56 animate-pulse" />
        ) : (
          <>
            {!data.canMessage && (
              <div className="notice notice-warning mb-3">
                <span className="flex-1">
                  This account&apos;s eBay sign-in doesn&apos;t allow messages yet. <Link href="/connections" className="font-semibold underline">Reconnect it</Link> (one click) to switch these on.
                </span>
              </div>
            )}
            <div className="card divide-y divide-[var(--color-line)] overflow-hidden">
              {KINDS.map((spec) => (
                <AutomaticMessage key={spec.kind} spec={spec} data={data} connectionId={connectionId} onSaved={setData} />
              ))}
            </div>
          </>
        )}
      </SettingsSection>

      <QuickRepliesCard connectionId={connectionId} store={data?.store || ""} />

      {data && <SentLately data={data} connectionId={connectionId} />}
    </div>
  );
}
