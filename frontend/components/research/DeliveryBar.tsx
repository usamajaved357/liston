"use client";

import { ResearchDelivery, ResearchDeliveryFilter } from "@/lib/api";
import { count } from "./format";

// Which listings research compares the account with, by delivery time: a
// seller posting in 6–8 working days competes with other 6–8 day listings,
// not next-day ones. The account's own window comes from its postage policy.

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
      <p className="rounded-xl bg-[var(--color-paper)] px-4 py-3 text-[12.5px] text-[var(--color-muted)]">
        {accountName}&apos;s postage policy couldn&apos;t be read, so every listing is compared regardless of delivery time. Choose a postage
        policy in Settings to compare with sellers who deliver like you.
      </p>
    );
  }
  const options: { key: ResearchDeliveryFilter; label: string; n: number; hint: string }[] = [
    { key: "similar", label: "Deliver like you", n: counts.similar, hint: `Delivery windows that overlap ${days(account.min, account.max)}` },
    { key: "faster", label: "Faster", n: counts.faster, hint: `Arrive before ${account.min} working days` },
    { key: "slower", label: "Slower", n: counts.slower, hint: `Arrive after ${account.max} working days` },
    { key: "all", label: "All", n: counts.all, hint: "Every listing, whatever its delivery" },
  ];
  const how = [
    account.handling !== null ? `${account.handling} day${account.handling === 1 ? "" : "s"} handling` : null,
    account.serviceName || account.service?.replace(/^[A-Z]{2}_/, "").replace(/([a-z])([A-Z0-9])/g, "$1 $2") || null,
  ]
    .filter(Boolean)
    .join(" + ");
  return (
    <section className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-[var(--color-ink)]">
          {accountName} delivers in {days(account.min, account.max)}
        </p>
        <p className="text-[12px] text-[var(--color-muted)]">
          {account.policyName ? `Postage policy "${account.policyName}"` : "Postage policy"}
          {how ? `: ${how}` : ""}
          {counts.unknown > 0 && ` · ${counts.unknown} listing${counts.unknown === 1 ? "" : "s"} gave no delivery dates (often posted from abroad), only under All`}
        </p>
      </div>
      <div role="radiogroup" aria-label="Compare with" className="inline-flex flex-wrap rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={filter === o.key}
            title={o.hint}
            disabled={busy}
            onClick={() => filter !== o.key && onChange(o.key)}
            className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium disabled:opacity-60 ${
              filter === o.key ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            }`}
          >
            {o.label}
            <span className={`tabular-nums ${filter === o.key ? "text-white/75" : "text-[var(--color-muted)]/80"}`}>{count(o.n)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
