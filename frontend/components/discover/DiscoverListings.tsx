"use client";

import { DiscoverListing } from "@/lib/api";
import { age, count, flag, money } from "@/components/research/format";
import { DeliveryText, FlagTag, HuntIcon, perMonth, Thumb } from "./discover-ui";

// "Selling now": a category's or keyword's leading listings, the ones whose
// sold count was read fastest first. A table on a laptop (like Analytics'
// listings), a card each on a phone: how fast it sells (over the time it's
// been live, and lately when Discover has two readings), its best option,
// its price and delivery next to the account's, and a way to hunt it.

function BestOption({ listing }: { listing: DiscoverListing }) {
  const best = listing.options?.find((o) => o.sold > 0);
  if (!best) return <span className="text-[var(--color-muted)]">{listing.optionCount ? `${listing.optionCount} options` : "—"}</span>;
  const share = listing.sold ? Math.round((best.sold / listing.sold) * 100) : null;
  return (
    <span className="block min-w-0" title={listing.options!.map((o) => `${o.label}: ${count(o.sold)}`).join("\n")}>
      <span className="block truncate text-[var(--color-ink)]">{best.label}</span>
      <span className="block text-[11px] text-[var(--color-muted)]">
        {count(best.sold)} sold{share !== null && ` · ${share}%`}
        {listing.optionCount > 1 && ` · ${listing.optionCount} options`}
      </span>
    </span>
  );
}

function Pace({ l, top }: { l: DiscoverListing; top: number }) {
  if (l.sold === null) return <span className="text-[12px] text-[var(--color-muted)]">Not read</span>;
  return (
    <div className="ml-auto w-[96px] text-right">
      <p className="text-[13px] font-semibold tabular-nums text-[var(--color-ink)]">{perMonth(l.soldPerMonth)}</p>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--color-paper)]">
        <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${Math.max(l.soldPerMonth ? 4 : 0, ((l.soldPerMonth || 0) / top) * 100)}%` }} />
      </div>
      <p className="mt-0.5 text-[11px] tabular-nums text-[var(--color-muted)]">
        {count(l.sold)} sold
        {l.recent && <span className="font-medium text-emerald-700"> · {count(l.recent.sold)} in {l.recent.days}d</span>}
      </p>
    </div>
  );
}

function HuntButton({ url, onHunt }: { url: string; onHunt: (url: string) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onHunt(url);
      }}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-2.5 text-[12px] font-semibold text-[var(--color-ink)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
      title="Hunt this product: check it against an AliExpress supplier"
    >
      <HuntIcon />
      Hunt
    </button>
  );
}

export function DiscoverListings({ listings, currency, risingIds, onHunt }: { listings: DiscoverListing[]; currency: string; risingIds: Set<string>; onHunt?: (url: string) => void }) {
  const top = Math.max(1, ...listings.map((l) => l.soldPerMonth || 0));
  const meta = (l: DiscoverListing) => (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-[var(--color-muted)]">
      {l.seller?.username && <span className="max-w-[160px] truncate">{l.seller.username}</span>}
      {l.country && (
        <span title={`Ships from ${l.country}`}>
          · {flag(l.country)} {l.country}
        </span>
      )}
      {l.daysLive !== null && <span>· {age(l.daysLive)} live</span>}
      {l.flag && <FlagTag flag={l.flag} />}
      {risingIds.has(l.itemId) && (
        <span className="rounded bg-emerald-50 px-1.5 font-semibold text-emerald-700" title="Selling faster lately than over its life">
          Rising{l.lift ? ` ${l.lift}×` : ""}
        </span>
      )}
    </p>
  );
  const title = (l: DiscoverListing) =>
    l.url ? (
      <a href={l.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="line-clamp-2 font-medium leading-snug text-[var(--color-ink)] hover:text-[var(--color-primary)] hover:underline" title="Open on eBay">
        {l.title}
      </a>
    ) : (
      <p className="line-clamp-2 font-medium leading-snug text-[var(--color-ink)]">{l.title}</p>
    );

  return (
    <>
      {/* A phone: one card per listing. */}
      <ul className="divide-y divide-[var(--color-line)] md:hidden">
        {listings.map((l) => (
          <li key={l.itemId} className="px-4 py-3 text-[13px]">
            <div className="flex items-start gap-3">
              <Thumb src={l.image} size={48} />
              <div className="min-w-0 flex-1">
                {title(l)}
                {meta(l)}
              </div>
            </div>
            <div className="mt-2 flex items-end gap-3 pl-[3.75rem]">
              <div className="min-w-0 flex-1 text-[12px] leading-snug">
                <p>
                  <span className="font-semibold tabular-nums text-[var(--color-ink)]">{money(l.price?.value, l.price?.currency ?? currency)}</span>
                  <span className="text-[var(--color-muted)]">{l.shipping?.free ? " · free postage" : l.shipping ? ` + ${money(l.shipping.cost, currency)}` : ""}</span>
                </p>
                <p className="text-[11.5px]">
                  <DeliveryText delivery={l.delivery} />
                </p>
              </div>
              <Pace l={l} top={top} />
            </div>
            {(l.options?.some((o) => o.sold > 0) || (onHunt && l.url)) && (
              <div className="mt-2 flex items-center gap-3 pl-[3.75rem] text-[12px]">
                <div className="min-w-0 flex-1">{l.options?.some((o) => o.sold > 0) && <BestOption listing={l} />}</div>
                {onHunt && l.url && <HuntButton url={l.url} onHunt={onHunt} />}
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* A laptop: a table. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[820px] table-fixed text-[12.5px]">
          <thead className="whitespace-nowrap bg-[var(--color-paper)] text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            <tr>
              <th className="w-[38%] px-4 py-2 text-left">Listing</th>
              <th className="px-3 py-2 text-right">Price</th>
              <th className="px-3 py-2 text-left">Delivery</th>
              <th className="w-[18%] px-3 py-2 text-left">Best option</th>
              <th className="px-3 py-2 text-right">Sales</th>
              <th className="w-[104px] px-4 py-2 text-right">
                <span className="sr-only">Hunt</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {listings.map((l) => (
              <tr key={l.itemId} className="align-middle hover:bg-[var(--color-paper)]/60">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <Thumb src={l.image} size={44} />
                    <div className="min-w-0">
                      {title(l)}
                      {meta(l)}
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  <span className="font-semibold text-[var(--color-ink)]">{money(l.price?.value, l.price?.currency ?? currency)}</span>
                  <span className="block text-[11px] text-[var(--color-muted)]">{l.shipping?.free ? "Free postage" : l.shipping ? `+ ${money(l.shipping.cost, currency)}` : ""}</span>
                </td>
                <td className="px-3 py-2.5 text-[12px]">
                  <DeliveryText delivery={l.delivery} short />
                  <span className="block text-[11px] text-[var(--color-muted)]">
                    {l.delivery.compared === "faster" ? "Faster than you" : l.delivery.compared === "slower" ? "Slower than you" : l.delivery.compared === "similar" ? "Like you" : ""}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-[12px]">
                  <BestOption listing={l} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Pace l={l} top={top} />
                </td>
                <td className="px-4 py-2.5 text-right">{onHunt && l.url && <HuntButton url={l.url} onHunt={onHunt} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
