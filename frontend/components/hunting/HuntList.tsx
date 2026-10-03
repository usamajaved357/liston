"use client";

import { HuntList as HuntListData, HuntSort, HuntSummary, HuntView } from "@/lib/api";
import { count, money } from "@/components/research/format";
import { ToneIcon } from "@/components/research/ResearchPanels";
import { Person, RatingPill, StageChip, Thumb, VERDICT, ago, profitInk, roiText, signedMoney , EDIT_BUTTON, EditIcon } from "./HuntBits";
import { SalesScorePill } from "./HuntSales";
import { PillTabs } from "@/components/PillTabs";

// The account's hunted products: the pipeline as tabs (waiting, approved,
// drafted, listed, rejected), filters, and a row per product with its
// profit on the best seller, demand, and where it stands. Every product
// stays here whatever happens to it; drafting is done from its page.

export const VIEW_LABELS: Record<HuntView, string> = {
  all: "All",
  sourcing: "Needs a supplier",
  review: "Waiting for review",
  approved: "Approved",
  drafted: "Drafted",
  listed: "Listed",
  rejected: "Rejected",
  mine: "My hunts",
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
  sourcing: { title: "Nothing waiting for a supplier", text: "Products hunted from Product research wait here until someone opens them and adds the AliExpress product that supplies them." },
  review: { title: "Nothing waiting for review", text: "New finds from your hunters land here for a decision." },
  approved: { title: "Nothing approved waiting", text: "Approved products draft themselves and move to Drafted. One whose draft failed stays here with the reason; open it to try again." },
  drafted: { title: "Nothing drafted yet", text: "Approved products show here once their draft is made, until they go live." },
  listed: { title: "Nothing listed yet", text: "Products show here once their listing is live on eBay, with their sales." },
  rejected: { title: "Nothing rejected", text: "Rejected products show here with the reason." },
  all: { title: "No products hunted yet", text: "Click Hunt a product to check one for profit, then add it for review." },
  mine: { title: "You haven't added a product yet", text: "Products you add show here, whatever happens to them: waiting, sent back, approved, drafted, listed or rejected." },
};

// Where a product hunted as its listing alone came from.
const FROM = { discover: "From Discover", research: "From Product research" } as const;

