"use client";

import { HuntLevel, HuntMatchQuality, HuntPerson, HuntStage, HuntVerdict } from "@/lib/api";
import { money } from "@/components/research/format";
import { ToneIcon, Tone } from "@/components/research/ResearchPanels";
import { initials } from "@/components/team/team-shared";

// The small pieces every hunting view shares: where a product stands, how
// good its profit is, who hunted it.

const ICON: Record<HuntStage, React.ReactNode> = {
  pending: <path d="M10 6v4.2l2.6 1.6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />,
  sent_back: <path d="M8 6.5L5 9.5l3 3M5.5 9.5h6a3 3 0 010 6H10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  approved: <path d="M6.5 10.3l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  drafted: <path d="M6.5 13.5l.5-2.3 5.2-5.2 1.8 1.8-5.2 5.2-2.3.5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
  listed: <path d="M6 9.5V6.5A.5.5 0 016.5 6h3l4.5 4.5-3.5 3.5L6 9.5z M8.3 8.3h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  rejected: <path d="M7.3 7.3l5.4 5.4M12.7 7.3l-5.4 5.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />,
};

export const STAGE: Record<HuntStage, { label: string; chip: string; dot: string; icon: string }> = {
  pending: { label: "Waiting for review", chip: "bg-indigo-50 text-indigo-700 ring-indigo-200", dot: "bg-indigo-500", icon: "bg-indigo-600" },
  sent_back: { label: "Sent back", chip: "bg-amber-50 text-amber-800 ring-amber-200", dot: "bg-amber-500", icon: "bg-amber-500" },
  approved: { label: "Approved", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500", icon: "bg-emerald-600" },
  drafted: { label: "Drafted", chip: "bg-sky-50 text-sky-700 ring-sky-200", dot: "bg-sky-500", icon: "bg-sky-600" },
  listed: { label: "Listed", chip: "bg-teal-50 text-teal-700 ring-teal-200", dot: "bg-teal-500", icon: "bg-teal-600" },
  rejected: { label: "Rejected", chip: "bg-rose-50 text-rose-700 ring-rose-200", dot: "bg-rose-500", icon: "bg-rose-600" },
};

/** Where a product stands: its colour, a small mark for the stage, and the words. */
export function StageChip({ stage, className = "" }: { stage: HuntStage; className?: string }) {
  const s = STAGE[stage];
  return (
    <span className={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-1 pr-3 text-[12px] font-semibold ring-1 ring-inset ${s.chip} ${className}`}>
      <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-white ${s.icon}`} aria-hidden>
        <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5">
          {ICON[stage]}
        </svg>
      </span>
      {s.label}
    </span>
  );
}

// ---- ratings: coloured by how good they are, so they read at a glance ----------------

type Band = "great" | "good" | "fair" | "poor";
const BAND: Record<Band, string> = {
  great: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  good: "bg-lime-50 text-lime-800 ring-lime-200",
  fair: "bg-amber-50 text-amber-800 ring-amber-200",
  poor: "bg-rose-50 text-rose-700 ring-rose-200",
};
const STAR: Record<Band, string> = { great: "text-emerald-500", good: "text-lime-600", fair: "text-amber-500", poor: "text-rose-500" };

/** A 5-point rating's band: 4.7+ great, 4.5+ good, 4.2+ fair, under that poor. */
export const ratingBand = (r: number): Band => (r >= 4.7 ? "great" : r >= 4.5 ? "good" : r >= 4.2 ? "fair" : "poor");
/** An eBay feedback percentage's band: 99+ great, 98+ good, 96+ fair. */
export const feedbackBand = (p: number): Band => (p >= 99 ? "great" : p >= 98 ? "good" : p >= 96 ? "fair" : "poor");

function Star({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`h-3.5 w-3.5 flex-shrink-0 ${className}`} fill="currentColor" aria-hidden>
      <path d="M10 2.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4L10 14.6l-4.8 2.5.9-5.4L2.2 7.9l5.4-.8L10 2.2z" />
    </svg>
  );
}

const pill = "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11.5px] font-semibold ring-1 ring-inset tabular-nums";

/** "★ 4.8 · 256 reviews", coloured by the rating. */
export function RatingPill({ rating, reviews, small = false }: { rating: number | null | undefined; reviews?: number | null; small?: boolean }) {
  if (rating === null || rating === undefined) return null;
  const band = ratingBand(rating);
  return (
    <span className={`${pill} ${BAND[band]} ${small ? "!h-5 !px-1.5 !text-[11px]" : ""}`} title={`Rated ${rating} out of 5${reviews ? ` from ${reviews.toLocaleString("en-GB")} reviews` : ""}`}>
      <Star className={STAR[band]} />
      {rating.toFixed(1)}
      {reviews !== null && reviews !== undefined && !small && <span className="font-medium opacity-75">· {reviews.toLocaleString("en-GB")} reviews</span>}
    </span>
  );
}

