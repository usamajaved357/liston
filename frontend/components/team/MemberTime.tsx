"use client";

import { useEffect, useState } from "react";
import { api, ApiError, MemberTime, TeamRange } from "@/lib/api";
import { DeltaBadge } from "@/components/charts/DeltaBadge";
import { dayRangeLabel, fullNumber } from "@/components/charts/chart-format";
import { minutesText } from "./time-format";

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

function Stat({ label, value, sub, delta, compared }: { label: string; value: string; sub?: string; delta?: number | null; compared: string }) {
  return (
    <section className="card flex min-w-0 flex-col px-4 py-3.5">
      <span className="text-[12.5px] font-semibold text-[var(--color-muted)]">{label}</span>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-[24px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">{value}</span>
        {delta !== undefined && (
          <span className="ml-auto">
            <DeltaBadge change={delta} compared={compared} size="sm" />
          </span>
        )}
      </div>
      {sub && <p className="mt-1.5 text-[11.5px] text-[var(--color-muted)]">{sub}</p>}
    </section>
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
  if (current?.error) return <div className="card px-6 py-8 text-center text-[13px] text-rose-600">{current.error}</div>;
  if (!data) return <div className="card h-[320px] animate-pulse" aria-label="Loading" />;

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
        <Stat label="With Liston open" value={minutesText(open)} sub={`On ${fullNumber(t.daysInListon)} of ${data.range.days} day${data.range.days === 1 ? "" : "s"}`} delta={change(open, p.working + p.idle)} compared={compared} />
        <Stat label="Working" value={minutesText(t.working)} sub={open ? `${Math.round((t.working / open) * 100)}% of the time open` : "A click, key press or scroll within a couple of minutes"} delta={change(t.working, p.working)} compared={compared} />
        <Stat label="Idle" value={minutesText(t.idle)} sub="Open with nothing done (up to half an hour at a time)" delta={change(t.idle, p.idle)} compared={compared} />
        <Stat label="Actions per working hour" value={t.actionsPerHour === null ? "—" : String(t.actionsPerHour)} sub={`${fullNumber(t.actions)} action${t.actions === 1 ? "" : "s"} recorded`} compared={compared} />
      </div>

      {open === 0 ? (
        <div className="card px-6 py-10 text-center">
          <p className="text-[13px] font-semibold text-[var(--color-ink)]">No time in Liston in this period</p>
          <p className="mx-auto mt-1 max-w-xl text-[12px] leading-relaxed text-[var(--color-muted)]">
            {data.trackedSince
              ? `${first} wasn't in Liston in these days.`
              : `Liston keeps a member's time from their first visit after this was switched on; ${first} hasn't been in since.`}{" "}
            A minute counts as working when there was a click, key press or scroll in Liston within the last couple of minutes, and idle when Liston was open with
            nothing done.
          </p>
        </div>
      ) : (
        <>
          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
              <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Day by day</h2>
              <span className="flex items-center gap-3 text-[11px] text-[var(--color-muted)]">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm bg-[var(--color-primary)]" aria-hidden />
                  Working
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm bg-slate-300" aria-hidden />
                  Idle
                </span>
              </span>
            </div>
            <div className="overflow-x-auto border-t border-[var(--color-line)]">
              <table className="w-full min-w-[720px] table-fixed text-[12.5px]">
                <thead>
                  <tr className="bg-[var(--color-paper)] text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
                    <th className="w-[110px] px-4 py-2 text-left font-semibold">Day</th>
                    <th className="px-3 py-2 text-left font-semibold">
                      <div className="relative h-3">
                        {ticks.map((m) => (
                          <span key={m} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${((m - from) / span) * 100}%` }}>
                            {clock(m)}
                          </span>
                        ))}
                      </div>
                    </th>
                    <th className="w-[92px] px-3 py-2 text-center font-semibold">Working</th>
                    <th className="w-[72px] px-3 py-2 text-center font-semibold">Idle</th>
                    <th className="w-[96px] px-3 py-2 text-center font-semibold">In Liston</th>
                    <th className="w-[72px] px-3 py-2 text-center font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-line)]">
                  {days.map((d) => {
                    const empty = d.working + d.idle === 0;
                    const firstAt = d.spans[0]?.from;
                    const lastAt = d.spans[d.spans.length - 1]?.to;
                    return (
                      <tr key={d.day} className={empty ? "text-[var(--color-muted)]" : ""}>
                        <td className="px-4 py-2 font-medium text-[var(--color-ink)]">{dayName(d.day)}</td>
                        <td className="px-3 py-2">
                          <div className="relative h-4 overflow-hidden rounded bg-[var(--color-paper)]" role="img" aria-label={empty ? "Not in Liston" : `Working ${minutesText(d.working)}, idle ${minutesText(d.idle)}`}>
                            {ticks.map((m) => (
                              <span key={m} className="absolute inset-y-0 w-px bg-[var(--color-line)]" style={{ left: `${((m - from) / span) * 100}%` }} aria-hidden />
                            ))}
                            {d.spans.map((s, i) => (
                              <span
                                key={i}
                                title={`${clock(s.from)}–${clock(s.to)} · ${s.working ? "working" : "idle"} · ${AREA_NAMES[s.area] || s.area}`}
                                className={`absolute inset-y-0.5 ${s.working ? "bg-[var(--color-primary)]" : "bg-slate-300"}`}
                                style={{ left: `${((Math.max(s.from, from) - from) / span) * 100}%`, width: `max(2px, ${((Math.min(s.to, to) - Math.max(s.from, from)) / span) * 100}%)` }}
                              />
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-center tabular-nums">{empty ? "—" : minutesText(d.working)}</td>
                        <td className="px-3 py-2 text-center tabular-nums">{empty ? "—" : minutesText(d.idle)}</td>
                        <td className="px-3 py-2 text-center tabular-nums text-[var(--color-muted)]">{empty || firstAt === undefined ? "—" : `${clock(firstAt)}–${clock(lastAt)}`}</td>
                        <td className="px-3 py-2 text-center tabular-nums">{fullNumber(d.actions)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card overflow-hidden">
            <div className="flex items-baseline justify-between gap-2 px-4 py-3">
              <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Where the time went</h2>
              <span className="text-[11.5px] text-[var(--color-muted)]">By area of Liston, with what {first} did there</span>
            </div>
            <div className="overflow-x-auto border-t border-[var(--color-line)]">
              <table className="w-full min-w-[560px] table-fixed text-[12.5px]">
                <thead>
                  <tr className="bg-[var(--color-paper)] text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
                    <th className="w-[160px] px-4 py-2 text-left font-semibold">Area</th>
                    <th className="px-3 py-2 text-left font-semibold">Time</th>
                    <th className="w-[92px] px-3 py-2 text-center font-semibold">Working</th>
                    <th className="w-[72px] px-3 py-2 text-center font-semibold">Idle</th>
                    <th className="w-[72px] px-3 py-2 text-center font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-line)]">
                  {data.areas.map((a) => (
                    <tr key={a.area}>
                      <td className="px-4 py-2 font-medium text-[var(--color-ink)]">{a.label || AREA_NAMES[a.area]}</td>
                      <td className="px-3 py-2">
                        <div className="flex h-2.5 overflow-hidden rounded-full bg-[var(--color-paper)]" role="img" aria-label={`${minutesText(a.working)} working, ${minutesText(a.idle)} idle`}>
                          <span className="h-full bg-[var(--color-primary)]" style={{ width: `${(a.working / maxArea) * 100}%` }} />
                          <span className="h-full bg-slate-300" style={{ width: `${(a.idle / maxArea) * 100}%` }} />
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center tabular-nums">{minutesText(a.working)}</td>
                      <td className="px-3 py-2 text-center tabular-nums text-[var(--color-muted)]">{minutesText(a.idle)}</td>
                      <td className="px-3 py-2 text-center tabular-nums">{fullNumber(a.actions)}</td>
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
