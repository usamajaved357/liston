"use client";

import { ListonCard, ListonCardFact, ListonCardKind } from "@/lib/api";

// A Liston card: an order, a live listing, a draft, a hunted product or a
// buyer's eBay conversation ("Discuss with team") from any of the owner's
// accounts, as a message shows it. It names its account
// and opens that page there in a new tab (the conversation stays where it
// was), whichever account the viewer was working in. A locked card (an
// account or area the viewer can't open) and a gone one show none of the
// thing's details.

export const KIND_LABEL: Record<ListonCardKind, string> = { order: "Order", listing: "Listing", draft: "Draft", hunt: "Hunted product", conversation: "eBay conversation" };

const TONE: Record<string, string> = {
  good: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  bad: "bg-rose-50 text-rose-700 ring-rose-200",
  info: "bg-[var(--color-primary-soft)] text-[var(--color-primary)] ring-indigo-200",
  muted: "bg-slate-50 text-slate-600 ring-slate-200",
};

export function KindIcon({ kind, className = "h-4 w-4" }: { kind: ListonCardKind; className?: string }) {
  if (kind === "order")
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M4 7.5l8 4.5 8-4.5M12 12v9" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    );
  if (kind === "hunt")
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
        <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    );
  if (kind === "conversation")
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
        <path d="M4.5 6.5A2.5 2.5 0 017 4h10a2.5 2.5 0 012.5 2.5v7A2.5 2.5 0 0117 16h-6.5l-4 3.5V16H7a2.5 2.5 0 01-2.5-2.5v-7z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    );
  if (kind === "draft")
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
        <path d="M5 19h4l10-10-4-4L5 15v4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M4 12.5V5a1 1 0 011-1h7.5L20 11.5 12.5 19 4 12.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
    </svg>
  );
}

function factText(f: ListonCardFact): string {
  if (f.kind === "money") {
    let text: string;
    try {
      text = new Intl.NumberFormat(undefined, { style: "currency", currency: f.currency || "GBP" }).format(f.amount);
    } catch {
      text = `${f.currency} ${f.amount.toFixed(2)}`;
    }
    return f.label ? `${text} ${f.label}` : text;
  }
  if (f.kind === "date") return new Date(f.at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return f.text;
}

export function ListonCardView({ card, compact = false, onRemove, tone = "light" }: { card: ListonCard; compact?: boolean; onRemove?: () => void; tone?: "light" | "onBrand" }) {
  const shell = `group/card relative flex w-full max-w-[380px] items-stretch gap-3 overflow-hidden rounded-xl border text-left ${
    tone === "onBrand" ? "border-white/25 bg-white text-[var(--color-ink)]" : "border-[var(--color-line)] bg-[var(--color-panel)]"
  } ${compact ? "p-2" : "p-2.5"}`;
  const remove = onRemove && (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onRemove();
      }}
      aria-label="Take this card off"
      className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-panel)]/90 text-[var(--color-muted)] shadow-sm hover:text-rose-600"
    >
      <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
        <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </button>
  );

  if (card.locked || card.gone) {
    return (
      <div className={`${shell} items-center`}>
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--color-paper)] text-[var(--color-muted)]">
          {card.locked ? (
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
              <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <path d="M8 11V8a4 4 0 118 0v3" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          ) : (
            <KindIcon kind={card.kind} />
          )}
        </span>
        <p className="min-w-0 flex-1 text-[12.5px] text-[var(--color-muted)]">
          {card.locked ? `You don't have access to this ${KIND_LABEL[card.kind].toLowerCase()}` : `This ${KIND_LABEL[card.kind].toLowerCase()} is no longer in Liston`}
        </p>
        {remove}
      </div>
    );
  }

  const facts = card.facts.map(factText).filter(Boolean);
  return (
    <a href={card.url} target="_blank" rel="noopener" className={`${shell} transition-colors hover:border-[var(--color-primary)]/50`} title={`Open in ${card.account.label || "its account"} (new tab)`}>
      <span className={`flex flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-paper)] text-[var(--color-muted)] ${compact ? "h-11 w-11" : "h-14 w-14"}`}>
        {card.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.image} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <KindIcon kind={card.kind} className="h-5 w-5" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          <KindIcon kind={card.kind} className="h-3 w-3" />
          {KIND_LABEL[card.kind]}
          {card.account.label && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate normal-case tracking-normal text-[var(--color-ink)]">{card.account.label}</span>
            </>
          )}
        </span>
        <span className={`mt-0.5 block font-medium leading-snug text-[var(--color-ink)] group-hover/card:text-[var(--color-primary)] ${compact ? "truncate text-[12.5px]" : "line-clamp-2 text-[13px]"}`}>{card.title}</span>
        {card.kind === "conversation" ? (
          // The item it's about, then its last message.
          <>
            {facts[0] && <span className="mt-0.5 block truncate text-[11.5px] text-[var(--color-muted)]">{facts[0]}</span>}
            {facts[1] && <span className="mt-0.5 block truncate text-[11.5px] italic text-[var(--color-muted)]">&ldquo;{facts[1]}&rdquo;</span>}
          </>
        ) : (
          <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-[var(--color-muted)]">
            {card.status && <span className={`inline-flex h-[18px] items-center rounded px-1.5 text-[10.5px] font-semibold ring-1 ring-inset ${TONE[card.status.tone] || TONE.muted}`}>{card.status.label}</span>}
            <span className="min-w-0 truncate">{facts.join(" · ")}</span>
          </span>
        )}
      </span>
      {remove}
    </a>
  );
}
