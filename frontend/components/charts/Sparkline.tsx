// A tiny trend line with no axes, for a stat tile or a table row. Gaps
// (null) break the line rather than dropping to zero.

export function Sparkline({
  values,
  width = 96,
  height = 28,
  className = "text-[var(--color-primary)]",
  label,
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
  className?: string;
  label?: string;
}) {
  const known = values.filter((v): v is number => v != null);
  if (values.length < 2 || known.length < 2) return <span style={{ width, height }} className="inline-block" aria-hidden />;
  const max = Math.max(...known);
  const min = Math.min(...known, 0);
  const span = max - min || 1;
  const pad = 2;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  const segments: string[] = [];
  let current = "";
  values.forEach((v, i) => {
    if (v == null) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (current) segments.push(current);
  const lastIndex = values.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop()!;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      <circle cx={x(lastIndex)} cy={y(values[lastIndex] as number)} r={2.25} fill="currentColor" />
    </svg>
  );
}
