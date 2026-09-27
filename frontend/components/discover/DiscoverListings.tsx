"use client";

import { DiscoverListing } from "@/lib/api";
import { age, count, flag, money } from "@/components/research/format";
import { DeliveryText, HuntIcon, perMonth } from "./discover-ui";

// "Selling now": a category's or keyword's leading listings, the ones whose
// sold count was read fastest first. Each shows how fast it sells (its
// sales over the time it's been live, and lately when Discover has two
// readings), its best-selling options, its price and delivery next to the
// account's, and a way to hunt it.

function Options({ listing }: { listing: DiscoverListing }) {
  if (!listing.options?.length) return null;
  const shown = listing.options.filter((o) => o.sold > 0).slice(0, 3);
  if (!shown.length) return null;
  const rest = listing.optionCount - shown.length;
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-1">
      <span className="text-[11px] font-medium text-[var(--color-muted)]">Best options</span>
      {shown.map((o) => (
        <span key={o.label} className="inline-flex max-w-[220px] items-center gap-1 rounded-md bg-[var(--color-paper)] px-1.5 py-0.5 text-[11px] text-[var(--color-ink)] ring-1 ring-inset ring-[var(--color-line)]" title={`${o.label}: ${count(o.sold)} sold`}>
          <span className="truncate">{o.label}</span>
          <span className="shrink-0 font-semibold tabular-nums">{count(o.sold)}</span>
        </span>
      ))}
      {rest > 0 && <span className="text-[11px] text-[var(--color-muted)]">+{rest} more</span>}
    </p>
  );
}

export function DiscoverListings({
  listings,
  currency,
  risingIds,
  onHunt,
}: {
  listings: DiscoverListing[];
  currency: string;
  risingIds: Set<string>;
  onHunt?: (url: string) => void;
}) {
  const top = Math.max(1, ...listings.map((l) => l.soldPerMonth || 0));
  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {listings.map((l) => {
        const rising = risingIds.has(l.itemId);
        return (
          <li key={l.itemId} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              {l.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={l.image} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-contain" />
              ) : (
                <span className="h-12 w-12 shrink-0 rounded-lg border border-dashed border-[var(--color-line)]" />
              )}
              <div className="min-w-0 flex-1">
                {l.url ? (
                  <a href={l.url} target="_blank" rel="noreferrer" className="line-clamp-2 text-[13px] font-medium leading-snug text-[var(--color-ink)] hover:text-[var(--color-primary)] hover:underline" title="Open on eBay">
                    {l.title}
                  </a>
                ) : (
                  <p className="line-clamp-2 text-[13px] font-medium leading-snug text-[var(--color-ink)]">{l.title}</p>
                )}
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-[var(--color-muted)]">
                  {l.seller?.username && <span className="truncate">{l.seller.username}</span>}
                  {l.country && (
                    <span title={`Ships from ${l.country}`}>
                      · {flag(l.country)} {l.country}
                    </span>
                  )}
                  {l.daysLive !== null && <span>· {age(l.daysLive)} live</span>}
                  {rising && (
                    <span className="rounded bg-emerald-50 px-1.5 font-semibold text-emerald-700" title="Selling faster lately than over its life">
                      Rising{l.lift ? ` ${l.lift}×` : ""}
                    </span>
                  )}
                </p>
                <Options listing={l} />
              </div>
            </div>
            <div className="flex items-end justify-between gap-4 pl-[3.75rem] sm:w-[330px] sm:shrink-0 sm:items-start sm:pl-0">
              <div className="min-w-0 text-[12px] leading-snug">
                <p>
                  <span className="text-[13.5px] font-semibold tabular-nums text-[var(--color-ink)]">{money(l.price?.value, l.price?.currency ?? currency)}</span>
                  <span className="text-[var(--color-muted)]">{l.shipping?.free ? " · free postage" : l.shipping ? ` + ${money(l.shipping.cost, currency)}` : ""}</span>
                </p>
                <p className="text-[11.5px]">
                  <DeliveryText delivery={l.delivery} />
                </p>
              </div>
              <div className="w-[104px] shrink-0 text-right">
                {l.sold === null ? (
                  <span className="text-[12px] text-[var(--color-muted)]" title="Its sold count isn't read yet">
                    Not read
                  </span>
                ) : (
                  <>
                    <p className="text-[13.5px] font-semibold tabular-nums text-[var(--color-ink)]">{perMonth(l.soldPerMonth)}</p>
                    <p className="text-[11px] tabular-nums text-[var(--color-muted)]">{count(l.sold)} sold</p>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--color-paper)]">
                      <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${Math.max(l.soldPerMonth ? 4 : 0, ((l.soldPerMonth || 0) / top) * 100)}%` }} />
                    </div>
                    {l.recent && (
                      <p className="mt-1 text-[11px] font-medium tabular-nums text-emerald-700" title={`Between ${l.recent.from} and ${l.recent.to}`}>
                        {count(l.recent.sold)} in {l.recent.days} day{l.recent.days === 1 ? "" : "s"}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
            {onHunt && l.url && (
              <div className="flex justify-end sm:pt-0.5">
                <button
                  type="button"
                  onClick={() => onHunt(l.url!)}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-line)] px-2.5 text-[12px] font-semibold text-[var(--color-ink)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                  title="Hunt this product: check it against an AliExpress supplier"
                >
                  <HuntIcon />
                  Hunt this
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
