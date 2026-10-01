"use client";

import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { SidebarNavItem as NavItem } from "@/components/SidebarNavItem";
import { ShellFrame } from "@/components/ShellFrame";
import { useInboxBadge } from "@/lib/useInboxBadge";

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
  // The page fills the space below the header and scrolls inside itself (the Inbox).
  fill?: boolean;
}

// connectionsUsed / maxConnections / planName are accepted for compatibility
// with existing pages; the sidebar no longer shows plan usage.
export function AppShell({ children, header, subheader, role, isAdmin, sidebarFooter, fill = false }: AppShellProps) {
  const pathname = usePathname();
  const inboxBadge = useInboxBadge();

  return (
    <ShellFrame
      member={role === "member"}
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
            label={role === "member" ? "Dashboard" : "Marketplace"}
            icon={
              role === "member" ? (
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <rect x="3" y="3" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="2" />
                  <rect x="14" y="3" width="7" height="5" rx="1.5" stroke="currentColor" strokeWidth="2" />
                  <rect x="14" y="12" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="2" />
                  <rect x="3" y="16" width="7" height="5" rx="1.5" stroke="currentColor" strokeWidth="2" />
                </svg>
              ) : (
                // A shop front: the marketplaces Liston sells on.
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M4 9.5V19a1 1 0 001 1h14a1 1 0 001-1V9.5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M3 9.5L4.6 4.7A1 1 0 015.5 4h13a1 1 0 01.9.7L21 9.5a3 3 0 01-6 0 3 3 0 01-6 0 3 3 0 01-6 0z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M9.5 20v-5a1 1 0 011-1h3a1 1 0 011 1v5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                </svg>
              )
            }
          />
          {/* The Inbox: team chat for everyone, and every account's eBay messages. */}
          <NavItem
            href="/inbox"
            active={pathname === "/inbox"}
            label="Inbox"
            badge={inboxBadge}
            icon={
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                <path d="M4 6.5A1.5 1.5 0 015.5 5h13A1.5 1.5 0 0120 6.5v11a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5v-11z" stroke="currentColor" strokeWidth="1.8" />
                <path d="M4.5 7l7.5 5.5L19.5 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
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
        <div
          data-scroller
          data-fill={fill ? "" : undefined}
          className={`relative flex-1 min-h-0 px-[var(--page-gutter)] ${fill ? "flex flex-col overflow-hidden pb-2" : `overflow-y-auto overscroll-contain ${header ? "pb-8" : "py-8"}`}`}
        >
          {children}
        </div>
      </div>
    </ShellFrame>
  );
}

