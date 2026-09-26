"use client";

import { HuntList as HuntListData, HuntSort, HuntSummary, HuntView } from "@/lib/api";
import { count, money } from "@/components/research/format";
import { ToneIcon } from "@/components/research/ResearchPanels";
import { Person, RatingPill, StageChip, Thumb, VERDICT, ago, profitInk, roiText, signedMoney } from "./HuntBits";
import { SalesScorePill } from "./HuntSales";

// The account's hunted products: the pipeline as tabs (waiting, sent back,
// approved, drafted and listed, rejected), filters, and a row per product
// with its profit on the best seller, demand, where it stands, and the
// one action that moves it on for this person.

export const VIEW_LABELS: Record<HuntView, string> = {
  review: "Waiting for review",
  sent_back: "Sent back",
  approved: "Approved",
  listed: "Drafted & listed",
  rejected: "Rejected",
  all: "All",
};

export const SORT_LABELS: Record<HuntSort, string> = {
  newest: "Newest",
  waiting: "Longest waiting",
  profit: "Most profit",
  roi: "Best return",
  demand: "Most sold",
  sales: "Best sales",
};

const EMPTY: Record<HuntView, { title: string; text: string }> = {
  review: { title: "Nothing waiting for review", text: "New finds from the team land here for a decision." },
  sent_back: { title: "Nothing sent back", text: "Products a reviewer returns for another look show here until they're resubmitted." },
  approved: { title: "No approved products yet", text: "Approved products wait here, ready to draft." },
  listed: { title: "Nothing drafted yet", text: "Products drafted from the hunt, and the listings they become, show here with their sales." },
  rejected: { title: "Nothing rejected", text: "Rejected products show here with the reason." },
  all: { title: "No products hunted yet", text: "Check a product above to see its profit, then add it for review." },
};

function Status({ hunt }: { hunt: HuntSummary }) {
  let line: string | null = null;
  if (hunt.stage === "rejected") line = hunt.rejectReasonLabel;
  else if (hunt.stage === "sent_back") line = hunt.decisionNote;
  else if (hunt.stage === "pending") line = `waiting ${ago(hunt.submittedAt).replace(" ago", "")}`;
  else if (hunt.stage === "listed") line = hunt.sales ? `${money(hunt.sales.sales, hunt.sales.currency || hunt.currency)} · ${count(hunt.sales.units)} sold` : "No sales yet";
  else if (hunt.stage === "approved") line = hunt.autoApproved ? "Owner's find" : hunt.reviewer ? `by ${hunt.reviewer.name}` : null;
  return (
    <div className="flex min-w-0 flex-col items-center text-center">
      <StageChip stage={hunt.stage} />
      {line && <p className="mt-1 max-w-[190px] truncate text-[11.5px] text-[var(--color-muted)]">{line}</p>}
    </div>
  );
}

function Signals({ hunt }: { hunt: HuntSummary }) {
  return (
    <>
      {hunt.supplier?.rating !== null && hunt.supplier?.rating !== undefined && <RatingPill rating={hunt.supplier.rating} small />}
      {!hunt.competitorUrl && (
        <span className="inline-flex items-center rounded bg-indigo-50 px-1.5 text-[11px] font-semibold text-indigo-700" title="Checked without a competitor: priced at the target return, with no market price or demand">
          No competitor
        </span>
      )}
      {hunt.warnings > 0 && (
        <span className="inline-flex items-center gap-1 text-amber-700" title={`${hunt.warnings} thing${hunt.warnings === 1 ? "" : "s"} to check before approving`}>
          <ToneIcon tone="warn" className="h-3.5 w-3.5" />
          {hunt.warnings}
        </span>
      )}
      {!hunt.duplicates && (hunt.similar || 0) > 0 && (
        <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 text-[11px] font-semibold text-amber-800" title="A live listing on your accounts has a very similar title">
          Similar live
        </span>
      )}
      {hunt.duplicates > 0 && (
        <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 text-[11px] font-semibold text-amber-800" title="The same product is already hunted, drafted or live on your accounts">
          Already on {hunt.duplicates === 1 ? "1 account" : `${hunt.duplicates} places`}
        </span>
      )}
    </>
  );
}

