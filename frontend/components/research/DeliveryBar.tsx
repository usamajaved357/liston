"use client";

import { ResearchDelivery, ResearchDeliveryFilter } from "@/lib/api";
import { count } from "./format";

// Which listings research compares the account with, by delivery time: a
// seller posting in 6–8 working days competes with other 6–8 day listings,
// not next-day ones. The account's own window comes from its postage policy.
// One row, inside the overview card.

const days = (min: number, max: number) => (min === max ? `${min} working day${min === 1 ? "" : "s"}` : `${min}–${max} working days`);

export function DeliveryBar({
  delivery,
  accountName,
  busy,
  onChange,
}: {
  delivery: ResearchDelivery;
  accountName: string;
  busy: boolean;
  onChange: (filter: ResearchDeliveryFilter) => void;
}) {
  const { account, counts, filter } = delivery;
  if (!account) {
    return (
      <p className="px-4 py-2.5 text-[12px] text-[var(--color-muted)]">
        {accountName}&apos;s postage policy couldn&apos;t be read, so every listing is compared whatever its delivery time. Choose a postage policy in Settings to compare with sellers who deliver like you.
      </p>
    );
  }
  const options: { key: ResearchDeliveryFilter; label: string; n: number; hint: string }[] = [
    { key: "similar", label: "Like you", n: counts.similar, hint: `Delivery windows that overlap ${days(account.min, account.max)}` },
    { key: "faster", label: "Faster", n: counts.faster, hint: `Arrive before ${account.min} working days` },
    { key: "slower", label: "Slower", n: counts.slower, hint: `Arrive after ${account.max} working days` },
    { key: "all", label: "All", n: counts.all, hint: "Every listing, whatever its delivery" },
  ];
  const how = [
    account.policyName ? `"${account.policyName}"` : null,
    account.handling !== null ? `${account.handling} day${account.handling === 1 ? "" : "s"} handling` : null,
    account.serviceName || account.service?.replace(/^[A-Z]{2}_/, "").replace(/([a-z])([A-Z0-9])/g, "$1 $2") || null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
      <span className="text-[12.5px] text-[var(--color-muted)]">Sellers who deliver</span>
      <div role="radiogroup" aria-label="Compare with" className="inline-flex rounded-lg bg-[var(--color-paper)] p-0.5">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={filter === o.key}
            title={o.hint}
            disabled={busy}
            onClick={() => filter !== o.key && onChange(o.key)}
            className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors disabled:opacity-60 ${
              filter === o.key ? "bg-[var(--color-panel)] text-[var(--color-ink)] shadow-sm ring-1 ring-[var(--color-line)]" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            }`}
          >
            {o.label}
            <span className="tabular-nums text-[var(--color-muted)]">{count(o.n)}</span>
          </button>
        ))}
      </div>
      <span
        className="min-w-0 flex-1 truncate text-right text-[12px] text-[var(--color-muted)]"
        title={`${how}${counts.unknown > 0 ? ` · ${counts.unknown} listing${counts.unknown === 1 ? "" : "s"} gave no delivery dates (often posted from abroad), only under All` : ""}`}
      >
        {accountName}: {days(account.min, account.max)}
      </span>
    </div>
  );
}
