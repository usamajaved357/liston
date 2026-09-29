"use client";

import Link from "next/link";
import { ResearchItem } from "@/lib/api";
import { formatShortDate } from "@/lib/format";
import { age, bigMoney, count, flag, landed, money } from "./format";
import { MarkBadges } from "./ResearchFilters";

// The listings of a search, one row each: what it sells for, how many it has
// sold and what that came to, when it went live, and the two things to do
// with it — open it on eBay (a click anywhere on the row), or start a draft
// from it.

export type ResearchSort = "best" | "sold" | "revenue" | "price" | "newest";
export const RESEARCH_SORTS: { key: ResearchSort; label: string }[] = [
  { key: "best", label: "Best match" },
  { key: "sold", label: "Most sold" },
  { key: "revenue", label: "Top sales" },
  { key: "price", label: "Lowest price" },
  { key: "newest", label: "Newest" },
];

export function sortResearch(items: ResearchItem[], sort: ResearchSort) {
  return [...items].sort((a, b) => {
    if (sort === "sold") return (b.sold ?? -1) - (a.sold ?? -1);
    if (sort === "revenue") return (b.revenue ?? -1) - (a.revenue ?? -1);
    if (sort === "price") return landed(a) - landed(b);
    if (sort === "newest") return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    return 0;
  });
}

function DraftIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
      <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

