"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, ApiError, Amount, OrderDetail, OrderDetailLine, OrderDetailResponse, OrderEvent, OrderSourcing, SourceAccount, SourcingPatch, User } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { formatPrice, formatShortDate, formatDateTime } from "@/lib/format";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";

// One eBay order, laid out the way Seller Hub's order page is — the
// dispatch deadline and its paid → dispatched → delivered track, Postage,
// Item, then Order and Payment (what the buyer paid, what eBay took, what
// you earned) down the side — plus the part Seller Hub never had: a Source
// section saying where each item was bought from, by whom, and the
// supplier's tracking, which dispatches the item on eBay when it is saved.

const labelClass = "text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]";
const cardClass = "rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5";
const inputClass = "input input-sm w-full";

function money(a: Amount | null | undefined, fallbackCurrency = "GBP") {
  if (!a) return "—";
  return formatPrice(a.value, a.currency || fallbackCurrency);
}

function paymentLabel(status: string | null) {
  switch (status) {
    case "PAID":
      return { text: "Paid", tone: "ok" };
    case "FULLY_REFUNDED":
      return { text: "Refunded", tone: "warn" };
    case "PARTIALLY_REFUNDED":
      return { text: "Partly refunded", tone: "warn" };
    case "PENDING":
      return { text: "Awaiting payment", tone: "warn" };
    case "FAILED":
      return { text: "Payment failed", tone: "bad" };
    default:
      return { text: status || "—", tone: "muted" };
  }
}

function fulfillmentLabel(order: OrderDetail) {
  if (order.cancelState && order.cancelState !== "NONE_REQUESTED") {
    return order.cancelState === "CANCELED" ? { text: "Cancelled", tone: "bad" } : { text: "Cancel requested", tone: "warn" };
  }
  switch (order.fulfillmentStatus) {
    case "FULFILLED":
      return { text: "Dispatched", tone: "ok" };
    case "IN_PROGRESS":
      return { text: "Partly dispatched", tone: "warn" };
    default:
      return { text: "Awaiting dispatch", tone: "warn" };
  }
}

const TONES: Record<string, string> = {
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warn: "bg-amber-50 text-amber-800 border-amber-200",
  bad: "bg-red-50 text-[var(--color-danger)] border-red-200",
  muted: "bg-[var(--color-paper)] text-[var(--color-muted)] border-[var(--color-line)]",
};

