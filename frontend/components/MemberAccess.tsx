"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, Connection } from "@/lib/api";

// On a team member's home: what they can do on an account, each a way
// straight in, with what's waiting for them there (products to review,
// finds sent back, approved products ready to draft).

const AREAS: { key: string; label: string; path: string; features: string[]; icon: React.ReactNode }[] = [
  {
    key: "hunting",
    label: "Hunting",
    path: "/hunting",
    features: ["hunting", "hunting_review"],
    icon: (
      <>
        <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      </>
    ),
  },
  {
    key: "listings",
    label: "Listings",
    path: "/listings",
    features: ["listings"],
    icon: (
      <>
        <path d="M3.5 12.5V5.5a2 2 0 012-2h7l8 8-7 7-8-8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      </>
    ),
  },
  {
    key: "orders",
    label: "Orders",
    path: "/orders",
    features: ["orders"],
    icon: (
      <>
        <path d="M3.5 8L12 3.5 20.5 8v8L12 20.5 3.5 16V8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M3.5 8L12 12.5 20.5 8M12 12.5v8" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </>
    ),
  },
  {
    key: "analytics",
    label: "Analytics",
    path: "/analytics",
    features: ["analytics"],
    icon: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  },
  {
    key: "inbox",
    label: "Inbox",
    path: "/inbox",
    features: ["inbox"],
    icon: (
      <>
        <path d="M4 6.5A1.5 1.5 0 015.5 5h13A1.5 1.5 0 0120 6.5v11a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5v-11z" stroke="currentColor" strokeWidth="1.8" />
        <path d="M4.5 7l7.5 5.5L19.5 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  {
    key: "campaigns",
    label: "Campaigns",
    path: "/campaigns",
    features: ["campaigns"],
    icon: <path d="M4 10.5v3a1.5 1.5 0 001.5 1.5H8l6 4V5L8 9H5.5A1.5 1.5 0 004 10.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
  },
];

// What waits for this member on the account's hunting page, in words.
function useWaiting(connection: Connection) {
  const p: Record<string, boolean> = connection.permissions ?? {};
  const hunts = Boolean(p.hunting || p.hunting_review || p.listings);
  const [waiting, setWaiting] = useState<string | null>(null);
  useEffect(() => {
    if (!hunts) return;
    let cancelled = false;
    api
      .huntBadge(connection.id)
      .then((b) => {
        if (cancelled) return;
        const parts: string[] = [];
        if (p.hunting_review && b.review) parts.push(`${b.review} to review`);
        if (p.hunting && b.sentBack) parts.push(`${b.sentBack} sent back`);
        if (!p.hunting && !p.hunting_review && b.approved) parts.push(`${b.approved} ready to draft`);
        setWaiting(parts.length ? parts.join(" · ") : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connection.id, hunts, p.hunting, p.hunting_review]);
  return waiting;
}

export function MemberAccess({ connection }: { connection: Connection }) {
  const waiting = useWaiting(connection);
  const p: Record<string, boolean> = connection.permissions ?? {};
  const areas = AREAS.filter((a) => a.features.some((f) => p[f]));
  const base = `/accounts/${connection.id}`;
  return (
    <div className="mt-3 border-t border-[var(--color-line)] pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Your access</p>
        {waiting && (
          <Link
            href={`${base}/hunting`}
            className="relative z-10 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200 hover:bg-amber-100"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
            {waiting}
          </Link>
        )}
      </div>
      {areas.length === 0 ? (
        <p className="mt-1.5 text-[12px] text-[var(--color-muted)]">Nothing switched on here yet. Ask your team owner for access.</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {areas.map((a) => (
            <Link
              key={a.key}
              href={`${base}${a.path}`}
              className="relative z-10 inline-flex h-7 items-center gap-1.5 rounded-full bg-[var(--color-panel)] px-2.5 text-[12px] font-medium text-[var(--color-ink)] ring-1 ring-inset ring-[var(--color-line)] transition-colors hover:bg-[var(--color-primary-soft)] hover:text-[var(--color-primary)] hover:ring-[var(--color-primary)]/30"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 text-[var(--color-muted)]" aria-hidden>
                {a.icon}
              </svg>
              {a.key === "hunting" && p.hunting_review && !p.hunting ? "Reviewing" : a.key === "hunting" && p.hunting_review ? "Hunting & review" : a.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
