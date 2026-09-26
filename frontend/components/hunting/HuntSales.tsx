"use client";

import { HuntCheckResult, HuntSalesBand, HuntSalesScore } from "@/lib/api";
import { TrendChart } from "@/components/charts/TrendChart";
import { count, money } from "@/components/research/format";
import { formatShortDate } from "@/lib/format";
import { SoldHistory } from "./SoldHistory";

// How well the competitor's listing sells: a sales score, its sales split by
// variation (eBay's sold count for each), and its sales over time from
// Liston's own daily readings. eBay gives this app a listing's sold counts
// but not when they sold (its dated sales history is a limited release not
// granted to Liston), so the history builds up from the day it's hunted.

export const SALES_BAND: Record<HuntSalesBand, { ring: string; ink: string; soft: string }> = {
  hot: { ring: "#059669", ink: "text-emerald-700", soft: "bg-emerald-50 ring-emerald-200" },
  strong: { ring: "#0d9488", ink: "text-teal-700", soft: "bg-teal-50 ring-teal-200" },
  steady: { ring: "#4f46e5", ink: "text-indigo-700", soft: "bg-indigo-50 ring-indigo-200" },
  slow: { ring: "#d97706", ink: "text-amber-700", soft: "bg-amber-50 ring-amber-200" },
  cold: { ring: "#e11d48", ink: "text-rose-700", soft: "bg-rose-50 ring-rose-200" },
};

