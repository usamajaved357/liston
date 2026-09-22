"use client";

import { useId } from "react";
import { useWidth } from "./useWidth";
import { monotonePath } from "./curve";

// A tiny trend with no axes, for a stat tile: a smooth line over a soft
// wash of its colour, ending in a dot on the latest day. It fills the width
// it is given (drawn at its real size, so the line and dot never stretch).
// Long ranges are averaged into at most 16 steps so the shape reads
// instead of jittering; gaps (null) break the line rather than dropping to
// zero. The scale fits the range's own highs and lows: a sparkline shows
// shape, the tile's figure shows size.

const MAX_POINTS = 16;
const PAD = 4; // room for the end dot

function smoothed(values: (number | null)[]): (number | null)[] {
  if (values.length <= MAX_POINTS) return values;
  const size = Math.ceil(values.length / MAX_POINTS);
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i += size) {
    const known = values.slice(i, i + size).filter((v): v is number => v != null);
    out.push(known.length ? known.reduce((a, b) => a + b, 0) / known.length : null);
  }
  return out;
}


export function Sparkline({
  values: raw,
  height = 30,
  className = "text-[var(--color-primary)]",
  label,
}: {
  values: (number | null)[];
  height?: number;
  className?: string;
  label?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const gradientId = `spark-${useId().replace(/:/g, "")}`;
  const values = smoothed(raw);
  const known = values.filter((v): v is number => v != null);
  const drawable = width > 0 && values.length >= 2 && known.length >= 2;

  let body = null;
  if (drawable) {
    const max = Math.max(...known);
    const min = Math.min(...known);
    const flat = max === min;
    const x = (i: number) => PAD + (i / (values.length - 1)) * (width - PAD * 2);
    const y = (v: number) => (flat ? height / 2 : height - PAD - ((v - min) / (max - min)) * (height - PAD * 2));
    const runs: [number, number][][] = [];
    let run: [number, number][] = [];
    values.forEach((v, i) => {
      if (v == null) {
        if (run.length) runs.push(run);
        run = [];
      } else run.push([x(i), y(v)]);
    });
    if (run.length) runs.push(run);
    const last = runs[runs.length - 1][runs[runs.length - 1].length - 1];
    body = (
      <>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.2} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>
        {runs.map((r, i) =>
          r.length < 2 ? null : (
            <g key={i}>
              <path d={`${monotonePath(r)}L${r[r.length - 1][0].toFixed(1)},${height}L${r[0][0].toFixed(1)},${height}Z`} fill={`url(#${gradientId})`} />
              <path d={monotonePath(r)} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
            </g>
          ),
        )}
        <circle cx={last[0]} cy={last[1]} r={3} fill="currentColor" stroke="var(--color-panel)" strokeWidth={1.5} />
      </>
    );
  }
  return (
    <div ref={ref} className={`min-w-0 ${className}`} style={{ height }}>
      {drawable && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
          {body}
        </svg>
      )}
    </div>
  );
}