/** An eBay seller's feedback: "99.5% positive", coloured by it. */
export function FeedbackPill({ percent, score }: { percent: number | null | undefined; score?: number | null }) {
  if (percent === null || percent === undefined) return null;
  const band = feedbackBand(percent);
  return (
    <span className={`${pill} ${BAND[band]}`} title={`${percent}% positive feedback${score ? ` from ${score.toLocaleString("en-GB")}` : ""}`}>
      <svg viewBox="0 0 20 20" fill="none" className={`h-3.5 w-3.5 ${STAR[band]}`} aria-hidden>
        <path d="M6.5 10.3l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {percent}% positive
      {score ? <span className="font-medium opacity-75">· {score.toLocaleString("en-GB")}</span> : null}
    </span>
  );
}

/** A plain fact as a pill (orders, sold a month), in the brand's quiet tint. */
export function FactPill({ children, tone = "indigo", title }: { children: React.ReactNode; tone?: "indigo" | "slate" | "amber" | "rose"; title?: string }) {
  const tones = { indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200", slate: "bg-slate-50 text-slate-700 ring-slate-200", amber: "bg-amber-50 text-amber-800 ring-amber-200", rose: "bg-rose-50 text-rose-700 ring-rose-200" };
  return (
    <span className={`${pill} ${tones[tone]}`} title={title}>
      {children}
    </span>
  );
}

/** A store's three scores, each coloured: as described, communication, shipping speed. */
export function StoreScores({ store }: { store: { described: number | null; communication: number | null; shipping: number | null } | null | undefined }) {
  if (!store) return null;
  const scores: [string, number | null][] = [
    ["Described", store.described],
    ["Service", store.communication],
    ["Shipping", store.shipping],
  ];
  return (
    <span className="flex flex-wrap gap-1">
      {scores
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([label, v]) => (
          <span key={label} className={`inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10.5px] font-semibold ring-1 ring-inset tabular-nums ${BAND[ratingBand(v as number)]}`} title={`${label}: ${v} out of 5`}>
            {label} {(v as number).toFixed(1)}
          </span>
        ))}
    </span>
  );
}

export const VERDICT: Record<HuntVerdict, { label: string; tone: Tone; ink: string; soft: string }> = {
  strong: { label: "Good profit", tone: "good", ink: "text-emerald-700", soft: "bg-emerald-50 ring-emerald-200" },
  thin: { label: "Thin margin", tone: "warn", ink: "text-amber-700", soft: "bg-amber-50 ring-amber-200" },
  loss: { label: "Loses money", tone: "bad", ink: "text-rose-700", soft: "bg-rose-50 ring-rose-200" },
  unpriced: { label: "No competitor", tone: "unknown", ink: "text-indigo-700", soft: "bg-indigo-50/70 ring-indigo-200" },
  unknown: { label: "Profit unknown", tone: "unknown", ink: "text-[var(--color-muted)]", soft: "bg-[var(--color-paper)] ring-[var(--color-line)]" },
};

export function VerdictChip({ verdict }: { verdict: HuntVerdict }) {
  const v = VERDICT[verdict];
  return (
    <span className={`inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11.5px] font-semibold ring-1 ring-inset ${v.soft} ${v.ink}`}>
      <ToneIcon tone={v.tone} className="h-3.5 w-3.5" />
      {v.label}
    </span>
  );
}

export const LEVEL_TONE: Record<HuntLevel, Tone> = { ok: "good", warn: "warn", bad: "bad", unknown: "unknown" };
export const INK: Record<Tone, string> = { good: "text-emerald-600", warn: "text-amber-600", bad: "text-rose-600", unknown: "text-[var(--color-muted)]" };

/**
 * The colour a profit reads in: green at or over the target return, amber
 * above nothing, red at a loss; plain ink when it's only the target by
 * design (no competitor, `unpriced`), since nothing has proved it.
 */
export function profitInk(profit: number | null | undefined, roi: number | null | undefined, target: number | null | undefined, unpriced = false) {
  if (profit === null || profit === undefined) return "text-[var(--color-muted)]";
  if (unpriced && profit > 0) return "text-[var(--color-ink)]";
  if (profit <= 0) return "text-rose-600";
  if (target !== null && target !== undefined && roi !== null && roi !== undefined && roi < target) return "text-amber-600";
  return "text-emerald-600";
}

export function signedMoney(value: number | null | undefined, currency: string) {
  if (value === null || value === undefined) return "—";
  return value < 0 ? `−${money(Math.abs(value), currency)}` : money(value, currency);
}

export function roiText(roi: number | null | undefined) {
  if (roi === null || roi === undefined) return "—";
  return `${roi < 0 ? "−" : ""}${Math.abs(Math.round(roi))}%`;
}

