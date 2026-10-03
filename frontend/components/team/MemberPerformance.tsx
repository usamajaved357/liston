"use client";

import { ReactNode, useState } from "react";
import { ViewMenu } from "@/components/ViewMenu";
import { TeamMetricKey, WorkOverview } from "@/lib/api";
import { CARD, EmptyCard, FIGURE, Hue, IconTile, SectionHead, StatCard, StatRow, statIcon } from "@/components/StatCard";
import { initials, tintFor } from "@/components/AccountRail";
import { useConnections } from "@/lib/useConnections";
import { DeltaBadge } from "@/components/charts/DeltaBadge";
import { TrendChart } from "@/components/charts/TrendChart";
import { dayRangeLabel, fullNumber } from "@/components/charts/chart-format";
import { money } from "@/components/research/format";
import { hoursText } from "@/components/hunting/HuntBits";
import { minutesText, waitText } from "./time-format";

// A team member's Performance tab, laid out like the Overview: one card per
// area they work in (what they have access to, or did work in, in this
// period), each with its headline against the period before and the
// details behind it (the eBay Inbox: buyers answered, queries resolved,
// messages sent, how quickly they answer, cases handled; and their time in
// Liston, working and idle); then one chart of any measure, day by day
// against the period before; then the same by eBay account.
//
// `self`: the member's own Overview on one account — "you" and "your",
// no log links (the log is the owner's), no by-account table, and never any
// money (sales from their finds are units and orders; the server sends no
// amounts).

const change = (now: number, before: number) => (before > 0 ? (now - before) / before : null);

type Tone = "good" | "bad" | "warn" | "info" | "plain";
const TONE: Record<Tone, string> = {
  good: "text-emerald-700",
  bad: "text-rose-700",
  warn: "text-amber-700",
  info: "text-indigo-700",
  plain: "text-[var(--color-ink)]",
};

type Row = { label: string; value: string; tone?: Tone; metric?: TeamMetricKey; hint?: string };

// Each area's icon.
const AREA_ICONS = {
  // Work: a calendar with a tick, days worked.
  work: statIcon(<><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /><path d="M9 14.5l2 2 4-4" /></>),
  // Orders: a parcel.
  orders: statIcon(<><path d="M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7L12 3.5z" /><path d="M4.5 7.7L12 12l7.5-4.3M12 12v8.5" /></>),
  // Inbox: a speech bubble.
  inbox: statIcon(<path d="M5 5.5h14a1.5 1.5 0 011.5 1.5v8.5A1.5 1.5 0 0119 17h-7l-4 3.5V17H5a1.5 1.5 0 01-1.5-1.5V7A1.5 1.5 0 015 5.5z" />),
  // Listings: a price tag.
  listings: statIcon(<><path d="M4 12.5V5a1 1 0 011-1h7.5l7.5 7.5-8 8-8-7z" /><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" stroke="none" /></>),
  // Hunting: a target.
  hunting: statIcon(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5" /></>),
  // Reviewing: a clipboard with a tick.
  reviewing: statIcon(<><rect x="5" y="4.5" width="14" height="16" rx="2.5" /><path d="M9 4.5v-1h6v1" /><path d="M9 13l2 2 4-4.5" /></>),
  // Time in Liston: a clock.
  time: statIcon(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>),
  // The chart: bars.
  chart: statIcon(<><path d="M4 20h16" /><rect x="5.5" y="11" width="3" height="6.5" rx="1" /><rect x="10.5" y="6.5" width="3" height="11" rx="1" /><rect x="15.5" y="13.5" width="3" height="4" rx="1" /></>),
  // By eBay account: a shopfront.
  store: statIcon(<><path d="M4.5 9.5l1.2-4.5h12.6l1.2 4.5" /><path d="M4.5 9.5a2.5 2.5 0 005 0 2.5 2.5 0 005 0 2.5 2.5 0 005 0" /><path d="M5.5 11.5V19h13v-7.5M10 19v-4h4v4" /></>),
  // Nothing recorded: an empty tray.
  empty: statIcon(<><path d="M4 13.5l2.2-7A1.5 1.5 0 017.6 5.5h8.8a1.5 1.5 0 011.4 1l2.2 7" /><path d="M4 13.5V18a1.5 1.5 0 001.5 1.5h13A1.5 1.5 0 0020 18v-4.5h-4.5l-1.2 2h-4.6l-1.2-2H4z" /></>, "h-6 w-6"),
};

// A capsule in a card's corner: its log, or the Time tab.
function CornerLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full bg-[var(--color-panel)]/80 px-2.5 py-1 text-[11.5px] font-semibold text-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]/15 transition-colors hover:bg-[var(--color-primary-soft)]"
    >
      {label}
    </button>
  );
}

