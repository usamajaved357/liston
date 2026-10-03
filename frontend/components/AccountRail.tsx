"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api, Connection, UserTeam } from "@/lib/api";
import { useConnections } from "@/lib/useConnections";
import { useCurrentTeam } from "@/lib/useCurrentTeam";
import { homeFor, rememberTeam } from "@/lib/team";
import { useAccountsUnread } from "@/lib/rail";
import { landingPathForConnection, sectionAllowed } from "@/lib/permissions";

// The account rail: a slim column to the left of the sidebar, the way Slack
// shows workspaces. At the top the team this tab is in, which opens the
// switch to the person's other workspaces (with their unread); under it the
// Dashboard (the workspace's Overview, or a member's Dashboard), then each
// eBay account in the workspace with its name, site and unread messages (the
// only part that scrolls, so a workspace with many accounts keeps the rest in
// place), and for an owner Add at the foot to connect another. One click goes anywhere; an account keeps
// the section you're in (Orders stays Orders) where you can open it. Shown or
// hidden from the button at the top of the sidebar; the account finder
// (Ctrl/Cmd+K, "Find an account" in the sidebar) searches them by name.

// What the person is in a workspace: its owner, a co-manager (owner access: everything the owner has), or a member.
export const ROLE_LABEL: Record<UserTeam["role"], string> = { owner: "Workspace owner", owner_access: "Co-manager", member: "Member" };

export function initials(name: string, fallback: string) {
  const letters = name
    .replace(/'s (team|workspace)$/i, "")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return letters || fallback;
}

// Each account keeps its own colour wherever it's drawn, whatever its place in the list.
const TINTS = [
  "bg-sky-100 text-sky-800",
  "bg-emerald-100 text-emerald-800",
  "bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-800",
  "bg-violet-100 text-violet-800",
  "bg-teal-100 text-teal-800",
  "bg-orange-100 text-orange-800",
  "bg-fuchsia-100 text-fuchsia-800",
];
export function tintFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}

const count = (n: number) => (n > 99 ? "99+" : String(n));

/**
 * An account's circle: its eBay store's logo, the way eBay draws it on the
 * store page (its initials in its colour while it has none, or if the logo
 * won't load), its eBay site in the corner.
 */
export function AccountTile({ connection, size = 40 }: { connection: Connection; size?: number }) {
  const site = connection.marketplace?.label;
  const [broken, setBroken] = useState<string | null>(null);
  const logo = connection.logo_url && connection.logo_url !== broken ? connection.logo_url : null;
  return (
    <span
      style={{ width: size, height: size, fontSize: Math.round(size * 0.33) }}
      className={`relative flex flex-shrink-0 items-center justify-center rounded-full font-bold ${logo ? "bg-white" : tintFor(connection.id)}`}
      aria-hidden
    >
      {logo ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(logo)} className="h-full w-full rounded-full object-cover" />
          <span className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ring-black/[0.08]" />
        </>
      ) : (
        initials(connection.label, "A")
      )}
      {site && (
        <span className="absolute -bottom-1 -right-1.5 rounded-[5px] bg-[var(--color-panel)] px-[3px] text-[9px] font-bold leading-[13px] tracking-wide text-[var(--color-muted)] ring-1 ring-[var(--color-line)]">
          {site}
        </span>
      )}
      {connection.status !== "active" && <span className="absolute -left-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-[var(--color-paper)]" />}
    </span>
  );
}

/** Opening a team, an account or the connect panel, the same from the rail and the finder. */
export function useRailActions() {
  const router = useRouter();
  const pathname = usePathname();
  const { team } = useCurrentTeam();
  const [switching, setSwitching] = useState<string | null>(null);
  const here = pathname.match(/^\/accounts\/([^/]+)/)?.[1] || null;

  async function openTeam(target: UserTeam) {
    if (target.id === team?.id) return router.push(homeFor(target.role));
    setSwitching(target.id);
    try {
      const { team: picked } = await api.switchTeam(target.id);
      rememberTeam(picked.id);
      window.location.assign(homeFor(picked.role));
    } catch {
      setSwitching(null);
    }
  }

  // Same section, other account: /accounts/<id>/orders?x -> /accounts/<other>/orders.
  function openAccount(target: Connection) {
    if (target.id === here) return;
    const section = here ? pathname.replace(/^\/accounts\/[^/]+/, "").split("/")[1] || "" : "";
    const keep = ["hunting", "research", "listings", "orders", "analytics", "campaigns", "inbox", "settings"].includes(section) ? `/${section}` : "";
    router.push(sectionAllowed(target, section) ? `/accounts/${target.id}${keep}` : landingPathForConnection(target));
  }

  // The owner's Marketplace page with its "Add an account" panel open.
  function connectAccount() {
    if (pathname === "/connections") window.dispatchEvent(new Event("liston:add-account"));
    else router.push("/connections?add=1");
  }

  return { here, switching, openTeam, openAccount, connectAccount, home: homeFor(team?.role) };
}