export const MATCH: Record<HuntMatchQuality, { label: string; title: string; chip: string }> = {
  exact: { label: "Same option", title: "The competitor sells this exact option at this price.", chip: "text-emerald-700 bg-emerald-50" },
  close: { label: "Close match", title: "The nearest option the competitor sells.", chip: "text-sky-700 bg-sky-50" },
  lowest: { label: "Their lowest", title: "The competitor doesn't sell this option, so their lowest price is used.", chip: "text-amber-800 bg-amber-50" },
  single: { label: "Listing price", title: "The competitor's listing has one price for everything.", chip: "text-[var(--color-muted)] bg-[var(--color-paper)]" },
  target: { label: "Your price", title: "No competitor: priced as a draft would be, at your target return.", chip: "text-indigo-700 bg-indigo-50" },
};

export function MatchChip({ quality }: { quality: HuntMatchQuality }) {
  const m = MATCH[quality];
  return (
    <span title={m.title} className={`inline-flex h-5 items-center whitespace-nowrap rounded px-1.5 text-[10.5px] font-semibold ${m.chip}`}>
      {m.label}
    </span>
  );
}

/** A person's initials in a circle, with their name beside it when `named`. */
export function Person({ person, you, named = true, size = 22 }: { person: HuntPerson | null; you?: string | null; named?: boolean; size?: number }) {
  if (!person) return <span className="text-[var(--color-muted)]">Someone</span>;
  const isYou = you && person.id === you;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
        className="flex flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-soft)] font-semibold text-[var(--color-primary)]"
        aria-hidden
      >
        {initials(person.name, person.name)}
      </span>
      {named && <span className="truncate">{isYou ? "You" : person.name}</span>}
    </span>
  );
}

/** "just now", "12 min ago", "3 h ago", "2 days ago", else the date. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} day${Math.floor(s / 86400) === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function hoursText(hours: number | null | undefined) {
  if (hours === null || hours === undefined) return "—";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} h`;
  return `${Math.round(hours / 24)} days`;
}

/** A product photo in a rounded tile, or a quiet placeholder. */
export function Thumb({ src, size = 56, className = "" }: { src: string | null | undefined; size?: number; className?: string }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" style={{ width: size, height: size }} className={`flex-shrink-0 rounded-xl border border-[var(--color-line)] bg-white object-contain ${className}`} />
  ) : (
    <span style={{ width: size, height: size }} className={`flex flex-shrink-0 items-center justify-center rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] text-[var(--color-line-strong)] ${className}`} aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 17.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function ExternalIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path d="M11 4h5v5M16 4l-7 7M8 5H5.5A1.5 1.5 0 004 6.5v8A1.5 1.5 0 005.5 16h8a1.5 1.5 0 001.5-1.5V12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const HuntIcon = ({ className = "h-4 w-4" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
    <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

/** Broadcast that hunting changed, so the side menu's badge counts again. */
export function announceHuntingChange() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("liston:hunting"));
}

// ---- section headers ----------------------------------------------------------------------

const SECTION_ICON = {
  // Coins: the profit.
  profit: <path d="M10 3.5c3.6 0 6.5 1.3 6.5 3s-2.9 3-6.5 3-6.5-1.3-6.5-3 2.9-3 6.5-3zM3.5 6.5v3.5c0 1.7 2.9 3 6.5 3s6.5-1.3 6.5-3V6.5M3.5 10v3.5c0 1.7 2.9 3 6.5 3s6.5-1.3 6.5-3V10" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
  // A shield with a tick: what to check before approving.
  checks: <path d="M10 2.8l5.8 2.2v4.6c0 3.6-2.5 6.3-5.8 7.6-3.3-1.3-5.8-4-5.8-7.6V5L10 2.8zM7.3 10.1l1.9 1.9 3.6-3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  // Rising bars: the sales.
  sales: <path d="M4 16.5h12M5.5 13.5v-3M9 13.5V7.5M12.5 13.5v-5M16 13.5V4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  // Stacked layers: the options.
  options: <path d="M10 3l7 3.7-7 3.7-7-3.7L10 3zM3 10.2l7 3.7 7-3.7M3 13.6l7 3.7 7-3.7" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
  // Two boxes: the two listings.
  listings: <path d="M3.5 5.5h5v9h-5zM11.5 5.5h5v9h-5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
} as const;

/** A section's header: a small icon tile, the title, and what it's about on the right. */
export function SectionHead({ icon, title, meta, className = "" }: { icon: keyof typeof SECTION_ICON; title: React.ReactNode; meta?: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 py-3 sm:px-5 ${className}`}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
            {SECTION_ICON[icon]}
          </svg>
        </span>
        <h3 className="truncate text-[13.5px] font-semibold text-[var(--color-ink)]">{title}</h3>
      </div>
      {meta && <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--color-muted)]">{meta}</div>}
    </div>
  );
}
