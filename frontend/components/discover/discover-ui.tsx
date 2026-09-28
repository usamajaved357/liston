"use client";

import { DiscoverAccount, DiscoverBudget, DiscoverOpportunity } from "@/lib/api";

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

// Discover's headline tiles: an icon in a tinted disc, the figure, one
// line of what's behind it, and (for a share or a score) a thin gauge.
export type StatTone = "primary" | "emerald" | "amber" | "rose" | "sky" | "slate";
const STAT_TONE: Record<StatTone, { disc: string; bar: string }> = {
  primary: { disc: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]", bar: "bg-[var(--color-primary)]" },
  emerald: { disc: "bg-emerald-50 text-emerald-600", bar: "bg-emerald-500" },
  amber: { disc: "bg-amber-50 text-amber-600", bar: "bg-amber-500" },
  rose: { disc: "bg-rose-50 text-rose-600", bar: "bg-rose-500" },
  sky: { disc: "bg-sky-50 text-sky-600", bar: "bg-sky-500" },
  slate: { disc: "bg-slate-100 text-slate-500", bar: "bg-slate-400" },
};
export const STAT_ICONS = {
  target: "M12 3.5a8.5 8.5 0 108.5 8.5M12 7.5a4.5 4.5 0 104.5 4.5M12 12l7.5-7.5M17 3v3.5h3.5",
  trend: "M3.5 17.5l5.5-6 4 3.5 7.5-8M15.5 7h5v5",
  layers: "M12 4l8.5 4.5L12 13 3.5 8.5 12 4zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5",
  check: "M12 21a9 9 0 100-18 9 9 0 000 18zM8.5 12.5l2.5 2.5 4.5-5",
  tag: "M3.5 12.5v-8a1 1 0 011-1h8l8 8-9 9-8-8zM8 8h.01",
  wallet: "M3.5 7.5A2 2 0 015.5 5.5h12a2 2 0 012 2v10a2 2 0 01-2 2h-12a2 2 0 01-2-2v-10zM15 12.5h4.5v3H15a1.5 1.5 0 010-3z",
};
export function StatTile({
  icon,
  label,
  value,
  sub,
  tone = "primary",
  gauge,
  chip,
  info,
}: {
  icon: keyof typeof STAT_ICONS;
  label: string;
  value: string;
  sub?: React.ReactNode;
  tone?: StatTone;
  gauge?: number | null; // 0–100
  chip?: string;
  info?: string;
}) {
  const t = STAT_TONE[tone];
  return (
    <div className="relative flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-panel)] px-3.5 pb-3 pt-3 shadow-[var(--shadow-card)]">
      <div className="flex items-start justify-between gap-2">
        <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${t.disc}`}>
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
            <path d={STAT_ICONS[icon]} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        {chip && <span className={`inline-flex h-5 items-center rounded-full px-2 text-[10.5px] font-semibold ${t.disc}`}>{chip}</span>}
      </div>
      <span className="mt-2.5 flex min-w-0 items-center gap-1 text-[12px] font-medium text-[var(--color-muted)]">
        <span className="truncate">{label}</span>
        {info && (
          <span title={info} className="flex-shrink-0 cursor-help text-[var(--color-line-strong)] hover:text-[var(--color-muted)]" aria-label={info}>
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
              <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 7.25v3.5M8 5.2v.05" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
        )}
      </span>
      <p className="mt-0.5 truncate text-[23px] font-semibold leading-tight tracking-tight tabular-nums text-[var(--color-ink)]">{value}</p>
      {sub && <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-[var(--color-muted)]">{sub}</p>}
      {gauge !== undefined && gauge !== null && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-[var(--color-paper)]" aria-hidden>
          <div className={`h-full rounded-full ${t.bar}`} style={{ width: `${Math.max(2, Math.min(100, gauge))}%` }} />
        </div>
      )}
    </div>
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

/** A small tag for a flagged keyword, category or listing: restricted item, eBay's word filter, or a brand. */
export function FlagTag({ flag }: { flag: import("@/lib/api").DiscoverFlag | null | undefined }) {
  if (!flag) return null;
  if (flag.restricted) {
    const banned = flag.restricted.kind === "prohibited";
    return (
      <span className={`inline-flex shrink-0 items-center rounded px-1.5 text-[10.5px] font-semibold ${banned ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-800"}`} title={`${flag.restricted.label}: eBay ${banned ? "doesn't allow these" : "restricts these"}`}>
        {banned ? "Not allowed" : "Restricted"}
      </span>
    );
  }
  if (flag.brand) {
    return (
      <span className="inline-flex shrink-0 items-center rounded bg-violet-50 px-1.5 text-[10.5px] font-semibold text-violet-700" title={`Names the brand ${flag.brand}: check it isn't VeRO-protected before using it`}>
        Brand
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded bg-slate-100 px-1.5 text-[10.5px] font-semibold text-slate-600" title={`“${flag.hazmat}” trips eBay's hazardous-materials filter: word it differently in your listing`}>
      Filtered word
    </span>
  );
}

// The search beside a tab row: words in whatever the open tab lists (products, keywords).
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (next: string) => void; placeholder: string }) {
  return (
    <label className="relative min-w-[180px] flex-1 sm:max-w-[260px] sm:flex-none sm:basis-[240px]">
      <span className="sr-only">{placeholder}</span>
      <svg viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted)]" aria-hidden>
        <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
        <path d="M16 16l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-[26px] w-full rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] pl-8 pr-3 text-[12px] text-[var(--color-ink)] placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] focus:outline-none"
      />
    </label>
  );
}
