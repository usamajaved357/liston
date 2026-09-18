"use client";

import { useEffect, useState } from "react";

// "Updated 3 min ago · ↻": how old the page's copy of the eBay data is, and
// a way to re-read it now. Pages render from Liston's mirror of the account
// (instant); this is the one control that spends an eBay call on purpose.

function describeAge(syncedAt: string | null, now: number) {
  if (!syncedAt) return "Not read yet";
  const seconds = Math.max(0, Math.round((now - new Date(syncedAt).getTime()) / 1000));
  if (seconds < 45) return "Updated just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours} h ago`;
  return `Updated ${Math.round(hours / 24)} d ago`;
}

export function SyncStatus({
  syncedAt,
  onRefresh,
  refreshing,
  disabled,
  note,
}: {
  syncedAt: string | null;
  onRefresh: () => void;
  refreshing: boolean;
  disabled?: boolean;
  // A short message about the last refresh attempt (e.g. "too soon").
  note?: string | null;
}) {
  // Re-render each minute so the age keeps reading right while idle.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(handle);
  }, []);

  return (
    <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
      <span className={note ? "text-[var(--color-warning)]" : ""}>{refreshing ? "Reading from eBay…" : note || describeAge(syncedAt, now)}</span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing || disabled}
        title="Re-read this account from eBay now"
        aria-label="Refresh from eBay"
        className="btn btn-ghost btn-icon !h-7 !w-7 disabled:opacity-50"
      >
        <svg viewBox="0 0 24 24" fill="none" className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}>
          <path d="M20 12a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
