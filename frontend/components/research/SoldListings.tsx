"use client";

import { ResearchSales } from "@/lib/api";
import { formatShortDate } from "@/lib/format";
import { bigMoney, count, money } from "./format";

// What sold for the search in the last 90 days, from eBay's sales history
// (Marketplace Insights), the way eBay's own research shows it: the figures
// across every sale, then each listing with its last sold price, how many
// sold and when. A listing eBay took down carries eBay's banner and can't
// be opened. Until eBay grants the API, it says what's needed.

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="truncate text-[17px] font-semibold leading-tight tracking-tight tabular-nums text-[var(--color-ink)]">{value}</p>
      <p className="mt-1 truncate text-[12px] text-[var(--color-muted)]">{label}</p>
    </div>
  );
}

export function SoldListings({ sales, currency }: { sales: ResearchSales; currency: string }) {
  if (!sales.available) {
    return (
      <div className="flex flex-col items-center px-6 py-12 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-paper)] text-[var(--color-muted)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
            <rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
            <path d="M8 10V7a4 4 0 118 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
        <p className="mt-3 text-[14px] font-semibold text-[var(--color-ink)]">Sold history needs eBay&apos;s approval</p>
        <p className="mt-1 max-w-lg text-[13px] leading-relaxed text-[var(--color-muted)]">
          What sold in the last 90 days, and which of those listings eBay removed for a policy violation, come from eBay&apos;s Marketplace Insights API. eBay hasn&apos;t granted it
          to Liston yet; this switches on by itself the day it does.
        </p>
      </div>
    );
  }
  if (sales.failed) {
    return <p className="px-4 py-10 text-center text-[13px] text-[var(--color-muted)]">eBay&apos;s sales history couldn&apos;t be read just now. Try the search again in a moment.</p>;
  }
  const s = sales.summary;
  const items = [...sales.items].sort((a, b) => (b.state === "removed" ? 1 : 0) - (a.state === "removed" ? 1 : 0) || (b.sold ?? 0) - (a.sold ?? 0));
  return (
    <>
      <div className="grid grid-cols-2 divide-[var(--color-line)] border-b border-[var(--color-line)] sm:grid-cols-3 xl:grid-cols-6 xl:divide-x">
        <Figure label="Average sold price" value={money(s.averagePrice, currency)} />
        <Figure label="Sold price range" value={s.price ? `${money(s.price.min, currency)} – ${money(s.price.max, currency)}` : "—"} />
        <Figure label={`Sold in ${sales.days} days`} value={count(s.sold)} />
        <Figure label="Sales" value={bigMoney(s.sales, currency)} />
        <Figure label="Sellers" value={count(s.sellers)} />
        <Figure label="Removed by eBay" value={count(s.removed)} />
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-10 text-center text-[13px] text-[var(--color-muted)]">Nothing sold for this search in the last {sales.days} days.</p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="bg-[var(--color-paper)] text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
              <tr>
                <th className="px-4 py-2">Listing</th>
                <th className="px-3 py-2 text-right">Last sold price</th>
                <th className="px-3 py-2 text-right">Sold</th>
                <th className="px-3 py-2 text-right">Sales</th>
                <th className="px-4 py-2">Last sold</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {items.map((item, i) => {
                const removed = item.state === "removed";
                const landed = item.price === null ? null : item.price + (item.shipping ?? 0);
                return (
                  <SoldRow key={item.itemId ?? i} removed={removed} url={removed ? null : item.url}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        {item.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={item.image} alt="" loading="lazy" className={`h-12 w-12 shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-contain ${removed ? "opacity-60 grayscale" : ""}`} />
                        ) : (
                          <span className="h-12 w-12 shrink-0 rounded-lg border border-dashed border-[var(--color-line)]" />
                        )}
                        <div className="min-w-0 max-w-[460px]">
                          {item.url && !removed ? (
                            <a href={item.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="line-clamp-2 font-medium text-[var(--color-ink)] hover:text-[var(--color-primary)] hover:underline">
                              {item.title}
                            </a>
                          ) : (
                            <p className={`line-clamp-2 font-medium ${removed ? "text-[var(--color-muted)]" : "text-[var(--color-ink)]"}`}>{item.title || `Item ${item.legacyItemId}`}</p>
                          )}
                          <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">
                            {[item.seller, removed ? `Item ${item.legacyItemId}` : null, item.state === "ended" ? "Ended" : null].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-[var(--color-ink)]">{money(landed, item.currency ?? currency)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-ink)]">{item.sold === null ? "—" : count(item.sold)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-ink)]">{landed !== null && item.sold !== null ? bigMoney(landed * item.sold, item.currency ?? currency) : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-[var(--color-muted)]">{item.lastSoldAt ? formatShortDate(item.lastSoldAt) : "—"}</td>
                  </SoldRow>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// A sold listing's row (a click opens it on eBay); one eBay removed gets
// eBay's banner above it and can't be opened.
function SoldRow({ removed, url, children }: { removed: boolean; url: string | null; children: React.ReactNode }) {
  if (!removed)
    return (
      <tr onClick={() => url && window.open(url, "_blank", "noopener,noreferrer")} title={url ? "Open on eBay" : undefined} className={`align-middle hover:bg-[var(--color-paper)]/60 ${url ? "cursor-pointer" : ""}`}>
        {children}
      </tr>
    );
  return (
    <>
      <tr className="bg-rose-50">
        <td colSpan={5} className="px-4 py-2">
          <p className="flex items-center gap-2 text-[12.5px] font-medium text-rose-800">
            <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-rose-600" aria-hidden>
              <circle cx="10" cy="10" r="8" fill="currentColor" />
              <path d="M10 5.8v5M10 13.6v.4" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
            This listing has been removed for a policy violation.
          </p>
        </td>
      </tr>
      <tr className="align-middle">{children}</tr>
    </>
  );
}
