"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api, User } from "@/lib/api";
import { Logo } from "@/components/Logo";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import { SidebarNavItem as NavItem } from "@/components/SidebarNavItem";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert } from "@/components/Alert";

interface AccountShellProps {
  children: React.ReactNode;
  header?: React.ReactNode;
  // A page's own controls for the header's right side (a Save button, say),
  // shown next to the Dashboard button so the two line up.
  actions?: React.ReactNode;
  // A full-width row under the title (tabs, say) that stays put while the
  // page scrolls; it spans the same width as the content, so anything
  // aligned in it lines up with the cards below.
  subheader?: React.ReactNode;
  connectionId: string;
  label: string;
  platformKey: string;
  platformName: string;
  // Kept for callers; the shell no longer displays it (the header does).
  status?: string;
  // The eBay site the account sells on, shown under the account name.
  marketplace?: { flag: string; label: string; currency: string; name: string } | null;
  // Undefined for an owner (show every tab). For a team member, comes from
  // the connection's resolved `permissions` (see ConnectionPermissions in
  // lib/api.ts) — only tabs with `true` are shown. The backend enforces the
  // same gate on each route independently (see requireFeature), so this is
  // a UX nicety, not the security boundary.
  permissions?: Record<string, boolean>;
  // A member has no other shell: their sidebar carries their identity, a way
  // back to their account list and the only logout they get.
  user: User;
}

