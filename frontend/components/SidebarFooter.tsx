"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ROLE_LABEL } from "@/components/AccountRail";
import { cacheUser, useCachedUser } from "@/lib/session";
import { useCurrentTeam } from "@/lib/useCurrentTeam";

// The foot of every sidebar: who's signed in (their photo, name and what
// they are in this workspace) and Log out, asked once before it happens.
// Their account settings are the sidebar's Settings, so this isn't a link.
export function SidebarFooter() {
  const router = useRouter();
  const user = useCachedUser();
  const { team } = useCurrentTeam();
  const [asking, setAsking] = useState(false);

  if (!user) return null;

  function logOut() {
    localStorage.removeItem("token");
    cacheUser(null);
    router.push("/login");
  }

  return (
    <div className="mt-auto -mx-1 border-t border-[var(--color-line)] pt-3">
      <div className="flex items-center gap-2.5 rounded-xl px-1.5 py-1">
        <Avatar avatarUrl={user.avatar_url} size={32} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[12.5px] font-semibold text-[var(--color-ink)]" title={user.email}>
            {user.name || user.email.split("@")[0]}
          </span>
          <span className="block truncate text-[11px] text-[var(--color-muted)]">{team ? ROLE_LABEL[team.role] : user.email}</span>
        </span>
        <button
          type="button"
          onClick={() => setAsking(true)}
          title="Log out"
          aria-label="Log out"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[var(--color-muted)] transition-colors hover:bg-rose-50 hover:text-rose-600"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-[17px] w-[17px]" aria-hidden>
            <path d="M10 4H6.5A2.5 2.5 0 004 6.5v11A2.5 2.5 0 006.5 20H10M15 8l4 4-4 4M19 12H9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <ConfirmDialog
        open={asking}
        title="Log out?"
        description="You'll need to log in again to use Liston on this device."
        confirmLabel="Log out"
        onCancel={() => setAsking(false)}
        onConfirm={logOut}
      />
    </div>
  );
}
