"use client";

import { useEffect, useState } from "react";
import { api, ApiError, TeamRange, WorkOverview } from "@/lib/api";
import { MemberPerformance } from "@/components/team/MemberPerformance";
import { dayRangeLabel } from "@/components/charts/chart-format";
import { Alert } from "@/components/Alert";

// A team member's Overview on an account: their own work there, as their
// owner sees it on their Team page — a card per area they have access to,
// one chart of any measure against the period before — for the dates
// chosen. Never any money (the server sends none). Whatever the page adds
// below (the order queue, with Orders access) follows.

const RANGES: { key: TeamRange; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
];

function Skeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card space-y-3 p-4">
            <div className="h-3 w-1/3 animate-pulse rounded-full bg-[var(--color-line)]" />
            <div className="h-6 w-1/4 animate-pulse rounded-full bg-[var(--color-line)]" />
            <div className="h-3 w-2/3 animate-pulse rounded-full bg-[var(--color-line)]" />
          </div>
        ))}
      </div>
      <div className="card h-[300px] animate-pulse" />
    </div>
  );
}

export function MemberWorkOverview({ connectionId, children }: { connectionId: string; children?: React.ReactNode }) {
  const [range, setRange] = useState<TeamRange>("7d");
  // The answer for a request; loading until the one asked for has answered.
  const key = `${connectionId}:${range}`;
  const [result, setResult] = useState<{ key: string; data?: WorkOverview; error?: string } | null>(null);
  const answered = result?.key === key ? result : null;

  useEffect(() => {
    let cancelled = false;
    api
      .myWork(connectionId, range)
      .then((data) => !cancelled && setResult({ key, data }))
      .catch((err) => !cancelled && setResult({ key, error: err instanceof ApiError ? err.message : "Couldn't load your work. Try again." }));
    return () => {
      cancelled = true;
    };
  }, [connectionId, range, key]);

  const data = answered?.data;
  return (
    <div className="space-y-8">
      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-[var(--color-muted)]">
            Your work on this account
            {data && (
              <>
                {" · "}
                <span className="font-medium text-[var(--color-ink)]">{dayRangeLabel(data.range.from, data.range.to)}</span>
              </>
            )}
          </p>
          <div role="radiogroup" aria-label="Dates" className="inline-flex max-w-full flex-wrap rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                role="radio"
                aria-checked={range === r.key}
                onClick={() => setRange(r.key)}
                className={`h-7 rounded-full px-3 text-[12px] font-medium transition-colors ${
                  range === r.key ? "bg-[var(--color-primary)] text-white shadow-sm" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {answered?.error ? <Alert>{answered.error}</Alert> : data ? <MemberPerformance key={`${data.range.from}:${data.range.to}`} data={data} self /> : <Skeleton />}
      </section>
      {children}
    </div>
  );
}