function Chip({ text, tone }: { text: string; tone: string }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[12px] font-semibold ${TONES[tone] || TONES.muted}`}>{text}</span>;
}

function daysUntil(iso: string | null) {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function cleanTitle(title: string | null) {
  return (title || "").replace(/\[[^[\]]*\]\s*$/, "").trim();
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="btn btn-ghost btn-sm"
    >
      {done ? "Copied" : label}
    </button>
  );
}

const SOURCING_STATUS: { value: OrderSourcing["status"]; label: string; tone: string }[] = [
  { value: "to_order", label: "To order", tone: "warn" },
  { value: "ordered", label: "Ordered", tone: "muted" },
  { value: "shipped", label: "Shipped", tone: "ok" },
  { value: "delivered", label: "Delivered", tone: "ok" },
  { value: "problem", label: "Problem", tone: "bad" },
];

// --- sourcing card (one per line item) -----------------------------------

function SourcingCard({
  connectionId,
  orderId,
  line,
  accounts,
  carriers,
  actionsEnabled,
  user,
  currency,
  onSaved,
  onManageAccounts,
  note,
  onNote,
}: {
  connectionId: string;
  orderId: string;
  line: OrderDetailLine;
  accounts: SourceAccount[];
  carriers: { code: string; label: string }[];
  actionsEnabled: boolean;
  user: User;
  currency: string;
  onSaved: (sourcing: OrderSourcing, dispatch: { ok: boolean; reason?: string } | null) => void;
  onManageAccounts: () => void;
  // Kept by the parent: the card remounts on each save (it is keyed by the
  // saved row) and the message must outlive that.
  note: { tone: "ok" | "bad"; text: string } | null;
  onNote: (note: { tone: "ok" | "bad"; text: string } | null) => void;
}) {
  const s = line.sourcing;
  const [status, setStatus] = useState<OrderSourcing["status"]>(s?.status || "to_order");
  const [sourceAccountId, setSourceAccountId] = useState(s?.sourceAccountId || "");
  const [sourceOrderNo, setSourceOrderNo] = useState(s?.sourceOrderNo || "");
  const [placedAt, setPlacedAt] = useState(s?.placedAt ? String(s.placedAt).slice(0, 10) : "");
  const [cardLabel, setCardLabel] = useState(s?.cardLabel || "");
  const [cost, setCost] = useState(s?.cost ? String(s.cost.value) : "");
  const [tracking, setTracking] = useState(s?.trackingNumber || "");
  const [carrier, setCarrier] = useState(s?.carrier || "");
  const [notes, setNotes] = useState(s?.notes || "");
  const [saving, setSaving] = useState(false);
  const setNote = onNote;
  const [showPassword, setShowPassword] = useState(false);

  const account = accounts.find((a) => a.id === sourceAccountId) || null;
  const trackingChanged = tracking.replace(/\s+/g, "") !== (s?.trackingNumber || "");
  const dirty =
    status !== (s?.status || "to_order") ||
    sourceAccountId !== (s?.sourceAccountId || "") ||
    sourceOrderNo !== (s?.sourceOrderNo || "") ||
    placedAt !== (s?.placedAt ? String(s.placedAt).slice(0, 10) : "") ||
    cardLabel !== (s?.cardLabel || "") ||
    cost !== (s?.cost ? String(s.cost.value) : "") ||
    trackingChanged ||
    carrier !== (s?.carrier || "") ||
    notes !== (s?.notes || "");

  async function save() {
    setSaving(true);
    setNote(null);
    const patch: SourcingPatch = {
      sourceAccountId: sourceAccountId || null,
      sourceOrderNo,
      placedAt: placedAt || null,
      cardLabel,
      cost: cost.trim() ? { value: cost.trim(), currency } : null,
      trackingNumber: tracking,
      notes,
      quantity: line.quantity,
      ...(carrier ? { carrier } : {}),
      // The status follows the data unless the person changed it.
      ...(status !== (s?.status || "to_order") ? { status } : {}),
    };
    try {
      const result = await api.saveOrderSourcing(connectionId, orderId, line.sourcingKey, patch);
      onSaved(result.sourcing, result.dispatch);
      if (result.dispatch) {
        setNote(result.dispatch.ok ? { tone: "ok", text: "Saved — marked dispatched on eBay with this tracking number." } : { tone: "bad", text: `Saved, but not dispatched on eBay: ${result.dispatch.reason}` });
      } else {
        setNote({ tone: "ok", text: "Saved." });
      }
    } catch (err) {
      setNote({ tone: "bad", text: err instanceof ApiError ? err.message : "Couldn't save. Try again." });
    } finally {
      setSaving(false);
    }
  }

  const statusMeta = SOURCING_STATUS.find((x) => x.value === (s?.status || "to_order")) || SOURCING_STATUS[0];

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)]/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          {line.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={line.imageUrl} alt="" className="h-10 w-10 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-cover" />
          ) : (
            <div className="h-10 w-10 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-white" />
          )}
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-[var(--color-ink)]">{cleanTitle(line.title)}</p>
            <p className="text-[11.5px] text-[var(--color-muted)]">
              × {line.quantity}
              {line.variation.map((v) => (
                <span key={v.name}>
                  {" · "}
                  {v.name}: {v.value}
                </span>
              ))}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Chip text={statusMeta.label} tone={statusMeta.tone} />
          {s?.dispatchedAt && <span className="text-[11.5px] text-[var(--color-muted)]">Dispatched on eBay {formatShortDate(s.dispatchedAt)}{s.dispatchedBy?.name ? ` by ${s.dispatchedBy.name}` : ""}</span>}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className={labelClass}>Source account</label>
          <div className="mt-1 flex gap-1.5">
            <select className={inputClass} value={sourceAccountId} onChange={(e) => setSourceAccountId(e.target.value)}>
              <option value="">—</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} · {a.email}
                </option>
              ))}
            </select>
            <button type="button" onClick={onManageAccounts} className="btn btn-secondary btn-sm flex-shrink-0" title="Manage source accounts">
              +
            </button>
          </div>
          {account && (
            <p className="mt-1 flex items-center gap-2 text-[11.5px] text-[var(--color-muted)]">
              <span className="truncate">{account.email}</span>
              {account.password && (
                <>
                  <span className="font-mono">{showPassword ? account.password : "••••••••"}</span>
                  <button type="button" onClick={() => setShowPassword((v) => !v)} className="text-[var(--color-primary)] hover:underline" aria-label={showPassword ? "Hide password" : "Show password"}>
                    {showPassword ? "hide" : "show"}
                  </button>
                  <CopyButton text={account.password} label="copy" />
                </>
              )}
            </p>
          )}
        </div>
        <div>
          <label className={labelClass}>Source order #</label>
          <input className={`${inputClass} mt-1 font-mono`} value={sourceOrderNo} onChange={(e) => setSourceOrderNo(e.target.value)} placeholder="e.g. 3075828642684994" />
        </div>
        <div>
          <label className={labelClass}>Placing date</label>
          <input type="date" className={`${inputClass} mt-1`} value={placedAt} onChange={(e) => setPlacedAt(e.target.value)} />
          {s?.placedBy?.name && <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">Placed by {s.placedBy.name}</p>}
        </div>
        <div>
          <label className={labelClass}>Card</label>
          <input className={`${inputClass} mt-1`} value={cardLabel} onChange={(e) => setCardLabel(e.target.value)} placeholder="e.g. tide" />
        </div>
        <div>
          <label className={labelClass}>Cost paid ({currency})</label>
          <input type="number" step="0.01" min="0" className={`${inputClass} mt-1`} value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00" />
        </div>
        <div>
          <label className={labelClass}>Status</label>
          <select className={`${inputClass} mt-1`} value={status} onChange={(e) => setStatus(e.target.value as OrderSourcing["status"])}>
            {SOURCING_STATUS.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>Tracking number</label>
          <input className={`${inputClass} mt-1 font-mono`} value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Paste the supplier's tracking number" />
          <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">
            {actionsEnabled ? "Saving a new tracking number marks this item dispatched on eBay." : "eBay dispatch is off for this account until it is reconnected; the number is still saved."}
          </p>
        </div>
        <div>
          <label className={labelClass}>Carrier</label>
          <select className={`${inputClass} mt-1`} value={carrier} onChange={(e) => setCarrier(e.target.value)}>
            <option value="">Detect from number</option>
            {carriers.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <label className={labelClass}>Notes</label>
          <input className={`${inputClass} mt-1`} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the team should know about this supplier order" />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className={`text-[12px] ${note?.tone === "bad" ? "font-medium text-[var(--color-danger)]" : "text-emerald-700"}`}>{note?.text || ""}</p>
        <button type="button" onClick={save} disabled={saving || !dirty} className="btn btn-primary btn-sm">
          {saving ? "Saving…" : trackingChanged && tracking.trim() && actionsEnabled ? "Save & dispatch on eBay" : "Save"}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-[var(--color-muted)]">Signed in as {user.name || user.email}.</p>
    </div>
  );
}

// --- source accounts dialog ----------------------------------------------

function SourceAccountsDialog({ accounts, onChange, onClose }: { accounts: SourceAccount[]; onChange: (accounts: SourceAccount[]) => void; onClose: () => void }) {
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, boolean>>({});

  async function create() {
    if (!label.trim() || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { account } = await api.createSourceAccount({ label: label.trim(), email: email.trim(), password: password || null });
      onChange([...accounts, account].sort((a, b) => a.label.localeCompare(b.label)));
      setLabel("");
      setEmail("");
      setPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add the account.");
    } finally {
      setBusy(false);
    }
  }

  async function archive(id: string) {
    try {
      await api.updateSourceAccount(id, { archived: true });
      onChange(accounts.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove the account.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="w-full max-w-xl rounded-2xl bg-[var(--color-panel)] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-[var(--color-ink)]">Source accounts</h2>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
            Close
          </button>
        </div>
        <p className="mt-1 text-xs text-[var(--color-muted)]">The supplier buying accounts the team orders from. Shared with every team member.</p>
        {error && <p className="mt-2 text-xs font-medium text-[var(--color-danger)]">{error}</p>}
        <div className="mt-3 max-h-64 divide-y divide-[var(--color-line)] overflow-y-auto">
          {accounts.length === 0 && <p className="py-3 text-sm text-[var(--color-muted)]">No accounts yet.</p>}
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[var(--color-ink)]">{a.label}</p>
                <p className="truncate text-[12px] text-[var(--color-muted)]">
                  {a.email}
                  {a.password && (
                    <>
                      {" · "}
                      <span className="font-mono">{shown[a.id] ? a.password : "••••••••"}</span>{" "}
                      <button type="button" onClick={() => setShown((v) => ({ ...v, [a.id]: !v[a.id] }))} className="text-[var(--color-primary)] hover:underline">
                        {shown[a.id] ? "hide" : "show"}
                      </button>
                    </>
                  )}
                </p>
              </div>
              <button type="button" onClick={() => archive(a.id)} className="btn btn-ghost btn-sm text-[var(--color-danger)]">
                Remove
              </button>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-xl border border-dashed border-[var(--color-line)] p-3">
          <p className={labelClass}>Add an account</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <input className={inputClass} placeholder="Label (e.g. AE main)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <input className={inputClass} placeholder="Email / login" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input className={inputClass} placeholder="Password (optional)" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="mt-2 flex justify-end">
            <button type="button" onClick={create} disabled={busy || !label.trim() || !email.trim()} className="btn btn-secondary btn-sm">
              {busy ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- timeline -------------------------------------------------------------

function eventText(e: OrderEvent) {
  const d = e.detail as Record<string, unknown>;
  const amount = d.amount as Amount | undefined;
  switch (e.kind) {
    case "ebay.ordered":
      return "Order placed on eBay";
    case "ebay.paid":
      return `Buyer paid${amount ? ` ${money(amount)}` : ""}`;
    case "ebay.dispatched":
      return `Marked dispatched on eBay${d.carrier ? ` · ${d.carrier}` : ""}${d.trackingNumber ? ` ${d.trackingNumber}` : ""}`;
    case "ebay.dispatched_by_liston":
      return `Dispatched on eBay from Liston${d.carrier ? ` · ${d.carrier}` : ""}${d.trackingNumber ? ` ${d.trackingNumber}` : ""}`;
    case "ebay.refunded":
      return `Refund${amount ? ` of ${money(amount)}` : ""}${d.status ? ` (${String(d.status).toLowerCase()})` : ""}`;
    case "ebay.cancel_requested":
      return `Cancellation requested${d.initiator ? ` by ${String(d.initiator).toLowerCase()}` : ""}${d.reason ? ` · ${String(d.reason).replace(/_/g, " ").toLowerCase()}` : ""}`;
    case "sourcing.ordered":
      return `Supplier order placed · #${d.sourceOrderNo}`;
    case "note":
      return String(d.text || "");
    default:
      return e.kind;
  }
}

