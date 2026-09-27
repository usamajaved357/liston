"use client";

import { HuntCheckResult, HuntSalesBand, HuntSalesScore } from "@/lib/api";
import { TrendChart } from "@/components/charts/TrendChart";
import { age, count, money } from "@/components/research/format";
import { ToneIcon, Tone } from "@/components/research/ResearchPanels";
import { formatShortDate } from "@/lib/format";
import { SectionHead } from "./HuntBits";

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

// A figure judged at a glance, as the checks are: tinted by how good it is.
const STATUS: Record<Tone, { tile: string; value: string }> = {
  good: { tile: "bg-emerald-50/60 ring-emerald-200", value: "text-emerald-700" },
  warn: { tile: "bg-amber-50/70 ring-amber-200", value: "text-amber-700" },
  bad: { tile: "bg-rose-50/70 ring-rose-200", value: "text-rose-700" },
  unknown: { tile: "bg-[var(--color-paper)] ring-[var(--color-line)]", value: "text-[var(--color-ink)]" },
};
const STATUS_INK: Record<Tone, string> = { good: "text-emerald-600", warn: "text-amber-600", bad: "text-rose-600", unknown: "text-[var(--color-muted)]" };

function StatusTile({ label, value, note, tone }: { label: string; value: string; note?: string; tone: Tone }) {
  const t = STATUS[tone];
  return (
    <div className={`min-w-0 rounded-xl px-3.5 py-3 ring-1 ring-inset ${t.tile}`}>
      <p className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        <span className="truncate">{label}</span>
        {tone !== "unknown" && (
          <span className={`flex-shrink-0 ${STATUS_INK[tone]}`}>
            <ToneIcon tone={tone} className="h-3.5 w-3.5" />
          </span>
        )}
      </p>
      <p className={`mt-1 truncate text-[20px] font-semibold leading-tight tabular-nums ${t.value}`}>{value}</p>
      {note && <p className="mt-0.5 truncate text-[11.5px] text-[var(--color-muted)]">{note}</p>}
    </div>
  );
}

const by = (value: number | null | undefined, good: number, warn: number): Tone => (value === null || value === undefined ? "unknown" : value >= good ? "good" : value >= warn ? "warn" : "bad");

const TREND = { up: { text: "Rising", ink: "text-emerald-700" }, flat: { text: "Steady", ink: "text-[var(--color-ink)]" }, down: { text: "Slowing", ink: "text-rose-700" } };

