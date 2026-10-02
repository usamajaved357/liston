"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/Logo";
import { useWorkClock } from "@/lib/useWorkClock";
import { NowPlaying } from "@/components/inbox/NowPlaying";
import { useCurrentTeam } from "@/lib/useCurrentTeam";
import { AccountRail } from "@/components/AccountRail";
import { AccountFinder } from "@/components/AccountFinder";
import { useRailShown } from "@/lib/rail";

// The frame both shells share: the sidebar beside the page on a laptop; on a
// phone or a portrait tablet (below lg) a slim bar with the logo and a menu
// button instead, the same sidebar sliding in over the page when it's
// opened. Following a link in it closes it. Every signed-in page is in it,
// so it also keeps a team member's time in Liston (useWorkClock; `member`
// from the shell, which knows who's signed in; a member with owner access
// is shown the owner's pages and still clocked), and shows a team chat voice
// note playing on while you're away from it (NowPlaying, at the top right).
// The account rail (teams and accounts, AccountRail) sits to the sidebar's
// left on every page when shown, and inside the phone's menu too; the
// account finder (AccountFinder, Ctrl/Cmd+K) is on every page.

export function ShellFrame({ sidebar, sidebarClassName = "gap-7", member = false, children }: { sidebar: React.ReactNode; sidebarClassName?: string; member?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { team } = useCurrentTeam();
  const rail = useRailShown();
  useWorkClock(member || team?.role === "owner_access");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const panel = `bg-[var(--color-panel)] p-4 flex flex-col ${sidebarClassName}`;
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden lg:flex-row">
      {rail && (
        <div className="hidden h-full lg:flex">
          <AccountRail />
        </div>
      )}
      <aside className={`hidden lg:flex w-[220px] flex-shrink-0 h-full overflow-y-auto overscroll-contain border-r border-[var(--color-line)] ${panel}`}>{sidebar}</aside>

      <div className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-panel)] px-2 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
          className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-ink)] hover:bg-[var(--color-paper)]"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <Logo size={26} />
        <span className="text-[15px] font-extrabold text-[var(--color-ink)]">Liston</span>
      </div>

      <NowPlaying />
      <AccountFinder />

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          {/* The rail, when shown, beside the sidebar; the sidebar's first row (where you are) stops short of the close button. */}
          <div
            className="absolute inset-y-0 left-0 flex max-w-[92vw] shadow-xl"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a, [data-nav]")) setOpen(false);
            }}
          >
          {rail && <AccountRail />}
          <aside className={`relative w-[260px] min-w-0 overflow-y-auto overscroll-contain [&>:nth-child(2)>:first-child]:mr-10 ${panel}`}>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            {sidebar}
          </aside>
          </div>
        </div>
      )}

      {children}
    </div>
  );
}
