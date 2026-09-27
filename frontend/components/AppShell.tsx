"use client";

import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { SidebarNavItem as NavItem } from "@/components/SidebarNavItem";
import { ShellFrame } from "@/components/ShellFrame";

interface AppShellProps {
  children: React.ReactNode;
  header?: React.ReactNode;
  // A row under the title (tabs, say) that stays put while the page
  // scrolls — the same slot AccountShell has.
  subheader?: React.ReactNode;
  connectionsUsed: number;
  maxConnections: number;
  planName: string;
  // Team management is owner-only — the nav item (and the page itself) is
  // hidden for a member, who never has a role other than "member" here.
  role?: "owner" | "member";
  // Access requests are reviewed only by the addresses in ADMIN_EMAILS.
  isAdmin?: boolean;
  // Pinned to the sidebar's foot (a member's name and Log out).
  sidebarFooter?: React.ReactNode;
}

// connectionsUsed / maxConnections / planName are accepted for compatibility
// with existing pages; the sidebar no longer shows plan usage.
export function AppShell({ children, header, subheader, role, isAdmin, sidebarFooter }: AppShellProps) {
  const pathname = usePathname();

  return (
    <ShellFrame
      sidebarClassName="gap-7"
      sidebar={
      <>
        <div className="flex items-center gap-2.5 px-2">
          <Logo size={30} />
          <span className="font-extrabold text-[15px] text-[var(--color-ink)]">Liston</span>
        </div>

        <nav className="flex flex-col gap-0.5">
          {/* Overview and Connections management are owner-only concepts — a
              member can't add/remove connections or touch policies, so in
              practice they never reach this shell at all (see /dashboard and
              the member branch of /connections). Gated here too as
              defense in depth against a brief render before those redirects
              land. */}
          {role !== "member" && (
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
          )}
          <NavItem
            href="/connections"
            active={pathname === "/connections"}
            label={role === "member" ? "Dashboard" : "Connections"}
            icon={
              role === "member" ? (
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <rect x="3" y="3" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="2" />
                  <rect x="14" y="3" width="7" height="5" rx="1.5" stroke="currentColor" strokeWidth="2" />
                  <rect x="14" y="12" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="2" />
                  <rect x="3" y="16" width="7" height="5" rx="1.5" stroke="currentColor" strokeWidth="2" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M12 3a14 14 0 010 18M12 3a14 14 0 000 18M3 12h18" stroke="currentColor" strokeWidth="1.4" />
                </svg>
              )
            }
          />
          {role === "member" && (
            <NavItem
              href="/account"
              active={pathname === "/account"}
              label="Profile"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <circle cx="12" cy="8.5" r="3.5" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M5 19.5c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              }
            />
          )}
          {role === "owner" && (
            <NavItem
              href="/team"
              active={pathname === "/team"}
              label="Team"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <circle cx="17" cy="8.5" r="2.3" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M15.5 14c2.5 0 5 1.6 5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              }
            />
          )}
          {isAdmin && (
            <NavItem
              href="/admin/usage"
              active={pathname === "/admin/usage"}
              label="eBay usage"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M4 19h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M7 16V10M12 16V6M17 16v-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              }
            />
          )}
          {isAdmin && (
            <NavItem
              href="/admin/access"
              active={pathname === "/admin/access"}
              label="Access requests"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6l7-3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              }
            />
          )}
        </nav>

        {sidebarFooter && <div className="mt-auto border-t border-[var(--color-line)] pt-3">{sidebarFooter}</div>}
      </>
      }
    >
      <div data-page-column className="flex-1 min-w-0 min-h-0 flex flex-col">
        {header && (
          <div className="page-header flex-shrink-0 bg-[var(--color-paper)]">
            {header}
            {subheader && <div className="mt-5">{subheader}</div>}
          </div>
        )}
        <div data-scroller className={`relative flex-1 min-h-0 overflow-y-auto overscroll-contain px-[var(--page-gutter)] ${header ? "pb-8" : "py-8"}`}>{children}</div>
      </div>
    </ShellFrame>
  );
}