// --- eBay-shaped pieces ---------------------------------------------------

// "24 Sep at 11:59 pm BST", the way Seller Hub states a deadline.
function formatDeadline(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }).toLowerCase()}`;
}

function formatDayMonthYear(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function formatDayMonth(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// Seller Hub's three-step track under the deadline: paid → dispatched → delivered.
function ProgressTrack({ steps }: { steps: { label: string; date: string; done: boolean }[] }) {
  const lastDone = steps.reduce((acc, step, i) => (step.done ? i : acc), -1);
  const progress = steps.length > 1 ? Math.max(0, lastDone) / (steps.length - 1) : 0;
  const align = (i: number) => (i === 0 ? "text-left" : i === steps.length - 1 ? "text-right" : "text-center");
  return (
    <div className="mt-6">
      <div className="relative flex items-center justify-between">
        <div className="absolute left-[11px] right-[11px] top-1/2 h-[3px] -translate-y-1/2 rounded bg-[var(--color-line)]" />
        <div className="absolute left-[11px] top-1/2 h-[3px] -translate-y-1/2 rounded bg-[var(--color-primary)]" style={{ width: `calc((100% - 22px) * ${progress})` }} />
        {steps.map((step) => (
          <span key={step.label} className={`relative z-10 flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 ${step.done ? "border-[var(--color-primary)] bg-[var(--color-primary)]" : "border-[var(--color-line)] bg-white"}`}>
            {step.done && (
              <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 10.5l4 4 8-9" />
              </svg>
            )}
          </span>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-3">
        {steps.map((step, i) => (
          <div key={step.label} className={align(i)}>
            <p className="text-[13px] font-bold text-[var(--color-ink)]">{step.label}</p>
            <p className="text-[12px] text-[var(--color-muted)]">{step.date}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 py-1.5 text-[13px]">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className="min-w-0 text-[var(--color-ink)]">{value}</span>
    </div>
  );
}

function MoneyRow({ label, value, bold = false, indent = false, negative = false }: { label: string; value: string; bold?: boolean; indent?: boolean; negative?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 text-[13px] ${bold ? "font-bold text-[var(--color-ink)]" : "text-[var(--color-ink)]"} ${indent ? "pl-4" : ""}`}>
      <span className={indent ? "underline decoration-dotted underline-offset-2" : ""}>{label}</span>
      <span>{negative ? `-${value}` : value}</span>
    </div>
  );
}

function CopyIcon({ text, title }: { text: string; title: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={done ? "Copied" : title}
      aria-label={title}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="ml-1.5 inline-flex h-5 w-5 items-center justify-center rounded text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
    >
      {done ? (
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 text-emerald-600" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 10.5l4 4 8-9" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <rect x="7" y="7" width="10" height="10" rx="1.5" />
          <path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7" />
        </svg>
      )}
    </button>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 8l5 5 5-5" />
    </svg>
  );
}