export function AccountShell({
  children,
  header,
  actions,
  subheader,
  connectionId,
  label,
  platformKey,
  platformName,
  marketplace,
  permissions,
  user,
}: AccountShellProps) {
  const router = useRouter();
  const canShow = (feature: string) => permissions === undefined || permissions[feature];
  const pathname = usePathname();
  const base = `/accounts/${connectionId}`;
  const [confirmAction, setConfirmAction] = useState<"logout" | "delete" | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function handleLogout() {
    localStorage.removeItem("token");
    router.push("/login");
  }

  async function handleDeleteAccount() {
    setActionLoading(true);
    try {
      await api.deleteAccount();
      localStorage.removeItem("token");
      router.push("/login");
    } catch {
      setActionError("Couldn't remove your login. Try again.");
      setConfirmAction(null);
      setActionLoading(false);
    }
  }

  return (
    <div className="h-screen flex overflow-hidden">
      <aside className="w-[220px] flex-shrink-0 h-screen overflow-y-auto bg-[var(--color-panel)] border-r border-[var(--color-line)] p-4 flex flex-col gap-6">
        <div className="flex items-center gap-2.5 px-2">
          <Logo size={30} />
          <span className="font-extrabold text-[15px] text-[var(--color-ink)]">Liston</span>
        </div>

        <AccountSwitcher connectionId={connectionId} label={label} platformKey={platformKey} platformName={platformName} marketplace={marketplace} />

        <nav className="flex flex-col gap-0.5">
          {/* Overview's only content today is the Earnings widget, which is
              orders-derived — showing it (or landing a member here at all)
              when they have no Orders access just means an empty page, so
              gate it the same as the Orders tab itself. */}
          {canShow("orders") && (
            <NavItem
              href={base}
              active={pathname === base}
              label="Overview"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <rect x="3" y="3" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.8" />
                  <rect x="13" y="3" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.8" />
                  <rect x="3" y="13" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.8" />
                  <rect x="13" y="13" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.8" />
                </svg>
              }
            />
          )}
          {canShow("listings") && (
            <NavItem
              href={`${base}/listings`}
              active={pathname.startsWith(`${base}/listings`)}
              label="Listings"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M3.5 12.5V5.5a2 2 0 012-2h7l8 8-7 7-8-8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                </svg>
              }
            />
          )}
          {canShow("orders") && (
            <NavItem
              href={`${base}/orders`}
              active={pathname.startsWith(`${base}/orders`)}
              label="Orders"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M3.5 8L12 3.5 20.5 8v8L12 20.5 3.5 16V8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M3.5 8L12 12.5 20.5 8M12 12.5v8" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                </svg>
              }
            />
          )}
          {canShow("campaigns") && (
            <NavItem
              href={`${base}/campaigns`}
              active={pathname.startsWith(`${base}/campaigns`)}
              label="Campaigns"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M4 10.5v3a1.5 1.5 0 001.5 1.5H8l6 4V5L8 9H5.5A1.5 1.5 0 004 10.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M17.5 9.5a3.5 3.5 0 010 5M8 15v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              }
            />
          )}
          {canShow("inbox") && (
            <NavItem
              href={`${base}/inbox`}
              active={pathname.startsWith(`${base}/inbox`)}
              label="Inbox"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M4 6.5A1.5 1.5 0 015.5 5h13A1.5 1.5 0 0120 6.5v11a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5v-11z" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M4.5 7l7.5 5.5L19.5 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              }
            />
          )}
          {/* Connection Settings (business policies, shipping location) is always
              admin-only, never delegable — hidden outright for a member rather
              than shown then 403'd. */}
          {permissions === undefined && (
            <NavItem
              href={`${base}/settings`}
              active={pathname.startsWith(`${base}/settings`)}
              label="Settings"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h10M18 17h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <circle cx="16" cy="7" r="2" stroke="currentColor" strokeWidth="1.8" />
                  <circle cx="8" cy="12" r="2" stroke="currentColor" strokeWidth="1.8" />
                  <circle cx="16" cy="17" r="2" stroke="currentColor" strokeWidth="1.8" />
                </svg>
              }
            />
          )}
        </nav>

        {permissions !== undefined && (
          <div className="mt-auto space-y-1 border-t border-[var(--color-line)] pt-3">
            <Link href="/connections" className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Your accounts
            </Link>
            <button type="button" onClick={() => setConfirmAction("logout")} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                <path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4M15 8l4 4-4 4M19 12H9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Log out
            </button>
            <p className="truncate px-2.5 pt-1 text-[11px] text-[var(--color-muted)]">{user.email}</p>
          </div>
        )}
      </aside>

      <div className="flex-1 min-w-0 h-screen flex flex-col">
        {header && (
          <div className="page-header flex-shrink-0 bg-[var(--color-paper)]">
          {/* Title and controls both sit on the sidebar's logo line (see
              .page-header); the subtitle hangs below the title. */}
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">{header}</div>
            <div className="page-header-controls">
              {actions}
              {/* Owners came from the main dashboard; members have no dashboard,
                  their way out is the sidebar footer. */}
              {permissions === undefined && (
                <Link href="/dashboard" className="btn btn-sm flex-shrink-0 bg-[var(--color-primary-soft)] font-semibold text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white">
                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                    <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Dashboard
                </Link>
              )}
            </div>
          </div>
          {subheader && <div className="mt-5">{subheader}</div>}
          </div>
        )}
        <div className={`flex-1 min-h-0 overflow-y-auto px-10 ${header ? "pb-8" : "py-8"}`}>
          {actionError && (
            <div className="mb-4">
              <Alert>{actionError}</Alert>
            </div>
          )}
          {children}
        </div>
      </div>

      <ConfirmDialog
        open={confirmAction === "logout"}
        title="Log out?"
        description="You'll need to log in again to get back here."
        confirmLabel="Log out"
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleLogout}
      />
      <ConfirmDialog
        open={confirmAction === "delete"}
        title="Remove your login?"
        description={
          permissions === undefined
            ? "This permanently deletes your account, connections, and listing data. This action cannot be undone."
            : "This removes your own team-member login. It doesn't affect the accounts or data owned by whoever gave you access."
        }
        confirmLabel={permissions === undefined ? "Delete account" : "Remove my login"}
        danger
        loading={actionLoading}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleDeleteAccount}
      />
    </div>
  );
}