// Before the daily readings have two days to compare: what happens when.
function Timeline({ steps }: { steps: { when: string; what: string; done: boolean }[] }) {
  return (
    <ol className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
      {steps.map((s, i) => (
        <li key={s.when} className={`relative flex items-start gap-3 rounded-xl px-3.5 py-3 ring-1 ring-inset ${s.done ? "bg-emerald-50/60 ring-emerald-200" : "bg-[var(--color-paper)] ring-[var(--color-line)]"}`}>
          <span className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${s.done ? "bg-emerald-600 text-white" : "bg-white text-[var(--color-muted)] ring-1 ring-[var(--color-line)]"}`}>
            {s.done ? (
              <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                <path d="M5 10.5l3.2 3.2L15 6.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              i + 1
            )}
          </span>
          <span className="min-w-0">
            <span className={`block text-[11px] font-semibold uppercase tracking-wide ${s.done ? "text-emerald-700" : "text-[var(--color-muted)]"}`}>{s.when}</span>
            <span className="block text-[12.5px] leading-snug text-[var(--color-ink)]">{s.what}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function HuntSales({ result }: { result: HuntCheckResult }) {
  if (!result.competitor || !result.sales) return null;
  const { variations, history, ebay } = result.sales;
  const score = result.salesScore;
  const currency = result.currency;
  const demand = result.demand;
  const named = variations.filter((v) => v.label);
  const maxSold = Math.max(1, ...variations.map((v) => v.sold || 0));
  // The first day read, as the chart counts days.
  const firstDay = history?.days?.[0]?.day;
  const since = firstDay ? new Date(`${firstDay}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : history?.since ? formatShortDate(history.since) : null;
  const tracked = Boolean(history && history.readings >= 2);
  const selling = named.length > 1 ? demand.sellingVariations / Math.max(1, demand.variations || named.length) : null;
  const perDay = demand.soldPerMonth !== null ? Math.round((demand.soldPerMonth / 30) * 10) / 10 : null;
  const stock = demand.available;
  const price = result.competitor.lowestPrice;

  return (
    <section className="card overflow-hidden">
      <SectionHead icon="sales" title="Sales" meta={<>The competitor&apos;s listing, from eBay&apos;s sold counts{score && <SalesScorePill score={score} />}</>} />

      <div className="grid grid-cols-1 gap-5 border-t border-[var(--color-line)] p-4 sm:p-5 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        {/* The score and what it's made of. */}
        <div className="min-w-0 rounded-xl bg-[var(--color-paper)]/60 p-4 ring-1 ring-inset ring-[var(--color-line)]">
          {score ? (
            <>
              <div className="flex items-center gap-4">
                <ScoreRing score={score} />
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Sales score</p>
                  <p className={`text-[22px] font-semibold leading-tight ${SALES_BAND[score.band].ink}`}>{score.label}</p>
                  <p className="text-[11.5px] leading-snug text-[var(--color-muted)]">Out of 100, from the four parts below</p>
                </div>
              </div>
              <p className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">How the {score.score} adds up</p>
              <ul className="mt-2 space-y-2.5">
                {score.parts.map((p) => (
                  <li key={p.key} title={p.detail}>
                    <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                      <span className="font-medium text-[var(--color-ink)]">{p.label}</span>
                      <span className="whitespace-nowrap tabular-nums text-[var(--color-muted)]">
                        <b className="font-semibold text-[var(--color-ink)]">{p.points}</b> of {p.max} pts
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white ring-1 ring-inset ring-[var(--color-line)]">
                      <div className="h-full rounded-full" style={{ width: `${(p.points / p.max) * 100}%`, background: SALES_BAND[score.band].ring }} />
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">
                      {p.value ? (
                        <>
                          <b className="font-semibold text-[var(--color-ink)]">{p.value}</b>
                          {p.full ? ` · full points at ${p.full}` : ""}
                        </>
                      ) : (
                        p.detail
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-[12.5px] text-[var(--color-muted)]">eBay doesn&apos;t show how many this listing has sold, so there&apos;s no sales score.</p>
          )}
        </div>

        <div className="flex min-w-0 flex-col">
          {/* The listing's record at a glance, stretched to the score beside it. */}
          <div className="grid flex-1 auto-rows-fr grid-cols-2 gap-2.5 sm:grid-cols-3">
            <StatusTile label="Sells a month" value={demand.soldPerMonth === null ? "—" : count(demand.soldPerMonth)} note={perDay !== null ? `about ${perDay} a day` : "not shown by eBay"} tone={by(demand.soldPerMonth, 10, 3)} />
            <StatusTile label="Sold in all" value={demand.sold === null ? "—" : count(demand.sold)} note={demand.daysLive !== null ? `in ${age(demand.daysLive)}` : "since it was listed"} tone={by(demand.sold, 50, 10)} />
            <StatusTile
              label="Options selling"
              value={named.length > 1 ? `${demand.sellingVariations} of ${demand.variations || named.length}` : (demand.sold || 0) > 0 ? "Selling" : "None yet"}
              note={named.length > 1 ? `${Math.round((selling || 0) * 100)}% of its options` : variations[0]?.supplier?.length ? `matched to ${variations[0].supplier.join(", ")}` : "a single listing"}
              tone={named.length > 1 ? by(selling, 0.6, 0.3) : (demand.sold || 0) > 0 ? "good" : "bad"}
            />
            <StatusTile
              label="Trend"
              value={history?.trend ? TREND[history.trend].text : "Too early"}
              note={history?.trend ? "against its average" : tracked ? "after 3 days of readings" : "from Liston's daily readings"}
              tone={history?.trend === "up" ? "good" : history?.trend === "down" ? "warn" : history?.trend === "flat" ? "good" : "unknown"}
            />
            {stock !== null ? (
              <StatusTile label="Their stock" value={count(stock)} note={stock < 5 ? "could sell out soon" : "left on their listing"} tone={stock < 5 ? "warn" : "unknown"} />
            ) : (
              <StatusTile label="Their price" value={price === null ? "—" : money(price, currency)} note={named.length > 1 ? "their cheapest option" : "on their listing"} tone="unknown" />
            )}
            <StatusTile label="Listed for" value={demand.daysLive === null ? "—" : age(demand.daysLive)} note={stock !== null && price !== null ? `from ${money(price, currency)}` : "on eBay"} tone="unknown" />
          </div>

          {/* Only with options to compare. */}
          {named.length > 1 && (
            <div className="mt-4">
              <p className="text-[12px] font-semibold text-[var(--color-ink)]">Sold by variation</p>
              <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2.5 xl:grid-cols-2">
                {variations.slice(0, 12).map((v, i) => (
                  <li key={`${v.label}-${i}`} className="min-w-0">
                    <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
                      <span className="min-w-0 truncate font-medium text-[var(--color-ink)]">{v.label || "The listing"}</span>
                      <span className="flex-shrink-0 tabular-nums text-[var(--color-muted)]">
                        <b className="font-semibold text-[var(--color-ink)]">{v.sold === null ? "—" : count(v.sold)}</b> sold
                        {v.share !== null ? ` · ${v.share}%` : ""}
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--color-paper)]">
                      <div className={`h-full rounded-full ${i === 0 && (v.sold || 0) > 0 ? "bg-[var(--color-primary)]" : "bg-indigo-300"}`} style={{ width: `${((v.sold || 0) / maxSold) * 100}%` }} />
                    </div>
                    <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-[var(--color-muted)]">
                      {v.price !== null && <span>{money(v.price, currency)}</span>}
                      {v.available !== null && <span className={v.available < 5 ? "text-amber-700" : ""}>{count(v.available)} left</span>}
                      {v.supplier.length ? <span className="text-emerald-700">Supplier: {v.supplier.join(", ")}</span> : <span className="text-amber-700">No matching supplier option</span>}
                    </p>
                  </li>
                ))}
              </ul>
              {variations.length > 12 && <p className="mt-2 text-[11.5px] text-[var(--color-muted)]">and {variations.length - 12} more</p>}
            </div>
          )}
        </div>
      </div>

      {/* Over time, from Liston's readings. */}
      <div className="border-t border-[var(--color-line)] p-4 sm:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[12px] font-semibold text-[var(--color-ink)]">Sales over time</p>
          {since && <p className="text-[11.5px] text-[var(--color-muted)]">Liston has read it daily since {since}</p>}
        </div>
        {tracked && history ? (
          <>
            <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="Last 7 days" value={history.soldLast7 === null ? "—" : `${count(history.soldLast7)} sold`} note={history.coveredDays < 7 ? `over ${history.coveredDays} days read` : undefined} />
              <Tile label="Last 30 days" value={history.soldLast30 === null ? "—" : `${count(history.soldLast30)} sold`} note={history.coveredDays < 30 ? `over ${history.coveredDays} days read` : undefined} />
              <Tile label="A day lately" value={history.perDay === null ? "—" : `${history.perDay}`} note={perDay !== null ? `usually ${perDay}` : undefined} />
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
          <>
            <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">eBay shows how many a listing has sold, not when. Liston reads it every day, and the picture builds up from there.</p>
            <Timeline
              steps={
                history
                  ? [
                      { when: since ? `First reading · ${since}` : "First reading", what: demand.sold !== null ? `${count(demand.sold)} sold in all` : "Its sold count, kept", done: true },
                      { when: "Tomorrow", what: "Sales per day start", done: false },
                      { when: "After 3 days", what: "The trend joins the score", done: false },
                    ]
                  : [
                      { when: "When it's added", what: "Liston takes its first reading", done: false },
                      { when: "The next day", what: "Sales per day start", done: false },
                      { when: "After 3 days", what: "The trend joins the score", done: false },
                    ]
              }
            />
          </>
        )}
        {ebay?.available && ebay.found && (
          <p className="mt-2 text-[12px] text-[var(--color-ink)]">
            eBay: <b className="font-semibold">{count(ebay.sold || 0)} sold</b> in the last {ebay.days} days
            {ebay.lastSoldAt ? `, last on ${formatShortDate(ebay.lastSoldAt)}` : ""}
            {ebay.lastPrice !== null && ebay.lastPrice !== undefined ? ` at ${money(ebay.lastPrice, currency)}` : ""}.
          </p>
        )}
      </div>
    </section>
  );
}
