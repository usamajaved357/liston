import { ReactNode } from "react";

const FEATURES = [
  "Track competitor listings automatically",
  "Generate original titles, descriptions & images with AI",
  "Publish straight to your TikTok Shop",
];

interface AuthLayoutProps {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}

export function AuthLayout({ eyebrow, title, subtitle, children, footer }: AuthLayoutProps) {
  return (
    <main className="min-h-screen grid lg:grid-cols-2 bg-[var(--color-paper)]">
      <section className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-[var(--color-primary)] px-12 py-12 text-white">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            background:
              "radial-gradient(circle at 15% 15%, var(--color-accent) 0%, transparent 45%), radial-gradient(circle at 85% 85%, #1c4a74 0%, transparent 50%)",
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white text-sm font-semibold ring-1 ring-white/20">
            L
          </div>
          <span className="font-semibold tracking-tight">Liston</span>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            Turn competitor listings into your own, automatically.
          </h2>
          <p className="mt-4 text-[15px] text-white/70 leading-relaxed">
            Scrape, rewrite with AI, and publish across marketplaces — without lifting a finger
            for each listing.
          </p>
          <ul className="mt-8 space-y-3">
            {FEATURES.map((feature) => (
              <li key={feature} className="flex items-start gap-3 text-[15px] text-white/85">
                <svg
                  viewBox="0 0 20 20"
                  fill="none"
                  className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--color-accent)]"
                >
                  <circle cx="10" cy="10" r="10" fill="currentColor" opacity="0.2" />
                  <path
                    d="M6 10.5l2.5 2.5L14 7.5"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {feature}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-white/40">© {new Date().getFullYear()} Liston</p>
      </section>

      <section className="flex items-center justify-center px-4 py-12 sm:px-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center lg:text-left">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-[var(--color-primary)] text-white text-sm font-semibold mb-4 lg:hidden">
              L
            </div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-accent)] mb-1.5">
              {eyebrow}
            </p>
            <h1 className="text-[26px] font-semibold text-[var(--color-ink)] tracking-tight">{title}</h1>
            <p className="mt-1.5 text-[15px] text-[var(--color-muted)]">{subtitle}</p>
          </div>

          <div className="bg-[var(--color-panel)] p-6 sm:p-7 rounded-xl border border-[var(--color-line)] shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.12)]">
            {children}
          </div>

          <div className="mt-5 text-center text-sm text-[var(--color-muted)]">{footer}</div>
        </div>
      </section>
    </main>
  );
}
