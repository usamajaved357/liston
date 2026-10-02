"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { useCurrentTeam } from "@/lib/useCurrentTeam";
import { useConnections } from "@/lib/useConnections";
import { homeFor } from "@/lib/team";
import { openFinder, setRailShown, useAccountsUnread, useRailShown } from "@/lib/rail";
import { ROLE_LABEL } from "@/components/AccountRail";

// The top of every sidebar: where this page is. On an account's pages the
// team (a link back to All accounts), the account and its eBay site; on the
// team's own pages the team and what the person is in it. Beside it the
// button that shows or hides the account rail, with a dot while the rail is
// hidden and another team or account has something unread; under it "Find
// an account", the finder (also Ctrl/Cmd+K), there with the rail hidden too.

const noChange = () => () => {};

export function SidebarHeader({ account }: { account?: { id: string; label: string; site?: string | null } }) {
  const { team, teams } = useCurrentTeam();
  const connections = useConnections();
  const unread = useAccountsUnread();
  const shown = useRailShown();
  // The finder's keys as this computer writes them (after the page is in the browser).
  const shortcut = useSyncExternalStore(
    noChange,
    () => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K"),
    () => "Ctrl K"
  );

  const elsewhere =
    teams.some((t) => t.id !== team?.id && t.unread > 0) || Object.entries(unread).some(([id, n]) => n > 0 && id !== account?.id);

  const toggle = (
    <button
      type="button"
      onClick={() => setRailShown(!shown)}
      aria-pressed={shown}
      aria-label={shown ? "Hide workspaces and accounts" : "Show workspaces and accounts"}
      title={shown ? "Hide workspaces and accounts" : "Show workspaces and accounts"}
      className={`relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-colors ${
        shown ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]" : "text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
      }`}
    >
      {/* A panel with its left column: the rail beside the sidebar. */}
      <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M9 4.5v15" stroke="currentColor" strokeWidth="1.8" />
        {shown ? <path d="M15.5 10l-2 2 2 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M13.5 10l2 2-2 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
      {!shown && elsewhere && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-[var(--color-panel)]" aria-label="Something unread in another workspace or account" />}
    </button>
  );

  // The finder, as a capsule.
  const find = (
    <button
      type="button"
      data-nav
      onClick={openFinder}
      className="mt-4 flex h-9 w-full items-center gap-2 rounded-full border border-[var(--color-line)] bg-[var(--color-paper)] pl-3 pr-1.5 text-left text-[13px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-panel)] hover:text-[var(--color-ink)]"
    >
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 flex-shrink-0" aria-hidden>
        <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <span className="min-w-0 flex-1 truncate">Find an account</span>
      <kbd className="hidden flex-shrink-0 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-px font-sans text-[10.5px] font-medium lg:inline">{shortcut}</kbd>
    </button>
  );

  if (!team) {
    return <div className="flex min-h-[44px] items-center justify-end">{toggle}</div>;
  }

  // A long name takes a second line rather than being cut short.
  const title = "line-clamp-2 text-[15px] font-bold leading-5 text-[var(--color-ink)] [overflow-wrap:anywhere]";

  if (account) {
    return (
      <div>
        <div className="flex min-h-[44px] items-start gap-2">
          <div className="min-w-0 flex-1 pl-2.5">
            <Link href={homeFor(team.role)} title={`${team.name}: Dashboard`} className="block truncate text-[11.5px] font-semibold leading-4 text-[var(--color-muted)] hover:text-[var(--color-primary)]">
              {team.name}
            </Link>
            <p className={`mt-0.5 ${title}`} title={account.label}>
              {account.label}
            </p>
            {account.site && <p className="mt-0.5 truncate text-[11.5px] leading-4 text-[var(--color-muted)]">{account.site}</p>}
          </div>
          {toggle}
        </div>
        {find}
      </div>
    );
  }

  const n = connections.length;
  return (
    <div>
      <div className="flex min-h-[44px] items-start gap-2">
        <div className="min-w-0 flex-1 pl-2.5">
          <p className={title} title={team.name}>
            {team.name}
          </p>
          <p className="mt-1 truncate text-[11.5px] leading-4 text-[var(--color-muted)]">{n ? `${ROLE_LABEL[team.role]} · ${n} eBay account${n === 1 ? "" : "s"}` : ROLE_LABEL[team.role]}</p>
        </div>
        {toggle}
      </div>
      {find}
    </div>
  );
}