function QuickAction({ hunt, onOpen, onApprove, onDraft, wide = false }: { hunt: HuntSummary; onOpen: () => void; onApprove: () => void; onDraft: () => void; wide?: boolean }) {
  const p = hunt.permissions;
  const size = wide ? "flex-1" : "btn-sm";
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  if (p.canDecide && hunt.stage === "pending")
    return (
      <div className={`flex items-center gap-1.5 ${wide ? "w-full" : ""}`}>
        <button type="button" onClick={act(onOpen)} className={`btn btn-secondary ${size}`}>
          Review
        </button>
        <button type="button" onClick={act(onApprove)} className={`btn btn-primary ${size}`}>
          Approve
        </button>
      </div>
    );
  if (p.canDraft && hunt.stage === "approved")
    return (
      <button type="button" onClick={act(onDraft)} className={`btn btn-primary ${wide ? "w-full" : "btn-sm"}`}>
        Draft
      </button>
    );
  if (p.canResubmit)
    return (
      <button type="button" onClick={act(onOpen)} className={`btn btn-secondary ${wide ? "w-full" : "btn-sm"}`}>
        Fix & resubmit
      </button>
    );
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 text-[var(--color-line-strong)]" aria-hidden>
      <path d="M8 5l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Row({ hunt, you, onOpen, onApprove, onDraft }: { hunt: HuntSummary; you: string; onOpen: () => void; onApprove: () => void; onDraft: () => void }) {
  const v = VERDICT[hunt.verdict];
  // No competitor: the profit is the target by design, so it reads plain, "at your price".
  const unpriced = hunt.verdict === "unpriced";
  const ink = profitInk(hunt.headline.profit, hunt.headline.roi, hunt.targetRoiPercent, unpriced);
  const returnText = `${roiText(hunt.headline.roi)} ${unpriced ? "at your price" : "return"}`;
  return (
    <li>
      {/* Phones */}
      <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()} className="block cursor-pointer px-4 py-3.5 md:hidden">
        <div className="flex gap-3">
          <Thumb src={hunt.imageUrl} size={56} />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-[13.5px] font-medium leading-snug text-[var(--color-ink)]">{hunt.title}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-[var(--color-muted)]">
              <Person person={hunt.hunter} you={you} size={16} />
              <span>· {ago(hunt.createdAt)}</span>
              <Signals hunt={hunt} />
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-end justify-between gap-3">
          <div>
            <p className={`text-[17px] font-semibold leading-none tabular-nums ${ink}`}>{signedMoney(hunt.headline.profit, hunt.currency)}</p>
            <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">
              {returnText}
              {hunt.soldPerMonth !== null ? ` · ${count(hunt.soldPerMonth)}/mo sold` : ""}
            </p>
            {hunt.salesScore && (
              <span className="mt-1.5 inline-flex">
                <SalesScorePill score={hunt.salesScore} small />
              </span>
            )}
          </div>
          <StageChip stage={hunt.stage} />
        </div>
        {(hunt.stage === "sent_back" && hunt.decisionNote) || (hunt.stage === "rejected" && hunt.rejectReasonLabel) ? (
          <p className="mt-2 line-clamp-2 rounded-lg bg-[var(--color-paper)] px-2.5 py-1.5 text-[12px] text-[var(--color-ink)]">{hunt.stage === "rejected" ? hunt.rejectReasonLabel : hunt.decisionNote}</p>
        ) : null}
        {(hunt.permissions.canDecide && hunt.stage === "pending") || (hunt.permissions.canDraft && hunt.stage === "approved") || hunt.permissions.canResubmit ? (
          <div className="mt-3 flex">
            <QuickAction hunt={hunt} onOpen={onOpen} onApprove={onApprove} onDraft={onDraft} wide />
          </div>
        ) : null}
      </div>

      {/* Wider screens */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => e.key === "Enter" && onOpen()}
        className="hidden cursor-pointer grid-cols-[minmax(0,1fr)_132px_120px_196px_176px] items-center gap-4 px-4 py-3 transition-colors hover:bg-[var(--color-paper)]/70 md:grid"
      >
        <div className="flex min-w-0 items-center gap-3">
          <Thumb src={hunt.imageUrl} size={52} />
          <div className="min-w-0">
            <p className="line-clamp-2 text-[13.5px] font-medium leading-snug text-[var(--color-ink)]">{hunt.title}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-[var(--color-muted)]">
              <Person person={hunt.hunter} you={you} size={16} />
              <span>· {ago(hunt.createdAt)}</span>
              {hunt.bestSeller?.label && <span className="max-w-[160px] truncate">· Best seller {hunt.bestSeller.label}</span>}
              <Signals hunt={hunt} />
            </div>
          </div>
        </div>
        <div className="text-center" title={unpriced ? "No competitor: priced at your target return" : `${v.label}${hunt.headline.basis === "best_seller" ? " on the best seller" : hunt.headline.basis === "best_option" ? " on the best option" : ""}`}>
          <p className={`text-[15px] font-semibold tabular-nums ${ink}`}>{signedMoney(hunt.headline.profit, hunt.currency)}</p>
          <p className="text-[11.5px] tabular-nums text-[var(--color-muted)]">{returnText}</p>
        </div>
        <div className="flex flex-col items-center text-center">
          <p className="text-[13px] font-semibold tabular-nums text-[var(--color-ink)]">
            {hunt.soldPerMonth === null ? "—" : count(hunt.soldPerMonth)}
            <span className="ml-1 text-[11.5px] font-normal text-[var(--color-muted)]">/ month</span>
          </p>
          <span className="mt-1">
            <SalesScorePill score={hunt.salesScore} small />
          </span>
        </div>
        <Status hunt={hunt} />
        <div className="flex justify-end">
          <QuickAction hunt={hunt} onOpen={onOpen} onApprove={onApprove} onDraft={onDraft} />
        </div>
      </div>
    </li>
  );
}

