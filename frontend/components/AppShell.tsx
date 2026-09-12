"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";

interface NavItemProps {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
}

function NavItem({ href, active, icon, label }: NavItemProps) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-[var(--color-primary)]/5 text-[var(--color-primary)]"
          : "text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
      }`}
    >
      {icon}
      {label}
    </Link>
  );
}

interface AppShellProps {
  children: React.ReactNode;
  connectionsUsed: number;
  maxConnections: number;
  planName: string;
}

export function AppShell({ children, connectionsUsed, maxConnections, planName }: AppShellProps) {
  const pathname = usePathname();
  const connectionsPct = maxConnections ? Math.min(100, (connectionsUsed / maxConnections) * 100) : 0;

  return (
    <div className="min-h-screen flex">
      <aside className="w-[220px] flex-shrink-0 bg-[var(--color-panel)] border-r border-[var(--color-line)] p-4 flex flex-col gap-7">
        <div className="flex items-center gap-2.5 px-2">
          <Logo size={30} />
          <span className="font-extrabold text-[15px] text-[var(--color-ink)]">Liston</span>
        </div>

        <nav className="flex flex-col gap-0.5">
          <NavItem
            href="/dashboard"
            active={pathname === "/dashboard"}
            label="Overview"
            icon={
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                <rect x="3" y="3" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="2" />
                <rect x="14" y="3" width="7" height="5" rx="1.5" stroke="currentColor" strokeWidth="2" />
                <rect x="14" y="12" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="2" />
                <rect x="3" y="16" width="7" height="5" rx="1.5" stroke="currentColor" strokeWidth="2" />
              </svg>
            }
          />
          <NavItem
            href="/connections"
            active={pathname === "/connections"}
            label="Connections"
            icon={
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
                <path d="M12 3a14 14 0 010 18M12 3a14 14 0 000 18M3 12h18" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            }
          />
          <NavItem
            href="/settings"
            active={pathname === "/settings"}
            label="Settings"
            icon={
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                <path
                  d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            }
          />
        </nav>

        <div className="mt-auto rounded-lg bg-[var(--color-paper)] p-3 flex flex-col gap-1">
          <span className="text-[10.5px] font-bold uppercase tracking-wide text-[var(--color-accent)]">
            {planName} plan
          </span>
          <div className="h-1 rounded-full bg-[var(--color-line)] overflow-hidden">
            <div className="h-full bg-[var(--color-accent)]" style={{ width: `${connectionsPct}%` }} />
          </div>
          <span className="text-[10.5px] text-[var(--color-muted)]">
            {connectionsUsed} of {maxConnections} connections used
          </span>
        </div>
      </aside>

      <div className="flex-1 min-w-0">
        <div className="px-10 py-8">{children}</div>
      </div>
    </div>
  );
}