function AreaCard({
  title,
  hue,
  icon,
  value,
  unit,
  delta,
  compared,
  note,
  rows,
  onOpenLog,
  headlineMetric,
  action,
}: {
  title: string;
  hue: Hue;
  icon: ReactNode;
  value: string;
  unit?: string;
  delta?: number | null;
  compared: string;
  note: ReactNode;
  rows: Row[];
  onOpenLog?: (kind: TeamMetricKey) => void;
  headlineMetric?: TeamMetricKey;
  // A link in the corner instead of the log's (the Time tab).
  action?: { label: string; onClick: () => void };
}) {
  const corner = action ? <CornerLink label={action.label} onClick={action.onClick} /> : headlineMetric && onOpenLog ? <CornerLink label="Log" onClick={() => onOpenLog(headlineMetric)} /> : null;
  return (
    <StatCard
      label={title}
      hue={hue}
      icon={icon}
      corner={corner}
      details={rows.map((r) => (
        <StatRow key={r.label} label={r.label} hint={r.metric && onOpenLog ? r.hint || "See each one in the log" : r.hint} ink={TONE[r.tone || "plain"]} onClick={r.metric && onOpenLog ? () => onOpenLog(r.metric!) : undefined}>
          {r.value}
        </StatRow>
      ))}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className={`${FIGURE} flex-shrink-0 text-[var(--color-ink)]`}>{value}</span>
        {unit && <span className="min-w-0 truncate text-[12.5px] text-[var(--color-muted)]">{unit}</span>}
        {delta !== undefined && (
          <span className="ml-auto flex-shrink-0 self-center">
            <DeltaBadge change={delta} compared={compared} size="sm" />
          </span>
        )}
      </div>
      {/* A member's notes run longer than the Overview's: they wrap rather than being cut. */}
      <p className="mt-2 text-[12px] leading-snug text-[var(--color-muted)]">{note}</p>
    </StatCard>
  );
}

