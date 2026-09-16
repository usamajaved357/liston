import Link from "next/link";

// The fixed bar above a full-screen editor: one row, one job per third —
// a way back on the left, what you're editing in the centre, the actions
// on the right. No product branding: the seller is inside a task.
//
// Everything in the centre sits on ONE line (title, then small chips
// inline). Stacking an eyebrow, a title and a stepper in here made a
// 64px bar look crammed; anything that needs its own line (a stepper,
// a subtitle) belongs in the page body.
export function EditorHeader({
  backHref,
  backLabel,
  title,
  chips,
  actions,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  chips?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="z-40 flex-shrink-0 border-b border-[var(--color-line)] bg-[var(--color-panel)]">
      <div className="grid h-14 grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 sm:px-6">
        <Link
          href={backHref}
          className="justify-self-start inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {backLabel}
        </Link>
        <div className="flex min-w-0 max-w-[56vw] items-center justify-center gap-2.5">
          <h1 className="truncate text-[15px] font-bold leading-none text-[var(--color-ink)]">{title}</h1>
          {chips && <div className="flex flex-shrink-0 items-center gap-1.5">{chips}</div>}
        </div>
        <div className="justify-self-end flex items-center gap-2">{actions}</div>
      </div>
    </header>
  );
}

// A horizontal progress row for multi-step pages. Lives in the body, not
// the header, so it has room to breathe and reads as part of the task.
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-3">
      {steps.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const active = n === current;
        return (
          <li key={label} className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2">
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                  done
                    ? "bg-[var(--color-accent)] text-white"
                    : active
                    ? "bg-[var(--color-primary)] text-white"
                    : "border border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-muted)]"
                }`}
              >
                {done ? "✓" : n}
              </span>
              <span className={`text-sm ${active ? "font-semibold text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>{label}</span>
            </span>
            {i < steps.length - 1 && <span className={`h-px w-10 ${done ? "bg-[var(--color-accent)]" : "bg-[var(--color-line)]"}`} />}
          </li>
        );
      })}
    </ol>
  );
}
