"use client";

import { PillTabs } from "@/components/PillTabs";

// A row of mutually exclusive options in one capsule — date ranges, chart
// modes. Liston's tabs (PillTabs) as a choice of one; `size` is kept for
// older callers, every capsule now being the one size.

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled = false,
}: {
  options: { key: T; label: string; title?: string }[];
  value: T;
  onChange: (key: T) => void;
  size?: "sm" | "md";
  label?: string;
  disabled?: boolean;
}) {
  return <PillTabs role="radiogroup" label={label} tabs={options} value={value} onChange={onChange} disabled={disabled} />;
}