// The full name beside a tile while it's pointed at or focused, drawn over the page.
function useTip() {
  const [tip, setTip] = useState<{ top: number; left: number; title: string; sub?: string } | null>(null);
  const bind = (title: string, sub?: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(e.currentTarget, title, sub),
    onFocus: (e: React.FocusEvent<HTMLElement>) => show(e.currentTarget, title, sub),
    onMouseLeave: () => setTip(null),
    onBlur: () => setTip(null),
  });
  function show(el: HTMLElement, title: string, sub?: string) {
    // Only with a mouse: a phone's tap would leave it standing over the menu.
    if (!window.matchMedia("(hover: hover)").matches) return;
    const r = el.getBoundingClientRect();
    setTip({ top: r.top + 22, left: r.right + 6, title, sub });
  }
  const node =
    tip &&
    createPortal(
      <div role="tooltip" style={{ top: tip.top, left: tip.left }} className="pointer-events-none fixed z-[80] max-w-[260px] -translate-y-1/2 rounded-lg bg-[var(--color-ink)] px-2.5 py-1.5 text-white shadow-[var(--shadow-pop)]">
        <p className="truncate text-[12.5px] font-semibold leading-4">{tip.title}</p>
        {tip.sub && <p className="mt-0.5 truncate text-[11px] leading-4 text-white/70">{tip.sub}</p>}
      </div>,
      document.body
    );
  return { bind, node, hide: () => setTip(null) };
}

// The bar at the rail's left edge beside where you are (Slack's pill).
function Here({ on }: { on: boolean }) {
  return <span aria-hidden className={`absolute left-0 top-5 w-1 -translate-y-1/2 rounded-r-full bg-[var(--color-ink)] transition-all ${on ? "h-6" : "h-0"}`} />;
}

function Badge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="absolute -right-1.5 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold tabular-nums text-white ring-2 ring-[var(--color-paper)]" aria-hidden>
      {count(n)}
    </span>
  );
}

// One place on the rail: its tile with its name under it.
const ITEM = "group relative flex w-full flex-col items-center gap-1.5 px-1.5 outline-none disabled:opacity-60";
const TILE = "relative flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[13px] font-bold transition-all group-focus-visible:ring-2 group-focus-visible:ring-[var(--color-primary)]";
const NAME = (on: boolean) => `line-clamp-2 w-full text-center text-[10.5px] leading-[13px] [overflow-wrap:anywhere] ${on ? "font-semibold text-[var(--color-ink)]" : "text-[var(--color-muted)] group-hover:text-[var(--color-ink)]"}`;
const CAPTION = "w-full text-center text-[9.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]";

