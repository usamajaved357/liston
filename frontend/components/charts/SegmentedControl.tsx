"use client";

// A row of mutually exclusive options in one capsule — date ranges, chart
// modes. The same control the Overview uses for its ranges, as a component.

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  label,
}: {
  options: { key: T; label: string; title?: string }[];
  value: T;
  onChange: (key: T) => void;
  size?: "sm" | "md";
  label?: string;
}) {
  const height = size === "sm" ? "h-6 px-2.5 text-[11.5px]" : "h-7 px-3 text-[12px]";
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.key)}
            className={`${height} rounded-full font-medium transition-colors ${
              on ? "bg-[var(--color-primary)] text-white shadow-sm" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