// An eBay account in the by-account table: its store logo in a circle, or its initials in its colour.
function AccountMark({ id, label }: { id: string | null; label: string }) {
  const connections = useConnections();
  const logo = id ? connections.find((c) => c.id === id)?.logo_url : null;
  return logo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={logo} alt="" className="h-7 w-7 flex-shrink-0 rounded-full bg-white object-cover ring-1 ring-black/[0.08]" />
  ) : (
    <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold ${id ? tintFor(id) : "bg-[var(--color-paper)] text-[var(--color-muted)]"}`} aria-hidden>
      {initials(label, "A")}
    </span>
  );
}

export function MemberPerformance({ data, onOpenLog, onOpenTime, self = false }: { data: WorkOverview; onOpenLog?: (kind: TeamMetricKey) => void; onOpenTime?: () => void; self?: boolean }) {
  // Their words, or yours.
  const they = self ? "you" : "they";
  const Their = self ? "Your" : "Their";
  const compared = `vs ${dayRangeLabel(data.range.previous.from, data.range.previous.to)}`;
  const t = data.totals;
  const p = data.previous;
  const has = (feature: string) => data.permissions.some((x) => x.feature === feature && x.allowed);
  const any = (keys: TeamMetricKey[]) => keys.some((k) => t[k] > 0 || p[k] > 0);
  const h = data.hunting;

  const ORDER_KEYS: TeamMetricKey[] = ["supplier_orders", "dispatched", "cases"];
  const LISTING_KEYS: TeamMetricKey[] = ["published", "drafted", "draft_work", "edited", "relisted", "ended"];
  const showOrders = has("orders") || any(ORDER_KEYS);
  const showListings = has("listings") || any(LISTING_KEYS);
  const showHunting = has("hunting") || has("hunting_review") || Boolean(h && (h.hunter.hunted || h.previousHunter.hunted)) || any(["hunted"]);
  const showReviews = has("hunting_review") || Boolean(h && (h.reviewer.reviewed || h.previousReviewer.reviewed));
  const INBOX_KEYS: TeamMetricKey[] = ["inbox_answered", "inbox_sent"];
  const showInbox = has("inbox") || any(INBOX_KEYS);
  const time = data.time;
  const prevTime = data.previousTime;
  const showTime = Boolean(time && prevTime && (time.working + time.idle > 0 || prevTime.working + prevTime.idle > 0));
  const reply = data.replyTime;

  // The chart's measures, a few that matter, for the areas shown: orders
  // placed and shipped, listings drafted and published, products hunted and
  // (decided by a reviewer, on the day decided) approved and rejected, and
  // converting (their finds with a sale that day).
  type ChartKey = "supplier_orders" | "dispatched" | "cases" | "inbox_answered" | "drafted" | "published" | "hunted" | "approved" | "rejected" | "converting";
  type OutcomeKey = "approved" | "rejected" | "converting";
  const isOutcome = (k: ChartKey): k is OutcomeKey => k === "approved" || k === "rejected" || k === "converting";
  const CHART: { key: ChartKey; label: string; area: "orders" | "listings" | "hunting" | "inbox" | "cases"; log?: TeamMetricKey }[] = [
    { key: "supplier_orders", label: "Orders placed", area: "orders", log: "supplier_orders" },
    { key: "dispatched", label: "Orders shipped", area: "orders", log: "dispatched" },
    { key: "inbox_answered", label: "Buyers answered", area: "inbox", log: "inbox_answered" },
    { key: "cases", label: "Cases handled", area: "cases", log: "cases" },
    { key: "drafted", label: "Listings drafted", area: "listings", log: "drafted" },
    { key: "published", label: "Listings published", area: "listings", log: "published" },
    { key: "hunted", label: "Products hunted", area: "hunting", log: "hunted" },
    { key: "approved", label: "Products approved", area: "hunting" },
    { key: "rejected", label: "Products rejected", area: "hunting" },
    // Their finds that sold: how many different products had an order that day.
    { key: "converting", label: "Converting products", area: "hunting" },
  ];
  const o = data.huntOutcomes;
  const areaShown = { orders: showOrders, listings: showListings, hunting: showHunting, inbox: showInbox, cases: showOrders || showInbox };
  const chartOptions = CHART.filter((c) => areaShown[c.area]);
  const options = chartOptions.length ? chartOptions : CHART.slice(0, 1);
  const valueAt = (k: ChartKey, i: number, before = false): number | null => {
    if (isOutcome(k)) return (before ? o?.previousSeries : o?.series)?.[i]?.[k] ?? null;
    const row = (before ? data.previousSeries : data.series)[i];
    return row ? row[k] : null;
  };
  const totalOf = (k: ChartKey, before = false) => (isOutcome(k) ? (before ? o?.previous[k] : o?.totals[k]) ?? 0 : before ? p[k] : t[k]);
  const [metric, setMetric] = useState<ChartKey>(() => options.find((c) => totalOf(c.key) > 0)?.key || options[0].key);
  const chosen = options.find((c) => c.key === metric) || options[0];
  const label = (k: TeamMetricKey) => data.metrics.find((m) => m.key === k)?.label || k;
  const points = data.series.map((s, i) => ({ day: s.day, value: valueAt(chosen.key, i), previous: valueAt(chosen.key, i, true), previousDay: data.previousSeries[i]?.day ?? null }));
  const nothing = data.actions === 0 && Object.values(p).every((v) => v === 0);

  const sales = h?.sales[0];
  const prevSales = h?.previousSales[0];
  const accountKeys: TeamMetricKey[] = [...(showOrders ? ORDER_KEYS : []), ...(showInbox ? INBOX_KEYS : []), ...(showListings ? LISTING_KEYS : []), ...(showHunting ? (["hunted"] as TeamMetricKey[]) : []), ...(showReviews ? (["hunts_reviewed"] as TeamMetricKey[]) : [])];
  const accountColumns = accountKeys.filter((k) => data.accounts.some((a) => a[k] > 0));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AreaCard
          title="Work"
          hue="indigo"
          icon={AREA_ICONS.work}
          value={fullNumber(t.active_days)}
          unit={`of ${data.range.days} day${data.range.days === 1 ? "" : "s"}`}
          delta={change(t.active_days, p.active_days)}
          compared={compared}
          note={self ? "Days you worked on this account in Liston" : "Days with work done in Liston"}
          onOpenLog={onOpenLog}
          rows={[
            { label: "Actions", value: fullNumber(data.actions), hint: `Everything ${they} did in Liston in this period` },
            ...(self ? [] : [{ label: "eBay accounts worked on", value: fullNumber(data.accounts.filter((a) => a.actions > 0).length) }]),
            { label: "A day, on days worked", value: t.active_days ? String(Math.round((data.actions / t.active_days) * 10) / 10) : "—", hint: "Actions per day worked" },
          ]}
        />
        {showOrders && (
          <AreaCard
            title="Orders"
            hue="sky"
            icon={AREA_ICONS.orders}
            value={fullNumber(t.supplier_orders)}
            unit="supplier orders"
            delta={change(t.supplier_orders, p.supplier_orders)}
            compared={compared}
            note="Placed with suppliers from an order"
            headlineMetric="supplier_orders"
            onOpenLog={onOpenLog}
            rows={[
              { label: "Orders dispatched", value: fullNumber(t.dispatched), metric: "dispatched" },
              { label: "Refunds, cancellations & cases", value: fullNumber(t.cases), metric: "cases", tone: t.cases ? "warn" : "plain" },
            ]}
          />
        )}
        {showInbox && (
          <AreaCard
            title="Inbox"
            hue="teal"
            icon={AREA_ICONS.inbox}
            value={fullNumber(t.inbox_answered)}
            unit="buyers answered"
            delta={change(t.inbox_answered, p.inbox_answered)}
            compared={compared}
            note={self ? "Buyer conversations you answered" : "Buyer conversations answered from the Inbox"}
            headlineMetric="inbox_answered"
            onOpenLog={onOpenLog}
            rows={[
              { label: "Messages sent", value: fullNumber(t.inbox_sent), metric: "inbox_sent" },
              {
                label: "Typical reply time",
                value: waitText(reply?.median),
                tone: reply?.median != null ? (reply.median <= 120 ? "good" : reply.median > 720 ? "bad" : "warn") : "plain",
                hint: reply?.count ? `How long a buyer had waited before ${self ? "your" : "their"} answer (the middle of ${reply.count} repl${reply.count === 1 ? "y" : "ies"})` : "No replies to a waiting buyer in this period",
              },
              { label: "Cases handled", value: fullNumber(t.cases), metric: "cases", hint: "Returns, item-not-received cases, payment disputes, refunds and cancellations handled from an order" },
            ]}
          />
        )}
        {showListings && (
          <AreaCard
            title="Listings"
            hue="violet"
            icon={AREA_ICONS.listings}
            value={fullNumber(t.published)}
            unit="published"
            delta={change(t.published, p.published)}
            compared={compared}
            note="New listings put live on eBay"
            headlineMetric="published"
            onOpenLog={onOpenLog}
            rows={[
              { label: "Drafts created", value: fullNumber(t.drafted), metric: "drafted" },
              { label: "Drafts worked on", value: fullNumber(t.draft_work), metric: "draft_work" },
              { label: "Live listings edited", value: fullNumber(t.edited), metric: "edited" },
              { label: "Relisted · ended", value: `${fullNumber(t.relisted)} · ${fullNumber(t.ended)}`, metric: "relisted" },
            ]}
          />
        )}
        {showHunting && (
          <AreaCard
            title="Hunting"
            hue="amber"
            icon={AREA_ICONS.hunting}
            value={fullNumber(h?.hunter.hunted ?? t.hunted)}
            unit="products hunted"
            delta={h ? change(h.hunter.hunted, h.previousHunter.hunted) : change(t.hunted, p.hunted)}
            compared={compared}
            note={h?.hunter.approvalRate !== null && h?.hunter.approvalRate !== undefined ? `${h.hunter.approvalRate}% approved of those decided` : `${Their} finds, by when hunted`}
            headlineMetric="hunted"
            onOpenLog={onOpenLog}
            rows={[
              { label: "Approved", value: fullNumber(h?.hunter.approved ?? 0), tone: h?.hunter.approved ? "good" : "plain" },
              { label: "Rejected", value: fullNumber(h?.hunter.rejected ?? 0), tone: h?.hunter.rejected ? "bad" : "plain" },
              { label: "Sent back · waiting", value: `${fullNumber(h?.hunter.sentBack ?? 0)} · ${fullNumber(h?.hunter.waiting ?? 0)}`, tone: h?.hunter.sentBack ? "warn" : "plain" },
              { label: "Drafted · listed", value: `${fullNumber(h?.hunter.drafted ?? 0)} · ${fullNumber(h?.hunter.listed ?? 0)}`, tone: h?.hunter.listed ? "info" : "plain" },
              self
                ? {
                    label: "Sold from your finds",
                    value: sales?.units ? `${fullNumber(sales.units)} sold` : "—",
                    tone: sales?.units ? "good" : "plain",
                    hint: prevSales?.units ? `${fullNumber(prevSales.units)} sold ${compared}` : "Units sold in this period from listings made from your finds",
                  }
                : {
                    label: "Sales from their finds",
                    value: sales?.sales !== undefined ? money(sales.sales, sales.currency || "GBP") : "—",
                    tone: sales?.sales ? "good" : "plain",
                    hint: prevSales?.sales !== undefined ? `${money(prevSales.sales, prevSales.currency || "GBP")} ${compared}` : "Sales in this period from listings made from their finds",
                  },
            ]}
          />
        )}
        {showReviews && (
          <AreaCard
            title="Reviewing"
            hue="emerald"
            icon={AREA_ICONS.reviewing}
            value={fullNumber(h?.reviewer.reviewed ?? t.hunts_reviewed)}
            unit="decisions"
            delta={h ? change(h.reviewer.reviewed, h.previousReviewer.reviewed) : change(t.hunts_reviewed, p.hunts_reviewed)}
            compared={compared}
            note={`Other people's finds ${they} decided on`}
            headlineMetric="hunts_reviewed"
            onOpenLog={onOpenLog}
            rows={[
              { label: "Approved", value: fullNumber(h?.reviewer.approved ?? 0), tone: h?.reviewer.approved ? "good" : "plain" },
              { label: "Rejected", value: fullNumber(h?.reviewer.rejected ?? 0), tone: h?.reviewer.rejected ? "bad" : "plain" },
              { label: "Sent back", value: fullNumber(h?.reviewer.sentBack ?? 0), tone: h?.reviewer.sentBack ? "warn" : "plain" },
              { label: "Average wait", value: hoursText(h?.reviewer.avgHoursToDecide), hint: "From submitted to decided" },
            ]}
          />
        )}
        {showTime && time && prevTime && (
          <AreaCard
            title="Time in Liston"
            hue="slate"
            icon={AREA_ICONS.time}
            value={minutesText(time.working)}
            unit="working"
            delta={change(time.working, prevTime.working)}
            compared={compared}
            note={`${minutesText(time.working + time.idle)} with Liston open, ${minutesText(time.idle)} of it idle`}
            action={onOpenTime ? { label: "Day by day", onClick: onOpenTime } : undefined}
            rows={[
              { label: "Working", value: minutesText(time.working), tone: "good", hint: "A click, key press or scroll in Liston within a couple of minutes" },
              { label: "Idle", value: minutesText(time.idle), tone: time.idle > time.working ? "warn" : "plain", hint: "Liston open with nothing done (counted for up to half an hour at a time)" },
              { label: "Actions per working hour", value: time.working >= 15 ? String(Math.round((data.actions / (time.working / 60)) * 10) / 10) : "—" },
            ]}
          />
        )}
      </div>

      {h && h.reasons.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
          <span className="mr-0.5">{Their} finds were rejected for</span>
          {h.reasons.map((r) => (
            <span key={r.label} className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 py-0.5 pl-2.5 pr-1 text-[11.5px] font-medium text-rose-700 ring-1 ring-inset ring-rose-100">
              {r.label}
              <span className="rounded-full bg-[var(--color-panel)] px-1.5 text-[10.5px] font-semibold tabular-nums ring-1 ring-inset ring-rose-100">{r.count}</span>
            </span>
          ))}
        </div>
      )}

      {nothing ? (
        <EmptyCard icon={AREA_ICONS.empty} title="No recorded work in this period">
          Work counts when it&apos;s done in Liston: supplier orders, dispatches, refunds and cases from an order, buyers answered and queries resolved in the Inbox, listings
          drafted, published, edited, relisted or ended, and products hunted or reviewed. Work done straight on eBay or AliExpress can&apos;t be seen.
        </EmptyCard>
      ) : (
        data.series.length > 1 && (
          <section className={`${CARD} p-4 sm:p-5`}>
            {/* One measure at a time, as the Analytics chart does: the figure on the left, the key and the choice on the right. */}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <IconTile hue="indigo">{AREA_ICONS.chart}</IconTile>
                <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-[var(--color-muted)]">{chosen.label} per day</p>
                <p className="mt-1 flex items-baseline gap-2">
                  <span className="text-[24px] font-semibold leading-none tracking-[-0.025em] tabular-nums text-[var(--color-ink)]">{fullNumber(totalOf(chosen.key))}</span>
                  <DeltaBadge change={change(totalOf(chosen.key), totalOf(chosen.key, true))} compared={compared} size="sm" variant="text" />
                  <span className="text-[11.5px] text-[var(--color-muted)]">{fullNumber(totalOf(chosen.key, true))} before</span>
                </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="flex items-center gap-3 text-[11px] text-[var(--color-muted)]">
                  <span className="flex items-center gap-1.5">
                    <span className="h-0.5 w-4 rounded-full bg-[var(--color-primary)]" aria-hidden />
                    {dayRangeLabel(data.range.from, data.range.to)}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-4 border-t-2 border-dashed border-slate-400" aria-hidden />
                    {dayRangeLabel(data.range.previous.from, data.range.previous.to)}
                  </span>
                </span>
                <ViewMenu title="Measure" sections={[{ label: "Show", value: chosen.key, options: options.map((c) => ({ key: c.key, label: c.label })), onChange: (k) => setMetric(k as ChartKey) }]} />
              </div>
            </div>
            <div className="mt-3">
              <TrendChart
                points={points}
                format={(v) => (v == null ? "—" : fullNumber(v))}
                // Counts: only whole numbers on the side, so small ranges don't read 1, 1, 1, 0.
                axisFormat={(v) => (Number.isInteger(v) ? fullNumber(v) : "")}
                label={chosen.label}
                currentLabel={dayRangeLabel(data.range.from, data.range.to)}
                previousLabel={dayRangeLabel(data.range.previous.from, data.range.previous.to)}
                legend={false}
                height={220}
              />
            </div>
            {chosen.log && onOpenLog && (
              <div className="mt-1 flex justify-end">
                <CornerLink label="See each one in the log" onClick={() => onOpenLog?.(chosen.log!)} />
              </div>
            )}
          </section>
        )
      )}

      {!self && data.accounts.some((a) => a.actions > 0) && (
        <section className={`${CARD} p-4 sm:p-5`}>
          <SectionHead hue="sky" icon={AREA_ICONS.store} title="By eBay account" sub={`${fullNumber(data.actions)} action${data.actions === 1 ? "" : "s"} in all`} />
          <div className="-mx-4 mt-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
            <table className="w-full min-w-[480px] table-fixed text-[12.5px]">
              <thead>
                <tr className="text-[11px] font-medium text-[var(--color-muted)] [&>th]:bg-[var(--color-paper)] [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
                  <th className="w-[34%] px-3 py-2 text-left font-medium">Account</th>
                  <th className="px-3 py-2 text-center font-medium">Actions</th>
                  {accountColumns.map((k) => (
                    <th key={k} className="px-3 py-2 text-center font-medium">
                      {label(k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {data.accounts
                  .filter((a) => a.actions > 0)
                  .map((a) => (
                    <tr key={a.connectionId || a.label}>
                      <td className="px-3 py-2.5">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <AccountMark id={a.connectionId} label={a.label} />
                          <span className="min-w-0 truncate font-medium text-[var(--color-ink)]">
                            {a.label}
                            {!a.connectionId && <span className="ml-1.5 text-[11px] font-normal text-[var(--color-muted)]">(disconnected)</span>}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-center font-semibold tabular-nums text-[var(--color-ink)]">{fullNumber(a.actions)}</td>
                      {accountColumns.map((k) => (
                        <td key={k} className={`px-3 py-2.5 text-center tabular-nums ${a[k] ? "text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>
                          {fullNumber(a[k])}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">
        Days run midnight to midnight in {data.range.timeZone.replace("_", " ")}. An order line or listing counts once per period however many times it was touched; edits, drafts
        and cases count each time. A buyer counts once as answered however many messages went; messages sent count each one. Hunting figures count products by when they
        were hunted, and decisions by when they were made. Time in Liston: working is a click, key press or scroll within a couple of minutes, idle is Liston open with
        nothing done, for up to half an hour at a time.
      </p>
    </div>
  );
}
