"use client";

import { DiscoverProduct, DiscoverSubjectRef } from "@/lib/api";
import { count, money } from "@/components/research/format";
import { Chevron, FlagTag, HuntIcon, Quiet, ScoreBadge, Thumb } from "./discover-ui";

// Products, the way a hunter reads them: the same product under several
// sellers grouped into one row, with its combined sales a month, how many
// sellers make a living from it, what buyers pay, how much of its sales
// come from sellers delivering like this account (whether a dropshipper
// can compete), whether it's rising or new, a score out of 100, and why.
// Shared by a subject's page and Winners (where each row says where it
// was found).

const MOMENTUM: Record<DiscoverProduct["momentum"], { label: string; cls: string } | null> = {
  rising: { label: "Rising", cls: "bg-emerald-50 text-emerald-700" },
  new: { label: "New", cls: "bg-sky-50 text-sky-700" },
  steady: null,
  quiet: null,
};

// What the owner already has of it, and how many other Liston sellers hunt it (never who).
function Marks({ product }: { product: DiscoverProduct }) {
  if (!product.mine && !product.crowd && !product.risk) return null;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5">
      {product.risk && (
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ring-1 ring-inset ${product.risk.level === "bad" ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-amber-50 text-amber-800 ring-amber-200"}`} title={product.risk.text}>
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />
          {product.risk.kind === "vero" ? "VeRO risk" : product.risk.kind === "refused" ? "eBay refused one like it" : "Rejected before for brand risk"}
        </span>
      )}
      {product.mine && (
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ring-1 ring-inset ${product.mine.kind === "similar" ? "bg-slate-50 text-slate-700 ring-slate-200" : "bg-indigo-50 text-indigo-700 ring-indigo-200"}`} title="Already on your accounts">
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />
          Yours · {product.mine.text}
        </span>
      )}
      {product.crowd ? (
        <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200" title="Other Liston sellers hunted it in the last two weeks; who isn't shown">
          {product.crowd} other Liston sellers hunting it
        </span>
      ) : null}
    </span>
  );
}

function Reasons({ reasons }: { reasons: DiscoverProduct["reasons"] }) {
  return (
    <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
      {reasons.map((r) => (
        <li key={r.text} className="flex items-center gap-1 text-[11px] leading-snug text-[var(--color-muted)]">
          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${r.good === true ? "bg-emerald-500" : r.good === false ? "bg-rose-400" : "bg-slate-300"}`} aria-hidden />
          {r.text}
        </li>
      ))}
    </ul>
  );
}

// What the sold count was sold in ("in 26 days", "in 5 months"), so it isn't read as a second monthly figure:
// under a month the two are the same number, since a listing counts as a month old at least.
function soldIn(days: number | null | undefined): string {
  if (days === null || days === undefined) return "";
  if (days < 1) return " today";
  if (days < 60) return ` in ${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`;
  if (days < 730) return ` in ${Math.round(days / 30)} months`;
  return ` in ${Math.round(days / 365)} years`;
}