function Status({ hunt }: { hunt: HuntSummary }) {
  let line: string | null = null;
  if (hunt.stage === "rejected") line = hunt.autoRejected ? `by Liston · ${hunt.rejectReasonLabel}` : hunt.rejectReasonLabel;
  else if (hunt.stage === "sent_back") line = hunt.decisionNote;
  else if (hunt.stage === "pending") line = `${hunt.addedFrom ? `${FROM[hunt.addedFrom]} · ` : ""}waiting ${ago(hunt.submittedAt).replace(" ago", "")}`;
  else if (hunt.stage === "sourcing") line = `${FROM[hunt.addedFrom ?? "discover"]} · add a supplier`;
  else if (hunt.stage === "listed") line = hunt.sales ? `${money(hunt.sales.sales, hunt.sales.currency || hunt.currency)} · ${count(hunt.sales.units)} sold` : "No sales yet";
  else if (hunt.stage === "drafted") line = [hunt.draftedBy ? `by ${hunt.draftedBy.name}` : null, hunt.draftedAt ? ago(hunt.draftedAt) : null].filter(Boolean).join(" · ") || null;
  else if (hunt.stage === "approved") line = hunt.draftState === "failed" ? "Draft failed · open to try again" : hunt.autoApproved ? "Owner's find" : hunt.reviewer ? `by ${hunt.reviewer.name}` : null;
  return (
    <div className="flex min-w-0 flex-col items-center text-center">
      {hunt.stage === "approved" && hunt.draftState === "drafting" ? (
        <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-sky-50 px-2 text-[11px] font-semibold text-sky-700 ring-1 ring-inset ring-sky-200">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-600/25 border-t-sky-600" aria-hidden />
          Drafting
        </span>
      ) : (
        <StageChip stage={hunt.stage} small />
      )}
      {line && <p className={`mt-0.5 max-w-[170px] truncate text-[11px] ${hunt.draftState === "failed" && hunt.stage === "approved" ? "font-semibold text-rose-700" : "text-[var(--color-muted)]"}`} title={hunt.draftState === "failed" ? hunt.draftError || undefined : undefined}>{line}</p>}
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

// A reviewer's Review / Approve on a waiting product and a hunter's Edit on a sent-back one; nothing else on the row (drafting is done from the product's page).
// Reviewing happens on the product's page (open the row); only the hunter's
// Edit, on one sent back, sits on the row.
function QuickAction({ hunt, onEdit, wide = false }: { hunt: HuntSummary; onEdit: () => void; wide?: boolean }) {
  const p = hunt.permissions;
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  // Hunted as its listing alone (Discover, Product research): its supplier is added on its page.
  if (p.canEdit && hunt.stage === "sourcing")
    return (
      <span className={`${EDIT_BUTTON} ${wide ? "w-full" : "!h-7 !px-3 !text-[12px]"}`}>
        <EditIcon />
        Add supplier
      </span>
    );
  if (p.canResubmit && hunt.stage === "sent_back")
    return (
      <button type="button" onClick={act(onEdit)} className={`${EDIT_BUTTON} ${wide ? "w-full" : "!h-7 !px-3 !text-[12px]"}`}>
        <EditIcon />
        Edit
      </button>
    );
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 text-[var(--color-line-strong)]" aria-hidden>
      <path d="M8 5l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Row({ hunt, you, onOpen, onEdit }: { hunt: HuntSummary; you: string; onOpen: () => void; onEdit: () => void }) {
  const v = VERDICT[hunt.verdict];
  // No competitor: the profit is the target by design, so it reads plain, "at your price".
  const unpriced = hunt.verdict === "unpriced";
  const ink = profitInk(hunt.headline.profit, hunt.headline.roi, hunt.targetRoiPercent, unpriced);
  const returnText = `${roiText(hunt.headline.roi)} ${unpriced ? "at your price" : "return"}`;
  return (
    <li
      // Dragged into team chat, it's shared as the product's card.
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-liston-ref", JSON.stringify({ kind: "hunt", id: hunt.id, connectionId: hunt.connectionId }));
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      {/* Phones */}
      <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()} className="block cursor-pointer px-4 py-3 md:hidden">
        <div className="flex gap-2.5">
          <Thumb src={hunt.imageUrl} size={48} />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-[13px] font-medium leading-snug text-[var(--color-ink)]">{hunt.title}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-[var(--color-muted)]">
              <Person person={hunt.hunter} you={you} size={16} />
              <span>· {ago(hunt.createdAt)}</span>
              <Signals hunt={hunt} />
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-end justify-between gap-3">
          <div>
            <p className={`text-[15px] font-semibold leading-none tabular-nums ${ink}`}>{signedMoney(hunt.headline.profit, hunt.currency)}</p>
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
          <Status hunt={hunt} />
        </div>
        {(hunt.stage === "sent_back" && hunt.decisionNote) || (hunt.stage === "rejected" && hunt.rejectReasonLabel) ? (
          <p className="mt-2 line-clamp-2 rounded-lg bg-[var(--color-paper)] px-2.5 py-1.5 text-[12px] text-[var(--color-ink)]">{hunt.stage === "rejected" ? hunt.rejectReasonLabel : hunt.decisionNote}</p>
        ) : null}
        {hunt.permissions.canResubmit && hunt.stage === "sent_back" ? (
          <div className="mt-3 flex">
            <QuickAction hunt={hunt} onEdit={onEdit} wide />
          </div>
        ) : null}
      </div>

      {/* Wider screens */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => e.key === "Enter" && onOpen()}
        className="hidden cursor-pointer grid-cols-[minmax(0,1fr)_112px_104px_176px_96px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--color-paper)]/70 md:grid"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Thumb src={hunt.imageUrl} size={42} />
          <div className="min-w-0">
            <p className="line-clamp-2 text-[12.5px] font-medium leading-snug text-[var(--color-ink)]">{hunt.title}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[var(--color-muted)]">
              <Person person={hunt.hunter} you={you} size={14} />
              <span>· {ago(hunt.createdAt)}</span>
              {hunt.bestSeller?.label && <span className="max-w-[160px] truncate">· Best seller {hunt.bestSeller.label}</span>}
              <Signals hunt={hunt} />
            </div>
          </div>
        </div>
        <div className="text-center" title={unpriced ? "No competitor: priced at your target return" : `${v.label}${hunt.headline.basis === "best_seller" ? " on the best seller" : hunt.headline.basis === "best_option" ? " on the best option" : ""}`}>
          <p className={`text-[13.5px] font-semibold tabular-nums ${ink}`}>{signedMoney(hunt.headline.profit, hunt.currency)}</p>
          <p className="text-[11px] tabular-nums text-[var(--color-muted)]">{returnText}</p>
        </div>
        <div className="flex flex-col items-center text-center">
          <p className="text-[12.5px] font-semibold tabular-nums text-[var(--color-ink)]">
            {hunt.soldPerMonth === null ? "—" : count(hunt.soldPerMonth)}
            <span className="ml-1 text-[11px] font-normal text-[var(--color-muted)]">/ month</span>
          </p>
          <span className="mt-0.5">
            <SalesScorePill score={hunt.salesScore} small />
          </span>
        </div>
        <Status hunt={hunt} />
        <div className="flex justify-end">
          <QuickAction hunt={hunt} onEdit={onEdit} />
        </div>
      </div>
    </li>
  );
}

// The tabs, as every page has them (PillTabs); the review queue's count tinted while anything waits.
export function PipelineTabs({ views, counts, value, onChange }: { views: HuntView[]; counts: Record<HuntView, number>; value: HuntView; onChange: (v: HuntView) => void }) {
  return (
    <PillTabs
      label="Hunted products"
      tabs={views.map((v) => ({ key: v, label: VIEW_LABELS[v], count: count(counts[v] ?? 0), countTone: v === "review" && (counts[v] ?? 0) > 0 ? ("alert" as const) : undefined }))}
      value={value}
      onChange={onChange}
    />
  );
}

export function HuntRows({ data, view, you, loading, query = "", filtered = false, onOpen, onEdit, onMore }: { data: HuntListData | null; view: HuntView; you: string; loading: boolean; query?: string; filtered?: boolean; onOpen: (id: string) => void; onEdit: (id: string) => void; onMore?: () => void }) {
  if (!data) {
    return (
      <ul className="divide-y divide-[var(--color-line)]">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i} className="flex items-center gap-2.5 px-4 py-3">
            <div className="h-[42px] w-[42px] animate-pulse rounded-lg bg-[var(--color-line)]" />
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
    // A search that finds nothing says so, rather than that nothing was ever hunted.
    const empty = query.trim()
      ? { title: `No products match \u201c${query.trim()}\u201d`, text: "Search by title, eBay item number, AliExpress product number, hunter or note." }
      : filtered
        ? { title: "No products match these filters", text: "Loosen or clear a filter to see more." }
        : EMPTY[view];
    return (
      <div className="flex flex-col items-center px-6 py-10 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
            <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        </span>
        <p className="mt-2.5 text-[13px] font-semibold text-[var(--color-ink)]">{empty.title}</p>
        <p className="mt-0.5 max-w-sm text-[12px] leading-relaxed text-[var(--color-muted)]">{empty.text}</p>
      </div>
    );
  }
  return (
    <div className={`overflow-hidden rounded-b-[var(--radius-card)] ${loading ? "opacity-60 transition-opacity" : "transition-opacity"}`}>
      <div className="hidden grid-cols-[minmax(0,1fr)_112px_104px_176px_96px] gap-3 border-b border-[var(--color-line)] bg-[var(--color-paper)] px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)] md:grid">
        <span>Product</span>
        <span className="text-center">Profit per sale</span>
        <span className="text-center">Demand</span>
        <span className="text-center">Status</span>
        <span />
      </div>
      <ul className="divide-y divide-[var(--color-line)]">
        {data.items.map((hunt) => (
          <Row key={hunt.id} hunt={hunt} you={you} onOpen={() => onOpen(hunt.id)} onEdit={() => onEdit(hunt.id)} />
        ))}
      </ul>
      {data.more && onMore && (
        <button type="button" onClick={onMore} disabled={loading} className="w-full border-t border-[var(--color-line)] py-2.5 text-[12.5px] font-semibold text-[var(--color-primary)] hover:bg-[var(--color-paper)]">
          {loading ? "Loading…" : "Show more"}
        </button>
      )}
    </div>
  );
}
