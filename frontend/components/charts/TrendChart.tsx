"use client";

import { useId, useMemo, useState } from "react";
import { dayLabel, dayLabelLong, niceTicks } from "./chart-format";
import { useWidth } from "./useWidth";
import { monotonePath } from "./curve";

// One measure over days, on one axis: the current period as an area (or
// bars, for counts like units sold) in the brand colour, the previous
// period as a dashed neutral line for comparison. Hovering (or arrow keys
// when focused) moves a crosshair that snaps to the nearest day, with one
// tooltip showing both periods. Unknown days (null) leave a gap; a day
// still running ("so far today") is drawn hollow and labelled.
//
// Colours: current = --color-primary, previous = --color-muted (dashed and
// named in the legend, so it never relies on colour). Validated together
// with the dataviz palette checker against the white card surface.

export interface TrendPoint {
  day: string;
  value: number | null;
  previous?: number | null;
  previousDay?: string | null;
  partial?: boolean;
}

const HEIGHT = 248; // the default; a compact card passes its own
// The plot runs to the box's right edge and its axis labels start at the
// left edge, so a chart lines up with its card's heading on both sides.
// The left margin fits the widest axis label.
const M = { top: 16, right: 1, bottom: 28 };
const AXIS_GAP = 12;
const labelWidth = (text: string) => text.length * 6.4;


