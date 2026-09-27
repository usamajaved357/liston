"use client";

import Link from "next/link";
import { User } from "@/lib/api";
import { Avatar } from "@/components/Avatar";

// The foot of a team member's sidebar on their Dashboard and Profile: who
// they are (opening their profile) and the way to log out.
export function MemberSidebarFooter({ user, onLogout }: { user: User; onLogout: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <Link href="/account" title="Your profile" className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 py-1 hover:bg-[var(--color-paper)]">
        <Avatar avatarUrl={user.avatar_url} size={30} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[12.5px] font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{user.name || user.email}</span>
          <span className="block truncate text-[11px] text-[var(--color-muted)]">Team member</span>
        </span>
      </Link>
      <button
        type="button"
        onClick={onLogout}
        title="Log out"
        aria-label="Log out"
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
          <path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4M15 8l4 4-4 4M19 12H9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
