import Link from "next/link";
import { Logo } from "@/components/Logo";

export function BackHeader({ backHref, backLabel }: { backHref: string; backLabel: string }) {
  return (
    <header className="border-b border-[var(--color-line)] bg-[var(--color-panel)]">
      <div className="px-10 py-5 grid grid-cols-[1fr_auto_1fr] items-center">
        <Link
          href={backHref}
          aria-label={backLabel}
          title={backLabel}
          className="justify-self-start flex h-9 w-9 items-center justify-center rounded-full border border-[var(--color-line)] text-[var(--color-muted)] hover:text-[var(--color-ink)] hover:border-[var(--color-accent)] transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
            <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <div className="flex items-center gap-2.5 justify-self-center">
          <Logo size={32} />
          <span className="font-semibold text-[var(--color-ink)]">Liston</span>
        </div>
        <div />
      </div>
    </header>
  );
}
