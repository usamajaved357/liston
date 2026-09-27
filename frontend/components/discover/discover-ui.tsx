"use client";

import { DiscoverAccount, DiscoverBudget, DiscoverListing, DiscoverOpportunity } from "@/lib/api";

// Small pieces Discover's views share: the opportunity badge, delivery next
// to the account's, and what's left of the day's eBay reads.

export const BAND: Record<DiscoverOpportunity["band"], { label: string; chip: string; ink: string; bar: string }> = {
  strong: { label: "Strong", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", ink: "text-emerald-700", bar: "bg-emerald-500" },
  fair: { label: "Fair", chip: "bg-amber-50 text-amber-800 ring-amber-200", ink: "text-amber-700", bar: "bg-amber-500" },
  weak: { label: "Weak", chip: "bg-rose-50 text-rose-700 ring-rose-200", ink: "text-rose-700", bar: "bg-rose-400" },
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

export const perMonth = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n >= 100 ? Math.round(n) : n}/mo`);

/** Working days until it arrives, coloured by how it sits next to the account's delivery. */
export function DeliveryText({ delivery }: { delivery: DiscoverListing["delivery"] }) {
  if (delivery.max === null || delivery.max === undefined) return <span className="text-[var(--color-muted)]">Delivery not given</span>;
  const days = delivery.min === delivery.max ? `${delivery.max}` : `${delivery.min}–${delivery.max}`;
  const tone = delivery.compared === "faster" ? "text-amber-700" : delivery.compared === "similar" || delivery.compared === "slower" ? "text-emerald-700" : "text-[var(--color-muted)]";
  const note = delivery.compared === "faster" ? "faster than you" : delivery.compared === "slower" ? "slower than you" : delivery.compared === "similar" ? "like you" : "";
  return (
    <span className={tone} title="Working days until it arrives, per eBay">
      {days} days{note && ` · ${note}`}
    </span>
  );
}

export function AccountDelivery({ account }: { account: DiscoverAccount | null }) {
  if (!account) return <span>Your postage policy couldn&apos;t be read, so delivery isn&apos;t compared.</span>;
  return (
    <span>
      Compared with your delivery: <span className="font-medium text-[var(--color-ink)]">{account.min === account.max ? account.max : `${account.min}–${account.max}`} working days</span>
      {account.policyName && <> ({account.policyName})</>}
    </span>
  );
}

/** What's left of the day's eBay reads for Discover. */
export function BudgetLine({ budget }: { budget: DiscoverBudget }) {
  const reset = budget.resetAt ? new Date(budget.resetAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <p className="text-[11.5px] text-[var(--color-muted)]">
      Today: {budget.used.trading.toLocaleString("en-GB")} of {budget.limits.trading.toLocaleString("en-GB")} sold-count reads · {budget.used.browse} of {budget.limits.browse} searches
      {reset && <> · resets at {reset}</>}
      {budget.tradingPaused && <span className="text-amber-700"> · sold counts paused so orders keep eBay&apos;s last calls today</span>}
    </p>
  );
}

export function SectionTitle({ title, note, right }: { title: string; note?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1 px-4 pb-2.5 pt-3.5">
      <div className="min-w-0">
        <h3 className="text-[13.5px] font-semibold text-[var(--color-ink)]">{title}</h3>
        {note && <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">{note}</p>}
      </div>
      {right}
    </div>
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
