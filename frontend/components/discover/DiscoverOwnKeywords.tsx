"use client";

import { DiscoverOwnKeywords as OwnKeywords, DiscoverSubjectRef } from "@/lib/api";
import { count } from "@/components/research/format";

// Which words in the account's own titles bring impressions, clicks and
// sales, from its stored traffic (the Analytics tab's figures). No eBay
// search: a hint at what to hunt more of.

export function DiscoverOwnKeywords({ data, onOpen }: { data: OwnKeywords; onOpen: (subject: DiscoverSubjectRef) => void }) {
  if (data.status !== "ok") {
    return (
      <div className="card px-6 py-10 text-center">
        <p className="text-[13.5px] font-semibold text-[var(--color-ink)]">Traffic isn&apos;t available for this account yet</p>
        <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">Your keywords come from the listings&apos; traffic on the Analytics tab. They show once eBay&apos;s traffic has been read.</p>
      </div>
    );
  }
  if (!data.keywords.length) {
    return (
      <div className="card px-6 py-10 text-center">
        <p className="text-[13.5px] font-semibold text-[var(--color-ink)]">No keyword stands out yet</p>
        <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">A keyword needs at least two of your listings with sales or traffic in these dates.</p>
      </div>
    );
  }
  const top = Math.max(1, ...data.keywords.map((k) => k.sold));
  return (
    <section className="card overflow-hidden">
      <div className="px-4 pb-2.5 pt-3.5">
        <h3 className="text-[13.5px] font-semibold text-[var(--color-ink)]">Your keywords</h3>
        <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">
          The words in your own titles: what their listings sold (all {data.listings}), and the traffic of the {data.measured} eBay measured. Click one to explore it on eBay.
        </p>
      </div>
      <div className="overflow-x-auto border-t border-[var(--color-line)]">
        <table className="w-full min-w-[620px] table-fixed text-[12.5px]">
          <thead className="bg-[var(--color-paper)] text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            <tr>
              <th className="w-[34%] px-4 py-2 text-left">Keyword</th>
              <th className="px-3 py-2 text-right">Listings</th>
              <th className="px-3 py-2 text-right">Impressions</th>
              <th className="px-3 py-2 text-right">Clicks</th>
              <th className="px-3 py-2 text-right" title="Clicks (listing views) over impressions">
                Click rate
              </th>
              <th className="px-3 py-2 text-right">Sold</th>
              <th className="px-4 py-2 text-right" title="Sold over clicks">
                Converts
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {data.keywords.map((k) => (
              <tr key={k.term} className="hover:bg-[var(--color-paper)]/60">
                <td className="px-4 py-2">
                  <button type="button" onClick={() => onOpen({ q: k.term })} className="block max-w-full truncate text-left font-medium text-[var(--color-ink)] hover:text-[var(--color-primary)] hover:underline" title={`Explore “${k.term}” on eBay`}>
                    {k.term}
                  </button>
                  <span className="mt-1 block h-1 overflow-hidden rounded-full bg-[var(--color-paper)]">
                    <span className="block h-full rounded-full bg-[var(--color-primary)]/70" style={{ width: `${(k.sold / top) * 100}%` }} />
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{k.listings}</td>
                <td className="px-3 py-2 text-right tabular-nums">{k.measured ? count(k.impressions) : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{k.measured ? count(k.views) : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{k.ctr === null ? "—" : `${k.ctr}%`}</td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums ${k.sold ? "text-emerald-700" : "text-[var(--color-muted)]"}`}>{count(k.sold)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{k.conversion === null ? "—" : `${k.conversion}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
