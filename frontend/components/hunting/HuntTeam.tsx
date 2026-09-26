"use client";

import { useEffect, useState } from "react";
import { api, ApiError, HuntTeam as HuntTeamData, TeamRange } from "@/lib/api";
import { SegmentedControl } from "@/components/charts/SegmentedControl";
import { dayRangeLabel } from "@/components/charts/chart-format";
import { count, money } from "@/components/research/format";
import { Person, hoursText } from "./HuntBits";

// Who's finding products and how their finds do, and how the reviewers
// keep up: per person for a range, on this account. A hunter's results
// count by when they hunted; a reviewer's decisions by when they made them;
// sales are the orders in the range for listings made from each hunter's
// products.

const RANGES: { key: TeamRange; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
];

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card min-w-0 px-3.5 py-3">
      <p className="truncate text-[12px] font-medium text-[var(--color-muted)]">{label}</p>
      <p className="mt-1 truncate text-[20px] font-semibold tracking-tight tabular-nums text-[var(--color-ink)]">{value}</p>
      {note && <p className="truncate text-[11.5px] text-[var(--color-muted)]">{note}</p>}
    </div>
  );
}

const rate = (n: number | null) => (n === null ? "—" : `${n}%`);

export function HuntTeam({ connectionId, you }: { connectionId: string; you: string }) {
  const [range, setRange] = useState<TeamRange>("30d");
  const [data, setData] = useState<HuntTeamData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The range whose figures last arrived: loading until it's this one.
  const [answered, setAnswered] = useState<TeamRange | null>(null);
  const loading = answered !== range;

  useEffect(() => {
    let cancelled = false;
    api
      .huntTeam(connectionId, range)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn't load the team's figures."))
      .finally(() => !cancelled && setAnswered(range));
    return () => {
      cancelled = true;
    };
  }, [connectionId, range]);

  const t = data?.totals;
  const currency = data?.currency || "GBP";
  const salesText = (s: HuntTeamData["totals"]["sales"]) => (s ? money(s.sales, s.currency || currency) : money(0, currency));
  const maxReason = Math.max(1, ...(data?.reasons || []).map((r) => r.count));

  return (
    <div className={`space-y-4 ${loading && data ? "opacity-60 transition-opacity" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl label="Date range" value={range} onChange={setRange} options={RANGES} />
        {data && <span className="text-[12px] text-[var(--color-muted)]">{dayRangeLabel(data.range.from, data.range.to)}</span>}
      </div>
      {error && <div className="notice notice-danger">{error}</div>}

      {!data && !error && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card h-[84px] animate-pulse" />
          ))}
        </div>
      )}

      {t && data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Tile label="Products hunted" value={count(t.hunter.hunted)} note={`${count(t.hunter.waiting)} waiting now`} />
            <Tile label="Approved" value={count(t.hunter.approved)} note={`${rate(t.hunter.approvalRate)} approval rate`} />
            <Tile label="Rejected" value={count(t.hunter.rejected)} note={`${count(t.hunter.sentBack)} sent back`} />
            <Tile label="Listed" value={count(t.hunter.listed)} note={`${count(t.hunter.drafted)} drafted in all`} />
            <Tile label="Sales from hunts" value={salesText(t.sales)} note={t.sales ? `${count(t.sales.units)} sold` : "no orders yet"} />
            <Tile label="Time to review" value={hoursText(t.reviewer.avgHoursToDecide)} note={`${count(t.reviewer.reviewed)} reviewed`} />
          </div>

          <section className="card overflow-hidden">
            <div className="flex items-baseline justify-between gap-2 px-4 py-3">
              <h3 className="text-[13px] font-semibold text-[var(--color-ink)]">By person</h3>
              <span className="text-[11.5px] text-[var(--color-muted)]">Hunter results by when hunted · reviews by when decided</span>
            </div>
            {data.people.length === 0 ? (
              <p className="border-t border-[var(--color-line)] px-4 py-6 text-center text-[13px] text-[var(--color-muted)]">No hunting or reviewing in this period.</p>
            ) : (
              <>
                <ul className="divide-y divide-[var(--color-line)] border-t border-[var(--color-line)] md:hidden">
                  {data.people.map((row) => (
                    <li key={row.person.id} className="px-4 py-3">
                      <p className="text-[13.5px] font-medium text-[var(--color-ink)]">
                        <Person person={row.person} you={you} />
                        {row.person.isOwner && <span className="ml-1.5 text-[11px] font-normal text-[var(--color-muted)]">owner</span>}
                      </p>
                      <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1.5 text-[12px]">
                        {[
                          ["Hunted", count(row.hunter.hunted)],
                          ["Approved", count(row.hunter.approved)],
                          ["Rejected", count(row.hunter.rejected)],
                          ["Approval", rate(row.hunter.approvalRate)],
                          ["Listed", count(row.hunter.listed)],
                          ["Sales", row.sales ? money(row.sales.sales, row.sales.currency || currency) : "—"],
                          ["Reviewed", count(row.reviewer.reviewed)],
                          ["Rejected by", count(row.reviewer.rejected)],
                          ["Review time", hoursText(row.reviewer.avgHoursToDecide)],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <dt className="text-[var(--color-muted)]">{label}</dt>
                            <dd className="font-semibold tabular-nums text-[var(--color-ink)]">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </li>
                  ))}
                </ul>
                <div className="hidden overflow-x-auto border-t border-[var(--color-line)] md:block">
                  <table className="w-full min-w-[940px] text-[12.5px]">
                    <thead>
                      <tr className="bg-[var(--color-paper)] text-[10.5px] uppercase tracking-wide text-[var(--color-muted)]">
                        <th rowSpan={2} className="px-4 py-2 text-left align-bottom font-semibold">Person</th>
                        <th colSpan={7} className="border-l border-[var(--color-line)] px-3 pt-2 text-left font-semibold text-[var(--color-ink)]">As hunter</th>
                        <th colSpan={5} className="border-l border-[var(--color-line)] px-3 pt-2 text-left font-semibold text-[var(--color-ink)]">As reviewer</th>
                      </tr>
                      <tr className="bg-[var(--color-paper)] text-[10.5px] uppercase tracking-wide text-[var(--color-muted)]">
                        {["Hunted", "Approved", "Sent back", "Rejected", "Waiting", "Rate", "Sales"].map((h, i) => (
                          <th key={h} className={`px-3 pb-2 pt-1 text-right font-semibold ${i === 0 ? "border-l border-[var(--color-line)]" : ""}`}>
                            {h}
                          </th>
                        ))}
                        {["Reviewed", "Approved", "Sent back", "Rejected", "Avg time"].map((h, i) => (
                          <th key={h} className={`px-3 pb-2 pt-1 text-right font-semibold ${i === 0 ? "border-l border-[var(--color-line)]" : ""}`}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--color-line)]">
                      {data.people.map((row) => {
                        const cells = [row.hunter.hunted, row.hunter.approved, row.hunter.sentBack, row.hunter.rejected, row.hunter.waiting];
                        return (
                          <tr key={row.person.id}>
                            <td className="px-4 py-2.5 font-medium text-[var(--color-ink)]">
                              <Person person={row.person} you={you} />
                              {row.person.isOwner && <span className="ml-1.5 text-[11px] font-normal text-[var(--color-muted)]">owner</span>}
                              {row.person.removed && <span className="ml-1.5 text-[11px] font-normal text-[var(--color-muted)]">(removed)</span>}
                            </td>
                            {cells.map((n, i) => (
                              <td key={i} className={`px-3 py-2.5 text-right tabular-nums ${n ? "text-[var(--color-ink)]" : "text-[var(--color-muted)]"} ${i === 0 ? "border-l border-[var(--color-line)]" : ""}`}>
                                {count(n)}
                              </td>
                            ))}
                            <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-[var(--color-ink)]">{rate(row.hunter.approvalRate)}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-ink)]">{row.sales ? money(row.sales.sales, row.sales.currency || currency) : "—"}</td>
                            {[row.reviewer.reviewed, row.reviewer.approved, row.reviewer.sentBack, row.reviewer.rejected].map((n, i) => (
                              <td key={i} className={`px-3 py-2.5 text-right tabular-nums ${n ? "text-[var(--color-ink)]" : "text-[var(--color-muted)]"} ${i === 0 ? "border-l border-[var(--color-line)]" : ""}`}>
                                {count(n)}
                              </td>
                            ))}
                            <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-ink)]">{hoursText(row.reviewer.avgHoursToDecide)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          {data.reasons.length > 0 && (
            <section className="card p-4">
              <h3 className="text-[13px] font-semibold text-[var(--color-ink)]">Why products were rejected</h3>
              <ul className="mt-3 space-y-2.5">
                {data.reasons.map((r) => (
                  <li key={r.key} className="grid grid-cols-[140px_minmax(0,1fr)_32px] items-center gap-3 text-[12.5px]">
                    <span className="truncate text-[var(--color-ink)]">{r.label}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-[var(--color-paper)]">
                      <span className="block h-full rounded-full bg-rose-400" style={{ width: `${(r.count / maxReason) * 100}%` }} />
                    </span>
                    <span className="text-right font-semibold tabular-nums text-[var(--color-ink)]">{count(r.count)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