// eBay's own guidance under "Postage", as Seller Hub shows it.
function PostageInstructions() {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-xl bg-[var(--color-paper)] p-4">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between text-left">
        <span className="flex items-center gap-2 text-[14px] font-bold text-[var(--color-ink)]">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z" />
            <circle cx="7" cy="17.5" r="1.5" />
            <circle cx="17" cy="17.5" r="1.5" />
          </svg>
          Postage instructions
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="mt-3 grid gap-5 text-[12.5px] leading-relaxed text-[var(--color-ink)] sm:grid-cols-3">
          <div>
            <p className="font-bold">Pack your item with care</p>
            <p className="mt-1">Use a box or envelope that&apos;s slightly larger than your item and cushion it with protective materials like bubble wrap, packing peanuts, foam or tissue paper to keep it secure during transit. If you&apos;re reusing a box, cover any previous labels or branding and reinforce corners with packing tape to ensure your package looks professional.</p>
          </div>
          <div>
            <p className="font-bold">Get your label</p>
            <p className="mt-1">Choose from a range of services featuring negotiated rates when you purchase a label with eBay. Your label will be pre-filled with the buyer&apos;s details and tracking will be uploaded automatically. Alternatively, you can find your own service and add the supplier&apos;s tracking number under Source below — Liston uploads it to eBay for you.</p>
          </div>
          <div>
            <p className="font-bold">Send on time</p>
            <p className="mt-1">Meet the required &quot;Dispatch by&quot; date when you drop off your package or schedule collection with the courier. If posting without tracking, mark the order as dispatched, although this method is not recommended as you will not receive proof of delivery. On-time delivery helps maintain your seller rating, feedback score and provides a better buyer experience.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// --- page -----------------------------------------------------------------

export default function OrderDetailPage() {
  const params = useParams<{ id: string; orderId: string }>();
  const { connection, user, loading: loadingConnection, error: connectionError } = useConnection(params.id);
  const [data, setData] = useState<OrderDetailResponse | null>(null);
  const [accounts, setAccounts] = useState<SourceAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [saveNotes, setSaveNotes] = useState<Record<string, { tone: "ok" | "bad"; text: string } | null>>({});
  const [moreOpen, setMoreOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [earnedOpen, setEarnedOpen] = useState(true);
  const [specificsOpen, setSpecificsOpen] = useState<Record<string, boolean>>({});

  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    api
      .getOrder(params.id, params.orderId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Couldn't load this order from eBay.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params.id, params.orderId, reloadKey]);

  useEffect(() => {
    api
      .listSourceAccounts()
      .then((d) => setAccounts(d.accounts))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [moreOpen]);

  const order = data?.order || null;
  const currency = order?.pricing.total?.currency || connection?.marketplace?.currency || "GBP";
  const dispatchBy = useMemo(() => {
    if (!order) return null;
    const dates = order.lineItems.map((li) => li.shipByDate).filter(Boolean) as string[];
    return dates.sort()[0] || null;
  }, [order]);
  const daysLeft = daysUntil(dispatchBy);

  const totalCost = useMemo(() => {
    if (!order) return null;
    const costs = order.lineItems.map((li) => li.sourcing?.cost?.value ?? null);
    if (costs.some((c) => c === null)) return null;
    return costs.reduce((a, b) => (a as number) + (b as number), 0) as number;
  }, [order]);

  function applySourcing(sourcing: OrderSourcing) {
    setData((current) => {
      if (!current) return current;
      return {
        ...current,
        order: {
          ...current.order,
          lineItems: current.order.lineItems.map((li) => (li.sourcingKey === sourcing.lineItemId ? { ...li, sourcing } : li)),
        },
      };
    });
  }

  async function addNote() {
    if (!noteText.trim()) return;
    setAddingNote(true);
    try {
      const { event } = await api.addOrderNote(params.id, params.orderId, noteText.trim());
      setData((current) => (current ? { ...current, events: [{ ...event, actor: { id: user?.id || "", name: user?.name || user?.email || null } }, ...current.events] } : current));
      setNoteText("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add the note.");
    } finally {
      setAddingNote(false);
    }
  }

  function scrollToSource() {
    document.getElementById("source")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (loadingConnection) return <div className="p-8 text-sm text-[var(--color-muted)]">Loading…</div>;
  if (connectionError || !connection || !user) return <div className="p-8"><Alert>{connectionError || "This account connection doesn't exist, or isn't yours."}</Alert></div>;

  const host = connection.marketplace?.itemHost || "www.ebay.co.uk";
  const pay = order ? paymentLabel(order.paymentStatus) : null;
  const ful = order ? fulfillmentLabel(order) : null;
  const a = order?.shipTo || null;
  const addressText = a ? [a.name, a.street1, a.street2, [a.city, a.state].filter(Boolean).join(", "), a.postalCode, a.country, a.phone].filter(Boolean).join("\n") : "";
  const earnings = order?.earnings || null;
  const netToSeller = earnings?.earnings || order?.totalDueSeller || null;
  const netVsCost = netToSeller && totalCost !== null ? netToSeller.value - totalCost : null;
  const dispatched = order?.fulfillmentStatus === "FULFILLED";
  const cancelled = !!order && order.cancelState === "CANCELED";
  const paidAt = order?.payments[0]?.date || null;
  const shippedAt = order?.fulfillments.find((f) => f.shippedDate)?.shippedDate || null;
  const firstItem = order?.lineItems[0] || null;
  const promoted = !!earnings?.fees.some((f) => f.code.startsWith("AD_FEE"));
  const buyerUrl = order?.buyer.username ? `https://${host}/usr/${encodeURIComponent(order.buyer.username)}` : null;
  const messageUrl = order?.buyer.username ? `https://contact.${host.replace(/^www\./, "")}/ws/eBayISAPI.dll?M2MContact&requested=${encodeURIComponent(order.buyer.username)}${firstItem?.itemId ? `&item=${firstItem.itemId}` : ""}` : null;
  const ebayOrderUrl = order ? `https://${host}/mesh/ord/details?orderid=${encodeURIComponent(order.legacyOrderId || order.orderId)}` : null;

  const deadlineTone = cancelled ? "" : dispatched ? "" : daysLeft !== null && daysLeft < 0 ? "text-[var(--color-danger)]" : daysLeft !== null && daysLeft <= 1 ? "text-amber-800" : "";

  return (
    <AccountShell
      connectionId={connection.id}
      label={connection.label}
      platformKey={connection.platform_key}
      platformName={connection.platform_name}
      status={connection.status}
      marketplace={connection.marketplace ? { flag: connection.marketplace.flag, label: connection.marketplace.label, currency: connection.marketplace.currency, name: connection.marketplace.name } : null}
      permissions={connection.permissions}
      user={user}
      header={
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href={`/accounts/${connection.id}/orders`} className="text-[12.5px] font-medium text-[var(--color-primary)] hover:underline print:hidden">
              ‹ All orders
            </Link>
            <h1 className="mt-0.5 text-[26px] font-extrabold tracking-tight text-[var(--color-ink)]">Order details</h1>
          </div>
          <button type="button" onClick={() => window.print()} className="btn btn-secondary btn-sm print:hidden">
            <svg viewBox="0 0 20 20" className="mr-1.5 h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 7V3h8v4M6 14H4a1 1 0 0 1-1-1V9a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4a1 1 0 0 1-1 1h-2M6 12h8v5H6z" />
            </svg>
            Print invoice
          </button>
        </div>
      }
    >
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {loading && !data && <p className="text-sm text-[var(--color-muted)]">Loading the order from eBay…</p>}

      {data && order && (
        <div className="pb-8">
          {/* The item, as Seller Hub heads the page */}
          {firstItem && (
            <div className="flex items-center gap-4 border-b border-[var(--color-line)] pb-5">
              {firstItem.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={firstItem.imageUrl} alt="" className="h-14 w-14 flex-shrink-0 rounded-md border border-[var(--color-line)] bg-white object-cover" />
              ) : (
                <div className="h-14 w-14 flex-shrink-0 rounded-md border border-[var(--color-line)] bg-[var(--color-paper)]" />
              )}
              <div className="min-w-0">
                <p className="truncate text-[18px] font-bold text-[var(--color-ink)]">{cleanTitle(firstItem.title)}</p>
                {order.lineItems.length > 1 && <p className="text-[12.5px] text-[var(--color-muted)]">and {order.lineItems.length - 1} more item{order.lineItems.length > 2 ? "s" : ""}</p>}
                <div className="mt-1 flex flex-wrap items-center gap-1.5 print:hidden">
                  {pay && <Chip text={pay.text} tone={pay.tone} />}
                  {ful && <Chip text={ful.text} tone={ful.tone} />}
                </div>
              </div>
            </div>
          )}

          <div className="mt-5 space-y-4 print:hidden">
            {!data.actionsEnabled && (
              <Alert variant="warning">
                This account was connected before Liston could act on orders. Reconnect it from Connections (one click) to enable dispatching from here — the order still shows from eBay&apos;s copy.
              </Alert>
            )}
            {order.cancelRequests.some((r) => r.state === "REQUESTED") && (
              <Alert variant="warning">The buyer has asked to cancel this order. Approve or decline it in Seller Hub for now — handling it here is coming.</Alert>
            )}
            {order.buyerCheckoutNotes && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-[13px] text-amber-900">
                <p className={labelClass}>Note from the buyer</p>
                <p className="mt-1 whitespace-pre-wrap">{order.buyerCheckoutNotes}</p>
              </div>
            )}
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            {/* ---- left column ---- */}
            <div className="space-y-4 lg:col-span-2">
              {/* Dispatch */}
              <div className={cardClass}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className={`text-[20px] font-bold text-[var(--color-ink)] ${deadlineTone}`}>
                      {cancelled ? "Order cancelled" : dispatched ? `Dispatched${shippedAt ? ` on ${formatDayMonthYear(shippedAt)}` : ""}` : dispatchBy ? `Dispatch by ${formatDeadline(dispatchBy)}` : "Awaiting dispatch"}
                    </h2>
                    {!cancelled && !dispatched && (
                      <p className="mt-1 text-[13px] text-[var(--color-ink)]">
                        Make sure you send your order within the dispatch time you specified in the listing.
                        {daysLeft !== null && <span className="ml-1 font-semibold">{daysLeft < 0 ? `${-daysLeft} day${-daysLeft === 1 ? "" : "s"} late.` : daysLeft === 0 ? "Due today." : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left.`}</span>}
                      </p>
                    )}
                    {(order.estimatedDelivery.min || order.estimatedDelivery.max) && (
                      <p className="mt-0.5 text-[13px] text-[var(--color-ink)]">
                        Estimated delivery date shown to buyer: {formatDayMonthYear(order.estimatedDelivery.min)}
                        {order.estimatedDelivery.max ? ` - ${formatDayMonthYear(order.estimatedDelivery.max)}` : ""}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-stretch gap-2 print:hidden">
                    {!cancelled && !dispatched && (
                      <button type="button" onClick={scrollToSource} className="btn btn-primary">
                        Add tracking
                      </button>
                    )}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMoreOpen((v) => !v);
                        }}
                        className="btn btn-secondary w-full"
                      >
                        More actions <Chevron open={moreOpen} />
                      </button>
                      {moreOpen && (
                        <div className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] py-1 text-[13px] shadow-lg">
                          {ebayOrderUrl && (
                            <a href={ebayOrderUrl} target="_blank" rel="noreferrer" className="block px-3 py-2 hover:bg-[var(--color-paper)]">
                              View order on eBay
                            </a>
                          )}
                          {messageUrl && (
                            <a href={messageUrl} target="_blank" rel="noreferrer" className="block px-3 py-2 hover:bg-[var(--color-paper)]">
                              Message buyer
                            </a>
                          )}
                          <button type="button" onClick={() => navigator.clipboard.writeText(order.orderId).catch(() => {})} className="block w-full px-3 py-2 text-left hover:bg-[var(--color-paper)]">
                            Copy order number
                          </button>
                          {addressText && (
                            <button type="button" onClick={() => navigator.clipboard.writeText(addressText).catch(() => {})} className="block w-full px-3 py-2 text-left hover:bg-[var(--color-paper)]">
                              Copy delivery address
                            </button>
                          )}
                          <button type="button" onClick={() => window.print()} className="block w-full px-3 py-2 text-left hover:bg-[var(--color-paper)]">
                            Print invoice
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <ProgressTrack
                  steps={[
                    { label: "Buyer paid", date: formatDayMonth(paidAt || order.createdAt), done: order.paymentStatus === "PAID" || order.paymentStatus === "FULLY_REFUNDED" || order.paymentStatus === "PARTIALLY_REFUNDED" },
                    { label: dispatched ? "Dispatched" : "Dispatch by", date: formatDayMonth(dispatched ? shippedAt : dispatchBy), done: dispatched },
                    { label: "Delivery", date: order.estimatedDelivery.max ? `est. ${formatDayMonth(order.estimatedDelivery.max)}` : "", done: false },
                  ]}
                />
              </div>

              {/* Postage */}
              <div className={cardClass}>
                <h2 className="text-[20px] font-bold text-[var(--color-ink)]">Postage</h2>
                <div className="mt-3 print:hidden">
                  <PostageInstructions />
                </div>
                <div className="mt-4 grid gap-5 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]">
                  <div className="text-[13px] leading-relaxed text-[var(--color-ink)]">
                    <p className="flex items-center text-[var(--color-muted)]">
                      Post to
                      {addressText && <CopyIcon text={addressText} title="Copy address" />}
                    </p>
                    {a ? (
                      <>
                        <p>{a.name}</p>
                        {a.street1 && <p>{a.street1}</p>}
                        {a.street2 && <p>{a.street2}</p>}
                        <p>{[a.city, a.state, a.postalCode].filter(Boolean).join(", ")}</p>
                        <p>{connection.marketplace && a.country === connection.marketplace.country ? connection.marketplace.countryName : a.country}</p>
                        {a.phone && (
                          <>
                            <p className="mt-3 text-[var(--color-muted)]">Phone</p>
                            <p>
                              <a href={`tel:${a.phone.replace(/\s+/g, "")}`} className="hover:underline">
                                {a.phone}
                              </a>
                            </p>
                          </>
                        )}
                      </>
                    ) : (
                      <p className="text-[var(--color-muted)]">No delivery address on this order.</p>
                    )}
                  </div>
                  <div className="text-[13px] leading-relaxed text-[var(--color-ink)]">
                    <p className="text-[var(--color-muted)]">Buyer selected postage service</p>
                    <p>{order.shippingService ? order.shippingService.replace(/_/g, " ") : "—"}</p>
                    <p className="mt-3 text-[var(--color-muted)]">Tracking</p>
                    {order.fulfillments.length ? (
                      order.fulfillments.map((f, i) => (
                        <p key={f.fulfillmentId || i}>
                          {f.trackingNumber ? <span className="font-mono">{f.trackingNumber}</span> : "No tracking"}
                          {f.carrier ? ` · ${f.carrier}` : ""}
                          {f.shippedDate ? ` · ${formatDayMonth(f.shippedDate)}` : ""}
                        </p>
                      ))
                    ) : (
                      <p>--</p>
                    )}
                  </div>
                  {!cancelled && (
                    <div className="print:hidden">
                      <button type="button" onClick={scrollToSource} className="btn btn-secondary">
                        {dispatched ? "Edit tracking" : "Add tracking"}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Item */}
              <div className={cardClass}>
                <h2 className="text-[20px] font-bold text-[var(--color-ink)]">{order.lineItems.length > 1 ? `Items · ${order.lineItems.length}` : "Item"}</h2>
                <div className="mt-3 divide-y divide-[var(--color-line)]">
                  {order.lineItems.map((li) => {
                    const open = !!specificsOpen[li.sourcingKey];
                    const cost = li.sourcing?.cost?.value ?? li.priceBreakdown?.totalCost ?? null;
                    return (
                      <div key={li.sourcingKey} className="py-4 first:pt-1 last:pb-0">
                        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_repeat(3,minmax(80px,auto))]">
                          <div className="flex items-start gap-4">
                            {li.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={li.imageUrl} alt="" className="h-[120px] w-[120px] flex-shrink-0 rounded-md border border-[var(--color-line)] bg-white object-cover" />
                            ) : (
                              <div className="h-[120px] w-[120px] flex-shrink-0 rounded-md border border-[var(--color-line)] bg-[var(--color-paper)]" />
                            )}
                            <div className="min-w-0 text-[13px] text-[var(--color-ink)]">
                              {li.viewItemUrl ? (
                                <a href={li.viewItemUrl} target="_blank" rel="noreferrer" className="text-[14px] font-medium leading-snug underline hover:text-[var(--color-primary)]">
                                  {cleanTitle(li.title)}
                                </a>
                              ) : (
                                <p className="text-[14px] font-medium leading-snug">{cleanTitle(li.title)}</p>
                              )}
                              {li.variation.length > 0 && <p className="mt-1 text-[var(--color-muted)]">{li.variation.map((v) => `${v.name}: ${v.value}`).join(" · ")}</p>}
                              {li.sku && (
                                <p className="mt-2">
                                  Custom label (SKU): <span className="font-mono">{li.sku}</span>
                                </p>
                              )}
                              {li.itemId && <p className="mt-1.5 text-[var(--color-muted)]">Item ID: {li.itemId}</p>}
                              {promoted && <p className="mt-1.5 text-[var(--color-muted)]">Sold via Promoted Listings</p>}
                              {li.promotions.map((p, i) => p.description && (
                                <p key={i} className="mt-0.5 text-[var(--color-muted)]">
                                  Sold with {p.description}
                                </p>
                              ))}
                              {li.refunds.length > 0 && <p className="mt-1 text-[var(--color-danger)]">Refunded {money(li.refunds[0].amount, currency)}</p>}
                              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 print:hidden">
                                {!cancelled && (
                                  <button type="button" onClick={scrollToSource} className="text-[var(--color-primary)] underline">
                                    {li.fulfillmentStatus === "FULFILLED" ? "Edit tracking" : "Add tracking"}
                                  </button>
                                )}
                                {li.listingId && (
                                  <Link href={`/accounts/${connection.id}/listings/draft/${li.listingId}`} className="text-[var(--color-primary)] underline">
                                    Open in Liston
                                  </Link>
                                )}
                              </div>
                              <button type="button" onClick={() => setSpecificsOpen((c) => ({ ...c, [li.sourcingKey]: !open }))} className="mt-3 flex items-center gap-1 text-[var(--color-ink)] underline print:hidden">
                                See more item specifics <Chevron open={open} />
                              </button>
                              {open && (
                                <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12.5px]">
                                  <dt className="text-[var(--color-muted)]">Line item</dt>
                                  <dd className="font-mono">{li.lineItemId || "—"}</dd>
                                  {li.legacyVariationId && (
                                    <>
                                      <dt className="text-[var(--color-muted)]">Variation ID</dt>
                                      <dd className="font-mono">{li.legacyVariationId}</dd>
                                    </>
                                  )}
                                  <dt className="text-[var(--color-muted)]">Status</dt>
                                  <dd>{li.fulfillmentStatus === "FULFILLED" ? "Dispatched" : "Awaiting dispatch"}</dd>
                                  {li.deliveryCost && (
                                    <>
                                      <dt className="text-[var(--color-muted)]">Postage charged</dt>
                                      <dd>{money(li.deliveryCost, currency)}</dd>
                                    </>
                                  )}
                                  {li.ebayCollectedTax && (
                                    <>
                                      <dt className="text-[var(--color-muted)]">Tax collected by eBay</dt>
                                      <dd>{money(li.ebayCollectedTax, currency)}</dd>
                                    </>
                                  )}
                                  {cost !== null && (
                                    <>
                                      <dt className="text-[var(--color-muted)]">Supplier cost</dt>
                                      <dd>
                                        {formatPrice(cost, currency)}
                                        {li.sourcing?.cost ? "" : " (est.)"}
                                      </dd>
                                    </>
                                  )}
                                </dl>
                              )}
                            </div>
                          </div>
                          <div className="text-[13px] sm:text-center">
                            <p className="text-[var(--color-muted)]">Quantity</p>
                            <p className="mt-1 font-semibold text-[var(--color-ink)]">{li.quantity}</p>
                          </div>
                          <div className="text-[13px] sm:text-center">
                            <p className="text-[var(--color-muted)]">Item price</p>
                            <p className="mt-1 text-[var(--color-ink)]">{money(li.unitPrice, currency)}</p>
                          </div>
                          <div className="text-[13px] sm:text-right">
                            <p className="text-[var(--color-muted)]">Item total</p>
                            <p className="mt-1 text-[var(--color-ink)]">{money(li.total, currency)}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Source — the part Seller Hub never had */}
              <div id="source" className={`${cardClass} scroll-mt-4 print:hidden`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-[20px] font-bold text-[var(--color-ink)]">Source</h2>
                    <p className="text-[12.5px] text-[var(--color-muted)]">Where each item was bought, by whom, and its tracking. Saving a tracking number dispatches the item on eBay.</p>
                  </div>
                  <button type="button" onClick={() => setAccountsOpen(true)} className="btn btn-secondary btn-sm">
                    Source accounts
                  </button>
                </div>
                <div className="mt-3 space-y-3">
                  {order.lineItems.map((li) => (
                    <SourcingCard
                      key={`${li.sourcingKey}-${li.sourcing?.updatedAt || "new"}`}
                      connectionId={connection.id}
                      orderId={order.orderId}
                      line={li}
                      accounts={accounts}
                      carriers={data.carriers}
                      actionsEnabled={data.actionsEnabled}
                      user={user}
                      currency={currency}
                      onSaved={(sourcing, dispatch) => {
                        applySourcing(sourcing);
                        if (dispatch?.ok) load();
                      }}
                      onManageAccounts={() => setAccountsOpen(true)}
                      note={saveNotes[li.sourcingKey] || null}
                      onNote={(n) => setSaveNotes((current) => ({ ...current, [li.sourcingKey]: n }))}
                    />
                  ))}
                </div>
              </div>

              {/* Timeline */}
              <div className={`${cardClass} print:hidden`}>
                <h2 className="text-[20px] font-bold text-[var(--color-ink)]">Timeline</h2>
                <div className="mt-2 flex gap-2">
                  <input
                    className={inputClass}
                    placeholder="Add a note for the team…"
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addNote();
                      }
                    }}
                  />
                  <button type="button" onClick={addNote} disabled={addingNote || !noteText.trim()} className="btn btn-secondary btn-sm flex-shrink-0">
                    Add
                  </button>
                </div>
                <ol className="mt-3 divide-y divide-[var(--color-line)]">
                  {data.events.map((e) => (
                    <li key={e.id} className="flex items-start justify-between gap-3 py-2 text-[12.5px]">
                      <div className="min-w-0">
                        <p className={`${e.kind === "note" ? "whitespace-pre-wrap text-[var(--color-ink)]" : "text-[var(--color-ink)]"}`}>{eventText(e)}</p>
                        {e.actor?.name && <p className="text-[11px] text-[var(--color-muted)]">{e.actor.name}</p>}
                      </div>
                      <span className="flex-shrink-0 text-[11.5px] text-[var(--color-muted)]">{formatDateTime(e.at)}</span>
                    </li>
                  ))}
                  {data.events.length === 0 && <li className="py-2 text-sm text-[var(--color-muted)]">Nothing yet.</li>}
                </ol>
              </div>
            </div>

            {/* ---- right column ---- */}
            <div className="space-y-4">
              {/* Order */}
              <div className={cardClass}>
                <h2 className="text-[20px] font-bold text-[var(--color-ink)]">Order</h2>
                <div className="mt-2">
                  <Row
                    label="Order"
                    value={
                      <span className="flex items-center">
                        <span className="font-mono">{order.legacyOrderId || order.orderId}</span>
                        <CopyIcon text={order.legacyOrderId || order.orderId} title="Copy order number" />
                      </span>
                    }
                  />
                  {order.salesRecordReference && <Row label="Sales record no." value={order.salesRecordReference} />}
                  <Row label="Sold" value={formatDayMonthYear(order.createdAt)} />
                  <Row label="Buyer paid" value={paidAt ? formatDayMonthYear(paidAt) : pay?.text || "—"} />
                  <Row
                    label="Buyer"
                    value={
                      <span className="block">
                        {a?.name && <span className="block">{a.name}</span>}
                        {order.buyer.username && (
                          <span className="block">
                            {buyerUrl ? (
                              <a href={buyerUrl} target="_blank" rel="noreferrer" className="underline hover:text-[var(--color-primary)]">
                                {order.buyer.username}
                              </a>
                            ) : (
                              order.buyer.username
                            )}
                            {order.buyer.feedbackScore != null && <span className="ml-1">({order.buyer.feedbackScore})</span>}
                          </span>
                        )}
                        {order.buyer.repeatBuyer && <span className="block text-[var(--color-muted)]">Repeat buyer</span>}
                      </span>
                    }
                  />
                </div>
                <button type="button" onClick={() => setContactOpen((v) => !v)} className="mt-2 flex items-center gap-1 text-[13px] text-[var(--color-ink)] underline print:hidden">
                  {contactOpen ? "Hide contact info" : "Show contact info"} <Chevron open={contactOpen} />
                </button>
                {contactOpen && (
                  <div className="mt-2 text-[13px] text-[var(--color-ink)]">
                    {a?.phone ? (
                      <p>
                        Phone:{" "}
                        <a href={`tel:${a.phone.replace(/\s+/g, "")}`} className="underline">
                          {a.phone}
                        </a>
                      </p>
                    ) : (
                      <p className="text-[var(--color-muted)]">No phone on this order.</p>
                    )}
                    {a?.email && <p className="break-all">Email: {a.email}</p>}
                  </div>
                )}
                {messageUrl && (
                  <a href={messageUrl} target="_blank" rel="noreferrer" className="btn btn-secondary mt-4 w-full print:hidden">
                    Message buyer
                  </a>
                )}
              </div>

              {/* Payment */}
              <div className={cardClass}>
                <h2 className="text-[20px] font-bold text-[var(--color-ink)]">Payment</h2>
                {order.paymentStatus === "PAID" && earnings && earnings.fundsStatusCode !== "PAYOUT" && earnings.fundsStatusCode !== "COMPLETED" && (
                  <div className="mt-3 flex gap-2.5 rounded-xl bg-[var(--color-paper)] p-3 text-[12.5px] text-[var(--color-ink)]">
                    <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--color-primary)]" fill="currentColor">
                      <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm.75-11.5a.75.75 0 0 0-1.5 0v.5a.75.75 0 0 0 1.5 0v-.5zM10 9a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-1.5 0v-4A.75.75 0 0 1 10 9z" clipRule="evenodd" />
                    </svg>
                    <p>
                      {earnings.fundsStatusCode === "FUNDS_ON_HOLD"
                        ? "eBay is holding the funds for this order. Once released, they will be available in your eBay balance."
                        : earnings.fundsStatusCode === "FUNDS_AVAILABLE_FOR_PAYOUT"
                          ? "Your buyer has paid for this order and the funds are available in your eBay balance."
                          : "Your buyer has paid for this order and eBay is processing the payment. Once complete, funds will be available in your eBay balance."}
                    </p>
                  </div>
                )}
                {order.paymentStatus === "PENDING" && (
                  <div className="mt-3 rounded-xl bg-amber-50 p-3 text-[12.5px] text-amber-900">The buyer hasn&apos;t paid for this order yet.</div>
                )}
                {order.paymentStatus === "PAID" && !earnings && (
                  <div className="mt-3 rounded-xl bg-[var(--color-paper)] p-3 text-[12.5px] text-[var(--color-ink)]">Your buyer has paid for this order. eBay hasn&apos;t recorded the sale in your finances yet, so the fee breakdown below is eBay&apos;s order total.</div>
                )}

                <div className="mt-3 flex items-start justify-between text-[13px]">
                  <span className="text-[var(--color-muted)]">Funds status</span>
                  <span className="text-right">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--color-ink)]">
                      <span className={`inline-block h-2.5 w-2.5 rounded-full ${earnings?.fundsStatusCode === "PAYOUT" || earnings?.fundsStatusCode === "COMPLETED" || earnings?.fundsStatusCode === "FUNDS_AVAILABLE_FOR_PAYOUT" ? "bg-emerald-500" : earnings?.fundsStatusCode === "FUNDS_ON_HOLD" ? "bg-amber-500" : "bg-[var(--color-line)]"}`} />
                      {earnings ? earnings.fundsStatus : order.paymentStatus === "PAID" ? "Pending" : pay?.text || "—"}
                    </span>
                    {earnings?.payoutId && <span className="block text-[11.5px] text-[var(--color-muted)]">Payout {earnings.payoutId}</span>}
                  </span>
                </div>

                <div className="mt-4 rounded-xl bg-[var(--color-paper)] p-4">
                  <p className="text-[14px] font-bold text-[var(--color-ink)]">What your buyer paid</p>
                  <div className="mt-2">
                    <MoneyRow label="Subtotal" value={money(order.pricing.subtotal, currency)} indent />
                    <MoneyRow label="Postage" value={money(order.pricing.delivery || { value: 0, currency }, currency)} indent />
                    {order.pricing.discount && order.pricing.discount.value !== 0 && <MoneyRow label="Discount" value={money(order.pricing.discount, currency)} indent negative />}
                    {order.pricing.deliveryDiscount && order.pricing.deliveryDiscount.value !== 0 && <MoneyRow label="Postage discount" value={money(order.pricing.deliveryDiscount, currency)} indent negative />}
                    {order.pricing.tax && order.pricing.tax.value !== 0 && <MoneyRow label="Tax" value={money(order.pricing.tax, currency)} indent />}
                    {order.pricing.adjustment && order.pricing.adjustment.value !== 0 && <MoneyRow label="Adjustment" value={money(order.pricing.adjustment, currency)} indent />}
                    <div className="mt-1 border-t border-[var(--color-line)] pt-1">
                      <MoneyRow label="Order total" value={money(order.pricing.total, currency)} bold />
                    </div>
                  </div>
                </div>

                <div className="mt-3 rounded-xl bg-[var(--color-paper)] p-4">
                  <button type="button" onClick={() => setEarnedOpen((v) => !v)} className="flex w-full items-center justify-between text-left">
                    <span className="text-[14px] font-bold text-[var(--color-ink)]">What you earned</span>
                    <Chevron open={earnedOpen} />
                  </button>
                  {earnedOpen && (
                    <div className="mt-2">
                      <MoneyRow label="Order total" value={money(earnings?.gross || order.pricing.total, currency)} bold />
                      <p className="mt-1 text-[13px] font-semibold text-[var(--color-ink)]">Selling costs</p>
                      {earnings ? (
                        earnings.fees.map((f) => <MoneyRow key={f.label} label={f.label} value={money(f.amount, currency)} indent negative />)
                      ) : order.totalMarketplaceFee ? (
                        <MoneyRow label="eBay fees" value={money(order.totalMarketplaceFee, currency)} indent negative />
                      ) : (
                        <p className="pl-4 text-[12.5px] text-[var(--color-muted)]">Not recorded by eBay yet.</p>
                      )}
                      <div className="mt-1 border-t border-[var(--color-line)] pt-1">
                        <MoneyRow label="Order earnings" value={netToSeller ? money(netToSeller, currency) : "—"} bold />
                      </div>
                      {order.refunds.length > 0 && (
                        <div className="mt-1 border-t border-[var(--color-line)] pt-1">
                          {order.refunds.map((r, i) => (
                            <MoneyRow key={r.referenceId || i} label={`Refund${r.date ? ` ${formatDayMonth(r.date)}` : ""}`} value={money(r.amount, currency)} indent negative />
                          ))}
                        </div>
                      )}
                      {totalCost !== null && (
                        <div className="mt-2 border-t border-dashed border-[var(--color-line)] pt-2">
                          <p className="text-[13px] font-semibold text-[var(--color-ink)]">Sourcing</p>
                          <MoneyRow label="Supplier cost" value={formatPrice(totalCost, currency)} indent negative />
                          {netVsCost !== null && (
                            <div className={`flex items-center justify-between py-1 text-[13px] font-bold ${netVsCost >= 0 ? "text-emerald-700" : "text-[var(--color-danger)]"}`}>
                              <span>Profit</span>
                              <span>{formatPrice(netVsCost, currency)}</span>
                            </div>
                          )}
                        </div>
                      )}
                      {ebayOrderUrl && (
                        <a href={ebayOrderUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-[13px] text-[var(--color-ink)] underline print:hidden">
                          View more details
                        </a>
                      )}
                    </div>
                  )}
                </div>
                {paidAt && <p className="mt-3 text-[11.5px] text-[var(--color-muted)]">Paid {formatDateTime(paidAt)}{order.payments[0]?.method ? ` · ${order.payments[0].method.replace(/_/g, " ").toLowerCase()}` : ""}</p>}
              </div>
            </div>
          </div>
        </div>
      )}

      {accountsOpen && <SourceAccountsDialog accounts={accounts} onChange={setAccounts} onClose={() => setAccountsOpen(false)} />}
    </AccountShell>
  );
}
