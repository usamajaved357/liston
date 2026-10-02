import { ReactNode } from "react";

// A part of a Settings tab: its heading and a line on what it is (an action
// such as "Add" beside them), above the card that holds it.

/** A part of the page: its heading (and an action beside it) above what it holds. */
export function SettingsSection({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-0.5">
        <div className="min-w-[220px] flex-1">
          <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--color-muted)]">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
