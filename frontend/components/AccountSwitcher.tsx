"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Connection } from "@/lib/api";
import { useConnections } from "@/lib/useConnections";
import { landingPathForConnection, sectionAllowed } from "@/lib/permissions";
import { PlatformIcon } from "@/components/PlatformIcon";

// The account card at the top of the account sidebar, with a menu that
// jumps straight to any other account. The section you're in is kept:
// switching from one account's Orders lands on the other's Orders, unless a
// team member can't open that section there, who lands where they can.
export function AccountSwitcher({
  connectionId,
  label,
  platformKey,
  platformName,
  marketplace,
}: {
  connectionId: string;
  label: string;
  platformKey: string;
  platformName: string;
  marketplace?: { flag: string; label: string; currency: string; name: string } | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const connections = useConnections();
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    setTimeout(() => search.current?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const others = connections.filter((c) => c.id !== connectionId);
  const shown = query.trim() ? others.filter((c) => c.label.toLowerCase().includes(query.trim().toLowerCase())) : others;
  const canSwitch = others.length > 0;

  function go(target: Connection) {
    // Same section, other account. /accounts/<id>/orders?x -> /accounts/<other>/orders
    const rest = pathname.replace(/^\/accounts\/[^/]+/, "");
    const section = rest.split("/")[1] || "";
    const keep = ["hunting", "research", "listings", "orders", "analytics", "campaigns", "inbox", "settings"].includes(section) ? `/${section}` : "";
    setOpen(false);
    setQuery("");
    router.push(sectionAllowed(target, section) ? `/accounts/${target.id}${keep}` : landingPathForConnection(target));
  }

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => canSwitch && setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
          open ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]" : "border-[var(--color-line)] bg-[var(--color-paper)]"
        } ${canSwitch ? "hover:border-[var(--color-line-strong)]" : "cursor-default"}`}
      >
        <PlatformIcon platformKey={platformKey} size={32} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--color-ink)]">{label}</p>
          <p className="truncate text-[11px] text-[var(--color-muted)]" title={marketplace ? `${marketplace.name} · ${marketplace.currency}` : undefined}>
            {marketplace ? `${marketplace.flag} ${marketplace.name} · ${marketplace.currency}` : platformName}
          </p>
        </div>
        {canSwitch && (
          <svg viewBox="0 0 24 24" fill="none" className={`h-4 w-4 flex-shrink-0 text-[var(--color-muted)] transition-transform ${open ? "rotate-180" : ""}`}>
            <path d="M7 10l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1.5 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]" style={{ boxShadow: "var(--shadow-pop)" }} role="listbox">
          {others.length > 5 && (
            <div className="border-b border-[var(--color-line)] p-2">
              <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an account" className="input input-sm" />
            </div>
          )}
          <p className="px-3 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Switch to</p>
          <ul className="max-h-72 overflow-y-auto pb-1.5">
            {shown.length === 0 ? (
              <li className="px-3 py-3 text-[12.5px] text-[var(--color-muted)]">No account matches.</li>
            ) : (
              shown.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => go(c)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--color-paper)]" role="option" aria-selected={false}>
                    <PlatformIcon platformKey={c.platform_key} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-[var(--color-ink)]">{c.label}</span>
                      <span className="block truncate text-[11px] text-[var(--color-muted)]">
                        {c.marketplace ? `${c.marketplace.flag} ${c.marketplace.label} · ${c.marketplace.currency}` : c.platform_name}
                      </span>
                    </span>
                    {c.status !== "active" && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-500" title="Needs attention" />}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
