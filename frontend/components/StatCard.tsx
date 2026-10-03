import { ReactNode } from "react";

// The figure cards on the Overviews, a member's Performance and Time tabs:
// an icon in the card's own colour beside its name (what it means on
// hover), a link in the corner when there is one, the figure and its note,
// then its details on a soft panel that runs to the card's foot, so a row of
// cards lines up whatever each one holds. A faint wash of the colour sits at
// the card's top.

export type Hue = "indigo" | "rose" | "sky" | "amber" | "emerald" | "violet" | "teal" | "slate";

export const HUES: Record<Hue, { tile: string; wash: string }> = {
  indigo: { tile: "bg-indigo-50 text-indigo-600 ring-indigo-100", wash: "from-indigo-50/80" },
  rose: { tile: "bg-rose-50 text-rose-600 ring-rose-100", wash: "from-rose-50/80" },
  sky: { tile: "bg-sky-50 text-sky-600 ring-sky-100", wash: "from-sky-50/80" },
  amber: { tile: "bg-amber-50 text-amber-600 ring-amber-100", wash: "from-amber-50/80" },
  emerald: { tile: "bg-emerald-50 text-emerald-600 ring-emerald-100", wash: "from-emerald-50/80" },
  violet: { tile: "bg-violet-50 text-violet-600 ring-violet-100", wash: "from-violet-50/80" },
  teal: { tile: "bg-teal-50 text-teal-600 ring-teal-100", wash: "from-teal-50/80" },
  slate: { tile: "bg-slate-100 text-slate-600 ring-slate-200", wash: "from-slate-100/70" },
};

/** A 24-unit line icon at the card's size. */
export const statIcon = (paths: ReactNode, size = "h-[17px] w-[17px]") => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={size} aria-hidden>
    {paths}
  </svg>
);

/** The tinted square an icon sits in, on cards and section headers alike. */
export function IconTile({ hue, children, size = "md" }: { hue: Hue; children: ReactNode; size?: "sm" | "md" }) {
  return (
    <span className={`flex flex-shrink-0 items-center justify-center ring-1 ring-inset ${HUES[hue].tile} ${size === "sm" ? "h-7 w-7 rounded-lg" : "h-8 w-8 rounded-[10px]"}`}>{children}</span>
  );
}

// Hover lift shared by every card in this style.
export const CARD = "relative flex min-w-0 flex-col overflow-hidden rounded-[18px] border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-card)]";
export const CARD_HOVER = "transition-shadow hover:shadow-[0_1px_2px_rgba(15,23,42,0.04),0_14px_30px_-14px_rgba(15,23,42,0.2)]";

export function StatCard({
  label,
  hue,
  icon,
  hint,
  corner,
  wide,
  children,
  details,
}: {
  label: string;
  hue: Hue;
  icon: ReactNode;
  hint?: string;
  // A link or button at the header's right (the log, day by day).
  corner?: ReactNode;
  // The last card spans two columns below lg, so an odd count still fills the row.
  wide?: boolean;
  children: ReactNode;
  details?: ReactNode;
}) {
  return (
    <div title={hint} className={`${CARD} ${CARD_HOVER} p-3.5 sm:p-4 xl:p-3.5 2xl:p-4 ${wide ? "max-lg:col-span-2" : ""}`}>
      <div aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b ${HUES[hue].wash} to-transparent`} />
      <div className="relative flex items-center gap-2.5">
        <IconTile hue={hue}>{icon}</IconTile>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-[var(--color-ink)]">{label}</span>
        {corner && <span className="flex-shrink-0">{corner}</span>}
      </div>
      <div className="relative mt-4 flex min-w-0 flex-col">{children}</div>
      {details && (
        <dl className="relative mt-4 flex-1 space-y-1.5 rounded-xl bg-[var(--color-paper)] px-2.5 py-2.5 text-[12px] sm:px-3 sm:text-[12.5px] xl:px-2.5 xl:text-[12px] 2xl:px-3 2xl:text-[12.5px]">{details}</dl>
      )}
    </div>
  );
}

/**
 * A line on a card's panel: its name, and its figure on the right. On a
 * phone's narrow columns a long name takes a second line rather than being
 * cut. With `onClick` the line opens what's behind it (a member's log).
 */
export function StatRow({ label, hint, warn, ink, onClick, children }: { label: string; hint?: string; warn?: boolean; ink: string; onClick?: () => void; children: ReactNode }) {
  const body = (
    <>
      <dt className="flex min-w-0 items-baseline gap-1.5 text-[var(--color-muted)]">
        {warn && <span className="h-1.5 w-1.5 flex-shrink-0 -translate-y-px self-center rounded-full bg-amber-500" aria-hidden />}
        <span className="min-w-0 leading-snug sm:truncate">{label}</span>
      </dt>
      <dd className={`flex shrink-0 items-center gap-1 font-semibold tabular-nums ${warn ? "text-amber-600" : ink}`}>
        {children}
        {onClick && (
          <svg viewBox="0 0 24 24" fill="none" aria-hidden className="-mr-1 h-3.5 w-3.5 text-[var(--color-muted)] opacity-0 transition-opacity group-hover/row:opacity-100">
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </dd>
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} title={hint} className="group/row -mx-1.5 flex w-[calc(100%+12px)] items-baseline justify-between gap-2 rounded-lg px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--color-panel)]">
      {body}
    </button>
  ) : (
    <div className="flex items-baseline justify-between gap-2" title={hint}>
      {body}
    </div>
  );
}

/** 28px where a card has the room, 24px while four or five share a row on a laptop. */
export const FIGURE = "truncate text-[24px] font-semibold leading-none tracking-[-0.025em] tabular-nums sm:text-[28px] xl:text-[24px] 2xl:text-[28px]";
export const NOTE = "mt-2 truncate text-[12px] text-[var(--color-muted)]";

/** A section card's header: its icon, title, and what sits at the right. */
export function SectionHead({ hue, icon, title, sub, children }: { hue: Hue; icon: ReactNode; title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <IconTile hue={hue}>{icon}</IconTile>
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-semibold text-[var(--color-ink)]">{title}</h2>
          {sub && <p className="truncate text-[12px] text-[var(--color-muted)]">{sub}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

/** An empty state in the same language: a soft icon, a title, the why. */
export function EmptyCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className={`${CARD} items-center px-6 py-10 text-center`}>
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-paper)] text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)]">{icon}</span>
      <p className="mt-3.5 text-[14px] font-semibold text-[var(--color-ink)]">{title}</p>
      <div className="mx-auto mt-1.5 max-w-xl text-[12.5px] leading-relaxed text-[var(--color-muted)]">{children}</div>
    </div>
  );
}
