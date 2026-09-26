"use client";

import { HuntLevel, HuntMatchQuality, HuntPerson, HuntStage, HuntVerdict } from "@/lib/api";
import { money } from "@/components/research/format";
import { ToneIcon, Tone } from "@/components/research/ResearchPanels";
import { initials } from "@/components/team/team-shared";

// The small pieces every hunting view shares: where a product stands, how
// good its profit is, who hunted it.

export const STAGE: Record<HuntStage, { label: string; chip: string; dot: string }> = {
  pending: { label: "Waiting for review", chip: "bg-indigo-50 text-indigo-700 ring-indigo-200", dot: "bg-indigo-500" },
  sent_back: { label: "Sent back", chip: "bg-amber-50 text-amber-800 ring-amber-200", dot: "bg-amber-500" },
  approved: { label: "Approved", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" },
  drafted: { label: "Drafted", chip: "bg-sky-50 text-sky-700 ring-sky-200", dot: "bg-sky-500" },
  listed: { label: "Listed", chip: "bg-teal-50 text-teal-700 ring-teal-200", dot: "bg-teal-500" },
  rejected: { label: "Rejected", chip: "bg-rose-50 text-rose-700 ring-rose-200", dot: "bg-rose-500" },
};

export function StageChip({ stage, className = "" }: { stage: HuntStage; className?: string }) {
  const s = STAGE[stage];
  return (
    <span className={`inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11.5px] font-semibold ring-1 ring-inset ${s.chip} ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

export const VERDICT: Record<HuntVerdict, { label: string; tone: Tone; ink: string; soft: string }> = {
  strong: { label: "Good profit", tone: "good", ink: "text-emerald-700", soft: "bg-emerald-50 ring-emerald-200" },
  thin: { label: "Thin margin", tone: "warn", ink: "text-amber-700", soft: "bg-amber-50 ring-amber-200" },
  loss: { label: "Loses money", tone: "bad", ink: "text-rose-700", soft: "bg-rose-50 ring-rose-200" },
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

/** The colour a profit reads in: green at or over the target return, amber above nothing, red at a loss. */
export function profitInk(profit: number | null | undefined, roi: number | null | undefined, target: number | null | undefined) {
  if (profit === null || profit === undefined) return "text-[var(--color-muted)]";
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
