"use client";

import { useState } from "react";
import { api, ApiError, type OrderDetailLine, type OrderSourcing, type SourcingPatch } from "@/lib/api";
import { formatPrice } from "@/lib/format";
import { Chevron, Chip, SOURCING_STATUS, cleanTitle, formatDayMonth, inputClass, labelClass } from "@/components/orders/order-ui";

// --- source card (one per line item) --------------------------------------
// The team's spreadsheet row, on the order: the supplier login used, the
// supplier order number, who placed it and when, which card, what it cost,
// and the supplier's tracking. Collapsed it reads as one line; open, every
// field is editable. Saving a new tracking number dispatches the item on
// eBay.

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SourcingCard({
  connectionId,
  orderId,
  line,
  carriers,
  actionsEnabled,
  currency,
  onSaved,
  note,
  onNote,
  defaultOpen,
}: {
  connectionId: string;
  orderId: string;
  line: OrderDetailLine;
  carriers: { code: string; label: string }[];
  actionsEnabled: boolean;
  currency: string;
  onSaved: (sourcing: OrderSourcing, dispatch: { ok: boolean; reason?: string } | null) => void;
  // Kept by the parent: the card remounts on each save (it is keyed by the
  // saved row) and the message must outlive that.
  note: { tone: "ok" | "bad"; text: string } | null;
  onNote: (note: { tone: "ok" | "bad"; text: string } | null) => void;
  defaultOpen: boolean;
}) {
  const s = line.sourcing;
  const [open, setOpen] = useState(defaultOpen);
  const [status, setStatus] = useState<OrderSourcing["status"]>(s?.status || "to_order");
  const [email, setEmail] = useState(s?.sourceEmail || "");
  const [password, setPassword] = useState(s?.sourcePassword || "");
  const [showPassword, setShowPassword] = useState(false);
  const [sourceOrderNo, setSourceOrderNo] = useState(s?.sourceOrderNo || "");
  const [placedAt, setPlacedAt] = useState(s?.placedAt ? String(s.placedAt).slice(0, 10) : "");
  const [cardLabel, setCardLabel] = useState(s?.cardLabel || "");
  const [cost, setCost] = useState(s?.cost ? String(s.cost.value) : "");
  const [tracking, setTracking] = useState(s?.trackingNumber || "");
  const [carrier, setCarrier] = useState(s?.carrier || "");
  const [notes, setNotes] = useState(s?.notes || "");
  const [saving, setSaving] = useState(false);
  const setNote = onNote;

  const trackingChanged = tracking.replace(/\s+/g, "") !== (s?.trackingNumber || "");
  const dirty =
    status !== (s?.status || "to_order") ||
    email !== (s?.sourceEmail || "") ||
    password !== (s?.sourcePassword || "") ||
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
      sourceEmail: email.trim(),
      sourcePassword: password,
      sourceOrderNo: sourceOrderNo.trim(),
      placedAt: placedAt || null,
      cardLabel: cardLabel.trim(),
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
  const summary = [
    s?.sourceOrderNo ? `#${s.sourceOrderNo}` : null,
    s?.sourceEmail || null,
    s?.placedAt ? formatDayMonth(String(s.placedAt)) : null,
    s?.placedBy?.name ? `by ${s.placedBy.name}` : null,
    s?.cardLabel || null,
    s?.cost ? formatPrice(s.cost.value, s.cost.currency) : null,
    s?.trackingNumber ? `${s.carrier ? `${s.carrier} ` : ""}${s.trackingNumber}` : null,
  ].filter(Boolean);
  const fieldClass = `${inputClass} mt-1`;

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 px-4 py-3 text-left" aria-expanded={open}>
        {line.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={line.imageUrl} alt="" className="h-10 w-10 flex-shrink-0 rounded-md border border-[var(--color-line)] bg-white object-cover" />
        ) : (
          <div className="h-10 w-10 flex-shrink-0 rounded-md border border-[var(--color-line)] bg-[var(--color-paper)]" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold text-[var(--color-ink)]">
            {cleanTitle(line.title)}
            <span className="ml-2 font-normal text-[var(--color-muted)]">× {line.quantity}</span>
          </p>
          <p className="mt-0.5 truncate text-[12px] text-[var(--color-muted)]">{summary.length ? summary.join(" · ") : "No supplier order yet — open to add the details."}</p>
        </div>
        <span className="flex-shrink-0">
          <Chip text={statusMeta.label} tone={statusMeta.tone} />
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <div className="border-t border-[var(--color-line)] px-4 pb-4 pt-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className={labelClass}>Email</label>
              <input className={fieldClass} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Supplier account email" autoComplete="off" />
            </div>
            <div>
              <label className={labelClass}>Password</label>
              <div className="relative mt-1">
                <input type={showPassword ? "text" : "password"} className={`${inputClass} pr-10`} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Supplier account password" autoComplete="new-password" />
                <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? "Hide password" : "Show password"} className="absolute inset-y-0 right-0 flex items-center px-3 text-[var(--color-muted)] hover:text-[var(--color-ink)]">
                  <EyeIcon open={showPassword} />
                </button>
              </div>
            </div>
            <div>
              <label className={labelClass}>Placing date</label>
              <input type="date" className={fieldClass} value={placedAt} onChange={(e) => setPlacedAt(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>Tracking</label>
              <input className={`${fieldClass} font-mono`} value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Supplier's tracking number" />
            </div>
            <div>
              <label className={labelClass}>Carrier</label>
              <select className={fieldClass} value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                <option value="">Detect from number</option>
                {carriers.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>AE order #</label>
              <input className={`${fieldClass} font-mono`} value={sourceOrderNo} onChange={(e) => setSourceOrderNo(e.target.value)} placeholder="e.g. 3075828642684994" />
            </div>
            <div>
              <label className={labelClass}>Card</label>
              <input className={fieldClass} value={cardLabel} onChange={(e) => setCardLabel(e.target.value)} placeholder="e.g. tide" />
            </div>
            <div>
              <label className={labelClass}>Placer</label>
              <input className={fieldClass} value={s?.placedBy?.name || ""} readOnly placeholder="Set when the AE order # is saved" />
            </div>
            <div>
              <label className={labelClass}>Cost paid ({currency})</label>
              <input type="number" step="0.01" min="0" className={fieldClass} value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <label className={labelClass}>Status</label>
              <select className={fieldClass} value={status} onChange={(e) => setStatus(e.target.value as OrderSourcing["status"])}>
                {SOURCING_STATUS.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Notes</label>
              <input className={fieldClass} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the team should know about this supplier order" />
            </div>
          </div>
          <p className="mt-2 text-[11.5px] text-[var(--color-muted)]">
            {actionsEnabled ? "Saving a new tracking number marks this item dispatched on eBay with it." : "eBay dispatch is off for this account until it is reconnected; the details are still saved."}
            {s?.dispatchedAt ? ` Dispatched on eBay ${formatDayMonth(s.dispatchedAt)}${s.dispatchedBy?.name ? ` by ${s.dispatchedBy.name}` : ""}.` : ""}
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className={`text-[12px] ${note?.tone === "bad" ? "font-medium text-[var(--color-danger)]" : "text-emerald-700"}`}>{note?.text || ""}</p>
            <button type="button" onClick={save} disabled={saving || !dirty} className="btn btn-primary btn-sm">
              {saving ? "Saving…" : trackingChanged && tracking.trim() && actionsEnabled ? "Save & dispatch on eBay" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

