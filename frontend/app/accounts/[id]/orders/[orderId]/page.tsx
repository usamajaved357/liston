"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { api, ApiError, Amount, OrderCases, OrderDetail, OrderDetailLine, OrderDetailResponse, OrderDispute, OrderInquiry, OrderReturn, OrderSourcing, SourcingPatch } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { formatPrice, formatDateTime, internationalPhone } from "@/lib/format";
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

// Status as Seller Hub writes it: a coloured dot and plain text, no pill.
const DOTS: Record<string, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-[var(--color-danger)]",
  muted: "bg-[var(--color-line-strong)]",
  info: "bg-[var(--color-primary)]",
};

function Chip({ text, tone }: { text: string; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--color-ink)]">
      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${DOTS[tone] || DOTS.muted}`} aria-hidden />
      {text}
    </span>
  );
}

function daysUntil(iso: string | null) {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function cleanTitle(title: string | null) {
  return (title || "").replace(/\[[^[\]]*\]\s*$/, "").trim();
}

const SOURCING_STATUS: { value: OrderSourcing["status"]; label: string; tone: string }[] = [
  { value: "to_order", label: "To order", tone: "muted" },
  { value: "ordered", label: "Ordered", tone: "info" },
  { value: "shipped", label: "Shipped", tone: "ok" },
  { value: "delivered", label: "Delivered", tone: "ok" },
  { value: "problem", label: "Problem", tone: "bad" },
];

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

function SourcingCard({
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

// Seller Hub shows deadlines in the eBay site's own time zone ("24 Sep at
// 11.59pm BST"), whatever the viewer's clock says — the same here.
const SITE_TIMEZONES: Record<string, string> = {
  EBAY_GB: "Europe/London",
  EBAY_IE: "Europe/Dublin",
  EBAY_US: "America/Los_Angeles",
  EBAY_CA: "America/Toronto",
  EBAY_AU: "Australia/Sydney",
  EBAY_DE: "Europe/Berlin",
  EBAY_AT: "Europe/Vienna",
  EBAY_CH: "Europe/Zurich",
  EBAY_FR: "Europe/Paris",
  EBAY_IT: "Europe/Rome",
  EBAY_ES: "Europe/Madrid",
  EBAY_NL: "Europe/Amsterdam",
  EBAY_BE: "Europe/Brussels",
  EBAY_PL: "Europe/Warsaw",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Day/month/year of an instant in a time zone (the site's, when given).
function partsIn(iso: string, timeZone?: string) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short", timeZone }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return { day: Number(get("day")), month: Number(get("month")) - 1, year: get("year"), hour: get("hour"), minute: get("minute"), dayPeriod: get("dayPeriod").toLowerCase(), zone: get("timeZoneName") };
}

function formatDeadline(iso: string | null, timeZone?: string) {
  if (!iso) return "—";
  const p = partsIn(iso, timeZone);
  return `${p.day} ${MONTHS[p.month]} at ${p.hour}.${p.minute}${p.dayPeriod} ${p.zone}`;
}

function formatDayMonthYear(iso: string | null, timeZone?: string) {
  if (!iso) return "—";
  const p = partsIn(iso, timeZone);
  return `${p.day} ${MONTHS[p.month]} ${p.year}`;
}

function formatDayMonth(iso: string | null, timeZone?: string) {
  if (!iso) return "";
  const p = partsIn(iso, timeZone);
  return `${p.day} ${MONTHS[p.month]}`;
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

// --- action dialogs (Seller Hub's "More actions") ----------------------------

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl bg-[var(--color-panel)] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-[var(--color-ink)]">{title}</h2>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

type ActionKind = "tracking" | "dispatched" | "refund" | "cancel";

function ActionDialog({
  kind,
  connectionId,
  order,
  carriers,
  refundReasons,
  cancelReasons,
  currency,
  onClose,
  onDone,
}: {
  kind: ActionKind;
  connectionId: string;
  order: OrderDetail;
  carriers: { code: string; label: string }[];
  refundReasons: { code: string; label: string }[];
  cancelReasons: { code: string; label: string }[];
  currency: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState("");
  const [amount, setAmount] = useState(order.pricing.total ? order.pricing.total.value.toFixed(2) : "");
  const [full, setFull] = useState(true);
  const [reason, setReason] = useState(kind === "refund" ? refundReasons[0]?.code || "" : cancelReasons[0]?.code || "");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Money leaves the account on these two; a second, explicit confirmation
  // stands between the form and eBay.
  const [confirming, setConfirming] = useState(false);
  const pendingCancel = order.cancelRequests.find((r) => r.state === "REQUESTED") || null;
  const undispatched = order.lineItems.filter((li) => li.fulfillmentStatus !== "FULFILLED").length;
  const refundValue = full ? order.pricing.total?.value ?? null : Number(amount);
  const buyerName = order.shipTo?.name || order.buyer.username || "the buyer";

  async function run() {
    if ((kind === "refund" || kind === "cancel") && !confirming) {
      if (kind === "refund" && (!Number.isFinite(refundValue) || (refundValue as number) <= 0)) {
        setError("Enter a refund amount above zero.");
        return;
      }
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (kind === "tracking") {
        if (!tracking.trim()) throw new ApiError("Enter the tracking number.", 400);
        const r = await api.dispatchOrder(connectionId, order.orderId, { trackingNumber: tracking.trim(), ...(carrier ? { carrier } : {}) });
        onDone(`Marked dispatched on eBay with tracking ${tracking.trim()} (${r.lines} item${r.lines === 1 ? "" : "s"}).`);
      } else if (kind === "dispatched") {
        const r = await api.dispatchOrder(connectionId, order.orderId, {});
        onDone(`Marked dispatched on eBay without tracking (${r.lines} item${r.lines === 1 ? "" : "s"}).`);
      } else if (kind === "refund") {
        const r = await api.refundOrder(connectionId, order.orderId, { amount: full ? null : amount, reason, comment });
        onDone(`Refund of ${r.amount ? formatPrice(r.amount.value, r.amount.currency) : "the order"} sent to the buyer${r.status ? ` (${r.status.toLowerCase()})` : ""}.`);
      } else {
        const r = await api.cancelOrder(connectionId, order.orderId, { reason });
        onDone(r.approved ? "The buyer's cancellation was approved; eBay is refunding them." : "The order was cancelled on eBay; eBay is refunding the buyer.");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<ActionKind, string> = { tracking: "Add tracking number", dispatched: "Mark as dispatched", refund: "Send refund", cancel: "Cancel order" };

  return (
    <Modal title={titles[kind]} onClose={onClose}>
      <div className="mt-3 space-y-3 text-[13px] text-[var(--color-ink)]">
        {kind === "tracking" && (
          <>
            <p className="text-[var(--color-muted)]">
              Marks {undispatched === 1 ? "the item" : `all ${undispatched} undispatched items`} dispatched on eBay with this number. The buyer sees it straight away.
            </p>
            <div>
              <label className={labelClass}>Tracking number</label>
              <input className={`${inputClass} mt-1 font-mono`} value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="e.g. H06R4A0225077758" autoFocus />
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
          </>
        )}
        {kind === "dispatched" && (
          <p>
            This marks {undispatched === 1 ? "the item" : `all ${undispatched} undispatched items`} dispatched on eBay <span className="font-semibold">without a tracking number</span>. eBay doesn&apos;t recommend it: with no tracking you have no proof of delivery if the buyer opens a case.
          </p>
        )}
        {kind === "refund" && (
          <>
            <p className="text-[var(--color-muted)]">eBay takes the refund from your balance and returns it to the buyer&apos;s original payment method.</p>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={full} onChange={() => setFull(true)} /> Full refund{order.pricing.total ? ` (${money(order.pricing.total, currency)})` : ""}
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={!full} onChange={() => setFull(false)} /> Partial
              </label>
            </div>
            {!full && (
              <div>
                <label className={labelClass}>Amount ({currency})</label>
                <input type="number" step="0.01" min="0.01" max={order.pricing.total?.value} className={`${inputClass} mt-1`} value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
            )}
            <div>
              <label className={labelClass}>Reason</label>
              <select className={`${inputClass} mt-1`} value={reason} onChange={(e) => setReason(e.target.value)}>
                {refundReasons.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Message to buyer (optional)</label>
              <input className={`${inputClass} mt-1`} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} />
            </div>
          </>
        )}
        {kind === "cancel" && (
          <>
            {pendingCancel ? (
              <p>
                The buyer asked to cancel this order{pendingCancel.reason ? ` (${pendingCancel.reason.replace(/_/g, " ").toLowerCase()})` : ""}. Approving it cancels the order and eBay refunds them in full.
              </p>
            ) : (
              <>
                <p className="text-[var(--color-muted)]">Cancelling refunds the buyer in full. Cancelling because you&apos;re out of stock counts against your seller performance.</p>
                <div>
                  <label className={labelClass}>Reason</label>
                  <select className={`${inputClass} mt-1`} value={reason} onChange={(e) => setReason(e.target.value)}>
                    {cancelReasons.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </>
        )}
        {confirming && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-[13px] text-[var(--color-ink)]">
            <p className="font-semibold">
              {kind === "refund"
                ? `Refund ${formatPrice(refundValue as number, currency)} to ${buyerName}?`
                : pendingCancel
                  ? `Approve the cancellation and refund ${money(order.pricing.total, currency)} to ${buyerName}?`
                  : `Cancel this order and refund ${money(order.pricing.total, currency)} to ${buyerName}?`}
            </p>
            <p className="mt-1 text-[var(--color-muted)]">This is sent to eBay straight away and can&apos;t be undone.</p>
          </div>
        )}
        {error && <p className="font-medium text-[var(--color-danger)]">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={confirming ? () => setConfirming(false) : onClose} className="btn btn-secondary btn-sm">
            Back
          </button>
          <button type="button" onClick={run} disabled={busy} className={`btn btn-sm ${kind === "cancel" || kind === "refund" ? "bg-[var(--color-danger)] text-white hover:opacity-90" : "btn-primary"}`}>
            {busy
              ? "Working…"
              : kind === "tracking"
                ? "Add tracking & dispatch"
                : kind === "dispatched"
                  ? "Mark as dispatched"
                  : kind === "refund"
                    ? confirming
                      ? "Yes, send the refund"
                      : "Send refund"
                    : pendingCancel
                      ? confirming
                        ? "Yes, approve it"
                        : "Approve cancellation"
                      : confirming
                        ? "Yes, cancel the order"
                        : "Cancel order"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// --- post-sale cases: returns, item-not-received, payment disputes ---------

type CaseAction =
  | { kind: "return"; item: OrderReturn; action: "accept" | "decline" | "received" | "refund" | "message" }
  | { kind: "inquiry"; item: OrderInquiry; action: "shipment" | "refund" | "message" }
  | { kind: "dispute"; item: OrderDispute; action: "accept" | "contest" };

function humanise(code: string | null | undefined) {
  if (!code) return "";
  return String(code).replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function CasesPanel({ cases, order, currency, onAct }: { cases: OrderCases; order: OrderDetail; currency: string; onAct: (c: CaseAction) => void }) {
  const itemTitle = (itemId: string | null) => cleanTitle(order.lineItems.find((li) => li.itemId === itemId)?.title || order.lineItems[0]?.title || null);
  const rows: { key: string; tone: string; title: string; detail: string; due: string | null; actions: { label: string; primary?: boolean; run: () => void }[] }[] = [];

  for (const r of cases.returns) {
    const awaitingDecision = /RETURN_REQUESTED/i.test(r.state || "") && !r.closed;
    const shipped = /ITEM_SHIPPED|ITEM_DELIVERED|RETURN_LABEL/i.test(r.state || "") && !r.closed;
    rows.push({
      key: `return-${r.id}`,
      tone: r.closed ? "muted" : "warn",
      title: `Return request${r.closed ? " (closed)" : ""} · ${itemTitle(r.itemId)}`,
      detail: [humanise(r.reason), r.buyerComment ? `“${r.buyerComment}”` : "", r.tracking ? `Return tracking ${r.carrier ? `${r.carrier} ` : ""}${r.tracking}` : "", humanise(r.state)].filter(Boolean).join(" · "),
      due: r.respondBy,
      actions: r.closed
        ? []
        : [
            ...(awaitingDecision ? [{ label: "Accept return", primary: true, run: () => onAct({ kind: "return", item: r, action: "accept" }) }, { label: "Decline", run: () => onAct({ kind: "return", item: r, action: "decline" }) }] : []),
            ...(shipped ? [{ label: "Mark as received", run: () => onAct({ kind: "return", item: r, action: "received" }) }] : []),
            { label: "Refund buyer", primary: !awaitingDecision, run: () => onAct({ kind: "return", item: r, action: "refund" }) },
            { label: "Message", run: () => onAct({ kind: "return", item: r, action: "message" }) },
          ],
    });
  }
  for (const i of cases.inquiries) {
    rows.push({
      key: `inquiry-${i.id}`,
      tone: i.closed ? "muted" : "warn",
      title: `Item not received${i.closed ? " (closed)" : ""} · ${itemTitle(i.itemId)}`,
      detail: [i.claimAmount ? `Claim ${money(i.claimAmount, currency)}` : "", humanise(i.state)].filter(Boolean).join(" · "),
      due: i.respondBy,
      actions: i.closed
        ? []
        : [
            { label: "Provide tracking", primary: true, run: () => onAct({ kind: "inquiry", item: i, action: "shipment" }) },
            { label: "Refund buyer", run: () => onAct({ kind: "inquiry", item: i, action: "refund" }) },
            { label: "Message", run: () => onAct({ kind: "inquiry", item: i, action: "message" }) },
          ],
    });
  }
  for (const d of cases.disputes) {
    rows.push({
      key: `dispute-${d.id}`,
      tone: d.closed ? "muted" : "bad",
      title: `Payment dispute${d.closed ? " (closed)" : ""}${d.amount ? ` · ${money(d.amount, currency)}` : ""}`,
      detail: [humanise(d.reason), humanise(d.status)].filter(Boolean).join(" · "),
      due: d.respondBy,
      actions: d.closed || !/OPEN|ACTION_NEEDED/i.test(d.status || "")
        ? []
        : [
            { label: "Contest", primary: true, run: () => onAct({ kind: "dispute", item: d, action: "contest" }) },
            { label: "Accept dispute", run: () => onAct({ kind: "dispute", item: d, action: "accept" }) },
          ],
    });
  }
  if (!rows.length) return null;
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.key} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-[13px] ${row.tone === "bad" ? "border-red-200 bg-red-50" : row.tone === "warn" ? "border-amber-200 bg-amber-50" : "border-[var(--color-line)] bg-[var(--color-panel)]"}`}>
          <div className="min-w-0">
            <p className="font-semibold text-[var(--color-ink)]">{row.title}</p>
            {row.detail && <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">{row.detail}</p>}
            {row.due && !row.actions.length ? null : row.due && <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">Respond by {formatDateTime(row.due)}</p>}
          </div>
          {row.actions.length > 0 && (
            <div className="flex flex-wrap gap-2 print:hidden">
              {row.actions.map((a) => (
                <button key={a.label} type="button" onClick={a.run} className={`btn btn-sm ${a.primary ? "btn-primary" : "btn-secondary"}`}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CaseDialog({
  connectionId,
  order,
  currency,
  carriers,
  declineReasons,
  action,
  onClose,
  onDone,
}: {
  connectionId: string;
  order: OrderDetail;
  currency: string;
  carriers: { code: string; label: string }[];
  declineReasons: { code: string; label: string }[];
  action: CaseAction;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [comment, setComment] = useState("");
  const [declineReason, setDeclineReason] = useState(declineReasons[0]?.code || "");
  const [full, setFull] = useState(true);
  const [amount, setAmount] = useState(order.pricing.total ? order.pricing.total.value.toFixed(2) : "");
  const [tracking, setTracking] = useState(order.fulfillments.find((f) => f.trackingNumber)?.trackingNumber || "");
  const [carrier, setCarrier] = useState(order.fulfillments.find((f) => f.carrier)?.carrier || "");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buyerName = order.shipTo?.name || order.buyer.username || "the buyer";
  const moneyMoves = (action.kind === "return" && (action.action === "refund" || action.action === "accept")) || (action.kind === "inquiry" && action.action === "refund") || (action.kind === "dispute" && action.action === "accept");
  const refundValue = full ? order.pricing.total?.value ?? null : Number(amount);

  const titles: Record<string, string> = {
    "return.accept": "Accept the return",
    "return.decline": "Decline the return",
    "return.received": "Mark the return as received",
    "return.refund": "Refund the buyer",
    "return.message": "Message the buyer about the return",
    "inquiry.shipment": "Provide tracking",
    "inquiry.refund": "Refund the buyer",
    "inquiry.message": "Message the buyer",
    "dispute.accept": "Accept the payment dispute",
    "dispute.contest": "Contest the payment dispute",
  };
  const key = `${action.kind}.${action.action}`;

  async function run() {
    if (moneyMoves && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (action.kind === "return") {
        await api.respondToReturn(connectionId, order.orderId, {
          returnId: action.item.id,
          action: action.action,
          comment: comment || undefined,
          ...(action.action === "decline" ? { declineReason } : {}),
          ...(action.action === "refund" ? { amount: full ? null : amount } : {}),
        });
        onDone(
          action.action === "accept"
            ? "Return accepted — the buyer can now send the item back."
            : action.action === "decline"
              ? "Return request declined."
              : action.action === "received"
                ? "Marked as received. Refund the buyer when you're ready."
                : action.action === "refund"
                  ? `Refund of ${full ? money(order.pricing.total, currency) : formatPrice(amount, currency)} sent for the return.`
                  : "Message sent."
        );
      } else if (action.kind === "inquiry") {
        await api.respondToInquiry(connectionId, order.orderId, {
          inquiryId: action.item.id,
          action: action.action,
          ...(action.action === "shipment" ? { trackingNumber: tracking, ...(carrier ? { carrier } : {}) } : {}),
          message: comment || undefined,
        });
        onDone(action.action === "shipment" ? "Tracking sent to the buyer and eBay." : action.action === "refund" ? "Refund sent; eBay closes the case." : "Message sent.");
      } else {
        await api.respondToDispute(connectionId, order.orderId, { disputeId: action.item.id, action: action.action });
        onDone(action.action === "accept" ? "Dispute accepted; the buyer keeps the payment." : "Dispute contested with the evidence on file.");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={titles[key] || "Respond"} onClose={onClose}>
      <div className="mt-3 space-y-3 text-[13px] text-[var(--color-ink)]">
        {key === "return.accept" && <p className="text-[var(--color-muted)]">The buyer gets a return label and sends the item back. You refund once it arrives (or eBay refunds them automatically if you don&apos;t act in time).</p>}
        {key === "return.decline" && (
          <div>
            <label className={labelClass}>Reason</label>
            <select className={`${inputClass} mt-1`} value={declineReason} onChange={(e) => setDeclineReason(e.target.value)}>
              {declineReasons.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[12px] text-[var(--color-muted)]">The buyer can ask eBay to step in after a decline; eBay usually sides with the buyer on &quot;not as described&quot; returns.</p>
          </div>
        )}
        {(key === "return.refund" || key === "inquiry.refund") && (
          <>
            {key === "return.refund" && (
              <div className="flex gap-4">
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={full} onChange={() => setFull(true)} /> Full refund{order.pricing.total ? ` (${money(order.pricing.total, currency)})` : ""}
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={!full} onChange={() => setFull(false)} /> Partial
                </label>
              </div>
            )}
            {key === "return.refund" && !full && (
              <div>
                <label className={labelClass}>Amount ({currency})</label>
                <input type="number" step="0.01" min="0.01" max={order.pricing.total?.value} className={`${inputClass} mt-1`} value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
            )}
            {key === "inquiry.refund" && <p className="text-[var(--color-muted)]">Refunds the buyer in full and closes the item-not-received case.</p>}
          </>
        )}
        {key === "inquiry.shipment" && (
          <>
            <p className="text-[var(--color-muted)]">Tells the buyer and eBay the item was sent. Tracking that shows delivery is what closes the case in your favour.</p>
            <div>
              <label className={labelClass}>Tracking number</label>
              <input className={`${inputClass} mt-1 font-mono`} value={tracking} onChange={(e) => setTracking(e.target.value)} autoFocus />
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
          </>
        )}
        {key === "dispute.accept" && <p className="text-[var(--color-muted)]">The buyer keeps the money and the dispute closes. Choose this when you can&apos;t show the item was delivered as described.</p>}
        {key === "dispute.contest" && <p className="text-[var(--color-muted)]">Contests with the evidence already on the dispute (eBay attaches your tracking itself). To add photos or documents first, use eBay&apos;s dispute page, then contest.</p>}
        {key !== "dispute.accept" && key !== "dispute.contest" && (
          <div>
            <label className={labelClass}>{key.endsWith(".message") ? "Message" : "Note to the buyer (optional)"}</label>
            <textarea className={`${inputClass} mt-1 h-20 resize-none`} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} autoFocus={key.endsWith(".message")} />
          </div>
        )}
        {confirming && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3">
            <p className="font-semibold">
              {key === "return.refund" || key === "inquiry.refund"
                ? `Refund ${formatPrice(key === "inquiry.refund" ? order.pricing.total?.value ?? 0 : (refundValue as number), currency)} to ${buyerName}?`
                : key === "dispute.accept"
                  ? `Accept the dispute and let ${buyerName} keep ${money(action.kind === "dispute" ? action.item.amount : null, currency)}?`
                  : `Accept the return from ${buyerName}?`}
            </p>
            <p className="mt-1 text-[var(--color-muted)]">This is sent to eBay straight away and can&apos;t be undone.</p>
          </div>
        )}
        {error && <p className="font-medium text-[var(--color-danger)]">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={confirming ? () => setConfirming(false) : onClose} className="btn btn-secondary btn-sm">
            Back
          </button>
          <button type="button" onClick={run} disabled={busy} className={`btn btn-sm ${moneyMoves ? "bg-[var(--color-danger)] text-white hover:opacity-90" : "btn-primary"}`}>
            {busy ? "Working…" : confirming ? "Yes, do it" : titles[key]?.split(" ")[0] === "Message" ? "Send message" : titles[key] || "Confirm"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// --- page -----------------------------------------------------------------

export default function OrderDetailPage() {
  const params = useParams<{ id: string; orderId: string }>();
  const { connection, user, loading: loadingConnection, error: connectionError } = useConnection(params.id);
  const [data, setData] = useState<OrderDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveNotes, setSaveNotes] = useState<Record<string, { tone: "ok" | "bad"; text: string } | null>>({});
  const [moreOpen, setMoreOpen] = useState(false);
  const [action, setAction] = useState<ActionKind | null>(null);
  const [actionNote, setActionNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [earnedOpen, setEarnedOpen] = useState(true);
  const [specificsOpen, setSpecificsOpen] = useState<Record<string, boolean>>({});
  const [reconnectPrompt, setReconnectPrompt] = useState(false);
  const [cases, setCases] = useState<OrderCases | null>(null);
  const [caseAction, setCaseAction] = useState<CaseAction | null>(null);
  const [declineCancelOpen, setDeclineCancelOpen] = useState(false);
  const [decliningCancel, setDecliningCancel] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const searchParams = useSearchParams();
  const justReconnected = searchParams.get("reconnected") === "1";

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

  // Post-sale cases load beside the order, never blocking it.
  useEffect(() => {
    if (!data?.actionsEnabled) return;
    let cancelled = false;
    api
      .getOrderCases(params.id, params.orderId)
      .then((c) => {
        if (!cancelled) setCases(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [params.id, params.orderId, reloadKey, data?.actionsEnabled]);

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

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Sends the owner through eBay's consent again for THIS account, coming
  // back here; the token then carries the order scopes.
  async function reconnect() {
    setReconnecting(true);
    try {
      const { authorizeUrl } = await api.reauthorizeConnection(params.id, `/accounts/${params.id}/orders/${encodeURIComponent(params.orderId)}`);
      window.location.href = authorizeUrl;
    } catch (err) {
      setReconnecting(false);
      setActionNote({ tone: "bad", text: err instanceof ApiError ? err.message : "Couldn't start the eBay reconnect." });
    }
  }

  async function declineCancel() {
    setDecliningCancel(true);
    try {
      await api.declineCancellation(params.id, params.orderId);
      setDeclineCancelOpen(false);
      setActionNote({ tone: "ok", text: "The buyer's cancellation request was declined; the order stands." });
      load();
    } catch (err) {
      setActionNote({ tone: "bad", text: err instanceof ApiError ? err.message : "Couldn't decline the request." });
    } finally {
      setDecliningCancel(false);
    }
  }

  // Order actions need the reconnected token; until then, each one explains
  // that instead of being greyed out.
  function guarded(fn: () => void) {
    return () => (data?.actionsEnabled ? fn() : setReconnectPrompt(true));
  }

  async function toggleArchived() {
    if (!order) return;
    setArchiving(true);
    try {
      const r = await api.archiveOrder(params.id, order.orderId, !order.archived);
      setData((current) => (current ? { ...current, order: { ...current.order, archived: r.archived } } : current));
      setActionNote({ tone: "ok", text: r.archived ? "Order archived. It's hidden from the order list under Archived." : "Order restored to the order list." });
    } catch (err) {
      setActionNote({ tone: "bad", text: err instanceof ApiError ? err.message : "Couldn't archive the order." });
    } finally {
      setArchiving(false);
    }
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
  // The actions that only exist on eBay's own pages open there.
  const couponUrl = `https://${host}/sh/mkt/couponcodes`;
  const reportBuyerUrl = order?.buyer.username ? `https://${host}/help/selling/resolving-buyer-issues/reporting-issue-buyer` : null;
  const relistUrl = firstItem?.itemId ? `https://${host}/sl/sell?mode=Relist&itemId=${firstItem.itemId}` : null;
  const sellSimilarUrl = firstItem?.itemId ? `https://${host}/sl/sell?mode=SellSimilar&itemId=${firstItem.itemId}` : null;

  const siteTz = SITE_TIMEZONES[connection.marketplace?.id || ""];
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
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href={`/accounts/${connection.id}/orders`}
              aria-label="Back to orders"
              title="Back to orders"
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-[var(--color-line)] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] print:hidden"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <h1 className="mt-1 text-[24px] font-extrabold tracking-tight text-[var(--color-ink)]">Order details</h1>
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
            <div className="flex items-center gap-3 border-b border-[var(--color-line)] pb-4">
              {firstItem.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={firstItem.imageUrl} alt="" className="h-12 w-12 flex-shrink-0 rounded-md border border-[var(--color-line)] bg-white object-cover" />
              ) : (
                <div className="h-12 w-12 flex-shrink-0 rounded-md border border-[var(--color-line)] bg-[var(--color-paper)]" />
              )}
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold text-[var(--color-ink)]">{cleanTitle(firstItem.title)}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-[var(--color-muted)] print:hidden">
                  {pay && <Chip text={pay.text} tone={pay.tone} />}
                  {ful && <Chip text={ful.text} tone={ful.tone} />}
                  {order.archived && <Chip text="Archived" tone="muted" />}
                  {order.lineItems.length > 1 && <span>+ {order.lineItems.length - 1} more item{order.lineItems.length > 2 ? "s" : ""}</span>}
                </p>
              </div>
            </div>
          )}

          <div className="mt-5 space-y-4 print:hidden">
            {actionNote && <Alert variant={actionNote.tone === "ok" ? "success" : undefined}>{actionNote.text}</Alert>}
            {justReconnected && data.actionsEnabled && <Alert variant="success">eBay account reconnected — dispatch, refunds and cancellations now work from here.</Alert>}
            {!data.actionsEnabled && (
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2.5 text-[12.5px] text-[var(--color-ink)]">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-2 w-2 flex-shrink-0 rounded-full bg-amber-500" aria-hidden />
                  <span>
                    <span className="font-semibold">Order actions are off for this account</span>
                    <span className="text-[var(--color-muted)]"> — it was linked before eBay order permissions existed. Reconnect once to send tracking, refunds and cancellations from here.</span>
                  </span>
                </span>
                <button type="button" onClick={reconnect} disabled={reconnecting} className="btn btn-secondary btn-sm flex-shrink-0">
                  {reconnecting ? "Opening eBay…" : "Reconnect"}
                </button>
              </div>
            )}
            {order.cancelRequests.some((r) => r.state === "REQUESTED") && (
              <Alert variant="warning">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    The buyer has asked to cancel this order
                    {order.cancelRequests.find((r) => r.state === "REQUESTED")?.reason ? ` (${String(order.cancelRequests.find((r) => r.state === "REQUESTED")?.reason).replace(/_/g, " ").toLowerCase()})` : ""}.
                    {dispatched ? " It has already been dispatched, so declining is the usual answer." : " Approving refunds them in full."}
                  </span>
                  <span className="flex gap-2">
                    <button type="button" onClick={guarded(() => setDeclineCancelOpen(true))} className="btn btn-secondary btn-sm">
                      Decline
                    </button>
                    {!dispatched && (
                      <button type="button" onClick={guarded(() => setAction("cancel"))} className="btn btn-primary btn-sm">
                        Approve
                      </button>
                    )}
                  </span>
                </span>
              </Alert>
            )}
            {cases && (cases.returns.length > 0 || cases.inquiries.length > 0 || cases.disputes.length > 0) && (
              <CasesPanel cases={cases} order={order} currency={currency} onAct={(c) => setCaseAction(c)} />
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
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 basis-[320px]">
                    <h2 className={`text-[20px] font-bold text-[var(--color-ink)] ${deadlineTone}`}>
                      {cancelled ? "Order cancelled" : dispatched ? `Dispatched${shippedAt ? ` on ${formatDayMonthYear(shippedAt)}` : ""}` : dispatchBy ? `Dispatch by ${formatDeadline(dispatchBy, siteTz)}` : "Awaiting dispatch"}
                    </h2>
                    {!cancelled && !dispatched && <p className="mt-1 text-[13px] text-[var(--color-ink)]">Make sure you send your order within the dispatch time you specified in the listing.</p>}
                    {(order.estimatedDelivery.min || order.estimatedDelivery.max) && (
                      <p className="mt-0.5 text-[13px] text-[var(--color-ink)]">
                        Estimated delivery date shown to buyer: {formatDayMonthYear(order.estimatedDelivery.min || order.estimatedDelivery.max, siteTz)}
                        {order.estimatedDelivery.min && order.estimatedDelivery.max ? ` - ${formatDayMonthYear(order.estimatedDelivery.max, siteTz)}` : ""}
                      </p>
                    )}
                    {!cancelled && !dispatched && daysLeft !== null && (
                      <p className={`mt-0.5 text-[13px] font-semibold ${daysLeft < 0 ? "text-[var(--color-danger)]" : daysLeft <= 1 ? "text-amber-800" : "text-[var(--color-ink)]"}`}>
                        {daysLeft < 0 ? `${-daysLeft} day${-daysLeft === 1 ? "" : "s"} late` : daysLeft === 0 ? "Due today" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
                      </p>
                    )}
                  </div>
                  {/* Seller Hub's pair: a filled "Get postage label" over an
                      outlined "More actions", both 245px, the menu hanging
                      under the second at the same width. Labels are bought
                      on eBay itself (no label API for UK sellers), so the
                      first opens eBay's page for this order. */}
                  <div className="flex w-[160px] flex-col items-stretch gap-1.5 print:hidden">
                    {!cancelled && !dispatched && ebayOrderUrl && (
                      <a href={ebayOrderUrl} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm rounded-full !h-8 !px-3 !text-[12.5px]">
                        Get postage label
                      </a>
                    )}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMoreOpen((v) => !v);
                        }}
                        className="btn btn-secondary btn-sm w-full rounded-full border-[var(--color-primary)] !h-8 !px-3 !text-[12.5px] text-[var(--color-primary)]"
                        aria-expanded={moreOpen}
                      >
                        More actions <Chevron open={moreOpen} />
                      </button>
                      {moreOpen && (
                        <div className="absolute right-0 z-20 mt-1 max-h-[300px] w-[176px] overflow-y-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] py-1 text-[12.5px] text-[var(--color-ink)] shadow-[0_6px_20px_rgba(0,0,0,0.12)]" onClick={(e) => e.stopPropagation()}>
                          {(
                            [
                              { label: "Print invoices and more", run: () => window.print() },
                              { label: "Print coupon", href: couponUrl },
                              { label: "Send coupon", href: couponUrl },
                              { label: dispatched ? "Edit tracking number" : "Add tracking number", run: guarded(() => setAction("tracking")) },
                              { label: "Mark as dispatched", run: guarded(() => setAction("dispatched")), disabled: dispatched },
                              { label: "Send refund", run: guarded(() => setAction("refund")), disabled: order.paymentStatus === "FULLY_REFUNDED" },
                              { label: "View payment details", run: () => scrollTo("payment") },
                              { label: order.cancelRequests.some((r) => r.state === "REQUESTED") ? "Approve cancellation" : "Cancel order", run: guarded(() => setAction("cancel")), disabled: dispatched || cancelled },
                              { label: "Message buyer", href: messageUrl },
                              { label: "Report buyer", href: reportBuyerUrl },
                              { label: "Relist", href: relistUrl },
                              { label: "Sell similar", href: sellSimilarUrl },
                              { label: order.archived ? "Unarchive" : "Archive", run: toggleArchived, disabled: archiving },
                            ] as { label: string; run?: () => void; href?: string | null; disabled?: boolean }[]
                          ).map((item) =>
                            item.href !== undefined ? (
                              item.href ? (
                                <a key={item.label} href={item.href} target="_blank" rel="noreferrer" className="block px-3 py-1.5 leading-5 hover:bg-[var(--color-paper)]">
                                  {item.label}
                                </a>
                              ) : null
                            ) : (
                              <button
                                key={item.label}
                                type="button"
                                disabled={item.disabled}
                                onClick={() => {
                                  setMoreOpen(false);
                                  item.run?.();
                                }}
                                className="block w-full px-3 py-1.5 text-left leading-5 hover:bg-[var(--color-paper)] disabled:cursor-not-allowed disabled:text-[var(--color-muted)]"
                              >
                                {item.label}
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <ProgressTrack
                  steps={[
                    { label: "Buyer paid", date: formatDayMonth(paidAt || order.createdAt, siteTz), done: order.paymentStatus === "PAID" || order.paymentStatus === "FULLY_REFUNDED" || order.paymentStatus === "PARTIALLY_REFUNDED" },
                    { label: dispatched ? "Dispatched" : "Dispatch by", date: formatDayMonth(dispatched ? shippedAt : dispatchBy, siteTz), done: dispatched },
                    { label: "Delivery", date: order.estimatedDelivery.max ? `est. ${formatDayMonth(order.estimatedDelivery.max, siteTz)}` : "", done: false },
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
                            <p className="mt-3 flex items-center text-[var(--color-muted)]">
                              Phone
                              <CopyIcon text={internationalPhone(a.phone, a.country || connection.marketplace?.country)} title="Copy phone number" />
                            </p>
                            <p>
                              <a href={`tel:${internationalPhone(a.phone, a.country || connection.marketplace?.country).replace(/\s+/g, "")}`} className="hover:underline">
                                {internationalPhone(a.phone, a.country || connection.marketplace?.country)}
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
                      <button type="button" onClick={guarded(() => setAction("tracking"))} className="btn btn-secondary btn-sm rounded-full border-[var(--color-primary)] !h-8 !px-3 !text-[12.5px] text-[var(--color-primary)]">
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
                                  <button type="button" onClick={guarded(() => setAction("tracking"))} className="text-[var(--color-primary)] underline">
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
                                <dl className="mt-3 grid grid-cols-[minmax(120px,auto)_minmax(0,1fr)] gap-x-10 gap-y-2 text-[13px]">
                                  {Object.entries(li.itemSpecifics || {})
                                    .sort(([x], [y]) => x.localeCompare(y))
                                    .map(([name, values]) => (
                                      <Fragment key={name}>
                                        <dt className="text-[var(--color-muted)]">{name}</dt>
                                        <dd className="text-[var(--color-ink)]">{values.join(", ")}</dd>
                                      </Fragment>
                                    ))}
                                  {Object.keys(li.itemSpecifics || {}).length === 0 && <dd className="col-span-2 text-[var(--color-muted)]">No item specifics on this listing.</dd>}
                                </dl>
                              )}
                            </div>
                          </div>
                          <div className="text-[13px] sm:text-center">
                            <p className="text-[var(--color-muted)]">Quantity</p>
                            <p className="mt-1 font-semibold text-[var(--color-ink)]">{li.quantity}</p>
                            {li.quantityAvailable !== null && li.quantityAvailable !== undefined && <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">({li.quantityAvailable} available)</p>}
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
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-paper)] text-[var(--color-primary)]" aria-hidden>
                      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                        <path d="M3 7l9-4 9 4-9 4-9-4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                        <path d="M3 7v10l9 4 9-4V7M12 11v10" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <div>
                      <h2 className="text-[20px] font-bold text-[var(--color-ink)]">Source</h2>
                      <p className="text-[12.5px] text-[var(--color-muted)]">Supplier order for each item — a saved tracking number dispatches it on eBay.</p>
                    </div>
                  </div>
                </div>
                <div className="mt-3 space-y-3">
                  {order.lineItems.map((li) => (
                    <SourcingCard
                      key={`${li.sourcingKey}-${li.sourcing?.updatedAt || "new"}`}
                      connectionId={connection.id}
                      orderId={order.orderId}
                      line={li}
                      carriers={data.carriers}
                      actionsEnabled={data.actionsEnabled}
                      currency={currency}
                      onSaved={(sourcing, dispatch) => {
                        applySourcing(sourcing);
                        if (dispatch?.ok) load();
                      }}
                      defaultOpen={!li.sourcing || (li.sourcing.status !== "shipped" && li.sourcing.status !== "delivered")}
                      note={saveNotes[li.sourcingKey] || null}
                      onNote={(n) => setSaveNotes((current) => ({ ...current, [li.sourcingKey]: n }))}
                    />
                  ))}
                </div>
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
                  <div className="mt-2">
                    {a?.email && (
                      <Row
                        label="Email"
                        value={
                          <span className="flex items-start justify-between gap-1">
                            <span className="break-all">{a.email}</span>
                            <CopyIcon text={a.email} title="Copy email" />
                          </span>
                        }
                      />
                    )}
                    {a?.phone ? (
                      <Row
                        label="Phone"
                        value={
                          <span className="flex items-center justify-between gap-1">
                            <a href={`tel:${internationalPhone(a.phone, a.country || connection.marketplace?.country).replace(/\s+/g, "")}`} className="hover:underline">
                              {internationalPhone(a.phone, a.country || connection.marketplace?.country)}
                            </a>
                            <CopyIcon text={internationalPhone(a.phone, a.country || connection.marketplace?.country)} title="Copy phone number" />
                          </span>
                        }
                      />
                    ) : (
                      <p className="text-[13px] text-[var(--color-muted)]">No phone on this order.</p>
                    )}
                    {!a?.email && <p className="mt-1 text-[12px] text-[var(--color-muted)]">The buyer&apos;s email comes with the reconnected account.</p>}
                  </div>
                )}
                {messageUrl && (
                  <a href={messageUrl} target="_blank" rel="noreferrer" className="btn btn-secondary mt-4 w-full print:hidden">
                    Message buyer
                  </a>
                )}
              </div>

              {/* Payment */}
              <div id="payment" className={`${cardClass} scroll-mt-4`}>
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
                  <div className="mt-3 rounded-xl bg-[var(--color-paper)] p-3 text-[12.5px] text-[var(--color-ink)]">
                    {order.earningsUnavailable === "scope" ? (
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span>Fees and earnings need the finances permission this account was linked without. Reconnect once and they show here.</span>
                        <button type="button" onClick={reconnect} disabled={reconnecting} className="btn btn-secondary btn-sm flex-shrink-0">
                          {reconnecting ? "Opening eBay…" : "Reconnect"}
                        </button>
                      </span>
                    ) : order.earningsUnavailable === "error" ? (
                      "eBay's finances couldn't be read just now; the breakdown will fill in on the next load."
                    ) : (
                      "Your buyer has paid for this order. eBay hasn't posted the sale to your finances yet, so the fees aren't known — they appear here as soon as it does."
                    )}
                  </div>
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
                        <p className="pl-4 text-[12.5px] text-[var(--color-muted)]">{order.earningsUnavailable === "scope" ? "Reconnect the account to see fees." : "Not posted by eBay yet."}</p>
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

      {declineCancelOpen && order && (
        <Modal title="Decline the cancellation request" onClose={() => setDeclineCancelOpen(false)}>
          <p className="mt-3 text-[13px] text-[var(--color-ink)]">
            The order stays as it is and the buyer is told you declined. eBay expects a decline only when the item has already been sent — otherwise it can count against you if the buyer opens a case.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setDeclineCancelOpen(false)} className="btn btn-secondary btn-sm">
              Back
            </button>
            <button type="button" onClick={declineCancel} disabled={decliningCancel} className="btn btn-primary btn-sm">
              {decliningCancel ? "Working…" : "Decline request"}
            </button>
          </div>
        </Modal>
      )}
      {caseAction && order && cases && (
        <CaseDialog
          connectionId={connection.id}
          order={order}
          currency={currency}
          carriers={data?.carriers || []}
          declineReasons={cases.returnDeclineReasons}
          action={caseAction}
          onClose={() => setCaseAction(null)}
          onDone={(message) => {
            setCaseAction(null);
            setActionNote({ tone: "ok", text: message });
            load();
          }}
        />
      )}
      {reconnectPrompt && (
        <Modal title="Reconnect this eBay account" onClose={() => setReconnectPrompt(false)}>
          <p className="mt-3 text-[13px] text-[var(--color-ink)]">
            This account was linked before Liston asked eBay for order permissions, so eBay won&apos;t accept tracking, refunds or cancellations from here yet. Reconnecting re-runs eBay&apos;s consent for the same account — one click, nothing else changes — and brings you straight back to this order.
          </p>
          <div className="mt-5 flex justify-end gap-3">
            <button type="button" onClick={() => setReconnectPrompt(false)} className="btn btn-ghost">
              Not now
            </button>
            <button type="button" onClick={reconnect} disabled={reconnecting} className="btn btn-primary">
              {reconnecting ? "Opening eBay…" : "Reconnect now"}
            </button>
          </div>
        </Modal>
      )}
      {action && order && data && (
        <ActionDialog
          kind={action}
          connectionId={connection.id}
          order={order}
          carriers={data.carriers}
          refundReasons={data.refundReasons || []}
          cancelReasons={data.cancelReasons || []}
          currency={currency}
          onClose={() => setAction(null)}
          onDone={(message) => {
            setAction(null);
            setActionNote({ tone: "ok", text: message });
            load();
          }}
        />
      )}
    </AccountShell>
  );
}
