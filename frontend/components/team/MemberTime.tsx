"use client";

import { useEffect, useState } from "react";
import { api, ApiError, MemberTime, TeamRange } from "@/lib/api";
import { DeltaBadge } from "@/components/charts/DeltaBadge";
import { dayRangeLabel, fullNumber } from "@/components/charts/chart-format";
import { minutesText } from "./time-format";
import { CARD, EmptyCard, FIGURE, Hue, SectionHead, StatCard, statIcon } from "@/components/StatCard";

// A member's Time tab: their time in Liston for the range against the
// period before (with Liston open, working, idle, actions per working
// hour); each day as a strip across the hours they were in, working
// stretches in the brand colour and idle ones in grey (hover for when and
// where); and where the working time went, area by area, with what they did
// there. Days are the owner's, as on the rest of the page.

const change = (now: number, before: number) => (before > 0 ? (now - before) / before : null);
const clock = (minuteOfDay: number) => `${String(Math.floor(minuteOfDay / 60) % 24).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
const dayName = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const AREA_NAMES: Record<string, string> = {
  dashboard: "Dashboard",
  overview: "Overview",
  inbox: "Inbox",
  orders: "Orders",
  listings: "Listings",
  hunting: "Hunting",
  research: "Research",
  analytics: "Analytics",
  campaigns: "Campaigns",
  settings: "Settings",
  other: "Elsewhere in Liston",
};

const ICONS = {
  // With Liston open: a screen.
  open: statIcon(<><rect x="3.5" y="4.5" width="17" height="12" rx="2" /><path d="M9 20h6M12 16.5V20" /></>),
  // Working: a pulse.
  working: statIcon(<path d="M3.5 12h4l2.5-6 4 12 2.5-6h4" />),
  // Idle: paused.
  idle: statIcon(<><circle cx="12" cy="12" r="8.5" /><path d="M10 9v6M14 9v6" /></>),
  // Actions per working hour: a bolt.
  pace: statIcon(<path d="M13 3.5L5.5 13.5H12l-1 7 7.5-10H12l1-7z" />),
  // Day by day: a calendar.
  days: statIcon(<><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /></>),
  // Where the time went: a pie.
  areas: statIcon(<><path d="M12 3.5a8.5 8.5 0 108.5 8.5H12V3.5z" /><path d="M15 3.8A8.5 8.5 0 0120.2 9H15V3.8z" /></>),
  // No time: a clock.
  clock: statIcon(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>, "h-6 w-6"),
};

function Stat({ label, hue, icon, value, sub, delta, compared }: { label: string; hue: Hue; icon: React.ReactNode; value: string; sub?: string; delta?: number | null; compared: string }) {
  return (
    <StatCard label={label} hue={hue} icon={icon}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className={`${FIGURE} text-[var(--color-ink)]`}>{value}</span>
        {delta !== undefined && (
          <span className="ml-auto flex-shrink-0 self-center">
            <DeltaBadge change={delta} compared={compared} size="sm" />
          </span>
        )}
      </div>
      {sub && <p className="mt-2 text-[12px] leading-snug text-[var(--color-muted)]">{sub}</p>}
    </StatCard>
  );
}

export function MemberTimeView({ memberId, name, range, custom }: { memberId: string; name: string; range: TeamRange; custom: { from: string; to: string } }) {
  const key = JSON.stringify([memberId, range, custom]);
  const [loaded, setLoaded] = useState<{ key: string; data: MemberTime | null; error: string | null } | null>(null);
  useEffect(() => {
    if (range === "custom" && (!custom.from || !custom.to)) return;
    let live = true;
    api
      .getMemberTime(memberId, range, custom)
      .then((data) => live && setLoaded({ key, data, error: null }))
      .catch((err) => live && setLoaded({ key, data: null, error: err instanceof ApiError ? err.message : "Couldn't load their time." }));
    return () => {
      live = false;
    };
  }, [memberId, range, custom, key]);

  const current = loaded?.key === key ? loaded : null;
  const data = current?.data || (loaded?.data ?? null);
  if (current?.error) return <div className={`${CARD} items-center px-6 py-8 text-center text-[13px] text-rose-600`}>{current.error}</div>;
  if (!data) return <div className={`${CARD} h-[320px] animate-pulse`} aria-label="Loading" />;

  const first = name.split(" ")[0] || "They";
  const t = data.totals;
  const p = data.previous;
  const open = t.working + t.idle;
  const compared = `vs ${dayRangeLabel(data.range.previous.from, data.range.previous.to)}`;
  const withTime = data.days.filter((d) => d.working + d.idle > 0);
  // Long ranges list only the days they were in Liston; short ones every day.
  const days = (data.range.days > 31 ? withTime : data.days).slice().reverse();
  // The strip covers the hours anyone of these days was in, padded to whole hours.
  const starts = withTime.flatMap((d) => d.spans.map((s) => s.from));
  const ends = withTime.flatMap((d) => d.spans.map((s) => s.to));
  const from = starts.length ? Math.max(0, Math.floor(Math.min(...starts) / 60) * 60 - 60) : 8 * 60;
  const to = ends.length ? Math.min(1440, Math.ceil(Math.max(...ends) / 60) * 60 + 60) : 18 * 60;
  const span = Math.max(60, to - from);
  const step = span > 12 * 60 ? 180 : span > 6 * 60 ? 120 : 60;
  const ticks: number[] = [];
  for (let m = Math.ceil(from / step) * step; m <= to; m += step) ticks.push(m);
  const maxArea = Math.max(1, ...data.areas.map((a) => a.working + a.idle));

  return (
    <div className={`space-y-4 ${current ? "" : "opacity-60 transition-opacity"}`}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="With Liston open" hue="slate" icon={ICONS.open} value={minutesText(open)} sub={`On ${fullNumber(t.daysInListon)} of ${data.range.days} day${data.range.days === 1 ? "" : "s"}`} delta={change(open, p.working + p.idle)} compared={compared} />
        <Stat label="Working" hue="indigo" icon={ICONS.working} value={minutesText(t.working)} sub={open ? `${Math.round((t.working / open) * 100)}% of the time open` : "A click, key press or scroll within a couple of minutes"} delta={change(t.working, p.working)} compared={compared} />
        <Stat label="Idle" hue="amber" icon={ICONS.idle} value={minutesText(t.idle)} sub="Open with nothing done (up to half an hour at a time)" delta={change(t.idle, p.idle)} compared={compared} />
        <Stat label="Actions per working hour" hue="violet" icon={ICONS.pace} value={t.actionsPerHour === null ? "—" : String(t.actionsPerHour)} sub={`${fullNumber(t.actions)} action${t.actions === 1 ? "" : "s"} recorded`} compared={compared} />
      </div>

      {open === 0 ? (
        <EmptyCard icon={ICONS.clock} title="No time in Liston in this period">
          <p>
            {data.trackedSince
              ? `${first} wasn't in Liston in these days.`
              : `Liston keeps a member's time from their first visit after this was switched on; ${first} hasn't been in since.`}{" "}
            A minute counts as working when there was a click, key press or scroll in Liston within the last couple of minutes, and idle when Liston was open with
            nothing done.
          </p>
        </EmptyCard>
      ) : (
        <>
          <section className={`${CARD} p-4 sm:p-5`}>
            <SectionHead hue="indigo" icon={ICONS.days} title="Day by day" sub="When they were in Liston, hour by hour">
              <span className="flex items-center gap-3 text-[11.5px] text-[var(--color-muted)]">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-primary)]" aria-hidden />
                  Working
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-slate-300" aria-hidden />
                  Idle
                </span>
              </span>
            </SectionHead>
            <div className="-mx-4 mt-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
              <table className="w-full min-w-[720px] table-fixed text-[12.5px]">
                <thead>
                  <tr className="text-[11px] text-[var(--color-muted)] [&>th]:bg-[var(--color-paper)] [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
                    <th className="w-[110px] px-3 py-2 text-left font-medium">Day</th>
                    <th className="px-3 py-2 text-left font-medium">
                      <div className="relative h-3">
                        {ticks.map((m) => (
                          <span key={m} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${((m - from) / span) * 100}%` }}>
                            {clock(m)}
                          </span>
                        ))}
                      </div>
                    </th>
                    <th className="w-[92px] px-3 py-2 text-center font-medium">Working</th>
                    <th className="w-[72px] px-3 py-2 text-center font-medium">Idle</th>
                    <th className="w-[96px] px-3 py-2 text-center font-medium">In Liston</th>
                    <th className="w-[72px] px-3 py-2 text-center font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-line)]">
                  {days.map((d) => {
                    const empty = d.working + d.idle === 0;
                    const firstAt = d.spans[0]?.from;
                    const lastAt = d.spans[d.spans.length - 1]?.to;
                    return (
                      <tr key={d.day} className={empty ? "text-[var(--color-muted)]" : ""}>
                        <td className="px-3 py-2.5 font-medium text-[var(--color-ink)]">{dayName(d.day)}</td>
                        <td className="px-3 py-2.5">
                          <div className="relative h-4 overflow-hidden rounded-full bg-[var(--color-paper)]" role="img" aria-label={empty ? "Not in Liston" : `Working ${minutesText(d.working)}, idle ${minutesText(d.idle)}`}>
                            {ticks.map((m) => (
                              <span key={m} className="absolute inset-y-0 w-px bg-[var(--color-line)]" style={{ left: `${((m - from) / span) * 100}%` }} aria-hidden />
                            ))}
                            {d.spans.map((s, i) => (
                              <span
                                key={i}
                                title={`${clock(s.from)}–${clock(s.to)} · ${s.working ? "working" : "idle"} · ${AREA_NAMES[s.area] || s.area}`}
                                className={`absolute inset-y-[3px] rounded-full ${s.working ? "bg-[var(--color-primary)]" : "bg-slate-300"}`}
                                style={{ left: `${((Math.max(s.from, from) - from) / span) * 100}%`, width: `max(2px, ${((Math.min(s.to, to) - Math.max(s.from, from)) / span) * 100}%)` }}
                              />
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-center font-semibold tabular-nums">{empty ? "—" : minutesText(d.working)}</td>
                        <td className="px-3 py-2.5 text-center tabular-nums">{empty ? "—" : minutesText(d.idle)}</td>
                        <td className="px-3 py-2.5 text-center tabular-nums text-[var(--color-muted)]">{empty || firstAt === undefined ? "—" : `${clock(firstAt)}–${clock(lastAt)}`}</td>
                        <td className="px-3 py-2.5 text-center tabular-nums">{fullNumber(d.actions)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className={`${CARD} p-4 sm:p-5`}>
            <SectionHead hue="violet" icon={ICONS.areas} title="Where the time went" sub={`By area of Liston, with what ${first} did there`} />
            <div className="-mx-4 mt-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
              <table className="w-full min-w-[560px] table-fixed text-[12.5px]">
                <thead>
                  <tr className="text-[11px] text-[var(--color-muted)] [&>th]:bg-[var(--color-paper)] [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
                    <th className="w-[160px] px-3 py-2 text-left font-medium">Area</th>
                    <th className="px-3 py-2 text-left font-medium">Time</th>
                    <th className="w-[92px] px-3 py-2 text-center font-medium">Working</th>
                    <th className="w-[72px] px-3 py-2 text-center font-medium">Idle</th>
                    <th className="w-[72px] px-3 py-2 text-center font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-line)]">
                  {data.areas.map((a) => (
                    <tr key={a.area}>
                      <td className="px-3 py-2.5 font-medium text-[var(--color-ink)]">{a.label || AREA_NAMES[a.area]}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex h-2.5 gap-px overflow-hidden rounded-full bg-[var(--color-paper)]" role="img" aria-label={`${minutesText(a.working)} working, ${minutesText(a.idle)} idle`}>
                          <span className="h-full bg-[var(--color-primary)]" style={{ width: `${(a.working / maxArea) * 100}%` }} />
                          <span className="h-full bg-slate-300" style={{ width: `${(a.idle / maxArea) * 100}%` }} />
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-center font-semibold tabular-nums">{minutesText(a.working)}</td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-[var(--color-muted)]">{minutesText(a.idle)}</td>
                      <td className="px-3 py-2.5 text-center tabular-nums">{fullNumber(a.actions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">
        Each minute a Liston tab of {first}&apos;s is open counts once: working when there was a click, key press, scroll or touch in Liston within the last couple of
        minutes (time to read what&apos;s on screen), idle when it&apos;s open with nothing done. After half an hour with nothing done they count as away, so a tab left
        open overnight isn&apos;t counted. Time spent on eBay, AliExpress or anywhere else can&apos;t be seen. Days run midnight to midnight in {data.range.timeZone.replace("_", " ")}.
      </p>
    </div>
  );
}