// The top of the rail: the team this tab is in as a tile with its name, and
// the switch to every team the person is in, drawn beside the rail. A
// count on the tile says another team has something unread.
function TeamSwitch() {
  const { team, teams } = useCurrentTeam();
  const { switching, openTeam } = useRailActions();
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const open = at !== null;
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menu.current?.contains(e.target as Node) || button.current?.contains(e.target as Node)) return;
      setAt(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAt(null);
    const onResize = () => setAt(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  function toggle() {
    if (open) return setAt(null);
    const r = button.current?.getBoundingClientRect();
    if (r) setAt({ top: r.top, left: Math.min(r.right + 8, window.innerWidth - 296) });
  }

  if (!team) return <div className="h-[104px] flex-shrink-0 border-b border-[var(--color-line)]" />;

  const othersUnread = teams.filter((t) => t.id !== team.id).reduce((n, t) => n + (t.unread || 0), 0);

  return (
    <div className="flex-shrink-0 border-b border-[var(--color-line)] px-1.5 pb-3 pt-3.5">
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${team.name}, ${ROLE_LABEL[team.role]}. Switch workspace${othersUnread ? `, ${othersUnread} unread in your other workspaces` : ""}`}
        className="group flex w-full flex-col items-center gap-1.5 outline-none"
      >
        <span
          className={`relative flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-primary)] text-[15px] font-bold text-white shadow-[0_6px_16px_-6px_rgba(79,70,229,0.6)] transition-all group-hover:-translate-y-px group-hover:shadow-[0_8px_18px_-6px_rgba(79,70,229,0.7)] group-focus-visible:ring-2 group-focus-visible:ring-[var(--color-primary)] group-focus-visible:ring-offset-2 ${
            open ? "ring-2 ring-[var(--color-primary)]/30 ring-offset-2 ring-offset-[var(--color-paper)]" : ""
          }`}
        >
          {initials(team.name, "T")}
          <Badge n={othersUnread} />
          {/* The switch: up and down, the way a picker is marked. */}
          <span className="absolute -bottom-1 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-panel)] text-[var(--color-muted)] shadow-sm ring-1 ring-[var(--color-line)] transition-colors group-hover:text-[var(--color-primary)]" aria-hidden>
            <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3">
              <path d="M6.5 8l3.5-3.5L13.5 8M6.5 12l3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
        <span className="line-clamp-2 w-full text-center text-[11px] font-semibold leading-[13px] text-[var(--color-ink)] [overflow-wrap:anywhere]">{team.name}</span>
      </button>

      {at &&
        createPortal(
          <div ref={menu} role="menu" style={{ top: at.top, left: at.left }} className="fixed z-[70] w-[min(288px,calc(100vw-16px))] overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-pop)]">
            <p className="px-3.5 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Switch workspace</p>
            <div className="max-h-[min(360px,60vh)] overflow-y-auto pb-1">
              {teams.map((t) => {
                const current = t.id === team.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={current}
                    disabled={Boolean(switching)}
                    onClick={() => (current ? setAt(null) : openTeam(t))}
                    className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors disabled:opacity-60 ${current ? "bg-[var(--color-primary-soft)]/60" : "hover:bg-[var(--color-paper)]"}`}
                  >
                    <span
                      className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${
                        current ? "bg-[var(--color-primary)] text-white" : "bg-[var(--color-primary-soft)] text-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]/15"
                      }`}
                      aria-hidden
                    >
                      {initials(t.name, "T")}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-[var(--color-ink)]">{t.name}</span>
                      <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{t.role === "owner" ? "Your workspace" : `${ROLE_LABEL[t.role]} · ${t.ownerName}`}</span>
                    </span>
                    {switching === t.id ? (
                      <span className="h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-primary)]" aria-label="Opening" />
                    ) : current ? (
                      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 flex-shrink-0 text-[var(--color-primary)]" aria-label="This workspace">
                        <path d="M5 10.5l3.2 3.2L15 6.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : t.unread > 0 ? (
                      <span className="flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10.5px] font-bold tabular-nums text-white" aria-label={`${t.unread} unread`}>
                        {count(t.unread)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {teams.length < 2 && <p className="border-t border-[var(--color-line)] px-3.5 py-2.5 text-[12px] leading-snug text-[var(--color-muted)]">When another workspace owner adds you to their workspace, it shows here.</p>}
            {/* Workspace settings (its name, people, accounts, deleting it): its owner's alone. */}
            {team.role === "owner" && (
              <Link href="/workspace" onClick={() => setAt(null)} className="flex items-center gap-2.5 border-t border-[var(--color-line)] px-3.5 py-2.5 text-[12.5px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-paper)]">
                <span className="text-[var(--color-muted)]">{SETTINGS_ICON}</span>
                Workspace settings
              </Link>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}

// Whether a list scrolls on past its top or bottom edge, for the fades that say so.
function useScrollEdges() {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    const next = { top: el.scrollTop > 2, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 2 };
    setEdges((e) => (e.top === next.top && e.bottom === next.bottom ? e : next));
  };
  useEffect(() => {
    // Measured when the list or the window changes size (accounts arriving, say).
    const watch = new ResizeObserver(() => measure());
    if (scroller.current) watch.observe(scroller.current);
    if (content.current) watch.observe(content.current);
    return () => watch.disconnect();
  }, []);
  return { scroller, content, edges, measure };
}

// Settings: three sliders (the account's Settings tab draws the same).
export const SETTINGS_ICON = (
  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
    <path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h10M18 17h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="16" cy="7" r="2" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="8" cy="12" r="2" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="16" cy="17" r="2" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

export const DASHBOARD_ICON = (
  <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
    <rect x="3.5" y="3.5" width="7" height="8" rx="1.8" stroke="currentColor" strokeWidth="1.8" />
    <rect x="13.5" y="3.5" width="7" height="5" rx="1.8" stroke="currentColor" strokeWidth="1.8" />
    <rect x="13.5" y="11.5" width="7" height="9" rx="1.8" stroke="currentColor" strokeWidth="1.8" />
    <rect x="3.5" y="14.5" width="7" height="6" rx="1.8" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

export function AccountRail() {
  const { team } = useCurrentTeam();
  const connections = useConnections();
  const unread = useAccountsUnread();
  const { here, openAccount, connectAccount, home } = useRailActions();
  const { bind, node, hide } = useTip();
  const { scroller, content, edges, measure } = useScrollEdges();
  const role = team?.role;

  return (
    <nav aria-label="Workspaces and accounts" className="flex h-full w-[76px] flex-shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-paper)]">
      {/* The workspace this tab is in, switching to the person's other workspaces. */}
      <TeamSwitch />

      {/* The Dashboard: the workspace's Overview of every account (a member's Dashboard). */}
      <div className="flex-shrink-0 border-b border-[var(--color-line)] py-3">
        <Link
          href={home}
          onClick={hide}
          aria-label="Dashboard"
          aria-current={!here ? "page" : undefined}
          {...bind("Dashboard", role === "member" ? `Your accounts in ${team?.name || "this workspace"}` : `Every account in ${team?.name || "this workspace"}`)}
          className={ITEM}
        >
          <Here on={!here} />
          <span
            className={`${TILE} ${
              !here
                ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]/25"
                : "bg-[var(--color-panel)] text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)] group-hover:text-[var(--color-ink)] group-hover:ring-[var(--color-line-strong)]"
            }`}
          >
            {DASHBOARD_ICON}
          </span>
          <span className={NAME(!here)}>Dashboard</span>
        </Link>
      </div>

      {/* The workspace's eBay accounts (a member's, the ones they work on): the only part that scrolls. */}
      <p className={`${CAPTION} flex-shrink-0 pb-1 pt-3`}>Accounts</p>
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={measure} className="h-full overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div ref={content} className="flex flex-col items-center gap-3 pb-3 pt-2">
            {connections.map((c) => {
              const current = c.id === here;
              const n = unread[c.id] || 0;
              const site = c.marketplace?.label;
              const sub = [c.marketplace?.name || c.platform_name, n ? `${n} unread` : null, c.status !== "active" ? "Needs reconnecting" : null].filter(Boolean).join(" · ");
              return (
                <button
                  key={c.id}
                  type="button"
                  data-nav
                  onClick={() => {
                    hide();
                    openAccount(c);
                  }}
                  aria-label={`${c.label}${site ? `, eBay ${site}` : ""}${n ? `, ${n} unread` : ""}`}
                  aria-current={current ? "page" : undefined}
                  {...bind(c.label, sub)}
                  className={ITEM}
                >
                  <Here on={current} />
                  <span className={`relative rounded-full transition-all ${current ? "ring-2 ring-[var(--color-primary)] ring-offset-2 ring-offset-[var(--color-paper)]" : "group-hover:-translate-y-px"}`}>
                    <AccountTile connection={c} />
                    <Badge n={n} />
                  </span>
                  <span className={NAME(current)}>{c.label}</span>
                </button>
              );
            })}
            {team && connections.length === 0 && <p className="px-2 text-center text-[10.5px] leading-[13px] text-[var(--color-muted)]">None yet</p>}
          </div>
        </div>
        {/* More above or below: a fade at that edge. */}
        <div aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-[var(--color-paper)] to-transparent transition-opacity ${edges.top ? "opacity-100" : "opacity-0"}`} />
        <div aria-hidden className={`pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--color-paper)] to-transparent transition-opacity ${edges.bottom ? "opacity-100" : "opacity-0"}`} />
      </div>

      {/* Connect another eBay account: always in reach, however long the list. */}
      {role && role !== "member" && (
        <div className="flex-shrink-0 border-t border-[var(--color-line)] py-3">
          <button
            type="button"
            data-nav
            onClick={() => {
              hide();
              connectAccount();
            }}
            aria-label="Connect an eBay account"
            {...bind("Connect an eBay account")}
            className={ITEM}
          >
            <span className={`${TILE} border border-dashed border-[var(--color-line-strong)] text-[var(--color-muted)] group-hover:border-[var(--color-primary)] group-hover:text-[var(--color-primary)]`}>
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            <span className={NAME(false)}>Add</span>
          </button>
        </div>
      )}
      {node}
    </nav>
  );
}
