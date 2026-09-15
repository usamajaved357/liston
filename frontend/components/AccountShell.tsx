"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api, User } from "@/lib/api";
import { Logo } from "@/components/Logo";
import { PlatformIcon } from "@/components/PlatformIcon";
import { SidebarNavItem as NavItem } from "@/components/SidebarNavItem";
import { AccountMenu } from "@/components/AccountMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert } from "@/components/Alert";

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  expired: "bg-amber-50 text-amber-800 border-amber-200",
  error: "bg-red-50 text-red-700 border-red-200",
  suspended: "bg-red-50 text-red-700 border-red-200",
};

interface AccountShellProps {
  children: React.ReactNode;
  header?: React.ReactNode;
  connectionId: string;
  label: string;
  platformKey: string;
  platformName: string;
  status: string;
  // Undefined for an owner (show every tab). For a team member, comes from
  // the connection's resolved `permissions` (see ConnectionPermissions in
  // lib/api.ts) — only tabs with `true` are shown. The backend enforces the
  // same gate on each route independently (see requireFeature), so this is
  // a UX nicety, not the security boundary.
  permissions?: Record<string, boolean>;
  // Needed so this shell can offer a real, always-present way to log out —
  // every page under /accounts/[id]/* renders this shell and previously had
  // no logout affordance at all once inside a connection (a real gap for
  // everyone, but a dead end for a member with only one accessible account,
  // since "All connections" has nowhere useful to send them either).
  user: User;
}

export function AccountShell({
  children,
  header,
  connectionId,
  label,
  platformKey,
  platformName,
  status,
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

        <Link
          href="/connections"
          className="flex items-center gap-1.5 px-2 text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)] transition-colors"
        >
          ← {permissions === undefined ? "All connections" : "Your accounts"}
        </Link>

        <div className="flex items-center gap-2.5 rounded-lg bg-[var(--color-paper)] px-2.5 py-2.5">
          <PlatformIcon platformKey={platformKey} size={32} />
          <div className="min-w-0">
            <p className="text-sm font-bold text-[var(--color-ink)] truncate">{label}</p>
            <p className="text-[11px] text-[var(--color-muted)]">{platformName}</p>
          </div>
        </div>

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
                  <rect x="3" y="3" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="2" />
                  <rect x="14" y="3" width="7" height="5" rx="1.5" stroke="currentColor" strokeWidth="2" />
                  <rect x="14" y="12" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="2" />
                  <rect x="3" y="16" width="7" height="5" rx="1.5" stroke="currentColor" strokeWidth="2" />
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
                  <rect x="3.5" y="4" width="17" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
                  <rect x="3.5" y="10.5" width="17" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
                  <rect x="3.5" y="17" width="17" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
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
          )}
          {canShow("campaigns") && (
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
          )}
          {canShow("inbox") && (
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
                  <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
                  <path
                    d="M19.4 13.5a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.04 1.56V19.5a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.04-1.56 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.87 1.7 1.7 0 00-1.56-1.04H4.5a2 2 0 110-4h.09a1.7 1.7 0 001.56-1.04 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34H10.6A1.7 1.7 0 0011.5 4.5V4.4a2 2 0 114 0v.09a1.7 1.7 0 001.04 1.56 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87v.09a1.7 1.7 0 001.56 1.04h.09a2 2 0 110 4h-.09a1.7 1.7 0 00-1.56 1.04z"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinejoin="round"
                  />
                </svg>
              }
            />
          )}
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

      <div className="flex-1 min-w-0 h-screen flex flex-col">
        {header && (
          <div className="flex-shrink-0 flex items-start gap-4 px-10 pt-8 pb-6 bg-[var(--color-paper)]">
            <div className="flex-1 min-w-0">{header}</div>
            <AccountMenu
              email={user.email}
              subtitle={permissions === undefined ? "Owner" : "Team member"}
              avatarUrl={user.avatar_url}
              onLogout={() => setConfirmAction("logout")}
              onDeleteAccount={() => setConfirmAction("delete")}
            />
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