export function PipelineTabs({ views, counts, value, onChange }: { views: HuntView[]; counts: Record<HuntView, number>; value: HuntView; onChange: (v: HuntView) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Hunted products">
      {views.map((v) => {
        const on = v === value;
        const n = counts[v] ?? 0;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(v)}
            className={`-mb-px flex flex-shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-[13.5px] font-medium transition-colors ${
              on ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            }`}
          >
            {VIEW_LABELS[v]}
            <span
              className={`min-w-[20px] rounded-full px-1.5 text-center text-[11px] font-semibold leading-[18px] tabular-nums ${
                on ? "bg-[var(--color-primary)] text-white" : n && v === "review" ? "bg-indigo-100 text-indigo-700" : "bg-[var(--color-paper)] text-[var(--color-muted)]"
              }`}
            >
              {count(n)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function HuntRows({ data, view, you, loading, onOpen, onApprove, onDraft, onMore }: { data: HuntListData | null; view: HuntView; you: string; loading: boolean; onOpen: (id: string) => void; onApprove: (hunt: HuntSummary) => void; onDraft: (hunt: HuntSummary) => void; onMore?: () => void }) {
  if (!data) {
    return (
      <ul className="divide-y divide-[var(--color-line)]">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-4">
            <div className="h-[52px] w-[52px] animate-pulse rounded-xl bg-[var(--color-line)]" />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-2/3 animate-pulse rounded bg-[var(--color-line)]" />
              <div className="h-3 w-1/3 animate-pulse rounded bg-[var(--color-line)]" />
            </div>
          </li>
        ))}
      </ul>
    );
  }
  if (!data.items.length) {
    const empty = EMPTY[view];
    return (
      <div className="flex flex-col items-center px-6 py-12 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
            <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        </span>
        <p className="mt-3 text-[14px] font-semibold text-[var(--color-ink)]">{empty.title}</p>
        <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-[var(--color-muted)]">{empty.text}</p>
      </div>
    );
  }
  return (
    <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
      <div className="hidden grid-cols-[minmax(0,1fr)_132px_120px_196px_176px] gap-4 border-b border-[var(--color-line)] bg-[var(--color-paper)] px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)] md:grid">
        <span>Product</span>
        <span className="text-center">Profit per sale</span>
        <span className="text-center">Demand</span>
        <span className="text-center">Status</span>
        <span />
      </div>
      <ul className="divide-y divide-[var(--color-line)]">
        {data.items.map((hunt) => (
          <Row key={hunt.id} hunt={hunt} you={you} onOpen={() => onOpen(hunt.id)} onApprove={() => onApprove(hunt)} onDraft={() => onDraft(hunt)} />
        ))}
      </ul>
      {data.more && onMore && (
        <button type="button" onClick={onMore} disabled={loading} className="w-full border-t border-[var(--color-line)] py-3 text-[13px] font-semibold text-[var(--color-primary)] hover:bg-[var(--color-paper)]">
          {loading ? "Loading…" : "Show more"}
        </button>
      )}
    </div>
  );
}
