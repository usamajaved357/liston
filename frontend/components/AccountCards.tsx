"use client";

import { ReactNode, useMemo, useState } from "react";
import Link from "next/link";
import { Connection } from "@/lib/api";
import { PlatformIcon } from "@/components/PlatformIcon";
import { formatShortDate } from "@/lib/format";

// The connected accounts as a searchable grid of cards: two or three to a
// row, each with its market and a way in. One eBay account on several sites
// shows as a card per site, and each card links to its other sites.

const STATUS: Record<Connection["status"], { label: string; dot: string; chip: string }> = {
  active: { label: "Connected", dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  expired: { label: "Reconnect needed", dot: "bg-amber-500", chip: "bg-amber-50 text-amber-800 ring-amber-200" },
  error: { label: "Needs attention", dot: "bg-rose-500", chip: "bg-rose-50 text-rose-700 ring-rose-200" },
  suspended: { label: "Suspended", dot: "bg-rose-500", chip: "bg-rose-50 text-rose-700 ring-rose-200" },
};

export function StatusPill({ status }: { status: Connection["status"] }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${s.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

// The eBay seller behind a connection, so its sites can be grouped.
function sellerOf(c: Connection): string | null {
  const ebay = c.settings?.ebay as { userId?: string; username?: string } | undefined;
  return ebay?.userId || ebay?.username || null;
}

function marketText(c: Connection): string {
  const m = c.marketplace;
  return [c.label, c.platform_name, m?.name, m?.label, m?.currency, m?.countryName].filter(Boolean).join(" ").toLowerCase();
}

const SearchIcon = (
  <svg viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]">
    <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
    <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

function AccountCard({ connection, href, siblings, actions }: { connection: Connection; href: string; siblings: Connection[]; actions?: ReactNode }) {
  const m = connection.marketplace;
  return (
    // The whole card opens the account: the name's link is stretched over it
    // (after:inset-0), and the links and buttons inside sit above it.
    <li className="card group relative flex flex-col p-4 transition-[box-shadow,border-color] hover:border-[var(--color-line-strong)] hover:shadow-md focus-within:border-[var(--color-primary)]">
      <div className="flex items-start gap-3">
        <PlatformIcon platformKey={connection.platform_key} size={40} />
        <div className="min-w-0 flex-1">
          <Link
            href={href}
            className="block truncate text-[15px] font-semibold text-[var(--color-ink)] outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] group-hover:text-[var(--color-primary)]"
            title={`Open ${connection.label}${m ? ` · ${m.name}` : ""}`}
          >
            {connection.label}
          </Link>
          {/* The market chip below already says which platform; this line
              is the account's health and when it was added, never cut off. */}
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 whitespace-nowrap text-[12px] text-[var(--color-muted)]">
            {connection.status === "active" && (
              <>
                <span className="flex items-center gap-1.5 text-emerald-700">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                  Connected
                </span>
                <span aria-hidden>·</span>
              </>
            )}
            <span title={`${connection.platform_name} account added ${formatShortDate(connection.created_at)}`}>Added {formatShortDate(connection.created_at)}</span>
          </p>
        </div>
        {/* Healthy is the quiet default; anything else stands out. */}
        {connection.status !== "active" && <StatusPill status={connection.status} />}
        {actions ? (
          // Icon buttons in the corner, above the card's own link.
          <div className="relative z-10 -mr-1.5 -mt-1 flex shrink-0 items-center">{actions}</div>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" aria-hidden className="mt-1 h-4 w-4 shrink-0 text-[var(--color-muted)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--color-primary)]">
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {m && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-primary-soft)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-ink)]">
            <span aria-hidden>{m.flag}</span>
            {m.name} · {m.currency}
          </span>
        )}
        {siblings.map((s) => (
          <Link
            key={s.id}
            href={`/accounts/${s.id}`}
            className="relative z-10 inline-flex items-center gap-1 rounded-full bg-[var(--color-panel)] px-2 py-1 text-[11px] font-medium text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)] hover:text-[var(--color-ink)] hover:ring-[var(--color-line-strong)]"
            title={`The same eBay account on ${s.marketplace?.name ?? "another site"}`}
          >
            Also on <span aria-hidden>{s.marketplace?.flag}</span> {s.marketplace?.label}
          </Link>
        ))}
      </div>

    </li>
  );
}

