"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { usePathname } from "next/navigation";
import { Marketplace, User } from "@/lib/api";
import { AccountTimeZoneProvider } from "@/lib/timezone";
import { SyncStatus } from "@/components/SyncStatus";
import { SITE_TIMEZONES } from "@/components/orders/order-ui";
import { SidebarHeader } from "@/components/SidebarHeader";
import { SidebarFooter } from "@/components/SidebarFooter";
import { SidebarNavItem as NavItem } from "@/components/SidebarNavItem";
import { ShellFrame } from "@/components/ShellFrame";
import { NotificationBell } from "@/components/NotificationBell";
import { useAccountInboxBadge } from "@/lib/useInboxBadge";

interface AccountShellProps {
  children: React.ReactNode;
  header?: React.ReactNode;
  // A page's own controls for the header's right side (a Save button, say),
  // shown just left of the notifications bell so they line up.
  actions?: React.ReactNode;
  // A full-width row under the title (tabs, say) that stays put while the
  // page scrolls; it spans the same width as the content, so anything
  // aligned in it lines up with the cards below.
  subheader?: React.ReactNode;
  // A full-width row pinned under the scrolling body (paging, say).
  footer?: React.ReactNode;
  // Keep the footer pinned on phones too (an action bar), where a footer
  // otherwise follows the content.
  pinFooter?: boolean;
  // The page fills the space below the header and scrolls inside itself
  // (the Inbox's panes), instead of the whole body scrolling.
  fill?: boolean;
  connectionId: string;
  label: string;
  platformKey: string;
  platformName: string;
  // Kept for callers; the shell no longer displays it (the header does).
  status?: string;
  // The eBay site the account sells on, shown under the account name. Its
  // time zone is the clock every date on the account's pages reads in.
  marketplace?: Marketplace | null;
  // How fresh the page's copy of the eBay data is, with a re-read button:
  // shown at the top right, in the same place on every account page.
  sync?: { syncedAt: string | null; onRefresh: () => void; refreshing: boolean; note?: string | null };
  // Undefined for an owner (show every tab). For a team member, comes from
  // the connection's resolved `permissions` (see ConnectionPermissions in
  // lib/api.ts) — only tabs with `true` are shown. The backend enforces the
  // same gate on each route independently (see requireFeature), so this is
  // a UX nicety, not the security boundary.
  permissions?: Record<string, boolean>;
  // Who's viewing (a member's Log out is on their Dashboard and Profile).
  user: User;
}

// How many hunted products wait on this person: to review (reviewers and
// the owner), sent back to them (hunters), or, for someone who only drafts,
// approved and ready. Counted again whenever hunting changes on the page.
function useHuntBadge(connectionId: string, enabled: boolean, permissions?: Record<string, boolean>) {
  const [badge, setBadge] = useState(0);
  const listerOnly = Boolean(permissions && !permissions.hunting && !permissions.hunting_review);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      api
        .huntBadge(connectionId)
        .then((b) => !cancelled && setBadge(listerOnly ? b.approved : b.review + b.sentBack + (b.sourcing ?? 0)))
        .catch(() => {});
    load();
    window.addEventListener("liston:hunting", load);
    return () => {
      cancelled = true;
      window.removeEventListener("liston:hunting", load);
    };
  }, [connectionId, enabled, listerOnly]);
  return enabled ? badge : 0;
}

export function AccountShell({
  children,
  header,
  actions,
  subheader,
  footer,
  pinFooter = false,
  fill = false,
  connectionId,
  label,
  platformName,
  marketplace,
  permissions,
  sync,
  user,
}: AccountShellProps) {
  const timeZone = marketplace?.timeZone || (marketplace?.id ? SITE_TIMEZONES[marketplace.id] : undefined);
  const canShow = (feature: string) => permissions === undefined || permissions[feature];
  const pathname = usePathname();
  const base = `/accounts/${connectionId}`;
  const huntingAccess = canShow("hunting") || canShow("hunting_review") || canShow("listings");
  const huntBadge = useHuntBadge(connectionId, huntingAccess, permissions);
  const inboxBadge = useAccountInboxBadge(connectionId, canShow("inbox"));


  return (
    <AccountTimeZoneProvider value={timeZone}>
    <ShellFrame
      member={user.role === "member"}
      sidebarClassName="gap-6"
      sidebar={
      <>
        {/* Where this is (the team, the account and its site), and the button showing the teams and accounts rail. */}
        <SidebarHeader account={{ id: connectionId, label, site: marketplace ? `${marketplace.name} · ${marketplace.currency}` : platformName }} />

        <nav className="flex flex-col gap-0.5">
          {/* Every member has an Overview: their own work on the account
              (and the order queue with Orders access); an owner's has the money. */}
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
          {huntingAccess && (
            <NavItem
              href={`${base}/hunting`}
              active={pathname.startsWith(`${base}/hunting`)}
              label="Hunting"
              badge={huntBadge}
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.8" />
                  <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              }
            />
          )}
          {canShow("listings") && (
            <NavItem
              href={`${base}/research`}
              active={pathname.startsWith(`${base}/research`)}
              label="Research"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M15.5 15.5L20 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M7.5 12l2-2.5 2 1.5 2-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
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
          {/* The account's Inbox is its eBay messages (team chat is on the Dashboard's Inbox): with Inbox access. */}
          {canShow("inbox") && (
            <NavItem
              href={`${base}/inbox`}
              active={pathname.startsWith(`${base}/inbox`)}
              label="Inbox"
              badge={inboxBadge}
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
          {canShow("analytics") && (
            <NavItem
              href={`${base}/analytics`}
              active={pathname.startsWith(`${base}/analytics`)}
              label="Analytics"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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

        {/* Who's signed in, and Log out. */}
        <SidebarFooter />
      </>
      }
    >
      <div data-page-column className="flex-1 min-w-0 min-h-0 flex flex-col">
        {header && (
          <div className="page-header flex-shrink-0 bg-[var(--color-paper)]">
          {/* Title and controls both sit on the sidebar's logo line (see
              .page-header); the subtitle hangs below the title. */}
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1 basis-[220px]">{header}</div>
            {/* On a phone the controls take their own row under the title, on
                the right. The notifications bell is always the last thing on
                the right; All accounts is on the rail and the sidebar's team name. */}
            <div className="page-header-controls max-sm:w-full max-sm:justify-end">
              {sync && <SyncStatus syncedAt={sync.syncedAt} onRefresh={sync.onRefresh} refreshing={sync.refreshing} note={sync.note} />}
              {actions}
              <NotificationBell />
            </div>
          </div>
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
        {footer && (
          <div
            data-pinned-footer={pinFooter ? "" : undefined}
            className={`flex-shrink-0 border-t border-[var(--color-line)] bg-[var(--color-panel)] px-[var(--page-gutter)] ${pinFooter ? "shadow-[0_-8px_24px_-18px_rgba(15,23,42,0.35)]" : ""}`}
          >
            {footer}
          </div>
        )}
      </div>

    </ShellFrame>
    </AccountTimeZoneProvider>
  );
}
