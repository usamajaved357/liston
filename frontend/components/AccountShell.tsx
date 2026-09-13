"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { PlatformIcon } from "@/components/PlatformIcon";
import { SidebarNavItem as NavItem } from "@/components/SidebarNavItem";

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  expired: "bg-amber-50 text-amber-800 border-amber-200",
  error: "bg-red-50 text-red-700 border-red-200",
  suspended: "bg-red-50 text-red-700 border-red-200",
};

interface AccountShellProps {
  children: React.ReactNode;
  connectionId: string;
  label: string;
  platformKey: string;
  platformName: string;
  status: string;
}

export function AccountShell({ children, connectionId, label, platformKey, platformName, status }: AccountShellProps) {
  const pathname = usePathname();
  const base = `/accounts/${connectionId}`;

  return (
    <div className="min-h-screen flex">
      <aside className="w-[220px] flex-shrink-0 bg-[var(--color-panel)] border-r border-[var(--color-line)] p-4 flex flex-col gap-6">
        <div className="flex items-center gap-2.5 px-2">
          <Logo size={30} />
          <span className="font-extrabold text-[15px] text-[var(--color-ink)]">Liston</span>
        </div>

        <Link
          href="/connections"
          className="flex items-center gap-1.5 px-2 text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)] transition-colors"
        >
          ← All connections
        </Link>

        <div className="flex items-center gap-2.5 rounded-lg bg-[var(--color-paper)] px-2.5 py-2.5">
          <PlatformIcon platformKey={platformKey} size={32} />
          <div className="min-w-0">
            <p className="text-sm font-bold text-[var(--color-ink)] truncate">{label}</p>
            <p className="text-[11px] text-[var(--color-muted)]">{platformName}</p>
          </div>
        </div>

        <nav className="flex flex-col gap-0.5">
          <NavItem
            href={base}
            active={pathname === base}
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
            href={`${base}/listings`}
            active={pathname.startsWith(`${base}/listings`)}
            label="Listings"
            icon={
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                <rect x="3.5" y="4" width="17" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
                <rect x="3.5" y="10.5" width="17" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
                <rect x="3.5" y="17" width="17" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            }
          />
          <NavItem
            href={`${base}/orders`}
            active={pathname.startsWith(`${base}/orders`)}
            label="Orders"
            icon={
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                <path
                  d="M6 3h12l1 5H5l1-5z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
                <path d="M5 8h14v11a2 2 0 01-2 2H7a2 2 0 01-2-2V8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                <path d="M9 12a3 3 0 006 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            }
          />
          <NavItem
            href={`${base}/campaigns`}
            active={pathname.startsWith(`${base}/campaigns`)}
            label="Campaigns"
            icon={
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                <path d="M3 10v4a1 1 0 001 1h2l7 4V5L6 9H4a1 1 0 00-1 1z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                <path d="M17 9a3 3 0 010 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            }
          />
          <NavItem
            href={`${base}/inbox`}
            active={pathname.startsWith(`${base}/inbox`)}
            label="Inbox"
            icon={
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                <path
                  d="M3.5 6.5h17v11a1.5 1.5 0 01-1.5 1.5h-14A1.5 1.5 0 013.5 17.5v-11z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
                <path d="M3.5 6.5l8.5 6 8.5-6" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              </svg>
            }
          />
        </nav>

        <div className="mt-auto rounded-lg bg-[var(--color-paper)] p-3 flex flex-col gap-1.5">
          <span className="text-[10.5px] font-bold uppercase tracking-wide text-[var(--color-muted)]">Status</span>
          <span
            className={`inline-flex w-fit rounded-full border px-2 py-0.5 text-[11px] font-bold capitalize ${
              STATUS_STYLES[status] || STATUS_STYLES.error
            }`}
          >
            {status}
          </span>
        </div>
      </aside>

      <div className="flex-1 min-w-0">
        <div className="px-10 py-8">{children}</div>
      </div>
    </div>
  );
}
