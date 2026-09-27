"use client";

import { DiscoverSubjectRef, DiscoverWatchList } from "@/lib/api";
import { count, money } from "@/components/research/format";
import { ago } from "@/components/hunting/HuntBits";
import { CardHeader, Chevron, perMonth, Quiet, ScoreBadge, Thumb } from "./discover-ui";

// The categories and keywords the team watches on this account, read again
// every night: each with its opportunity, its leading listings' sales, what
// they sold lately (the difference between two days' readings) and which
// of them are rising.

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
  return (
    <section className="card overflow-hidden">
      <div className="p-4 pb-3">
        <CardHeader title="Watchlist" note={`${data.items.length} of ${data.limit} watched · Liston reads each one again every night, so its recent sales and rising listings build up`} />
      </div>
      {!data.items.length ? (
        <div className="border-t border-[var(--color-line)] px-4">
          <Quiet>Nothing watched yet. Open a category or keyword and press Watch.</Quiet>
        </div>
      ) : (
        <div className="overflow-x-auto border-t border-[var(--color-line)]">
          <table className="w-full min-w-[820px] table-fixed text-[12.5px]">
            <thead className="bg-[var(--color-paper)] text-left text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              <tr>
                <th className="w-[28%] px-4 py-2">Watching</th>
                <th className="px-3 py-2">Opportunity</th>
                <th className="px-3 py-2 text-right">Monthly sales</th>
                <th className="px-3 py-2 text-right">Lately</th>
                <th className="px-3 py-2 text-right">Live</th>
                <th className="w-[20%] px-3 py-2">Rising</th>
                <th className="w-[52px] px-4 py-2">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {data.items.map((w) => {
                const subject: DiscoverSubjectRef = w.kind === "category" ? { categoryId: w.value } : { q: w.value };
                return (
                  <tr key={w.id} className="align-middle hover:bg-[var(--color-paper)]/60">
                    <td className="px-4 py-2.5">
                      <button type="button" onClick={() => onOpen(subject)} className="group block max-w-full text-left">
                        <span className="flex items-center gap-1.5 font-medium text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">
                          <span className="truncate">{w.kind === "keyword" ? `“${w.label}”` : w.label}</span>
                          <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-line-strong)]" />
                        </span>
                        <span className="block truncate text-[11px] text-[var(--color-muted)]">
                          {w.kind === "keyword" ? "Keyword" : "Category"} · {w.createdBy ? `added by ${w.createdBy}` : "added"} {ago(w.createdAt)}
                          {w.lastReadAt && ` · read ${ago(w.lastReadAt)}`}
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-2.5">{w.opportunity ? <ScoreBadge score={w.opportunity.score} band={w.opportunity.band} size="sm" /> : <span className="text-[11.5px] text-[var(--color-muted)]">Read tonight</span>}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {w.figures ? (
                        <>
                          <span className="font-semibold text-[var(--color-ink)]">{perMonth(w.figures.medianPerMonth)}</span>
                          <span className="block text-[11px] text-[var(--color-muted)]">
                            middle listing{w.figures.price !== null && ` · ${money(w.figures.price, currency)}`}
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {w.recent ? (
                        <>
                          <span className="font-semibold text-emerald-700">{count(w.recent.sold)} sold</span>
                          <span className="block text-[11px] text-[var(--color-muted)]">
                            in {w.recent.days} day{w.recent.days === 1 ? "" : "s"}
                          </span>
                        </>
                      ) : (
                        <span className="text-[11.5px] text-[var(--color-muted)]">After 2 readings</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{w.figures ? count(w.figures.total) : "—"}</td>
                    <td className="px-3 py-2.5">
                      {w.rising && w.rising.length ? (
                        <span className="flex items-center gap-1">
                          {w.rising.map((l) => (
                            <a key={l.itemId} href={l.url || undefined} target="_blank" rel="noreferrer" title={`${l.title}${l.recent ? `: ${l.recent.sold} sold in ${l.recent.days} days` : ""}`}>
                              <Thumb src={l.image} size={28} />
                            </a>
                          ))}
                        </span>
                      ) : (
                        <span className="text-[11.5px] text-[var(--color-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => onRemove(w.id)}
                        disabled={removing === w.id}
                        aria-label={`Stop watching ${w.label}`}
                        title="Stop watching"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-danger)] disabled:opacity-50"
                      >
                        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                          <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
