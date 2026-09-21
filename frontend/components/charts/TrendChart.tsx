"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { dayLabel, dayLabelLong, niceTicks } from "./chart-format";

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

const HEIGHT = 248;
const M = { top: 16, right: 16, bottom: 28, left: 52 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function TrendChart({
  points,
  format,
  axisFormat = format,
  label,
  currentLabel = "This period",
  previousLabel = "Previous period",
  variant = "area",
  showPrevious = true,
}: {
  points: TrendPoint[];
  format: (v: number | null) => string;
  axisFormat?: (v: number) => string;
  label: string;
  currentLabel?: string;
  previousLabel?: string;
  variant?: "area" | "bars";
  showPrevious?: boolean;
}) {
  const [boxRef, measured] = useWidth<HTMLDivElement>();
  const width = Math.max(240, measured || 640);
  const [active, setActive] = useState<number | null>(null);
  const gradientId = useId().replace(/:/g, "");

  const hasPrevious = showPrevious && points.some((p) => p.previous != null);
  const innerW = width - M.left - M.right;
  const innerH = HEIGHT - M.top - M.bottom;
  const n = points.length;

  const { ticks, yMax } = useMemo(() => {
    const values = points.flatMap((p) => [p.value, hasPrevious ? p.previous : null]).filter((v): v is number => v != null);
    const t = niceTicks(Math.max(0, ...values), 4);
    return { ticks: t, yMax: t[t.length - 1] || 1 };
  }, [points, hasPrevious]);

  // Bars sit in slots; lines run edge to edge.
  const slot = n > 0 ? innerW / n : innerW;
  const x = (i: number) => (variant === "bars" ? M.left + slot * (i + 0.5) : M.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW));
  const y = (v: number) => M.top + innerH - (v / yMax) * innerH;

  function linePaths(get: (p: TrendPoint) => number | null | undefined) {
    const segments: { d: string; start: number; end: number }[] = [];
    let d = "";
    let start = -1;
    points.forEach((p, i) => {
      const v = get(p);
      if (v == null) {
        if (d) segments.push({ d, start, end: i - 1 });
        d = "";
        return;
      }
      if (!d) start = i;
      d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    if (d) segments.push({ d, start, end: n - 1 });
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
  const xLabels = points
    .map((p, i) => ({ i, day: p.day }))
    .filter(({ i }) => i % labelEvery === 0 || i === n - 1)
    .filter(({ i }, k, arr) => !(i === n - 1 && k > 0 && i - arr[k - 1].i < labelEvery * 0.6));

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
      {/* Legend: always present when two periods are drawn. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--color-muted)]">
        <span className="inline-flex items-center gap-1.5">
          {variant === "bars" ? (
            <span className="inline-block h-2.5 w-2.5 rounded-[3px] bg-[var(--color-primary)]" aria-hidden />
          ) : (
            <span className="inline-block h-[2px] w-4 rounded bg-[var(--color-primary)]" aria-hidden />
          )}
          {currentLabel}
        </span>
        {hasPrevious && (
          <span className="inline-flex items-center gap-1.5">
            <svg width="16" height="4" aria-hidden>
              <line x1="0" y1="2" x2="16" y2="2" stroke="var(--color-muted)" strokeWidth="1.5" strokeDasharray="3 3" />
            </svg>
            {previousLabel}
          </span>
        )}
        {partialIndex >= 0 && (
          <span className="inline-flex items-center gap-1.5">
            <svg width="10" height="10" aria-hidden>
              <circle cx="5" cy="5" r="3.5" fill="var(--color-panel)" stroke="var(--color-primary)" strokeWidth="1.5" />
            </svg>
            Today so far
          </span>
        )}
      </div>

      {/* Fills its box: the measured width only sets the drawing's own
          coordinates, so the chart never props its container open. */}
      <svg
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
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
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Recessive grid and y-axis labels. */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} strokeDasharray={t === 0 ? undefined : "2 4"} />
            <text x={M.left - 10} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[var(--color-muted)] text-[11px] tabular-nums">
              {axisFormat(t)}
            </text>
          </g>
        ))}
        {xLabels.map(({ i, day }) => (
          <text key={day} x={x(i)} y={HEIGHT - 8} textAnchor={i === 0 && variant !== "bars" ? "start" : i === n - 1 && variant !== "bars" ? "end" : "middle"} className="fill-[var(--color-muted)] text-[11px]">
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
                <path d={s.d} fill="none" stroke="var(--color-primary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            ))}

        {/* The step into today (still running) is dashed, the point hollow. */}
        {variant === "area" && partialIndex >= 0 && (
          <>
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
          x={M.left}
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
export function TrendTable({ points, format, currentLabel = "This period", previousLabel = "Previous period" }: { points: TrendPoint[]; format: (v: number | null) => string; currentLabel?: string; previousLabel?: string }) {
  const hasPrevious = points.some((p) => p.previous != null);
  return (
    <div className="max-h-[280px] overflow-y-auto rounded-lg border border-[var(--color-line)]">
      <table className="w-full text-[12.5px]">
        <thead className="sticky top-0 bg-[var(--color-paper)] text-left text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
          <tr>
            <th className="px-3 py-2 font-semibold">Day</th>
            <th className="px-3 py-2 text-right font-semibold">{currentLabel}</th>
            {hasPrevious && <th className="px-3 py-2 text-right font-semibold">{previousLabel}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-line)]">
          {points.map((p) => (
            <tr key={p.day}>
              <td className="px-3 py-1.5 text-[var(--color-ink)]">
                {dayLabelLong(p.day)}
                {p.partial && <span className="ml-1 text-[var(--color-muted)]">(so far)</span>}
              </td>
              <td className="px-3 py-1.5 text-right font-medium tabular-nums text-[var(--color-ink)]">{format(p.value)}</td>
              {hasPrevious && <td className="px-3 py-1.5 text-right tabular-nums text-[var(--color-muted)]">{format(p.previous ?? null)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