interface AccountCardsProps {
  connections: Connection[];
  hrefFor?: (c: Connection) => string;
  actionsFor?: (c: Connection) => ReactNode;
  // Shown at the right of the search row (the owner's "Add account").
  toolbarEnd?: ReactNode;
  summary?: ReactNode;
}

export function AccountCards({ connections, hrefFor = (c) => `/accounts/${c.id}`, actionsFor, toolbarEnd, summary }: AccountCardsProps) {
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState<string>("all");

  // The markets present, busiest first, for the filter chips.
  const markets = useMemo(() => {
    const byId = new Map<string, { id: string; flag: string; label: string; n: number }>();
    for (const c of connections) {
      const m = c.marketplace;
      if (!m) continue;
      const entry = byId.get(m.id) ?? { id: m.id, flag: m.flag, label: m.label, n: 0 };
      entry.n += 1;
      byId.set(m.id, entry);
    }
    return [...byId.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  }, [connections]);

  const siblingsOf = useMemo(() => {
    const groups = new Map<string, Connection[]>();
    for (const c of connections) {
      const seller = sellerOf(c);
      if (seller) groups.set(seller, [...(groups.get(seller) ?? []), c]);
    }
    return (c: Connection) => {
      const seller = sellerOf(c);
      return seller ? (groups.get(seller) ?? []).filter((s) => s.id !== c.id && s.marketplace) : [];
    };
  }, [connections]);

  const needle = query.trim().toLowerCase();
  const shown = [...connections]
    .filter((c) => market === "all" || c.marketplace?.id === market)
    .filter((c) => !needle || needle.split(/\s+/).every((word) => marketText(c).includes(word)))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || (a.marketplace?.label ?? "").localeCompare(b.marketplace?.label ?? ""));

  const chip = (active: boolean) =>
    `inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors ${
      active ? "bg-[var(--color-primary)] text-white" : "bg-[var(--color-panel)] text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)] hover:text-[var(--color-ink)]"
    }`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          {SearchIcon}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by account name or market"
            aria-label="Search accounts"
            autoComplete="off"
            className="input input-sm !pl-10"
          />
        </div>
        {summary && <div className="text-[13px] text-[var(--color-muted)]">{summary}</div>}
        {toolbarEnd && <div className="ml-auto">{toolbarEnd}</div>}
      </div>

      {markets.length > 1 && (
        <div role="radiogroup" aria-label="Market" className="mb-4 flex flex-wrap gap-1.5">
          <button type="button" role="radio" aria-checked={market === "all"} onClick={() => setMarket("all")} className={chip(market === "all")}>
            All markets <span className="opacity-70">{connections.length}</span>
          </button>
          {markets.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={market === m.id} onClick={() => setMarket(market === m.id ? "all" : m.id)} className={chip(market === m.id)}>
              <span aria-hidden>{m.flag}</span> {m.label} <span className="opacity-70">{m.n}</span>
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="card px-6 py-10 text-center">
          <p className="text-sm font-medium text-[var(--color-ink)]">No accounts match{needle ? ` “${query.trim()}”` : ""}</p>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setMarket("all");
            }}
            className="mt-2 text-[13px] font-medium text-[var(--color-primary)] hover:underline"
          >
            Show all accounts
          </button>
        </div>
      ) : (
        // As many columns as fit (three on a laptop, one on a phone), by the
        // space the page has rather than the window, since the sidebar takes some.
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4">
          {shown.map((c) => (
            <AccountCard key={c.id} connection={c} href={hrefFor(c)} siblings={siblingsOf(c)} actions={actionsFor?.(c)} />
          ))}
        </ul>
      )}
    </div>
  );
}
