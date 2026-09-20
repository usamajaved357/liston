"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, ApiError, Amount, OrderDetail, OrderDetailLine, OrderDetailResponse, OrderEvent, OrderSourcing, SourceAccount, SourcingPatch, User } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { formatPrice, formatShortDate, formatDateTime } from "@/lib/format";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";

// One eBay order, the way Seller Hub's order page shows it — header with
// the state and dispatch-by, the items, who it goes to, the money — plus
// the part Seller Hub never had: where each item was bought from, by whom,
// and the supplier's tracking, which dispatches the item on eBay when it is
// saved.

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

  if (loadingConnection) return <div className="p-8 text-sm text-[var(--color-muted)]">Loading…</div>;
  if (connectionError || !connection || !user) return <div className="p-8"><Alert>{connectionError || "This account connection doesn't exist, or isn't yours."}</Alert></div>;

  const pay = order ? paymentLabel(order.paymentStatus) : null;
  const ful = order ? fulfillmentLabel(order) : null;
  const a = order?.shipTo || null;
  const addressText = a ? [a.name, a.street1, a.street2, [a.city, a.state].filter(Boolean).join(", "), a.postalCode, a.country, a.phone].filter(Boolean).join("\n") : "";
  const netVsCost = order?.totalDueSeller && totalCost !== null ? order.totalDueSeller.value - totalCost : null;

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
            <Link href={`/accounts/${connection.id}/orders`} className="text-[12.5px] font-medium text-[var(--color-primary)] hover:underline">
              ‹ All orders
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-2.5">
              <h1 className="font-mono text-xl font-extrabold tracking-tight text-[var(--color-ink)]">{params.orderId}</h1>
              {order && <CopyButton text={order.orderId} label="Copy #" />}
              {pay && <Chip text={pay.text} tone={pay.tone} />}
              {ful && <Chip text={ful.text} tone={ful.tone} />}
            </div>
            {order && (
              <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">
                Placed {formatDateTime(order.createdAt)}
                {order.salesRecordReference ? ` · Sales record #${order.salesRecordReference}` : ""}
                {order.buyer.username ? ` · Buyer ${order.buyer.username}` : ""}
              </p>
            )}
          </div>
          {order && order.fulfillmentStatus !== "FULFILLED" && dispatchBy && (
            <div className={`rounded-xl border px-3 py-2 text-[12.5px] ${daysLeft !== null && daysLeft < 0 ? "border-red-200 bg-red-50 text-[var(--color-danger)]" : daysLeft !== null && daysLeft <= 1 ? "border-amber-200 bg-amber-50 text-amber-800" : "border-[var(--color-line)] bg-[var(--color-paper)] text-[var(--color-ink)]"}`}>
              <span className="font-semibold">Dispatch by {formatShortDate(dispatchBy)}</span>
              {daysLeft !== null && <span className="ml-1.5">{daysLeft < 0 ? `· ${-daysLeft}d late` : daysLeft === 0 ? "· today" : `· ${daysLeft}d left`}</span>}
            </div>
          )}
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
        <div className="space-y-4 pb-8">
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

          <div className="grid gap-4 lg:grid-cols-3">
            {/* Items */}
            <div className={`${cardClass} lg:col-span-2`}>
              <div className="flex items-center justify-between">
                <h2 className="text-[15px] font-bold text-[var(--color-ink)]">Items · {order.lineItems.length}</h2>
              </div>
              <div className="mt-3 divide-y divide-[var(--color-line)]">
                {order.lineItems.map((li) => {
                  const lineStatus = li.fulfillmentStatus === "FULFILLED" ? { text: "Dispatched", tone: "ok" } : { text: "Awaiting dispatch", tone: "warn" };
                  const cost = li.sourcing?.cost?.value ?? li.priceBreakdown?.totalCost ?? null;
                  return (
                    <div key={li.sourcingKey} className="flex items-start gap-3 py-3">
                      {li.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={li.imageUrl} alt="" className="h-16 w-16 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-cover" />
                      ) : (
                        <div className="h-16 w-16 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)]" />
                      )}
                      <div className="min-w-0 flex-1">
                        {li.viewItemUrl ? (
                          <a href={li.viewItemUrl} target="_blank" rel="noreferrer" className="text-[13.5px] font-semibold leading-snug text-[var(--color-ink)] hover:text-[var(--color-primary)]">
                            {cleanTitle(li.title)}
                          </a>
                        ) : (
                          <p className="text-[13.5px] font-semibold leading-snug text-[var(--color-ink)]">{cleanTitle(li.title)}</p>
                        )}
                        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-[var(--color-muted)]">
                          {li.itemId && <span className="font-mono">#{li.itemId}</span>}
                          {li.sku && <span className="font-mono">SKU {li.sku}</span>}
                          {li.variation.map((v) => (
                            <span key={v.name}>
                              <span className="font-semibold text-[var(--color-ink)]">{v.name}:</span> {v.value}
                            </span>
                          ))}
                          {li.listingId && (
                            <Link href={`/accounts/${connection.id}/listings/draft/${li.listingId}`} className="text-[var(--color-primary)] hover:underline">
                              Liston listing
                            </Link>
                          )}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <Chip text={lineStatus.text} tone={lineStatus.tone} />
                          {li.sourcing && <Chip text={(SOURCING_STATUS.find((x) => x.value === li.sourcing!.status) || SOURCING_STATUS[0]).label} tone={(SOURCING_STATUS.find((x) => x.value === li.sourcing!.status) || SOURCING_STATUS[0]).tone} />}
                          {li.refunds.length > 0 && <Chip text={`Refunded ${money(li.refunds[0].amount)}`} tone="warn" />}
                        </div>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <p className="text-[14px] font-bold text-[var(--color-ink)]">{money(li.total, currency)}</p>
                        <p className="text-[11.5px] text-[var(--color-muted)]">
                          {li.quantity} × {money(li.unitPrice, currency)}
                        </p>
                        {cost !== null && (
                          <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">
                            Cost {formatPrice(cost, currency)}
                            {li.sourcing?.cost ? "" : " (est.)"}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Buyer & delivery */}
            <div className={cardClass}>
              <div className="flex items-center justify-between">
                <h2 className="text-[15px] font-bold text-[var(--color-ink)]">Deliver to</h2>
                {addressText && <CopyButton text={addressText} label="Copy address" />}
              </div>
              {a ? (
                <div className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink)]">
                  <p className="font-semibold">{a.name}</p>
                  {a.street1 && <p>{a.street1}</p>}
                  {a.street2 && <p>{a.street2}</p>}
                  <p>{[a.city, a.state].filter(Boolean).join(", ")}</p>
                  <p>{[a.postalCode, a.country].filter(Boolean).join(" · ")}</p>
                  {a.phone && (
                    <p className="mt-1">
                      <a href={`tel:${a.phone.replace(/\s+/g, "")}`} className="text-[var(--color-primary)] hover:underline">
                        {a.phone}
                      </a>
                    </p>
                  )}
                  {a.email && <p className="text-[12px] text-[var(--color-muted)]">{a.email}</p>}
                </div>
              ) : (
                <p className="mt-2 text-sm text-[var(--color-muted)]">No delivery address on this order.</p>
              )}
              <div className="mt-4 border-t border-[var(--color-line)] pt-3 text-[12.5px] text-[var(--color-muted)]">
                {order.buyer.username && (
                  <p>
                    Buyer <span className="font-medium text-[var(--color-ink)]">{order.buyer.username}</span>
                  </p>
                )}
                {order.shippingService && <p>Service: {order.shippingService.replace(/_/g, " ")}</p>}
                {(order.estimatedDelivery.min || order.estimatedDelivery.max) && (
                  <p>
                    Estimated delivery {order.estimatedDelivery.min ? formatShortDate(order.estimatedDelivery.min) : ""}
                    {order.estimatedDelivery.max ? ` – ${formatShortDate(order.estimatedDelivery.max)}` : ""}
                  </p>
                )}
              </div>
              {order.fulfillments.length > 0 && (
                <div className="mt-4 border-t border-[var(--color-line)] pt-3">
                  <p className={labelClass}>Dispatched on eBay</p>
                  {order.fulfillments.map((f, i) => (
                    <p key={f.fulfillmentId || i} className="mt-1 text-[12.5px] text-[var(--color-ink)]">
                      {f.shippedDate ? formatShortDate(f.shippedDate) : ""}
                      {f.carrier ? ` · ${f.carrier}` : ""}
                      {f.trackingNumber ? (
                        <>
                          {" · "}
                          <span className="font-mono">{f.trackingNumber}</span>
                        </>
                      ) : (
                        " · no tracking"
                      )}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Sourcing */}
          <div className={cardClass}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[15px] font-bold text-[var(--color-ink)]">Sourcing</h2>
                <p className="text-[12px] text-[var(--color-muted)]">Where each item was bought, by whom, and its tracking. A tracking number dispatches the item on eBay.</p>
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

          <div className="grid gap-4 lg:grid-cols-3">
            {/* Payment */}
            <div className={cardClass}>
              <h2 className="text-[15px] font-bold text-[var(--color-ink)]">Payment</h2>
              <div className="mt-2 space-y-1 text-[13px]">
                {[
                  ["Items", order.pricing.subtotal],
                  ["Postage", order.pricing.delivery],
                  ["Discount", order.pricing.discount],
                  ["Tax", order.pricing.tax],
                  ["Adjustment", order.pricing.adjustment],
                ]
                  .filter(([, v]) => v && (v as Amount).value !== 0)
                  .map(([label, v]) => (
                    <div key={label as string} className="flex justify-between text-[var(--color-muted)]">
                      <span>{label as string}</span>
                      <span>{money(v as Amount, currency)}</span>
                    </div>
                  ))}
                <div className="flex justify-between border-t border-[var(--color-line)] pt-1.5 font-bold text-[var(--color-ink)]">
                  <span>Buyer paid</span>
                  <span>{money(order.pricing.total, currency)}</span>
                </div>
                {order.totalMarketplaceFee && (
                  <div className="flex justify-between text-[var(--color-muted)]">
                    <span>eBay fees</span>
                    <span>−{money(order.totalMarketplaceFee, currency)}</span>
                  </div>
                )}
                {order.totalDueSeller && (
                  <div className="flex justify-between font-semibold text-[var(--color-ink)]">
                    <span>Net to you</span>
                    <span>{money(order.totalDueSeller, currency)}</span>
                  </div>
                )}
                {totalCost !== null && (
                  <div className="flex justify-between text-[var(--color-muted)]">
                    <span>Supplier cost</span>
                    <span>−{formatPrice(totalCost, currency)}</span>
                  </div>
                )}
                {netVsCost !== null && (
                  <div className={`flex justify-between border-t border-[var(--color-line)] pt-1.5 font-bold ${netVsCost >= 0 ? "text-emerald-700" : "text-[var(--color-danger)]"}`}>
                    <span>Profit</span>
                    <span>{formatPrice(netVsCost, currency)}</span>
                  </div>
                )}
                {order.refunds.length > 0 && (
                  <div className="mt-2 border-t border-[var(--color-line)] pt-2">
                    {order.refunds.map((r, i) => (
                      <div key={r.referenceId || i} className="flex justify-between text-[var(--color-danger)]">
                        <span>Refund {r.date ? formatShortDate(r.date) : ""}</span>
                        <span>−{money(r.amount, currency)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {order.payments[0]?.date && <p className="mt-3 text-[11.5px] text-[var(--color-muted)]">Paid {formatDateTime(order.payments[0].date)}</p>}
            </div>

            {/* Timeline */}
            <div className={`${cardClass} lg:col-span-2`}>
              <h2 className="text-[15px] font-bold text-[var(--color-ink)]">Timeline</h2>
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
        </div>
      )}

      {accountsOpen && <SourceAccountsDialog accounts={accounts} onChange={setAccounts} onClose={() => setAccountsOpen(false)} />}
    </AccountShell>
  );
}
