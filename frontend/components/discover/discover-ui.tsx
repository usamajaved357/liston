"use client";

import { DiscoverAccount, DiscoverBudget, DiscoverListing, DiscoverOpportunity } from "@/lib/api";

// Pieces Discover's views share, in the Analytics page's style: card
// headers, quiet empty text, thumbnails, the opportunity badge, delivery
// next to the account's, and what's left of the day's eBay reads.

export const BAND: Record<DiscoverOpportunity["band"], { label: string; chip: string; ink: string; bar: string; soft: string }> = {
  strong: { label: "Strong", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", ink: "text-emerald-700", bar: "bg-emerald-500", soft: "bg-emerald-50" },
  fair: { label: "Fair", chip: "bg-amber-50 text-amber-800 ring-amber-200", ink: "text-amber-700", bar: "bg-amber-500", soft: "bg-amber-50" },
  weak: { label: "Weak", chip: "bg-rose-50 text-rose-700 ring-rose-200", ink: "text-rose-700", bar: "bg-rose-400", soft: "bg-rose-50" },
};

export function ScoreBadge({ score, band, size = "md" }: { score: number; band: DiscoverOpportunity["band"]; size?: "sm" | "md" }) {
  const b = BAND[band];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full font-semibold tabular-nums ring-1 ring-inset ${b.chip} ${size === "sm" ? "h-5 px-1.5 text-[11px]" : "h-6 px-2 text-[12px]"}`}
      title={`Opportunity ${score} of 100: ${b.label.toLowerCase()}`}
    >
      {score}
      <span className="font-medium opacity-80">{b.label}</span>
    </span>
  );
}

export function CardHeader({ title, aside, note }: { title: string; aside?: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{title}</h2>
        {note && <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--color-muted)]">{note}</p>}
      </div>
      {aside}
    </div>
  );
}

export function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-[12.5px] leading-relaxed text-[var(--color-muted)]">{children}</p>;
}

export function Thumb({ src, size = 36 }: { src: string | null; size?: number }) {
  const cls = "flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-contain";
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" width={size} height={size} style={{ width: size, height: size }} className={cls} loading="lazy" />
  ) : (
    <span style={{ width: size, height: size }} className={`${cls} bg-[var(--color-paper)]`} />
  );
}

export const perMonth = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${n >= 100 ? Math.round(n).toLocaleString("en-GB") : Math.round(n * 10) / 10}/mo`;

/** Working days until it arrives, coloured by how it sits next to the account's delivery. */
export function DeliveryText({ delivery, short = false }: { delivery: DiscoverListing["delivery"]; short?: boolean }) {
  if (delivery.max === null || delivery.max === undefined) return <span className="text-[var(--color-muted)]">Not given</span>;
  const days = delivery.min === delivery.max ? `${delivery.max}` : `${delivery.min}–${delivery.max}`;
  const tone = delivery.compared === "faster" ? "text-amber-700" : delivery.compared === "similar" || delivery.compared === "slower" ? "text-emerald-700" : "text-[var(--color-muted)]";
  const note = delivery.compared === "faster" ? "faster than you" : delivery.compared === "slower" ? "slower than you" : delivery.compared === "similar" ? "like you" : "";
  return (
    <span className={tone} title="Working days until it arrives, per eBay">
      {days} days{note && !short && ` · ${note}`}
    </span>
  );
}

export function AccountDelivery({ account }: { account: DiscoverAccount | null }) {
  if (!account) return <span>Your postage policy couldn&apos;t be read, so delivery isn&apos;t compared.</span>;
  return (
    <span>
      Your delivery: <span className="font-medium text-[var(--color-ink)]">{account.min === account.max ? account.max : `${account.min}–${account.max}`} working days</span>
      {account.policyName && <> ({account.policyName})</>}
    </span>
  );
}

/** What's left of the day's eBay reads for Discover. */
export function BudgetLine({ budget }: { budget: DiscoverBudget }) {
  const reset = budget.resetAt ? new Date(budget.resetAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <p className="text-[11px] text-[var(--color-muted)]">
      eBay reads today: {budget.used.trading.toLocaleString("en-GB")} of {budget.limits.trading.toLocaleString("en-GB")} sold counts · {budget.used.browse} of {budget.limits.browse} searches
      {reset && <> · resets at {reset}</>}
      {budget.tradingPaused && <span className="text-amber-700"> · sold counts paused so orders keep eBay&apos;s last calls today</span>}
    </p>
  );
}

export const StarIcon = ({ filled = false, className = "h-4 w-4" }: { filled?: boolean; className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill={filled ? "currentColor" : "none"} aria-hidden>
    <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
  </svg>
);

export const HuntIcon = ({ className = "h-3.5 w-3.5" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
    <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.9" />
    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.9" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

export const Chevron = ({ className = "h-4 w-4" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
    <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