export function TrendChart({
  points,
  format,
  axisFormat = format,
  label,
  currentLabel = "This period",
  previousLabel = "Previous period",
  variant = "area",
  showPrevious = true,
  legend = true,
  height = HEIGHT,
}: {
  points: TrendPoint[];
  format: (v: number | null) => string;
  axisFormat?: (v: number) => string;
  label: string;
  currentLabel?: string;
  previousLabel?: string;
  variant?: "area" | "bars";
  showPrevious?: boolean;
  legend?: boolean; // false when the card shows a ChartLegend in its heading
  height?: number;
}) {
  const [boxRef, measured] = useWidth<HTMLDivElement>();
  const width = Math.max(240, measured || 640);
  const [active, setActive] = useState<number | null>(null);
  const gradientId = useId().replace(/:/g, "");

  const hasPrevious = showPrevious && points.some((p) => p.previous != null);
  const innerH = height - M.top - M.bottom;
  const n = points.length;

  const { ticks, yMax } = useMemo(() => {
    const values = points.flatMap((p) => [p.value, hasPrevious ? p.previous : null]).filter((v): v is number => v != null);
    const t = niceTicks(Math.max(0, ...values), 4);
    return { ticks: t, yMax: t[t.length - 1] || 1 };
  }, [points, hasPrevious]);
  const left = Math.ceil(Math.max(...ticks.map((t) => labelWidth(axisFormat(t))), 8)) + AXIS_GAP;
  const innerW = width - left - M.right;

  // Bars sit in slots; lines run edge to edge.
  const slot = n > 0 ? innerW / n : innerW;
  const x = (i: number) => (variant === "bars" ? left + slot * (i + 0.5) : left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW));
  const y = (v: number) => M.top + innerH - (v / yMax) * innerH;

  // Smooth runs between gaps: a monotone curve through each day's figure,
  // never overshooting a real high or low.
  function linePaths(get: (p: TrendPoint) => number | null | undefined) {
    const segments: { d: string; start: number; end: number }[] = [];
    let run: [number, number][] = [];
    let start = -1;
    const close = (end: number) => {
      if (run.length) segments.push({ d: monotonePath(run), start, end });
      run = [];
    };
    points.forEach((p, i) => {
      const v = get(p);
      if (v == null) return close(i - 1);
      if (!run.length) start = i;
      run.push([x(i), y(v)]);
    });
    close(n - 1);
    return segments;
  }

  // The finished days and the running one are drawn apart: the last step
  // into a partial day is dashed.
  const lastFinal = points.map((p, i) => (p.value != null && !p.partial ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  const currentSegments = linePaths((p) => (p.partial ? null : p.value));
  const partialIndex = points.findIndex((p) => p.partial && p.value != null);
  const previousSegments = hasPrevious ? linePaths((p) => p.previous) : [];
  const baseline = y(0);

  // Label every few days so labels never collide (~64px each).
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 64))));
  // The last day is always labelled; a regular label too close to it
  // (in pixels) gives way.
  const xLabels = points
    .map((p, i) => ({ i, day: p.day }))
    .filter(({ i }) => i % labelEvery === 0 || i === n - 1)
    .filter(({ i }) => i === n - 1 || x(n - 1) - x(i) >= 64);

  function indexFromPointer(clientX: number, target: SVGRectElement) {
    const rect = target.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * innerW;
    const raw = variant === "bars" ? Math.floor(px / slot) : Math.round((px / innerW) * (n - 1));
    return Math.min(n - 1, Math.max(0, raw));
  }

  function onKey(e: React.KeyboardEvent) {
    if (!n) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setActive((i) => {
        const from = i ?? (e.key === "ArrowRight" ? -1 : n);
        return Math.min(n - 1, Math.max(0, from + (e.key === "ArrowRight" ? 1 : -1)));
      });
    } else if (e.key === "Escape") setActive(null);
  }

  const activePoint = active != null ? points[active] : null;
  const tooltipLeft = active != null ? x(active) : 0;
  const flip = tooltipLeft > width - 200;
  const barW = Math.max(2, Math.min(22, slot - Math.max(2, slot * 0.28)));

  return (
    <div ref={boxRef} className="relative w-full min-w-0 select-none">
      {legend && (
        <div className="mb-2">
          <ChartLegend current={currentLabel} previous={hasPrevious ? previousLabel : null} today={partialIndex >= 0} bars={variant === "bars"} />
        </div>
      )}

      {/* Fills its box: the measured width only sets the drawing's own
          coordinates, so the chart never props its container open. */}
      <svg
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ width: "100%" }}
        role="img"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        className="block overflow-visible rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Recessive grid and y-axis labels. */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} strokeDasharray={t === 0 ? undefined : "2 4"} />
            <text x={0} y={y(t)} dy="0.32em" textAnchor="start" className="fill-[var(--color-muted)] text-[11px] tabular-nums">
              {axisFormat(t)}
            </text>
          </g>
        ))}
        {xLabels.map(({ i, day }) => (
          <text key={day} x={x(i)} y={height - 8} textAnchor={i === 0 && variant !== "bars" ? "start" : i === n - 1 && variant !== "bars" ? "end" : "middle"} className="fill-[var(--color-muted)] text-[11px]">
            {dayLabel(day)}
          </text>
        ))}

        {/* Previous period: dashed, neutral, under the current one. */}
        {previousSegments.map((s, k) => (
          <path key={`p${k}`} d={s.d} fill="none" stroke="var(--color-muted)" strokeWidth={1.5} strokeDasharray="4 4" strokeLinecap="round" opacity={0.85} />
        ))}

        {variant === "bars"
          ? points.map((p, i) => {
              if (p.value == null) return null;
              const h = Math.max(p.value > 0 ? 2 : 0, baseline - y(p.value));
              const bx = x(i) - barW / 2;
              const r = Math.min(4, barW / 2, h);
              const top = baseline - h;
              // 4px rounded data-end, square at the baseline.
              const d = `M${bx},${baseline}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + barW - r}Q${bx + barW},${top} ${bx + barW},${top + r}V${baseline}Z`;
              return (
                <path
                  key={p.day}
                  d={d}
                  fill="var(--color-primary)"
                  opacity={p.partial ? 0.45 : active == null || active === i ? 1 : 0.55}
                  stroke={p.partial ? "var(--color-primary)" : undefined}
                  strokeDasharray={p.partial ? "3 2" : undefined}
                />
              );
            })
          : currentSegments.map((s, k) => (
              <g key={`c${k}`}>
                <path d={`${s.d}L${x(s.end).toFixed(1)},${baseline}L${x(s.start).toFixed(1)},${baseline}Z`} fill={`url(#${gradientId})`} />
                <path d={s.d} fill="none" stroke="var(--color-primary)" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            ))}

        {/* The step into today (still running) is dashed, the point hollow. */}
        {variant === "area" && partialIndex >= 0 && (
          <>
            {lastFinal >= 0 && lastFinal === partialIndex - 1 && (
              <path
                d={`M${x(lastFinal).toFixed(1)},${y(points[lastFinal].value as number).toFixed(1)}L${x(partialIndex).toFixed(1)},${y(points[partialIndex].value as number).toFixed(1)}L${x(partialIndex).toFixed(1)},${baseline}L${x(lastFinal).toFixed(1)},${baseline}Z`}
                fill={`url(#${gradientId})`}
                opacity={0.5}
              />
            )}
            {lastFinal >= 0 && lastFinal === partialIndex - 1 && (
              <line
                x1={x(lastFinal)}
                y1={y(points[lastFinal].value as number)}
                x2={x(partialIndex)}
                y2={y(points[partialIndex].value as number)}
                stroke="var(--color-primary)"
                strokeWidth={2}
                strokeDasharray="3 3"
                strokeLinecap="round"
              />
            )}
            <circle cx={x(partialIndex)} cy={y(points[partialIndex].value as number)} r={4} fill="var(--color-panel)" stroke="var(--color-primary)" strokeWidth={2} />
          </>
        )}

        {/* Crosshair and the active day's points. */}
        {activePoint && (
          <g pointerEvents="none">
            <line x1={x(active!)} x2={x(active!)} y1={M.top} y2={baseline} stroke="var(--color-ink)" strokeOpacity={0.18} strokeWidth={1} />
            {hasPrevious && activePoint.previous != null && (
              <circle cx={x(active!)} cy={y(activePoint.previous)} r={4} fill="var(--color-muted)" stroke="var(--color-panel)" strokeWidth={2} />
            )}
            {variant === "area" && activePoint.value != null && (
              <circle cx={x(active!)} cy={y(activePoint.value)} r={5} fill={activePoint.partial ? "var(--color-panel)" : "var(--color-primary)"} stroke={activePoint.partial ? "var(--color-primary)" : "var(--color-panel)"} strokeWidth={2} />
            )}
          </g>
        )}

        {/* Hit area: the whole plot, so the pointer only has to be near a day. */}
        <rect
          x={left}
          y={M.top}
          width={innerW}
          height={innerH}
          fill="transparent"
          onPointerMove={(e) => setActive(indexFromPointer(e.clientX, e.currentTarget))}
          onPointerDown={(e) => setActive(indexFromPointer(e.clientX, e.currentTarget))}
          onPointerLeave={() => setActive(null)}
        />
      </svg>

      {activePoint && (
        <div
          className="pointer-events-none absolute z-10 min-w-[168px] rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2.5 text-[12px] shadow-[var(--shadow-pop)]"
          style={{ top: 36, left: flip ? undefined : tooltipLeft + 14, right: flip ? width - tooltipLeft + 14 : undefined }}
          role="status"
        >
          <p className="font-medium text-[var(--color-muted)]">
            {dayLabelLong(activePoint.day)}
            {activePoint.partial && <span className="ml-1 text-[var(--color-primary)]">· so far</span>}
          </p>
          <div className="mt-1.5 flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
              <span className="inline-block h-[2px] w-3 rounded bg-[var(--color-primary)]" aria-hidden />
              {currentLabel}
            </span>
            <span className="text-[13px] font-semibold tabular-nums text-[var(--color-ink)]">{format(activePoint.value)}</span>
          </div>
          {hasPrevious && (
            <div className="mt-1 flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
                <svg width="12" height="4" aria-hidden>
                  <line x1="0" y1="2" x2="12" y2="2" stroke="var(--color-muted)" strokeWidth="1.5" strokeDasharray="2 2" />
                </svg>
                {activePoint.previousDay ? dayLabel(activePoint.previousDay) : previousLabel}
              </span>
              <span className="font-medium tabular-nums text-[var(--color-ink)]">{format(activePoint.previous ?? null)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The same points as a plain table: the chart's accessible twin. */
// Which line is which: the current period (solid brand line) and the
// previous one (dashed), each captioned and dated, plus the hollow "today
// so far" point when the running day is drawn. Sits in a chart card's
// heading, or above the chart.
export function ChartLegend({
  current,
  previous,
  today = false,
  bars = false,
  currentCaption = "This period",
  previousCaption = "Previous period",
}: {
  current: string;
  previous?: string | null;
  today?: boolean;
  bars?: boolean;
  currentCaption?: string;
  previousCaption?: string;
}) {
  const item = (swatch: React.ReactNode, caption: string, text?: string) => (
    <div className="flex items-center gap-2">
      {swatch}
      <div className="leading-tight">
        <p className="text-[10.5px] font-medium uppercase tracking-wide text-[var(--color-muted)]">{caption}</p>
        {text && <p className="text-[12.5px] font-semibold text-[var(--color-ink)]">{text}</p>}
      </div>
    </div>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      {item(
        bars ? (
          <span className="inline-block h-3 w-3 rounded-[3px] bg-[var(--color-primary)]" aria-hidden />
        ) : (
          <span className="inline-block h-[3px] w-5 rounded-full bg-[var(--color-primary)]" aria-hidden />
        ),
        currentCaption,
        current,
      )}
      {previous &&
        item(
          <svg width="20" height="4" className="flex-shrink-0" aria-hidden>
            <line x1="1" y1="2" x2="19" y2="2" stroke="var(--color-muted)" strokeWidth="2" strokeDasharray="4 3" strokeLinecap="round" />
          </svg>,
          previousCaption,
          previous,
        )}
      {today &&
        item(
          <svg width="12" height="12" className="flex-shrink-0" aria-hidden>
            <circle cx="6" cy="6" r="4" fill="var(--color-panel)" stroke="var(--color-primary)" strokeWidth="2" />
          </svg>,
          "Today",
          "So far",
        )}
    </div>
  );
}

export function TrendTable({ points, format, currentLabel = "This period", previousLabel = "Previous period" }: { points: TrendPoint[]; format: (v: number | null) => string; currentLabel?: string; previousLabel?: string }) {
  const hasPrevious = points.some((p) => p.previous != null);
  // Fixed columns, every figure right-aligned under a right-aligned heading.
  return (
    <div className="max-h-[300px] overflow-y-auto rounded-xl border border-[var(--color-line)]">
      <table className="w-full table-fixed text-[12.5px]">
        <colgroup>
          <col className="w-[34%]" />
          <col />
          {hasPrevious && <col />}
          {hasPrevious && <col className="w-[18%]" />}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-[var(--color-paper)] text-[10.5px] uppercase tracking-wide text-[var(--color-muted)] shadow-[0_1px_0_var(--color-line)]">
          <tr>
            <th scope="col" className="px-4 py-2.5 text-left font-semibold">Day</th>
            <th scope="col" className="px-4 py-2.5 text-right font-semibold">{currentLabel}</th>
            {hasPrevious && <th scope="col" className="px-4 py-2.5 text-right font-semibold">{previousLabel}</th>}
            {hasPrevious && <th scope="col" className="px-4 py-2.5 text-right font-semibold">Change</th>}
          </tr>
        </thead>
        <tbody>
          {points.map((p) => {
            const change = p.value != null && p.previous != null && p.previous !== 0 ? (p.value - p.previous) / p.previous : null;
            return (
              <tr key={p.day} className="border-b border-[var(--color-line)]/70 last:border-0 odd:bg-[var(--color-panel)] even:bg-[var(--color-paper)]/40">
                <td className="px-4 py-2 text-[var(--color-ink)]">
                  {dayLabelLong(p.day)}
                  {p.partial && <span className="ml-1 text-[var(--color-muted)]">(so far)</span>}
                </td>
                <td className="px-4 py-2 text-right font-semibold tabular-nums text-[var(--color-ink)]">{format(p.value)}</td>
                {hasPrevious && <td className="px-4 py-2 text-right tabular-nums text-[var(--color-muted)]">{format(p.previous ?? null)}</td>}
                {hasPrevious && (
                  <td className={`px-4 py-2 text-right text-[11.5px] font-semibold tabular-nums ${change == null ? "text-[var(--color-line-strong)]" : change >= 0 ? "text-emerald-700" : "text-[var(--color-danger)]"}`}>
                    {change == null ? "—" : `${change >= 0 ? "▲" : "▼"} ${Math.abs(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}%`}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