// "Hunt": check this listing's profit against a supplier and add it for review.
function HuntGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden>
      <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function ResearchListings({ items, currency, connectionId, maxSold, canHunt = false }: { items: ResearchItem[]; currency: string; connectionId: string; maxSold: number; canHunt?: boolean }) {
  const huntHref = (url: string) => `/accounts/${connectionId}/hunting?competitor=${encodeURIComponent(url)}`;
  return (
    <>
    {/* A phone: one card per listing, the same figures under its title. */}
    <ul className="divide-y divide-[var(--color-line)] md:hidden">
      {items.map((item) => (
        <li key={item.itemId} onClick={() => item.url && window.open(item.url, "_blank", "noopener,noreferrer")} className={`px-4 py-3 active:bg-[var(--color-paper)]/60 ${item.url ? "cursor-pointer" : ""}`}>
          <div className="flex items-start gap-3">
            {item.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.image} alt="" loading="lazy" className="h-14 w-14 shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-contain" />
            ) : (
              <span className="h-14 w-14 shrink-0 rounded-lg border border-dashed border-[var(--color-line)]" />
            )}
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[13.5px] font-medium leading-snug text-[var(--color-ink)]">{item.title}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-[var(--color-muted)]">
                <span className="truncate">{item.seller?.username}</span>
                {item.seller?.feedbackPercentage !== null && item.seller?.feedbackPercentage !== undefined && <span>· {item.seller.feedbackPercentage}%</span>}
                {item.location?.country && (
                  <span>
                    · {flag(item.location.country)} {item.location.country}
                  </span>
                )}
                {item.topRated && <span className="rounded bg-emerald-50 px-1.5 text-[11px] text-emerald-700">Top rated</span>}
              </p>
              {item.marks && (
                <p className="mt-1 flex flex-wrap items-center gap-1">
                  <MarkBadges marks={item.marks} />
                </p>
              )}
            </div>
          </div>
          <div className="mt-2 flex items-end gap-3 pl-[4.25rem]">
            <div className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--color-muted)]">
              <p>
                <span className="text-[14px] font-semibold tabular-nums text-[var(--color-ink)]">{money(item.price?.value, item.price?.currency ?? currency)}</span>
                {item.shipping?.free ? " · free postage" : item.shipping ? ` + ${money(item.shipping.cost, currency)}` : ""}
              </p>
              <p className="tabular-nums">
                {item.sold === null ? "Sold —" : <span className="font-medium text-[var(--color-ink)]">{count(item.sold)} sold</span>}
                {item.sold !== null && item.sold > 0 && item.soldPerMonth !== null && ` · ${item.soldPerMonth}/mo`}
                {item.revenue !== null && ` · ${bigMoney(item.revenue, currency)}`}
                {item.daysLive !== null && item.daysLive !== undefined && ` · ${age(item.daysLive)} live`}
              </p>
            </div>
            {item.url && canHunt && (
              <Link
                href={huntHref(item.url)}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border border-[var(--color-line)] px-3 text-[13px] font-semibold text-[var(--color-ink)]"
              >
                <HuntGlyph />
                Hunt
              </Link>
            )}
            {item.url && (
              <Link
                href={`/accounts/${connectionId}/listings/new?competitor=${encodeURIComponent(item.url)}`}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg bg-[var(--color-primary-soft)] px-3 text-[13px] font-semibold text-[var(--color-primary)]"
              >
                <DraftIcon />
                Draft
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
    <div className="relative hidden overflow-x-auto md:block">
      <table className="w-full min-w-[860px] text-[13px]">
        <thead className="bg-[var(--color-paper)] text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
          <tr>
            <th className="px-4 py-2">Listing</th>
            <th className="px-3 py-2 text-right">Price</th>
            <th className="px-3 py-2 text-right">Sold</th>
            <th className="px-3 py-2 text-right" title="Sold × today's price with postage; eBay doesn't give past sale prices">
              Sales
            </th>
            <th className="px-3 py-2">Listed</th>
            <th className="px-4 py-2 text-right">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-line)]">
          {items.map((item) => (
            <tr
              key={item.itemId}
              onClick={() => item.url && window.open(item.url, "_blank", "noopener,noreferrer")}
              title={item.url ? "Open on eBay" : undefined}
              className={`align-middle hover:bg-[var(--color-paper)]/60 ${item.url ? "cursor-pointer" : ""}`}
            >
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-3">
                  {item.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.image} alt="" loading="lazy" className="h-14 w-14 shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-contain" />
                  ) : (
                    <span className="h-14 w-14 shrink-0 rounded-lg border border-dashed border-[var(--color-line)]" />
                  )}
                  <div className="min-w-0 max-w-[440px]">
                    {item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="line-clamp-2 font-medium text-[var(--color-ink)] hover:text-[var(--color-primary)] hover:underline">
                        {item.title}
                      </a>
                    ) : (
                      <p className="line-clamp-2 font-medium text-[var(--color-ink)]">{item.title}</p>
                    )}
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-[var(--color-muted)]">
                      <span className="truncate">{item.seller?.username}</span>
                      {item.seller?.feedbackPercentage !== null && item.seller?.feedbackPercentage !== undefined && <span>· {item.seller.feedbackPercentage}%</span>}
                      {item.location?.country && (
                        <span title={`Ships from ${item.location.country}`}>
                          · {flag(item.location.country)} {item.location.country}
                        </span>
                      )}
                      {item.hasVariations && <span className="rounded bg-[var(--color-paper)] px-1.5 text-[11px] ring-1 ring-inset ring-[var(--color-line)]">Options</span>}
                      {item.topRated && <span className="rounded bg-emerald-50 px-1.5 text-[11px] text-emerald-700">Top rated</span>}
                    </p>
                    {item.marks && (
                      <p className="mt-1 flex flex-wrap items-center gap-1">
                        <MarkBadges marks={item.marks} />
                      </p>
                    )}
                  </div>
                </div>
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                <span className="font-semibold text-[var(--color-ink)]">{money(item.price?.value, item.price?.currency ?? currency)}</span>
                <span className="block text-[11.5px] text-[var(--color-muted)]">{item.shipping?.free ? "Free postage" : item.shipping ? `+ ${money(item.shipping.cost, currency)}` : ""}</span>
                {item.delivery?.max !== null && item.delivery?.max !== undefined && (
                  <span
                    className={`block text-[11.5px] ${item.delivery.compared === "faster" ? "text-amber-700" : item.delivery.compared === "similar" ? "text-emerald-700" : "text-[var(--color-muted)]"}`}
                    title="Working days until it arrives, per eBay"
                  >
                    {item.delivery.min === item.delivery.max ? `${item.delivery.max}` : `${item.delivery.min}–${item.delivery.max}`} days
                  </span>
                )}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {item.sold === null ? (
                  <span className="text-[var(--color-muted)]" title="Not read yet">
                    —
                  </span>
                ) : (
                  <div className="ml-auto w-24">
                    <span className="font-semibold text-[var(--color-ink)]">{count(item.sold)}</span>
                    {item.sold > 0 && item.soldPerMonth !== null && <span className="text-[11.5px] text-[var(--color-muted)]"> · {item.soldPerMonth}/mo</span>}
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--color-paper)]">
                      <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${maxSold ? Math.max(item.sold ? 4 : 0, (item.sold / maxSold) * 100) : 0}%` }} />
                    </div>
                  </div>
                )}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {item.revenue === null ? <span className="text-[var(--color-muted)]">—</span> : <span className="font-semibold text-[var(--color-ink)]">{bigMoney(item.revenue, currency)}</span>}
              </td>
              <td className="px-3 py-2.5 whitespace-nowrap">
                {item.createdAt ? (
                  <>
                    <span className="text-[var(--color-ink)]">{formatShortDate(item.createdAt)}</span>
                    <span className="block text-[11.5px] text-[var(--color-muted)]">{age(item.daysLive)} live</span>
                  </>
                ) : (
                  <span className="text-[var(--color-muted)]">—</span>
                )}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex items-center justify-end gap-1.5">
                  {item.url && canHunt && (
                    <Link
                      href={huntHref(item.url)}
                      onClick={(e) => e.stopPropagation()}
                      title="Check this listing's profit against a supplier and add it for review"
                      className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--color-line)] px-2.5 text-[12.5px] font-semibold text-[var(--color-ink)] hover:border-[var(--color-line-strong)]"
                    >
                      <HuntGlyph />
                      Hunt
                    </Link>
                  )}
                  {item.url && (
                    <Link
                      href={`/accounts/${connectionId}/listings/new?competitor=${encodeURIComponent(item.url)}`}
                      onClick={(e) => e.stopPropagation()}
                      title="Start a Liston draft from this listing"
                      className="inline-flex h-8 items-center gap-1 rounded-lg bg-[var(--color-primary-soft)] px-2.5 text-[12.5px] font-semibold text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white"
                    >
                      <DraftIcon />
                      Draft
                    </Link>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}
