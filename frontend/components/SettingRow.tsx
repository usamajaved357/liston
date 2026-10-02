"use client";

// The settings pages' pieces (Account, Workspace settings): two-column rows,
// what the setting is on the left and the control on the right, and the small
// tinted facts under a page's title.

export function SettingRow({ title, description, children, last }: { title: string; description: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`grid grid-cols-1 gap-3 px-5 py-4 md:grid-cols-[220px_minmax(0,1fr)] md:gap-6 ${last ? "" : "border-b border-[var(--color-line)]"}`}>
      <div>
        <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{title}</h2>
        <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-muted)]">{description}</p>
      </div>
      <div className="min-w-0 max-w-md">{children}</div>
    </div>
  );
}

// A fact at a glance: an icon, a word, a quiet tint.
const BADGE = {
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
  slate: "bg-slate-50 text-slate-600 ring-slate-200",
} as const;
const BADGE_ICON = {
  shield: <path d="M10 2.8l5.8 2.2v4.6c0 3.6-2.5 6.3-5.8 7.6-3.3-1.3-5.8-4-5.8-7.6V5L10 2.8z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
  check: <path d="M10 2.5l1.9 1.4 2.3-.2.8 2.2 1.9 1.4-.7 2.2.7 2.2-1.9 1.4-.8 2.2-2.3-.2L10 17.5l-1.9-1.4-2.3.2-.8-2.2-1.9-1.4.7-2.2-.7-2.2L5 5.9l.8-2.2 2.3.2L10 2.5zM7.3 10.2l1.8 1.8 3.6-3.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  alert: <path d="M10 3l7.5 13h-15L10 3zM10 8.5v3.2M10 14.2v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  calendar: <path d="M4 6.5A1.5 1.5 0 015.5 5h9A1.5 1.5 0 0116 6.5v8a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 014 14.5v-8zM4 8.5h12M7.5 3.5v3M12.5 3.5v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  spark: <path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6L10 3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
  store: <path d="M4 8.5V15a1 1 0 001 1h10a1 1 0 001-1V8.5M3.3 8.5l1.2-4a1 1 0 011-.7h9a1 1 0 011 .7l1.2 4a2.2 2.2 0 01-4.4 0 2.2 2.2 0 01-4.4 0 2.2 2.2 0 01-4.4 0z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
  people: <path d="M7.5 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM3 16c0-2.5 2-4.2 4.5-4.2S12 13.5 12 16M13.2 4.4a2.3 2.3 0 010 4.4M14.5 11.9c1.6.4 2.7 1.9 2.7 4.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
  key: <path d="M7.5 11.5a3.5 3.5 0 112.6-1.2l5.4 5.4M13 13l1.5-1.5M14.6 14.6l1.3-1.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
} as const;

export function InfoBadge({ tone, icon, children }: { tone: keyof typeof BADGE; icon: keyof typeof BADGE_ICON; children: React.ReactNode }) {
  return (
    <span className={`inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-semibold ring-1 ring-inset ${BADGE[tone]}`}>
      <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
        {BADGE_ICON[icon]}
      </svg>
      {children}
    </span>
  );
}
