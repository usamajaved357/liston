// Impressions → views → units sold, with the rate between each step: where
// buyers drop off. Each step is labelled with its figure, so the bar width
// is never the only way to read it.
import { compactNumber, fullNumber, percent } from "@/components/charts/chart-format";

export function Funnel({ impressions, views, sold, ctr }: { impressions: number | null; views: number | null; sold: number | null; ctr: number | null }) {
  const steps = [
    { key: "impressions", label: "Impressions", value: impressions },
    { key: "views", label: "Views", value: views },
    { key: "sold", label: "Units sold", value: sold },
  ];
  const max = Math.max(1, ...steps.map((s) => s.value ?? 0));
  const rates = [
    { label: "click through from search", value: ctr },
    { label: "of views became a sale", value: views && sold != null ? sold / views : null },
  ];
  return (
    <ol className="space-y-1">
      {steps.map((step, i) => (
        <li key={step.key}>
          <div className="flex items-baseline justify-between text-[12.5px]">
            <span className="text-[var(--color-ink)]">{step.label}</span>
            <span className="font-semibold tabular-nums text-[var(--color-ink)]" title={fullNumber(step.value)}>
              {compactNumber(step.value)}
            </span>
          </div>
          <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-[var(--color-paper)]">
            <div
              className="h-full rounded-full bg-[var(--color-primary)]"
              style={{ width: `${step.value ? Math.max(2, (Math.sqrt(step.value) / Math.sqrt(max)) * 100) : 0}%`, opacity: 1 - i * 0.22 }}
            />
          </div>
          {i < rates.length && (
            <p className="flex items-center gap-1.5 py-1.5 pl-1 text-[11.5px] text-[var(--color-muted)]">
              <svg viewBox="0 0 12 12" className="h-3 w-3 flex-shrink-0" aria-hidden>
                <path d="M6 2v8M3 7l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="font-semibold text-[var(--color-ink)]">{percent(rates[i].value)}</span> {rates[i].label}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
