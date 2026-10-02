"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Connection, UserTeam } from "@/lib/api";
import { useConnections } from "@/lib/useConnections";
import { useCurrentTeam } from "@/lib/useCurrentTeam";
import { FIND_EVENT, useAccountsUnread } from "@/lib/rail";
import { AccountTile, initials, ROLE_LABEL, useRailActions } from "@/components/AccountRail";

// Find an account or a team by name: a box over the page, opened from the
// rail's Search, the search button at the top of the sidebar, or Ctrl/Cmd+K
// anywhere. Every account in the team with its full name, eBay site and
// unread messages, All accounts, every team the person is in, and Connect
// for an owner; typing narrows them (name, site or currency), the arrow keys
// move, Enter opens. An account keeps the section you're in, as on the rail.

type Row =
  | { key: string; kind: "home"; title: string; sub: string }
  | { key: string; kind: "account"; connection: Connection }
  | { key: string; kind: "team"; team: UserTeam }
  | { key: string; kind: "connect" };

// The text with the first place it matches the search in bold.
function Marked({ text, q }: { text: string; q: string }) {
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-amber-100 px-px text-inherit">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function AccountFinder() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const { team, teams } = useCurrentTeam();
  const connections = useConnections();
  const unread = useAccountsUnread();
  const { here, switching, openTeam, openAccount, connectAccount, home } = useRailActions();

  useEffect(() => {
    const show = () => {
      setQuery("");
      setActive(0);
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setQuery("");
        setActive(0);
        setOpen((v) => !v);
      }
    };
    window.addEventListener(FIND_EVENT, show);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(FIND_EVENT, show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const has = (...texts: (string | null | undefined)[]) => !q || texts.some((t) => String(t || "").toLowerCase().includes(q));
  const member = team?.role === "member";

  const accountRows: Row[] = [
    ...(has("All accounts", "Overview", "Dashboard", team?.name)
      ? [{ key: "home", kind: "home" as const, title: member ? "Dashboard" : "All accounts", sub: member ? "Your accounts in this workspace" : "Every account together, the workspace's Overview" }]
      : []),
    ...connections
      .filter((c) => has(c.label, c.marketplace?.name, c.marketplace?.label, c.marketplace?.currency, c.marketplace?.countryName))
      .map((c) => ({ key: c.id, kind: "account" as const, connection: c })),
  ];
  const teamRows: Row[] = teams.length > 1 ? teams.filter((t) => has(t.name, t.ownerName)).map((t) => ({ key: `team:${t.id}`, kind: "team" as const, team: t })) : [];
  const connectRow: Row[] = !member && has("Connect an eBay account", "add") ? [{ key: "connect", kind: "connect" }] : [];
  const rows = [...accountRows, ...teamRows, ...connectRow];
  const at = Math.min(active, Math.max(0, rows.length - 1));

  function close() {
    setOpen(false);
  }

  function pick(row: Row) {
    close();
    if (row.kind === "home") router.push(home);
    else if (row.kind === "account") openAccount(row.connection);
    else if (row.kind === "team") openTeam(row.team);
    else connectAccount();
  }

  function move(to: number) {
    const next = (to + rows.length) % rows.length;
    setActive(next);
    requestAnimationFrame(() => list.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" && rows.length) {
      e.preventDefault();
      move(at + 1);
    } else if (e.key === "ArrowUp" && rows.length) {
      e.preventDefault();
      move(at - 1);
    } else if (e.key === "Enter" && rows[at]) {
      e.preventDefault();
      pick(rows[at]);
    }
  }

  const caption = "px-4 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]";
  const rowClass = (i: number) => `flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${i === at ? "bg-[var(--color-primary-soft)]" : "hover:bg-[var(--color-paper)]"}`;
  const renderRow = (row: Row) => {
    const index = rows.indexOf(row);
    const common = { "data-row": index, onMouseMove: () => index !== at && setActive(index), onClick: () => pick(row), role: "option", "aria-selected": index === at } as const;
    if (row.kind === "home") {
      return (
        <button key={row.key} type="button" {...common} className={rowClass(index)}>
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary-soft)] text-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]/20" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" className="h-[17px] w-[17px]">
              <rect x="3.5" y="3.5" width="7" height="8" rx="1.8" stroke="currentColor" strokeWidth="1.8" />
              <rect x="13.5" y="3.5" width="7" height="5" rx="1.8" stroke="currentColor" strokeWidth="1.8" />
              <rect x="13.5" y="11.5" width="7" height="9" rx="1.8" stroke="currentColor" strokeWidth="1.8" />
              <rect x="3.5" y="14.5" width="7" height="6" rx="1.8" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold text-[var(--color-ink)]">{row.title}</span>
            <span className="block truncate text-[12px] text-[var(--color-muted)]">{row.sub}</span>
          </span>
          {!here && <span className="flex-shrink-0 text-[11.5px] font-medium text-[var(--color-muted)]">Open now</span>}
        </button>
      );
    }
    if (row.kind === "account") {
      const c = row.connection;
      const n = unread[c.id] || 0;
      const site = [c.marketplace?.name || c.platform_name, c.marketplace?.currency].filter(Boolean).join(" · ");
      return (
        <button key={row.key} type="button" {...common} className={rowClass(index)}>
          <AccountTile connection={c} size={36} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold text-[var(--color-ink)]">
              <Marked text={c.label} q={q} />
            </span>
            <span className="block truncate text-[12px] text-[var(--color-muted)]">
              <Marked text={site} q={q} />
              {c.status !== "active" ? " · Needs reconnecting" : ""}
            </span>
          </span>
          {c.id === here ? (
            <span className="flex-shrink-0 text-[11.5px] font-medium text-[var(--color-muted)]">Open now</span>
          ) : n > 0 ? (
            <span className="flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10.5px] font-bold tabular-nums text-white" aria-label={`${n} unread`}>
              {n > 99 ? "99+" : n}
            </span>
          ) : null}
        </button>
      );
    }
    if (row.kind === "team") {
      const t = row.team;
      const current = t.id === team?.id;
      return (
        <button key={row.key} type="button" {...common} disabled={Boolean(switching)} className={`${rowClass(index)} disabled:opacity-60`}>
          <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl text-[12px] font-bold ${current ? "bg-[var(--color-primary)] text-white" : "bg-[var(--color-panel)] text-[var(--color-ink)] ring-1 ring-inset ring-[var(--color-line)]"}`} aria-hidden>
            {initials(t.name, "T")}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold text-[var(--color-ink)]">
              <Marked text={t.name} q={q} />
            </span>
            <span className="block truncate text-[12px] text-[var(--color-muted)]">{t.role === "owner" ? "Your workspace" : `${ROLE_LABEL[t.role]} · ${t.ownerName}`}</span>
          </span>
          {current ? (
            <span className="flex-shrink-0 text-[11.5px] font-medium text-[var(--color-muted)]">This workspace</span>
          ) : switching === t.id ? (
            <span className="h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-primary)]" aria-label="Opening" />
          ) : t.unread > 0 ? (
            <span className="flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10.5px] font-bold tabular-nums text-white" aria-label={`${t.unread} unread`}>
              {t.unread > 99 ? "99+" : t.unread}
            </span>
          ) : null}
        </button>
      );
    }
    return (
      <button key={row.key} type="button" {...common} className={rowClass(index)}>
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-dashed border-[var(--color-line-strong)] text-[var(--color-muted)]" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        <span className="min-w-0 flex-1 text-[13.5px] font-semibold text-[var(--color-ink)]">Connect an eBay account</span>
      </button>
    );
  };

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/30 px-4 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-modal="true" aria-label="Find an account or workspace" className="flex max-h-[75vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-3 border-b border-[var(--color-line)] px-4">
          <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px] flex-shrink-0 text-[var(--color-muted)]" aria-hidden>
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search accounts and workspaces"
            aria-label="Find an account or workspace"
            role="combobox"
            aria-expanded="true"
            aria-controls="account-finder-list"
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
          />
          <button type="button" onClick={close} className="flex-shrink-0 rounded-md border border-[var(--color-line)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)]">
            Esc
          </button>
        </div>

        <div ref={list} id="account-finder-list" role="listbox" className="flex-1 overflow-y-auto overscroll-contain pb-2">
          {rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-[var(--color-muted)]">{`Nothing called "${query.trim()}" in your accounts or workspaces.`}</p>
          ) : (
            <>
              {accountRows.length > 0 && <p className={caption}>{`Accounts in ${team?.name || "this workspace"}`}</p>}
              {accountRows.map(renderRow)}
              {teamRows.length > 0 && <p className={caption}>Your workspaces</p>}
              {teamRows.map(renderRow)}
              {connectRow.length > 0 && <div className="mx-4 my-1.5 h-px bg-[var(--color-line)]" />}
              {connectRow.map(renderRow)}
            </>
          )}
        </div>

        <div className="hidden items-center gap-4 border-t border-[var(--color-line)] bg-[var(--color-paper)] px-4 py-2 text-[11.5px] text-[var(--color-muted)] sm:flex">
          <span>
            <kbd className="rounded border border-[var(--color-line)] bg-[var(--color-panel)] px-1 font-sans">↑</kbd> <kbd className="rounded border border-[var(--color-line)] bg-[var(--color-panel)] px-1 font-sans">↓</kbd> to move
          </span>
          <span>
            <kbd className="rounded border border-[var(--color-line)] bg-[var(--color-panel)] px-1 font-sans">Enter</kbd> to open
          </span>
          <span className="ml-auto">{`${isMac() ? "⌘K" : "Ctrl K"} opens this anywhere`}</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
