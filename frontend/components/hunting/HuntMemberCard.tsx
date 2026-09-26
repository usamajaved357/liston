"use client";

import { MemberHunting } from "@/lib/api";
import { DeltaBadge } from "@/components/charts/DeltaBadge";
import { count, money } from "@/components/research/format";
import { hoursText } from "./HuntBits";

// A member's hunting on their page: how their finds did (counted by when
// they hunted them, so the figures add up) and, if they review, the
// decisions they made and how long products waited for them.

const change = (now: number, before: number) => (before > 0 ? (now - before) / before : null);

function Figure({ label, value, now, before, compared, note }: { label: string; value: string; now?: number; before?: number; compared: string; note?: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[11.5px] font-medium text-[var(--color-muted)]">{label}</p>
      <p className="mt-0.5 text-[18px] font-semibold tracking-tight tabular-nums text-[var(--color-ink)]">{value}</p>
      <div className="h-4 text-[11px]">{now !== undefined && before !== undefined ? <DeltaBadge change={change(now, before)} compared={compared} size="sm" variant="text" /> : note ? <span className="text-[var(--color-muted)]">{note}</span> : null}</div>
    </div>
  );
}

export function hasHunting(h: MemberHunting | undefined) {
  if (!h) return false;
  return h.hunter.hunted > 0 || h.previousHunter.hunted > 0 || h.reviewer.reviewed > 0 || h.previousReviewer.reviewed > 0 || h.sales.length > 0;
}

export function HuntMemberCard({ hunting: h, compared }: { hunting: MemberHunting; compared: string }) {
  const sales = h.sales[0];
  const previousSales = h.previousSales[0];
  const reviews = h.reviewer.reviewed > 0 || h.previousReviewer.reviewed > 0;
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Product hunting</h2>
        <span className="text-[11.5px] text-[var(--color-muted)]">Their finds by when hunted · sales in this period from listings made from them</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 xl:grid-cols-7">
        <Figure label="Hunted" value={count(h.hunter.hunted)} now={h.hunter.hunted} before={h.previousHunter.hunted} compared={compared} />
        <Figure label="Approved" value={count(h.hunter.approved)} now={h.hunter.approved} before={h.previousHunter.approved} compared={compared} />
        <Figure label="Rejected" value={count(h.hunter.rejected)} note={h.hunter.sentBack ? `${h.hunter.sentBack} sent back` : undefined} compared={compared} />
        <Figure label="Waiting" value={count(h.hunter.waiting)} compared={compared} />
        <Figure label="Approval rate" value={h.hunter.approvalRate === null ? "—" : `${h.hunter.approvalRate}%`} note={h.previousHunter.approvalRate !== null ? `${h.previousHunter.approvalRate}% before` : undefined} compared={compared} />
        <Figure label="Listed" value={count(h.hunter.listed)} note={h.hunter.drafted ? `${h.hunter.drafted} drafted` : undefined} compared={compared} />
        <Figure
          label="Sales from their finds"
          value={sales ? money(sales.sales, sales.currency || "GBP") : "—"}
          now={sales?.sales}
          before={previousSales?.sales ?? (sales ? 0 : undefined)}
          compared={compared}
        />
      </div>
      {reviews && (
        <div className="mt-4 border-t border-[var(--color-line)] pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">As a reviewer</p>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
            <Figure label="Reviewed" value={count(h.reviewer.reviewed)} now={h.reviewer.reviewed} before={h.previousReviewer.reviewed} compared={compared} />
            <Figure label="Approved" value={count(h.reviewer.approved)} compared={compared} />
            <Figure label="Rejected" value={count(h.reviewer.rejected)} compared={compared} />
            <Figure label="Sent back" value={count(h.reviewer.sentBack)} compared={compared} />
            <Figure label="Average wait" value={hoursText(h.reviewer.avgHoursToDecide)} note="from submitted to decided" compared={compared} />
          </div>
        </div>
      )}
      {h.reasons.length > 0 && (
        <p className="mt-3 text-[12px] text-[var(--color-muted)]">
          Rejected for: {h.reasons.map((r) => `${r.label} (${r.count})`).join(", ")}
        </p>
      )}
    </section>
  );
}
