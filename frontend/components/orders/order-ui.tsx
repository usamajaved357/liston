"use client";

// Building blocks shared by the order page and its dialogs: the Seller Hub
// look (labels, cards, dot statuses, money rows), site-time-zone dates, the
// progress track, and the modal shell.
import { useState, type ReactNode } from "react";
import { formatPrice } from "@/lib/format";
import type { Amount, OrderDetail, OrderSourcing } from "@/lib/api";

export const labelClass = "text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]";
export const cardClass = "rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5";
export const inputClass = "input input-sm w-full";

export function money(a: Amount | null | undefined, fallbackCurrency = "GBP") {
  if (!a) return "—";
  return formatPrice(a.value, a.currency || fallbackCurrency);
}

export function paymentLabel(status: string | null) {
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

export function fulfillmentLabel(order: OrderDetail) {
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
export const DOTS: Record<string, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-[var(--color-danger)]",
  muted: "bg-[var(--color-line-strong)]",
  info: "bg-[var(--color-primary)]",
};

export function Chip({ text, tone }: { text: string; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--color-ink)]">
      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${DOTS[tone] || DOTS.muted}`} aria-hidden />
      {text}
    </span>
  );
}

export function daysUntil(iso: string | null) {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function cleanTitle(title: string | null) {
  return (title || "").replace(/\[[^[\]]*\]\s*$/, "").trim();
}

export const SOURCING_STATUS: { value: OrderSourcing["status"]; label: string; tone: string }[] = [
  { value: "to_order", label: "To order", tone: "muted" },
  { value: "ordered", label: "Ordered", tone: "info" },
  { value: "shipped", label: "Shipped", tone: "ok" },
  { value: "delivered", label: "Delivered", tone: "ok" },
  { value: "problem", label: "Problem", tone: "bad" },
];


// Seller Hub shows deadlines in the eBay site's own time zone ("24 Sep at
// 11.59pm BST"), whatever the viewer's clock says — the same here.
export const SITE_TIMEZONES: Record<string, string> = {
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

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Day/month/year of an instant in a time zone (the site's, when given).
export function partsIn(iso: string, timeZone?: string) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short", timeZone }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return { day: Number(get("day")), month: Number(get("month")) - 1, year: get("year"), hour: get("hour"), minute: get("minute"), dayPeriod: get("dayPeriod").toLowerCase(), zone: get("timeZoneName") };
}

export function formatDeadline(iso: string | null, timeZone?: string) {
  if (!iso) return "—";
  const p = partsIn(iso, timeZone);
  return `${p.day} ${MONTHS[p.month]} at ${p.hour}.${p.minute}${p.dayPeriod} ${p.zone}`;
}

export function formatDayMonthYear(iso: string | null, timeZone?: string) {
  if (!iso) return "—";
  const p = partsIn(iso, timeZone);
  return `${p.day} ${MONTHS[p.month]} ${p.year}`;
}

export function formatDayMonth(iso: string | null, timeZone?: string) {
  if (!iso) return "";
  const p = partsIn(iso, timeZone);
  return `${p.day} ${MONTHS[p.month]}`;
}

// Seller Hub's three-step track under the deadline: paid → dispatched → delivered.
export function ProgressTrack({ steps }: { steps: { label: string; date: string; done: boolean }[] }) {
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

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 py-1.5 text-[13px]">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className="min-w-0 text-[var(--color-ink)]">{value}</span>
    </div>
  );
}

export function MoneyRow({ label, value, bold = false, indent = false, negative = false }: { label: string; value: string; bold?: boolean; indent?: boolean; negative?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 text-[13px] ${bold ? "font-bold text-[var(--color-ink)]" : "text-[var(--color-ink)]"} ${indent ? "pl-4" : ""}`}>
      <span className={indent ? "underline decoration-dotted underline-offset-2" : ""}>{label}</span>
      <span>{negative ? `-${value}` : value}</span>
    </div>
  );
}

export function CopyIcon({ text, title }: { text: string; title: string }) {
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

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 8l5 5 5-5" />
    </svg>
  );
}

// eBay's own guidance under "Postage", as Seller Hub shows it.
export function PostageInstructions() {
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

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
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

