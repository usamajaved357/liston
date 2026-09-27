"use client";

import { DiscoverSubjectRef, DiscoverWatchList } from "@/lib/api";
import { count, money } from "@/components/research/format";
import { ago } from "@/components/hunting/HuntBits";
import { perMonth, ScoreBadge } from "./discover-ui";

// The categories and keywords the team watches on this account: read again
// every night, so each shows what its leading listings sold lately (the
// difference between two days' readings) and which of them are rising.

export function DiscoverWatchlist({
  data,
  onOpen,
  onRemove,
  removing,
}: {
  data: DiscoverWatchList;
  onOpen: (subject: DiscoverSubjectRef) => void;
  onRemove: (id: string) => void;
  removing: string | null;
}) {
  const currency = data.market.currency;
  if (!data.items.length) {
    return (
      <div className="card px-6 py-10 text-center">
        <p className="text-[13.5px] font-semibold text-[var(--color-ink)]">Nothing watched yet</p>
        <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-[var(--color-muted)]">
          Open a category or keyword in Explore and press Watch. Liston reads it again every night, so after a day or two you see what its leading listings sold lately and
          which are taking off.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-[var(--color-muted)]">
        {data.items.length} of {data.limit} watched · read again every night
      </p>
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {data.items.map((w) => {
          const subject: DiscoverSubjectRef = w.kind === "category" ? { categoryId: w.value } : { q: w.value };
          return (
            <li key={w.id} className="card flex min-w-0 flex-col px-4 py-3.5">
              <div className="flex items-start gap-3">
                <button type="button" onClick={() => onOpen(subject)} className="group min-w-0 flex-1 text-left">
                  <span className="block text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">{w.kind === "category" ? "Category" : "Keyword"}</span>
                  <span className="block truncate text-[13.5px] font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{w.label}</span>
                </button>
                {w.opportunity && <ScoreBadge score={w.opportunity.score} band={w.opportunity.band} size="sm" />}
                <button
                  type="button"
                  onClick={() => onRemove(w.id)}
                  disabled={removing === w.id}
                  aria-label={`Stop watching ${w.label}`}
                  title="Stop watching"
                  className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-danger)] disabled:opacity-50"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
              {w.figures ? (
                <p className="mt-1.5 text-[12px] text-[var(--color-muted)]">
                  {count(w.figures.total)} live · {perMonth(w.figures.medianPerMonth)} · {w.figures.selling} of {w.figures.read} sell
                  {w.figures.price !== null && ` · ${money(w.figures.price, currency)}`}
                </p>
              ) : (
                <p className="mt-1.5 text-[12px] text-[var(--color-muted)]">Read tonight for the first time.</p>
              )}
              <p className={`mt-2 text-[12.5px] ${w.recent ? "text-emerald-800" : "text-[var(--color-muted)]"}`}>
                {w.recent ? (
                  <>
                    <span className="font-semibold tabular-nums">{count(w.recent.sold)} sold</span> in the last {w.recent.days} day{w.recent.days === 1 ? "" : "s"} across {w.recent.listings} listings
                  </>
                ) : (
                  "Recent sales show after its second daily reading."
                )}
              </p>
              {w.rising && w.rising.length > 0 && (
                <ul className="mt-2 space-y-1.5 border-t border-[var(--color-line)] pt-2">
                  {w.rising.map((l) => (
                    <li key={l.itemId} className="flex items-center gap-2 text-[12px]">
                      {l.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={l.image} alt="" loading="lazy" className="h-7 w-7 shrink-0 rounded border border-[var(--color-line)] bg-white object-contain" />
                      ) : (
                        <span className="h-7 w-7 shrink-0 rounded border border-dashed border-[var(--color-line)]" />
                      )}
                      <a href={l.url || undefined} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-[var(--color-ink)] hover:text-[var(--color-primary)]">
                        {l.title}
                      </a>
                      <span className="shrink-0 font-semibold tabular-nums text-emerald-700">
                        {l.recent ? `${count(l.recent.sold)} in ${l.recent.days}d` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-auto pt-2 text-[11px] text-[var(--color-muted)]">
                {w.createdBy ? `Added by ${w.createdBy}` : "Added"} {ago(w.createdAt)}
                {w.lastReadAt && ` · read ${ago(w.lastReadAt)}`}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
