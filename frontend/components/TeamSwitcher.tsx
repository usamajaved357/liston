"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { api, UserTeam } from "@/lib/api";
import { Logo } from "@/components/Logo";
import { useCurrentTeam } from "@/lib/useCurrentTeam";
import { homeFor, rememberTeam } from "@/lib/team";

// The top of every sidebar: the team this tab is in (Slack's workspace)
// and what the person is there, opening a menu of every team they're in,
// each with its unread notifications; picking one opens it (their
// Overview, or a member's Dashboard). A dot on the logo says another team
// has something unread.

const ROLE_LABEL: Record<UserTeam["role"], string> = { owner: "Owner", owner_access: "Owner access", member: "Team member" };

function TeamTile({ name, size = 32 }: { name: string; size?: number }) {
  const letters = name
    .replace(/'s team$/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <span
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      className="flex flex-shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-soft)] font-bold text-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]/15"
      aria-hidden
    >
      {letters || "T"}
    </span>
  );
}

export function TeamSwitcher() {
  const { team, teams } = useCurrentTeam();
  // Where the menu opens: under the button, drawn over the page so the sidebar doesn't clip it.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const open = at !== null;
  const [switching, setSwitching] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => setAt(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menu.current?.contains(e.target as Node) || button.current?.contains(e.target as Node)) return;
      setAt(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAt(null);
    const onMove = () => setAt(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  function toggle() {
    if (open) return setAt(null);
    const r = button.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 288)) });
  }

  const othersUnread = teams.filter((t) => t.id !== team?.id).reduce((n, t) => n + (t.unread || 0), 0);

  async function open_(target: UserTeam) {
    if (target.id === team?.id) {
      close();
      return;
    }
    setSwitching(target.id);
    try {
      const { team: picked } = await api.switchTeam(target.id);
      rememberTeam(picked.id);
      window.location.assign(homeFor(picked.role));
    } catch {
      setSwitching(null);
    }
  }

  // Before the profile is known: the brand, as before.
  if (!team) {
    return (
      <div className="flex items-center gap-2.5 px-2">
        <Logo size={30} />
        <span className="text-[15px] font-extrabold text-[var(--color-ink)]">Liston</span>
      </div>
    );
  }

  return (
    <div>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title={teams.length > 1 ? "Switch team" : team.name}
        className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-paper)]"
      >
        <span className="relative flex-shrink-0">
          <Logo size={30} />
          {othersUnread > 0 && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-[var(--color-panel)]" aria-label="Another team has unread notifications" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-bold leading-tight text-[var(--color-ink)]">{team.name}</span>
          <span className="block truncate text-[11px] leading-tight text-[var(--color-muted)]">{ROLE_LABEL[team.role]}</span>
        </span>
        <svg viewBox="0 0 20 20" fill="none" className={`h-4 w-4 flex-shrink-0 text-[var(--color-muted)] transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
          <path d="M6 8l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {at &&
        createPortal(
          <div ref={menu} role="menu" style={{ top: at.top, left: at.left }} className="fixed z-[70] w-[min(280px,calc(100vw-16px))] overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-pop)]">
            <p className="px-3.5 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Your teams</p>
            <div className="max-h-[min(360px,60vh)] overflow-y-auto pb-1">
              {teams.map((t) => {
                const here = t.id === team.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={here}
                    disabled={Boolean(switching)}
                    onClick={() => open_(t)}
                    className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors disabled:opacity-60 ${here ? "bg-[var(--color-primary-soft)]/50" : "hover:bg-[var(--color-paper)]"}`}
                  >
                    <TeamTile name={t.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-[var(--color-ink)]">{t.name}</span>
                      <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{t.role === "owner" ? "Your team" : `${ROLE_LABEL[t.role]} · ${t.ownerName}`}</span>
                    </span>
                    {switching === t.id ? (
                      <span className="h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-primary)]" aria-label="Opening" />
                    ) : here ? (
                      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 flex-shrink-0 text-[var(--color-primary)]" aria-label="This team">
                        <path d="M5 10.5l3.2 3.2L15 6.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : t.unread > 0 ? (
                      <span className="flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10.5px] font-bold tabular-nums text-white" aria-label={`${t.unread} unread`}>
                        {t.unread > 99 ? "99+" : t.unread}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {team.role !== "member" && (
              <Link href="/team" onClick={close} className="flex items-center gap-2 border-t border-[var(--color-line)] px-3.5 py-2.5 text-[12.5px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-paper)]">
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-[var(--color-muted)]" aria-hidden>
                  <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <circle cx="17" cy="8.5" r="2.3" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M15.5 14c2.5 0 5 1.6 5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                {team.role === "owner" ? "Team name and members" : "Team members"}
              </Link>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