export function DiscoverProducts({
  products,
  currency,
  onHunt,
  onOpen,
  showFrom = false,
  empty,
}: {
  products: DiscoverProduct[];
  currency: string;
  onHunt: (url: string) => void;
  onOpen?: (subject: DiscoverSubjectRef) => void;
  showFrom?: boolean;
  empty: string;
}) {
  if (!products.length) {
    return (
      <div className="px-4">
        <Quiet>{empty}</Quiet>
      </div>
    );
  }
  return (
    <>
      {/* A phone: a card per product. */}
      <ul className="divide-y divide-[var(--color-line)] md:hidden">
        {products.map((p, i) => (
          <li key={p.key} className="px-4 py-3">
            <div className="flex items-start gap-3">
              <span className="relative flex-shrink-0">
                <Thumb src={p.image} size={48} />
                <span className="absolute -left-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-ink)] px-1 text-[10.5px] font-semibold text-white">{i + 1}</span>
              </span>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[13px] font-medium leading-snug text-[var(--color-ink)]">{p.name}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-[var(--color-muted)]">
                  <span className="font-semibold text-[var(--color-ink)]">{count(Math.round(p.perMonth))}/mo</span>
                  <span>· {p.selling} of {p.sellers} sellers selling</span>
                  {p.price && <span>· {money(p.price.median, currency)}</span>}
                  {MOMENTUM[p.momentum] && <span className={`rounded px-1.5 font-semibold ${MOMENTUM[p.momentum]!.cls}`}>{MOMENTUM[p.momentum]!.label}</span>}
                  <FlagTag flag={p.flag} />
                </p>
                <Marks product={p} />
              </div>
              <ScoreBadge score={p.score} band={p.band} size="sm" />
            </div>
            <div className="pl-[3.75rem]">
              <Reasons reasons={p.reasons} />
              <div className="mt-2 flex items-center justify-between gap-2">
                {showFrom && p.from && onOpen ? (
                  <button type="button" onClick={() => onOpen(p.from!.kind === "category" ? { categoryId: p.from!.value } : { q: p.from!.value })} className="truncate text-[11.5px] text-[var(--color-primary)] hover:underline">
                    Found in {p.from.kind === "keyword" ? `“${p.from.name}”` : p.from.name}
                  </button>
                ) : (
                  <span />
                )}
                {p.url && (
                  <button type="button" onClick={() => onHunt(p.url!)} className="btn btn-primary btn-sm !h-8 gap-1.5 !text-[12px]">
                    <HuntIcon />
                    Hunt
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* A laptop: a table. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[960px] table-fixed text-[12.5px]">
          <thead className="whitespace-nowrap bg-[var(--color-paper)] text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            <tr>
              <th className="w-[44%] px-4 py-2 text-left">Product</th>
              <th className="w-[11%] px-3 py-2 text-center">Score</th>
              <th className="px-3 py-2 text-center" title="What its listings sell between them a month">
                Sales a month
              </th>
              <th className="px-3 py-2 text-center" title="Sellers selling it every month, of all its sellers among the leading listings">
                Sellers
              </th>
              <th className="px-3 py-2 text-center" title="What buyers pay with postage: the middle listing, and the range">
                Price
              </th>
              <th className="px-3 py-2 text-center" title="How much of its sales come from sellers delivering like you or slower">
                You can match
              </th>
              <th className="w-[88px] px-3 py-2 text-center">
                <span className="sr-only">Hunt</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {products.map((p, i) => (
              <tr key={p.key} className="align-top hover:bg-[var(--color-paper)]/60">
                <td className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <span className="relative flex-shrink-0">
                      <Thumb src={p.image} size={48} />
                      <span className="absolute -left-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-ink)] px-1 text-[10.5px] font-semibold text-white">{i + 1}</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5">
                        {p.url ? (
                          <a href={p.url} target="_blank" rel="noreferrer" className="line-clamp-1 font-medium leading-snug text-[var(--color-ink)] hover:text-[var(--color-primary)] hover:underline" title="Open its leading listing on eBay">
                            {p.name}
                          </a>
                        ) : (
                          <span className="line-clamp-1 font-medium leading-snug text-[var(--color-ink)]">{p.name}</span>
                        )}
                        {MOMENTUM[p.momentum] && <span className={`flex-shrink-0 rounded px-1.5 text-[10.5px] font-semibold ${MOMENTUM[p.momentum]!.cls}`}>{MOMENTUM[p.momentum]!.label}</span>}
                        <FlagTag flag={p.flag} />
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--color-muted)]">
                        <span>
                          {p.listings} listing{p.listings === 1 ? "" : "s"} among the leading ones
                        </span>
                        {p.category && <span>· {p.category}</span>}
                        {showFrom && p.from && onOpen && (
                          <button type="button" onClick={() => onOpen(p.from!.kind === "category" ? { categoryId: p.from!.value } : { q: p.from!.value })} className="inline-flex items-center gap-0.5 text-[var(--color-primary)] hover:underline">
                            · found in {p.from.kind === "keyword" ? `“${p.from.name}”` : p.from.name}
                            <Chevron className="h-3 w-3" />
                          </button>
                        )}
                      </p>
                      <Marks product={p} />
                      <Reasons reasons={p.reasons} />
                    </div>
                  </div>
                </td>
                <td className="px-3 py-3 text-center">
                  <ScoreBadge score={p.score} band={p.band} size="sm" />
                </td>
                <td className="px-3 py-3 text-center tabular-nums">
                  <span className="font-semibold text-[var(--color-ink)]">{count(Math.round(p.perMonth))}</span>
                  <span className="block text-[11px] text-[var(--color-muted)]" title="Sold in all since its oldest listing started">
                    {count(p.sold)} sold{soldIn(p.oldestDays)}
                  </span>
                  {p.recent && p.recent.days >= 2 && (
                    <span className="block text-[11px] font-medium text-emerald-700">
                      {count(p.recent.sold)} in {p.recent.days}d
                    </span>
                  )}
                </td>
                <td className="px-3 py-3 text-center tabular-nums">
                  <span className={`font-semibold ${p.selling >= 2 ? "text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>{p.selling}</span>
                  <span className="block text-[11px] text-[var(--color-muted)]">of {p.sellers} selling</span>
                </td>
                <td className="px-3 py-3 text-center tabular-nums">
                  {p.price ? (
                    <>
                      <span className="font-semibold text-[var(--color-ink)]">{money(p.price.median, currency)}</span>
                      {p.price.low !== p.price.high && (
                        <span className="block text-[11px] text-[var(--color-muted)]">
                          {money(p.price.low, currency)}–{money(p.price.high, currency)}
                        </span>
                      )}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-3 text-center tabular-nums">
                  {p.delivery.known && p.delivery.share !== null ? (
                    <>
                      <span className={`font-semibold ${p.delivery.share >= 40 ? "text-emerald-700" : p.delivery.share > 0 ? "text-amber-700" : "text-rose-700"}`}>{p.delivery.share}%</span>
                      <span className="block text-[11px] text-[var(--color-muted)]">of its sales</span>
                    </>
                  ) : (
                    <span className="text-[11.5px] text-[var(--color-muted)]">Not known</span>
                  )}
                </td>
                <td className="px-3 py-3 text-center">
                  {p.url && (
                    <button type="button" onClick={() => onHunt(p.url!)} className="btn btn-primary btn-sm !h-7 gap-1 !px-2.5 !text-[11.5px]" title="Hunt this product: check it against an AliExpress supplier">
                      <HuntIcon />
                      Hunt
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