/** "72 · Strong", coloured by the band. */
export function SalesScorePill({ score, small = false }: { score: { score: number; band: HuntSalesBand; label: string } | null | undefined; small?: boolean }) {
  if (!score) return null;
  const b = SALES_BAND[score.band];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full font-semibold ring-1 ring-inset tabular-nums ${b.soft} ${b.ink} ${small ? "h-5 px-1.5 text-[11px]" : "h-6 px-2 text-[11.5px]"}`} title="Sales score out of 100">
      {score.score}
      <span className="font-medium opacity-80">· {score.label}</span>
    </span>
  );
}

function ScoreRing({ score }: { score: HuntSalesScore }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const b = SALES_BAND[score.band];
  return (
    <div className="relative h-[88px] w-[88px] flex-shrink-0">
      <svg viewBox="0 0 88 88" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="44" cy="44" r={r} fill="none" stroke="var(--color-line)" strokeWidth="8" />
        <circle cx="44" cy="44" r={r} fill="none" stroke={b.ring} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(score.score / 100) * c} ${c}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[24px] font-semibold leading-none tabular-nums text-[var(--color-ink)]">{score.score}</span>
        <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]">of 100</span>
      </div>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2.5">
      <p className="truncate text-[11px] font-medium text-[var(--color-muted)]">{label}</p>
      <p className="mt-0.5 truncate text-[16px] font-semibold tabular-nums text-[var(--color-ink)]">{value}</p>
      {note && <p className="truncate text-[11px] text-[var(--color-muted)]">{note}</p>}
    </div>
  );
}

const TREND = { up: { text: "Rising", ink: "text-emerald-700" }, flat: { text: "Steady", ink: "text-[var(--color-ink)]" }, down: { text: "Slowing", ink: "text-rose-700" } };

export function HuntSales({ result, connectionId, onImported }: { result: HuntCheckResult; connectionId?: string; onImported?: () => void }) {
  if (!result.competitor || !result.sales) return null;
  const { variations, history, ebay } = result.sales;
  const itemId = result.competitor.itemId;
  // The page to copy dated sales from (a check made before this was kept has none).
  const exact = result.sales.exact || (itemId ? { url: `${(() => { try { return new URL(result.competitor?.url || "").origin; } catch { return "https://www.ebay.co.uk"; } })()}/bin/purchaseHistory?item=${itemId}`, importedAt: null, figures: null } : null);
  const score = result.salesScore;
  const currency = result.currency;
  const maxSold = Math.max(1, ...variations.map((v) => v.sold || 0));
  // The first day read, as the chart counts days.
  const firstDay = history?.days?.[0]?.day;
  const since = firstDay ? new Date(`${firstDay}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : history?.since ? formatShortDate(history.since) : null;
  const firstSold = result.demand.sold;

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
        <h3 className="text-[13px] font-semibold text-[var(--color-ink)]">Sales</h3>
        <p className="text-[11.5px] text-[var(--color-muted)]">The competitor&apos;s listing, from eBay&apos;s sold counts</p>
      </div>

      {exact && <SoldHistory key={itemId || "none"} exact={exact} connectionId={connectionId} itemId={itemId} competitorUrl={result.competitor.url} currency={currency} onImported={onImported} />}

      <div className="grid grid-cols-1 border-t border-[var(--color-line)] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* The score and what it's made of. */}
        <div className="border-[var(--color-line)] p-4 lg:border-r">
          {score ? (
            <>
              <div className="flex items-center gap-4">
                <ScoreRing score={score} />
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Sales score</p>
                  <p className={`text-[20px] font-semibold ${SALES_BAND[score.band].ink}`}>{score.label}</p>
                  <p className="text-[12px] leading-snug text-[var(--color-muted)]">
                    {score.exact ? "From eBay's sold history: its real recent pace and last sale." : score.estimate ? "From its sales so far; the trend joins in after 3 days of Liston's readings." : "From its sales and Liston's daily readings."}
                  </p>
                </div>
              </div>
              <ul className="mt-4 space-y-2.5">
                {score.parts.map((p) => (
                  <li key={p.key} title={p.detail}>
                    <div className="flex items-baseline justify-between gap-2 text-[12px]">
                      <span className="text-[var(--color-ink)]">{p.label}</span>
                      <span className="tabular-nums text-[var(--color-muted)]">
                        <b className="font-semibold text-[var(--color-ink)]">{p.points}</b> / {p.max}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-paper)]">
                      <div className="h-full rounded-full" style={{ width: `${(p.points / p.max) * 100}%`, background: SALES_BAND[score.band].ring }} />
                    </div>
                    <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">{p.detail}</p>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-[12.5px] text-[var(--color-muted)]">eBay doesn&apos;t show how many this listing has sold, so there&apos;s no sales score.</p>
          )}
        </div>

        {/* Sold by variation. */}
        <div className="p-4">
          <p className="text-[12px] font-semibold text-[var(--color-ink)]">{variations.length > 1 ? "Sold by variation" : "Sold"}</p>
          {variations.length === 0 || variations.every((v) => v.sold === null) ? (
            <p className="mt-2 text-[12.5px] text-[var(--color-muted)]">eBay doesn&apos;t show sold counts for this listing.</p>
          ) : (
            <ul className="mt-2.5 space-y-2.5">
              {variations.slice(0, 12).map((v, i) => (
                <li key={`${v.label}-${i}`} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
                    <span className="min-w-0 truncate font-medium text-[var(--color-ink)]">{v.label || "The listing"}</span>
                    <span className="flex-shrink-0 tabular-nums text-[var(--color-muted)]">
                      <b className="font-semibold text-[var(--color-ink)]">{v.sold === null ? "—" : count(v.sold)}</b> sold
                      {v.share !== null && variations.length > 1 ? ` · ${v.share}%` : ""}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--color-paper)]">
                    <div className={`h-full rounded-full ${i === 0 && (v.sold || 0) > 0 ? "bg-[var(--color-primary)]" : "bg-indigo-300"}`} style={{ width: `${((v.sold || 0) / maxSold) * 100}%` }} />
                  </div>
                  <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-[var(--color-muted)]">
                    {v.price !== null && <span>{money(v.price, currency)}</span>}
                    {v.available !== null && <span className={v.available < 5 ? "text-amber-700" : ""}>{count(v.available)} left</span>}
                    {v.supplier.length ? (
                      <span className="text-emerald-700">Supplier: {v.supplier.join(", ")}</span>
                    ) : (
                      <span className="text-amber-700">No matching supplier option</span>
                    )}
                  </p>
                </li>
              ))}
              {variations.length > 12 && <li className="text-[11.5px] text-[var(--color-muted)]">and {variations.length - 12} more</li>}
            </ul>
          )}
        </div>
      </div>

      {/* Over time, from Liston's readings (eBay's own dated sales, once pasted, say it better). */}
      {!exact?.figures && (
      <div className="border-t border-[var(--color-line)] p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[12px] font-semibold text-[var(--color-ink)]">Sales over time</p>
          {since && <p className="text-[11.5px] text-[var(--color-muted)]">Liston has read it daily since {since}</p>}
        </div>
        {history && history.readings >= 2 ? (
          <>
            <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="Last 7 days" value={history.soldLast7 === null ? "—" : `${count(history.soldLast7)} sold`} note={history.coveredDays < 7 ? `over ${history.coveredDays} days read` : undefined} />
              <Tile label="Last 30 days" value={history.soldLast30 === null ? "—" : `${count(history.soldLast30)} sold`} note={history.coveredDays < 30 ? `over ${history.coveredDays} days read` : undefined} />
              <Tile label="A day lately" value={history.perDay === null ? "—" : `${history.perDay}`} note={result.demand.soldPerMonth !== null ? `usually ${Math.round((result.demand.soldPerMonth / 30) * 10) / 10}` : undefined} />
              <div className="min-w-0 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2.5">
                <p className="text-[11px] font-medium text-[var(--color-muted)]">Trend</p>
                <p className={`mt-0.5 text-[16px] font-semibold ${history.trend ? TREND[history.trend].ink : "text-[var(--color-muted)]"}`}>{history.trend ? TREND[history.trend].text : "Too early"}</p>
                <p className="text-[11px] text-[var(--color-muted)]">{history.trend ? "against its average" : "after 3 days of readings"}</p>
              </div>
            </div>
            {history.days.length > 1 && (
              <div className="mt-3">
                <TrendChart points={history.days.map((d) => ({ day: d.day, value: d.sold }))} format={(v) => (v === null ? "—" : `${count(v)} sold`)} label="Sold" currentLabel="Sold a day" variant="bars" showPrevious={false} legend={false} height={170} />
              </div>
            )}
            {history.byVariation.some((v) => v.sold > 0) && (
              <p className="mt-2 text-[12px] text-[var(--color-muted)]">
                Since {since}:{" "}
                {history.byVariation
                  .filter((v) => v.sold > 0)
                  .slice(0, 5)
                  .map((v) => `${v.label || "the listing"} ${v.sold}`)
                  .join(" · ")}
              </p>
            )}
          </>
        ) : (
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            {history && history.readings === 1
              ? `First reading: ${firstSold !== null ? `${count(firstSold)} sold in all` : "its sold count"}${since ? ` on ${since}` : ""}. Liston reads the listing every day from here, so sales per day fill in from tomorrow. For every past sale with its date, paste eBay's sold history above.`
              : history
                ? "Liston is reading this listing's sales now; refresh in a moment."
                : "eBay shows how many a listing has sold, not when. Once this product is added, Liston reads the competitor every day and its sales per day and trend build up here."}
          </p>
        )}
        {ebay?.available && ebay.found && (
          <p className="mt-2 text-[12px] text-[var(--color-ink)]">
            eBay: <b className="font-semibold">{count(ebay.sold || 0)} sold</b> in the last {ebay.days} days
            {ebay.lastSoldAt ? `, last on ${formatShortDate(ebay.lastSoldAt)}` : ""}
            {ebay.lastPrice !== null && ebay.lastPrice !== undefined ? ` at ${money(ebay.lastPrice, currency)}` : ""}.
          </p>
        )}
      </div>
      )}
    </section>
  );
}
